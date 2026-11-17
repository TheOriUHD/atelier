import SwiftUI
import UIKit
import FoundationModels
import MLXLLM
import MLXLMCommon
import MLXHuggingFace
import HuggingFace
import Tokenizers

/// Fetches a model's files from Hugging Face (what the macros do, written out so the place and the progress are ours).
struct HubDownloader: MLXLMCommon.Downloader {
    private let upstream = HubClient()

    func download(
        id: String,
        revision: String?,
        matching patterns: [String],
        useLatest: Bool,
        progressHandler: @Sendable @escaping (Progress) -> Void
    ) async throws -> URL {
        guard let repoID = HuggingFace.Repo.ID(rawValue: id) else { throw HuggingFaceDownloaderError.invalidRepositoryID(id) }
        return try await upstream.downloadSnapshot(of: repoID, revision: revision ?? "main", matching: patterns, progressHandler: { @MainActor progress in progressHandler(progress) })
    }
}

/// A first look at running a model on the phone itself: download one, ask it something, and measure what it costs
/// (speed, memory, heat). Reached from Settings › Developer, or by launching the app with `--llm-bench <model id>`.
@MainActor @Observable final class OnDeviceSpike {
    struct Candidate: Identifiable, Hashable {
        let id: String
        let name: String
        let note: String
    }

    static let candidates = [
        Candidate(id: "mlx-community/gemma-3-1b-it-qat-4bit", name: "Gemma 3 1B", note: "about 0.7 GB"),
        Candidate(id: "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-4bit", name: "LFM2.5 1.2B", note: "about 0.7 GB"),
        Candidate(id: "mlx-community/Qwen3-1.7B-4bit", name: "Qwen3 1.7B", note: "about 1 GB"),
        Candidate(id: "mlx-community/gemma-4-e2b-it-4bit", name: "Gemma 4 E2B", note: "about 3 GB"),
        Candidate(id: "mlx-community/Qwen3-4B-4bit", name: "Qwen3 4B", note: "about 2.3 GB"),
    ]

    var lines: [String] = []
    var output = ""
    var busy = false
    var progress: Double?

    private func say(_ text: String) {
        lines.append(text)
        NSLog("LLMBENCH %@", text)
        print("LLMBENCH \(text)")
        fflush(stdout)
    }

