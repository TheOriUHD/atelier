import AVFoundation
import Foundation
import Observation
import SwiftUI

/// Dictation as the desktop does it: the microphone's sound goes to the server while the person speaks, and the words
/// come back while they are still talking (`dictation.update`). The text stays in the box for them to edit.
@MainActor @Observable final class Dictation {
    enum Phase { case idle, starting, listening, finishing }

    private(set) var phase: Phase = .idle
    /// Everything the server has heard so far (its last words may still change).
    private(set) var heard = ""
    /// The last couple of seconds of loudness, oldest first, each from 0 to 1: the waveform.
    private(set) var levels: [CGFloat] = Array(repeating: 0, count: Dictation.bars)
    /// Set when the server ends the dictation by itself (too long, no speech service): the box shows it and resets.
    @ObservationIgnored var onFailure: (@MainActor (String) -> Void)?

    static let bars = 44
    var active: Bool { phase != .idle }

    @ObservationIgnored private var capture: DictationCapture?
    @ObservationIgnored private var sender: Task<Void, Error>?
    @ObservationIgnored private var rpc: Connection?
    @ObservationIgnored private var hub: ChatHub?
    @ObservationIgnored private var id = ""

    /// Asks for the microphone, tells the server, and starts sending what the microphone hears.
    func start(rpc: Connection, hub: ChatHub) async throws {
        guard phase == .idle else { return }
        phase = .starting
        heard = ""
        levels = Array(repeating: 0, count: Self.bars)
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw MobileError.message("Allow microphone access in iOS Settings to dictate.") }
            let started = try await rpc.call("dictation.start", ["language": .string("auto")])
            id = started["id"].string
            self.rpc = rpc
            self.hub = hub
            hub.dictationListener = { [weak self] update in self?.receive(update) }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let capture = try DictationCapture { [weak self] level in Task { @MainActor in self?.push(level) } }
            self.capture = capture
            let id = self.id
            sender = Task { [chunks = capture.chunks] in
                var sequence = 0
                for await chunk in chunks {
                    _ = try await rpc.call("dictation.audio", ["id": .string(id), "seq": .number(Double(sequence)), "pcm": .string(chunk.base64EncodedString())])
                    sequence += 1
                }
            }
            try capture.start()
            phase = .listening
        } catch {
            if !id.isEmpty, let rpc = self.rpc { let id = id; Task { _ = try? await rpc.call("dictation.cancel", ["id": .string(id)]) } }
            teardown()
            throw error
        }
    }

    /// Stops listening and returns the final words.
    func finish() async throws -> String {
        guard phase == .listening, let rpc else { return heard }
        phase = .finishing
        capture?.stop()
        do {
            try await sender?.value
            let text = try await rpc.call("dictation.stop", ["id": .string(id)])["text"].string
            teardown()
            return text
        } catch {
            let id = id
            Task { _ = try? await rpc.call("dictation.cancel", ["id": .string(id)]) }
            teardown()
            throw error
        }
    }

    /// Throws away what was heard.
    func cancel() {
        guard active else { return }
        if let rpc, !id.isEmpty { let id = id; Task { _ = try? await rpc.call("dictation.cancel", ["id": .string(id)]) } }
        teardown()
    }

    private func teardown() {
        capture?.stop()
        capture = nil
        sender?.cancel()
        sender = nil
        hub?.dictationListener = nil
        hub = nil
        rpc = nil
        id = ""
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func receive(_ update: JSON) {
        guard update["id"].string == id, !id.isEmpty else { return }
        if let error = update["error"].stringOrNil, !error.isEmpty {
            cancel()
            onFailure?(error)
        } else if phase == .listening || phase == .finishing {
            heard = update["text"].string
        }
    }

    private func push(_ level: CGFloat) {
        guard phase == .listening else { return }
        levels.removeFirst()
        levels.append(level)
    }

    #if DEBUG
    /// A listening state with words and a waveform, for looking at the screen without speaking.
    func demo(words: String) {
        phase = .listening
        heard = words
        levels = (0..<Self.bars).map { index in
            let wave = abs(sin(Double(index) * 0.55)) * abs(cos(Double(index) * 0.17))
            return index < 6 || (index > 24 && index < 31) || index > 38 ? 0 : CGFloat(0.25 + wave * 0.7)
        }
    }
    #endif
}

/// The microphone as 16 kHz mono 16-bit sound in half-second pieces, with the loudness of each moment.
private final class DictationCapture: @unchecked Sendable {
    let chunks: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let engine: AVAudioEngine
    private let converter: AVAudioConverter
    private let target: AVAudioFormat
    private let level: @Sendable (CGFloat) -> Void
    private let lock = NSLock()
    private var pending = Data()
    private var stopped = false

    init(level: @escaping @Sendable (CGFloat) -> Void) throws {
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else { throw MobileError.message("The microphone could not start.") }
        let engine = AVAudioEngine()
        let input = engine.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, let converter = AVAudioConverter(from: input, to: target) else { throw MobileError.message("The microphone could not start.") }
        self.engine = engine
        self.target = target
        self.converter = converter
        self.level = level
        var made: AsyncStream<Data>.Continuation?
        chunks = AsyncStream { made = $0 }
        continuation = made!
    }

    func start() throws {
        let input = engine.inputNode.outputFormat(forBus: 0)
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: input) { [self] buffer, _ in process(buffer) }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        lock.unlock()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        if !pending.isEmpty { continuation.yield(pending); pending = Data() }
        lock.unlock()
        continuation.finish()
    }

    private func process(_ buffer: AVAudioPCMBuffer) {
        level(Self.loudness(buffer))
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var failure: NSError?
        converter.convert(to: converted, error: &failure) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard failure == nil, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
        let bytes = Data(bytes: samples, count: Int(converted.frameLength) * 2)
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        pending.append(bytes)
        // Half a second at a time; the server takes at most two seconds per call.
        while pending.count >= 16_000 {
            continuation.yield(Data(pending.prefix(16_000)))
            pending = Data(pending.dropFirst(16_000))
        }
    }

    /// How loud this moment is, from 0 (quiet room) to 1 (loud speech).
    private static func loudness(_ buffer: AVAudioPCMBuffer) -> CGFloat {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
        let rms = (sum / Float(buffer.frameLength)).squareRoot()
        let decibels = 20 * log10(max(rms, 0.000_01))
        let scaled = (decibels + 52) / 40
        return CGFloat(min(max(scaled, 0), 1))
    }
}

/// The sound as it comes in: bars where there is speech, a dotted line where it is quiet. The newest is on the right.
struct VoiceWave: View {
    let levels: [CGFloat]

    var body: some View {
        Canvas { context, size in
            guard !levels.isEmpty else { return }
            let step = size.width / CGFloat(levels.count)
            for (index, level) in levels.enumerated() {
                let loud = level > 0.08
                let height = loud ? max(4, level * size.height) : 3
                let width: CGFloat = 3
                let rect = CGRect(x: step * (CGFloat(index) + 0.5) - width / 2, y: (size.height - height) / 2, width: width, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: width / 2), with: .color(loud ? Theme.ink : Theme.inkMuted.opacity(0.6)))
            }
        }
        .animation(.linear(duration: 0.08), value: levels)
        .accessibilityElement()
        .accessibilityLabel("Listening")
    }
}
