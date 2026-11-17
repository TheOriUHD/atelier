import Foundation
import UIKit
import MLXLLM
import MLXLMCommon
import MLXHuggingFace
import Tokenizers

/// What a model on the phone is asked: the conversation as the server composed it, and how to answer.
struct LocalChatRequest: Sendable {
    struct Turn: Sendable { let role: String; let text: String }
    let model: String
    let turns: [Turn]
    let maxTokens: Int?
    let temperature: Float?
    let topP: Float?
    let stop: [String]
}

/// What comes back, as it is produced.
enum LocalPiece: Sendable {
    case text(String)
    case thinking(String)
    case done(promptTokens: Int, generatedTokens: Int, reason: String)
}

enum LocalEngineError: LocalizedError {
    case notInstalled(String)
    case tooLong(estimate: Int, limit: Int)
    case background

    var errorDescription: String? {
        switch self {
        case .notInstalled(let id): "The model \(id) is not downloaded on this iPhone."
        case .tooLong(let estimate, let limit): "This conversation is too long for the model on this iPhone: about \(estimate) tokens, and it holds \(limit). Start a new conversation or choose a model on the server."
        case .background: "Atelier went to the background, and an iPhone does not let a model run there. Keep Atelier open while it answers."
        }
    }
}

/// Runs the downloaded models: one loaded at a time, one answer at a time (the phone's memory and GPU are for one).
/// While it works the screen stays on, because the GPU is only the app's while the app is in front.
@MainActor final class LocalEngine {
    static let shared = LocalEngine()

    private var loaded: (id: String, container: ModelContainer)?
    private var gate: Task<Void, Never>?
    private var active = 0
    private var idleUnload: Task<Void, Never>?
    private var memoryObserver: NSObjectProtocol?