    private static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }

    private static func thermal() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    /// Apple's own on-device model (no download): the same questions, to compare.
    func runApple() async {
        guard !busy else { return }
        busy = true
        UIApplication.shared.isIdleTimerDisabled = true
        defer { busy = false; UIApplication.shared.isIdleTimerDisabled = false }
        lines = []
        let model = SystemLanguageModel.default
        guard case .available = model.availability else { say("Apple's model is not available: \(model.availability)"); return }
        say("Apple's on-device model, thermal \(Self.thermal()), footprint \(String(format: "%.0f", Self.footprintMB())) MB")
        do {
            for (label, prompt) in [("short", "Name three things to see in Lisbon, one line each."), ("long", "Write a detailed, practical guide to planning a week-long trip to Japan: cities, trains, food, budget and etiquette. Use headings.")] {
                let session = LanguageModelSession()
                let begun = Date()
                var first: Double?
                var text = ""
                do {
                    for try await snapshot in session.streamResponse(to: prompt) {
                        if first == nil { first = Date().timeIntervalSince(begun) }
                        text = snapshot.content
                    }
                } catch { say("\(label): stopped with \(error)") }
                let seconds = Date().timeIntervalSince(begun)
                let estimated = Double(text.count) / 4
                say(String(format: "%@: %d characters (about %.0f tokens) in %.1f s, about %.1f tokens/s, first word %.2f s, footprint %.0f MB, thermal %@", label, text.count, estimated, seconds, estimated / max(0.1, seconds - (first ?? 0)), first ?? 0, Self.footprintMB(), Self.thermal()))
                say("sample: " + text.prefix(160).replacingOccurrences(of: "\n", with: " "))
            }
        }
    }

    /// Loads the model (downloading it the first time), then asks it two things: a short answer and a long one.
    func run(_ id: String, sustainedSeconds: Double = 60) async {
        guard !busy else { return }
        busy = true
        // The GPU is only the app's while it is in front, so the screen must not lock in the middle of an answer.
        UIApplication.shared.isIdleTimerDisabled = true
        defer { busy = false; progress = nil; UIApplication.shared.isIdleTimerDisabled = false }
        lines = []
        output = ""
        say("device \(ProcessInfo.processInfo.physicalMemory / 1_073_741_824) GB, thermal \(Self.thermal()), model \(id)")
        do {
            let started = Date()
            // A copy put in Documents/models/<name> beforehand (from a computer, so no mobile data is used) is read from there.
            let local = URL.documentsDirectory.appending(path: "models").appending(path: id.split(separator: "/").last.map(String.init) ?? id)
            let container: ModelContainer
            if FileManager.default.fileExists(atPath: local.path) {
                say("reading the copy at \(local.lastPathComponent)")
                container = try await LLMModelFactory.shared.loadContainer(from: local, using: #huggingFaceTokenizerLoader())
            } else {
                container = try await loadModelContainer(
                    from: HubDownloader(),
                    using: #huggingFaceTokenizerLoader(),
                    configuration: ModelConfiguration(id: id),
                    progressHandler: { [weak self] p in
                        Task { @MainActor in self?.progress = p.fractionCompleted }
                    }
                )
            }
            say(String(format: "loaded in %.1f s, footprint %.0f MB", Date().timeIntervalSince(started), Self.footprintMB()))
            let session = ChatSession(container)
            session.generateParameters.maxTokens = 3000
            let states = ["active", "inactive", "background"]
            say("app is \(states[UIApplication.shared.applicationState.rawValue]); generating")
            // If nothing comes, say what state the app is in (a locked phone puts it in the background, where the GPU is off limits).
            let watchdog = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(15))
                if !Task.isCancelled { self?.say("still waiting for the first word after 15 s; app is \(states[UIApplication.shared.applicationState.rawValue])") }
            }
            defer { watchdog.cancel() }
            for (label, prompt) in [("short", "Name three things to see in Lisbon, one line each."), ("long", "Write a detailed, practical guide to planning a week-long trip to Japan: cities, trains, food, budget and etiquette. Use headings.")] {
                output = ""
                var tokens = 0
                let begun = Date()
                var finished = false
                var first: Double?
                for try await piece in session.streamDetails(to: prompt) {
                    if case .chunk(let text) = piece {
                        if first == nil { first = Date().timeIntervalSince(begun) }
                        output += text
                        tokens += 1
                    }
                    if case .info(let info) = piece {
                        say(String(format: "%@: %d prompt tokens, %d generated, %.1f tokens/s, first token %.2f s, footprint %.0f MB, thermal %@", label, info.promptTokenCount, info.generationTokenCount, info.tokensPerSecond, first ?? 0, Self.footprintMB(), Self.thermal()))
                        finished = true
                    }
                    if label == "long", Date().timeIntervalSince(begun) > sustainedSeconds { break }
                }
                if !finished { say(String(format: "%@: stopped after %.0f s, ~%d chunks, footprint %.0f MB, thermal %@", label, Date().timeIntervalSince(begun), tokens, Self.footprintMB(), Self.thermal())) }
                say("sample: " + output.prefix(160).replacingOccurrences(of: "\n", with: " "))
            }
            // Round after round, to see what the phone keeps up once it warms: this is what a long conversation feels like.
            let topics = ["a kitchen garden", "the history of the printing press", "learning the piano as an adult", "a small business plan for a bakery", "how vaccines work", "restoring an old bicycle"]
            let begun = Date()
            var round = 0
            while Date().timeIntervalSince(begun) < sustainedSeconds * 2.5 {
                let fresh = ChatSession(container)
                fresh.generateParameters.maxTokens = 700
                var rate = 0.0, count = 0
                for try await piece in fresh.streamDetails(to: "Write a long, detailed essay about \(topics[round % topics.count]).") {
                    if case .info(let info) = piece { rate = info.tokensPerSecond; count = info.generationTokenCount }
                }
                round += 1
                say(String(format: "round %d at %.0f s: %d tokens, %.1f tokens/s, footprint %.0f MB, thermal %@", round, Date().timeIntervalSince(begun), count, rate, Self.footprintMB(), Self.thermal()))
            }
        } catch {
            say("failed: \(error)")
        }
    }
}

struct OnDeviceSpikePage: View {
    @State private var spike = OnDeviceSpike()
    @State private var choice = OnDeviceSpike.candidates[1]

    var body: some View {
        List {
            Section("Model") {
                Picker("Model", selection: $choice) {
                    ForEach(OnDeviceSpike.candidates) { Text("\($0.name), \($0.note)").tag($0) }
                }
                Button(spike.busy ? "Running…" : "Download and measure") { Task { await spike.run(choice.id) } }.disabled(spike.busy)
                if let progress = spike.progress { ProgressView(value: progress) }
            }
            Section("Results") {
                ForEach(Array(spike.lines.enumerated()), id: \.offset) { _, line in Text(line).font(.footnote.monospaced()) }
            }
            if !spike.output.isEmpty { Section("Answer") { Text(spike.output).font(.footnote) } }
        }
        .navigationTitle("On-device model test")
    }
}
