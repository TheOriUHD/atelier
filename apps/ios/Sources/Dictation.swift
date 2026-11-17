import AVFoundation
import Foundation
import Observation

@MainActor @Observable final class Dictation {
    var recording = false
    private var recorder: AVAudioRecorder?
    private var file: URL?
    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw MobileError.message("Allow microphone access in iOS Settings to dictate.") }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)
        let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".wav")
        let recorder = try AVAudioRecorder(url: file, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
        guard recorder.record(forDuration: 120) else { throw MobileError.message("The microphone could not start.") }
        self.file = file; self.recorder = recorder; recording = true
    }
    func finish(rpc: Connection) async throws -> String {
        recorder?.stop(); recording = false
        try AVAudioSession.sharedInstance().setActive(false)
        guard let file else { return "" }
        defer { try? FileManager.default.removeItem(at: file); self.file = nil; recorder = nil }
        let audio = try AVAudioFile(forReading: file)
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(audio.length)) else { throw MobileError.message("Could not read the recording.") }
        let input = try AVAudioFile(forReading: file, commonFormat: .pcmFormatInt16, interleaved: false)
        try input.read(into: buffer)
        guard let samples = buffer.int16ChannelData?[0] else { throw MobileError.message("Could not decode microphone audio.") }
        let data = Data(bytes: samples, count: Int(buffer.frameLength) * 2)
        let started = try await rpc.call("dictation.start", ["language": .string("auto")])
        let id = started["id"]
        do {
            for offset in stride(from: 0, to: data.count, by: 64000) {
                let chunk = data.subdata(in: offset..<min(offset + 64000, data.count))
                _ = try await rpc.call("dictation.audio", ["id": id, "seq": .number(Double(offset / 64000)), "pcm": .string(chunk.base64EncodedString())])
            }
            return try await rpc.call("dictation.stop", ["id": id])["text"].string
        } catch { _ = try? await rpc.call("dictation.cancel", ["id": id]); throw error }
    }
    func cancel() {
        recorder?.stop(); recorder = nil; recording = false
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