    private init() {
        // A phone under memory pressure takes the model out of memory; the next answer loads it again.
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.active == 0 { self?.unload() } }
        }
    }

    var isWorking: Bool { active > 0 }

    func unload() {
        loaded = nil
        idleUnload?.cancel()
    }

    private func container(for id: String) async throws -> ModelContainer {
        if let loaded, loaded.id == id { return loaded.container }
        guard LocalModelStore.shared.state(id) == .installed else { throw LocalEngineError.notInstalled(id) }
        loaded = nil
        let container = try await LLMModelFactory.shared.loadContainer(from: LocalModelStore.folder(id), using: #huggingFaceTokenizerLoader())
        loaded = (id, container)
        return container
    }

    private func begin() {
        active += 1
        UIApplication.shared.isIdleTimerDisabled = true
        idleUnload?.cancel()
    }

    private func end() {
        active -= 1
        guard active == 0 else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        // A model nobody asks anything of for five minutes leaves memory.
        idleUnload = Task { [weak self] in
            try? await Task.sleep(for: .seconds(300))
            if !Task.isCancelled { self?.unload() }
        }
    }

    /// Answers the conversation. Answers run one after another.
    func generate(_ request: LocalChatRequest) -> AsyncThrowingStream<LocalPiece, Error> {
        AsyncThrowingStream { continuation in
            let job = Task { @MainActor in
                // Wait for the answer before this one, if any.
                let before = self.gate
                let mine = Task<Void, Never> { await before?.value }
                self.gate = mine
                await mine.value
                self.begin()
                defer { self.end() }
                do {
                    try await self.run(request, into: continuation)
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in job.cancel() }
        }
    }

    private func run(_ request: LocalChatRequest, into continuation: AsyncThrowingStream<LocalPiece, Error>.Continuation) async throws {
        guard let spec = LocalModelSpec.spec(request.model) else { throw LocalEngineError.notInstalled(request.model) }
        let maxTokens = min(request.maxTokens ?? 4096, 8192)
        let characters = request.turns.reduce(0) { $0 + $1.text.count }
        let estimate = Int(Double(characters) / 3.2)
        if estimate + maxTokens / 4 > spec.context { throw LocalEngineError.tooLong(estimate: estimate, limit: spec.context) }

        #if targetEnvironment(simulator)
        // The simulator runs no model: a stand-in answers, so the rest can be tried there.
        if spec.thinks { continuation.yield(.thinking("The simulator has no GPU, so this is a stand-in.")) }
        for word in "This is the simulator's stand-in for \(spec.name). The conversation reached it from the server and the answer goes back the same way.".split(separator: " ") {
            try Task.checkCancellation()
            continuation.yield(.text(String(word) + " "))
            try await Task.sleep(for: .milliseconds(40))
        }
        continuation.yield(.done(promptTokens: 12, generatedTokens: 24, reason: "stop"))
        return
        #else
        let container = try await container(for: request.model)
        try Task.checkCancellation()

        let system = request.turns.filter { $0.role == "system" }.map(\.text).joined(separator: "\n\n")
        var turns = request.turns.filter { $0.role != "system" }
        // The last thing said to the model is its prompt; what came before it is history.
        let prompt = turns.last?.role == "user" ? turns.removeLast().text : ""
        let history: [Chat.Message] = turns.map { $0.role == "assistant" ? .assistant($0.text) : .user($0.text) }

        var parameters = GenerateParameters()
        parameters.maxTokens = maxTokens
        if let temperature = request.temperature { parameters.temperature = temperature }
        if let topP = request.topP { parameters.topP = topP }
        let session = ChatSession(container, instructions: system.isEmpty ? nil : system, history: history, generateParameters: parameters)

        var splitter = ThinkSplitter()
        var written = ""
        var emitted = 0
        var generated = 0, prompted = 0
        var reason = "stop"
        generation: for try await piece in session.streamDetails(to: prompt) {
            // A phone that went to the background has no GPU for us: say so instead of hanging.
            if UIApplication.shared.applicationState == .background { throw LocalEngineError.background }
            switch piece {
            case .chunk(let text):
                for part in splitter.feed(text) {
                    switch part {
                    case .thinking(let words): continuation.yield(.thinking(words))
                    case .text(let words):
                        written += words
                        if let cut = request.stop.compactMap({ written.range(of: $0) }).min(by: { $0.lowerBound < $1.lowerBound }) {
                            let fresh = String(written[..<cut.lowerBound].dropFirst(emitted))
                            if !fresh.isEmpty { continuation.yield(.text(fresh)) }
                            break generation
                        }
                        emitted += words.count
                        continuation.yield(.text(words))
                    }
                }
            case .info(let info):
                generated = info.generationTokenCount
                prompted = info.promptTokenCount
                if case .length = info.stopReason { reason = "length" }
            default: break
            }
        }
        for part in splitter.finish() {
            switch part {
            case .thinking(let words): continuation.yield(.thinking(words))
            case .text(let words): continuation.yield(.text(words))
            }
        }
        continuation.yield(.done(promptTokens: prompted, generatedTokens: generated, reason: reason))
        #endif
    }
}

/// Qwen3 and others write their reasoning between `<think>` and `</think>`; Atelier shows that as thinking, not as the answer.
struct ThinkSplitter {
    enum Part: Equatable { case thinking(String), text(String) }
    private var inside = false
    private var pending = ""

    /// Takes the next piece of output; keeps back the end of it while that could still turn out to be half a tag.
    mutating func feed(_ chunk: String) -> [Part] {
        pending += chunk
        var parts: [Part] = []
        while true {
            let tag = inside ? "</think>" : "<think>"
            if let range = pending.range(of: tag) {
                let before = String(pending[..<range.lowerBound])
                if !before.isEmpty { parts.append(inside ? .thinking(before) : .text(before)) }
                pending = String(pending[range.upperBound...])
                inside.toggle()
                continue
            }
            // Hold back a tail that is the start of the tag.
            var hold = 0
            for length in stride(from: min(tag.count - 1, pending.count), through: 1, by: -1) where pending.hasSuffix(String(tag.prefix(length))) { hold = length; break }
            let ready = String(pending.dropLast(hold))
            if !ready.isEmpty { parts.append(inside ? .thinking(ready) : .text(ready)) }
            pending = String(pending.suffix(hold))
            return parts
        }
    }

    mutating func finish() -> [Part] {
        defer { pending = "" }
        return pending.isEmpty ? [] : [inside ? .thinking(pending) : .text(pending)]
    }
}
