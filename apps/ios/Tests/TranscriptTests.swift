import XCTest
@testable import Atelier

final class TranscriptTests: XCTestCase {
    func testSecureServerAddress() throws {
        XCTAssertEqual(try serverURL("https://atelier.example.com").host, "atelier.example.com")
        for invalid in ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=x"] {
            XCTAssertThrowsError(try serverURL(invalid))
        }
    }
    func testSnapshotDeduplicatesAndRejectsGap() {
        var transcript = Transcript(snapshot: .object(["seq": .number(4), "messages": .array([])]))
        XCTAssertTrue(transcript.apply(.object(["seq": .number(4)])))
        XCTAssertFalse(transcript.apply(.object(["seq": .number(6)])))
        XCTAssertEqual(transcript.seq, 4)
    }
    func testStreamingText() {
        var transcript = Transcript(snapshot: .object(["seq": .number(0), "messages": .array([])]))
        XCTAssertTrue(transcript.apply(.object(["seq": .number(1), "event": .object(["type": .string("message"), "message": .object(["id": .string("m"), "parts": .array([])])])])))
        XCTAssertTrue(transcript.apply(.object(["seq": .number(2), "event": .object(["type": .string("delta"), "messageId": .string("m"), "index": .number(0), "kind": .string("text"), "text": .string("Hello")])])))
        XCTAssertEqual(transcript.messages[0]["parts"].array[0]["text"].string, "Hello")
        XCTAssertFalse(transcript.apply(.object(["seq": .number(3), "event": .object(["type": .string("future_permission")])])))
    }
    func testApprovalClearedByAnotherClient() {
        let request: JSON = .object(["id": .string("approval"), "kind": .string("permission")])
        var transcript = Transcript(snapshot: .object(["seq": .number(0), "messages": .array([]), "pending": request]))
        XCTAssertTrue(transcript.apply(.object(["seq": .number(1), "event": .object(["type": .string("pending"), "pending": .null])])))
        XCTAssertEqual(transcript.pending, .null)
        XCTAssertTrue(transcript.apply(.object(["seq": .number(1), "event": .object(["type": .string("pending"), "pending": request])])))
        XCTAssertEqual(transcript.pending, .null)
    }
    func testBranchAndCompactionRequireAuthoritativeSnapshot() {
        for kind in ["branch", "compacted", "resync", "unknown_event"] {
            var transcript = Transcript(snapshot: .object(["seq": .number(7), "messages": .array([])]))
            XCTAssertFalse(transcript.apply(.object(["seq": .number(8), "event": .object(["type": .string(kind)])])))
            XCTAssertEqual(transcript.seq, 7)
        }
    }
    func testToolOutputAndTaskUpdates() {
        var transcript = Transcript(snapshot: .object(["seq": .number(0), "messages": .array([]), "toolOutput": .object([:])]))
        for (index, text) in ["hello", " world"].enumerated() {
            XCTAssertTrue(transcript.apply(.object(["seq": .number(Double(index + 1)), "event": .object(["type": .string("tool_output"), "callId": .string("tool"), "text": .string(text)])])))
        }
        XCTAssertEqual(transcript.snapshot["toolOutput"]["tool"].string, "hello world")
        let tasks: JSON = .array([.object(["id": .string("task"), "status": .string("done")])])
        XCTAssertTrue(transcript.apply(.object(["seq": .number(3), "event": .object(["type": .string("tasks"), "tasks": tasks])])))
        XCTAssertEqual(transcript.snapshot["tasks"], tasks)
    }
    func testMissingMessageDeltaRequiresReload() {
        var transcript = Transcript(snapshot: .object(["seq": .number(0), "messages": .array([])]))
        XCTAssertFalse(transcript.apply(.object(["seq": .number(1), "event": .object(["type": .string("delta"), "messageId": .string("missing"), "index": .number(0), "kind": .string("text"), "text": .string("lost")])])))
        XCTAssertEqual(transcript.seq, 0)
    }
    func testJSONRoundTrip() throws {
        let original: JSON = .object(["optional": .null, "values": .array([.bool(true), .number(42), .string("hello")])])
        XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(original)), original)
    }
}
