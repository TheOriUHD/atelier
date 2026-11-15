// atelier-speech: dictation with the Mac's own on-device speech recognition (Speech's SpeechAnalyzer, macOS 26 and
// later; ARCHITECTURE §27). The desktop app's main process starts one per dictation and talks JSON lines over stdio:
//
//   in   {"type":"start","language":"de"|"auto"}   then {"type":"audio","pcm":"<base64, 16 kHz mono s16le>"} …
//        {"type":"stop"} (the last words, then exit)  or {"type":"cancel"} (exit at once)
//   out  {"type":"preparing","fraction":0.4}          the system is fetching the language's model
//        {"type":"ready","locale":"de_DE"}             listening
//        {"type":"text","text":"…"}                   everything heard so far (its end may still change)
//        {"type":"final","text":"…"}                  after stop
//        {"type":"error","code":"unsupported|unavailable|failed","message":"…"}
//
// `atelier-speech --probe` prints {"available":true|false,"locales":[…]} and exits.
// Nothing leaves the Mac, and it needs no permission of its own: the window records, main passes the sound on.
import AVFoundation
import Foundation
import Speech

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

/** The region a language is usually heard in, for a language picked without one. */
let usualRegion = ["de": "DE", "en": "US", "es": "ES", "fr": "FR", "it": "IT", "pt": "BR", "ja": "JP", "ko": "KR", "zh": "CN", "yue": "CN", "hi": "IN"]

@available(macOS 26.0, *)
func locale(for language: String) async -> Locale? {
  let supported = await SpeechTranscriber.supportedLocales
  let exact = { (tag: String) in supported.first { $0.identifier(.bcp47).lowercased() == tag.lowercased() } }
  if language == "auto" {
    // The first of the Mac's own languages it can hear, else English.
    for id in Locale.preferredLanguages {
      if let found = exact(id) { return found }
      let code = Locale(identifier: id).language.languageCode?.identifier ?? id
      if let found = await locale(for: code) { return found }
    }
    return exact("en-US")
  }
  // The Mac's own way of speaking it (German set up for Austria hears de-AT), then the language's usual region.
  for id in Locale.preferredLanguages where Locale(identifier: id).language.languageCode?.identifier == language {
    if let found = exact(id) { return found }
  }
  if let region = Locale.current.region?.identifier, let found = exact("\(language)-\(region)") { return found }
  if let region = usualRegion[language], let found = exact("\(language)-\(region)") { return found }
  return supported.first { $0.language.languageCode?.identifier == language }
}

@available(macOS 26.0, *)
final class Session: @unchecked Sendable {
  let transcriber: SpeechTranscriber
  let analyzer: SpeechAnalyzer
  let input: AsyncStream<AnalyzerInput>.Continuation
  let stream: AsyncStream<AnalyzerInput>
  let format: AVAudioFormat
  let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  let converter: AVAudioConverter?
  private let lock = NSLock()
  private var finalized = ""
  private var volatile = ""
  private var results: Task<Void, Error>?

  init(locale: Locale) async throws {
    transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    // The language's model is the system's to fetch, once; it says how far it got.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      let progress = request.progress
      let ticker = Task {
        while !Task.isCancelled {
          emit(["type": "preparing", "fraction": progress.fractionCompleted])
          try? await Task.sleep(nanoseconds: 500_000_000)
        }
      }
      defer { ticker.cancel() }
      try await request.downloadAndInstall()
    }
    analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw NSError(domain: "atelier-speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "No audio format for the transcriber."]) }
    format = best
    converter = best == source ? nil : AVAudioConverter(from: source, to: best)
    (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
  }

  func start() async throws {
    results = Task {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        let all: String = lock.withLock {
          if result.isFinal {
            finalized += text
            volatile = ""
          } else {
            volatile = text
          }
          return (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        emit(["type": "text", "text": all])
      }
    }
    try await analyzer.start(inputSequence: stream)
  }

  func feed(_ pcm: Data) {
    let frames = AVAudioFrameCount(pcm.count / 2)
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames) else { return }
    buffer.frameLength = frames
    pcm.withUnsafeBytes { raw in
      if let base = raw.baseAddress { memcpy(buffer.int16ChannelData![0], base, Int(frames) * 2) }
    }
    guard let converter else {
      input.yield(AnalyzerInput(buffer: buffer))
      return
    }
    let capacity = AVAudioFrameCount(Double(frames) * format.sampleRate / source.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
  }

  func finish() async -> String {
    input.finish()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    _ = try? await results?.value
    return lock.withLock { (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines) }
  }
}

@available(macOS 26.0, *)
func run() async {
  var session: Session?
  do {
    for try await line in FileHandle.standardInput.bytes.lines {
      guard let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = message["type"] as? String else { continue }
      switch type {
      case "start":
        guard session == nil else { continue }
        guard SpeechTranscriber.isAvailable else { fail("unavailable", "This Mac’s speech recognition isn’t available.") }
        let language = message["language"] as? String ?? "auto"
        guard let chosen = await locale(for: language) else { fail("unsupported", "The Mac’s speech recognition doesn’t know this language.") }
        do {
          let started = try await Session(locale: chosen)
          try await started.start()
          session = started
          emit(["type": "ready", "locale": chosen.identifier])
        } catch {
          fail("failed", "The Mac’s speech recognition couldn’t start: \(error.localizedDescription)")
        }
      case "audio":
        if let encoded = message["pcm"] as? String, let pcm = Data(base64Encoded: encoded) { session?.feed(pcm) }
      case "stop":
        let text = await session?.finish() ?? ""
        emit(["type": "final", "text": text])
        exit(0)
      case "cancel":
        exit(0)
      default:
        continue
      }
    }
  } catch {
    exit(0)
  }
  // stdin closed: main went away.
  exit(0)
}

if CommandLine.arguments.contains("--probe") {
  if #available(macOS 26.0, *) {
    let locales = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    emit(["available": SpeechTranscriber.isAvailable, "locales": locales.sorted()])
  } else {
    emit(["available": false, "reason": "macOS 26 or later"])
  }
  exit(0)
}

if #available(macOS 26.0, *) {
  await run()
} else {
  fail("unavailable", "The Mac’s own dictation needs macOS 26 or later.")
}
