import XCTest
@testable import Atelier

@MainActor final class OnDeviceTests: XCTestCase {
    private func parts(_ chunks: [String]) -> [ThinkSplitter.Part] {
        var splitter = ThinkSplitter()
        var all: [ThinkSplitter.Part] = []
        for chunk in chunks { all += splitter.feed(chunk) }
        all += splitter.finish()
        return merged(all)
    }
    /// Pieces of the same kind next to each other are one.
    private func merged(_ parts: [ThinkSplitter.Part]) -> [ThinkSplitter.Part] {
        var out: [ThinkSplitter.Part] = []
        for part in parts {
            switch (out.last, part) {
            case (.text(let a)?, .text(let b)): out[out.count - 1] = .text(a + b)
            case (.thinking(let a)?, .thinking(let b)): out[out.count - 1] = .thinking(a + b)
            default: out.append(part)
            }
        }
        return out
    }

    func testPlainTextPassesThrough() {
        XCTAssertEqual(parts(["Hello ", "there"]), [.text("Hello there")])
    }

    func testThinkingIsSeparatedFromTheAnswer() {
        XCTAssertEqual(parts(["<think>Let me see.</think>The answer."]), [.thinking("Let me see."), .text("The answer.")])
    }

    func testATagSplitAcrossPiecesIsStillFound() {
        XCTAssertEqual(parts(["<thi", "nk>Hmm</th", "ink>Done"]), [.thinking("Hmm"), .text("Done")])
        XCTAssertEqual(parts(["a <", "b"]), [.text("a <b")])
    }

    func testAnUnclosedThoughtIsStillShownAsThinking() {
        XCTAssertEqual(parts(["<think>Not finished"]), [.thinking("Not finished")])
    }

    func testTheCatalogIsUsable() {
        XCTAssertEqual(Set(LocalModelSpec.catalog.map(\.id)).count, LocalModelSpec.catalog.count)
        for spec in LocalModelSpec.catalog {
            XCTAssertTrue(spec.repo.contains("/"))
            XCTAssertGreaterThan(spec.bytes, 100_000_000)
            XCTAssertGreaterThanOrEqual(spec.context, 8_192)
            XCTAssertNotNil(LocalModelSpec.spec(spec.id))
        }
    }

    func testNoModelDescriptionClaimsASpeed() {
        // Speeds depend on the phone; the app only shows one that was measured.
        for spec in LocalModelSpec.catalog {
            let text = spec.blurb.lowercased()
            XCTAssertFalse(text.contains("a second") || text.contains("tokens/s") || text.contains("tok/s") || text.contains("per second"), spec.name)
        }
    }

    func testALostConnectionIsRetriedAndAMissingFileIsNot() {
        XCTAssertTrue(DownloadRecovery.isTransient(URLError(.networkConnectionLost)))
        XCTAssertTrue(DownloadRecovery.isTransient(URLError(.timedOut)))
        XCTAssertTrue(DownloadRecovery.isTransient(URLError(.notConnectedToInternet)))
        XCTAssertFalse(DownloadRecovery.isTransient(URLError(.badURL)))
        XCTAssertFalse(DownloadRecovery.isTransient(URLError(.cancelled)))
        XCTAssertTrue(DownloadRecovery.isTransient(status: 503))
        XCTAssertTrue(DownloadRecovery.isTransient(status: 429))
        XCTAssertFalse(DownloadRecovery.isTransient(status: 404))
    }

    func testTheWaitBetweenTriesGrowsAndEnds() {
        let waits = (0..<20).compactMap { DownloadRecovery.delay(afterAttempts: $0) }
        XCTAssertEqual(waits, waits.sorted())
        XCTAssertEqual(waits.first, 2)
        XCTAssertNil(DownloadRecovery.delay(afterAttempts: waits.count))
    }

    func testEachFileKeepsItsOwnResumePoint() {
        XCTAssertEqual(DownloadRecovery.resumeFileName("model.safetensors"), "resume-model.safetensors")
        XCTAssertNotEqual(DownloadRecovery.resumeFileName("a.json"), DownloadRecovery.resumeFileName("b.json"))
        XCTAssertFalse(DownloadRecovery.resumeFileName("a/b.json").contains("/"))
    }

    func testTheModelListTellsTheServerWhatItNeeds() async throws {
        // Nothing is downloaded here: an empty list is still a list.
        var body = Data()
        for try await event in OnDeviceAPI.respond(to: OnDeviceAPI.Request(method: "GET", url: URL(string: "http://127.0.0.1:1/v1/models")!, body: nil)) {
            if case .body(let data) = event { body += data }
        }
        let list = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(list?["object"] as? String, "list")
        XCTAssertNotNil(list?["data"] as? [[String: Any]])
    }

    func testAnUnknownPathAndAMissingModelAreErrorsNotCrashes() async throws {
        var status = 0
        for try await event in OnDeviceAPI.respond(to: OnDeviceAPI.Request(method: "GET", url: URL(string: "http://127.0.0.1:1/v1/nothing")!, body: nil)) {
            if case .head(let code, _) = event { status = code }
        }
        XCTAssertEqual(status, 404)
        var answer = Data()
        let request = #"{"model":"not-downloaded","stream":false,"messages":[{"role":"user","content":"hi"}]}"#
        for try await event in OnDeviceAPI.respond(to: OnDeviceAPI.Request(method: "POST", url: URL(string: "http://127.0.0.1:1/v1/chat/completions")!, body: Data(request.utf8))) {
            if case .head(let code, _) = event { status = code }
            if case .body(let data) = event { answer += data }
        }
        XCTAssertEqual(status, 500)
        XCTAssertTrue(String(decoding: answer, as: UTF8.self).contains("not-downloaded"))
    }
}
