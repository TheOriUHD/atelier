import XCTest
@testable import Atelier

@MainActor final class ConnectionTests: XCTestCase {
    func testDisconnectedCallsAreNeverQueued() async {
        let connection = Connection()
        do {
            _ = try await connection.call("chat.send", ["sessionId": .string("test")])
            XCTFail("A disconnected mutation must not be queued")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Not connected")) }
    }
    func testCloseRejectsPendingRequest() async throws {
        let connection = Connection()
        connection.connect(try serverURL("https://127.0.0.1:1"), token: nil)
        let request = Task { try await connection.call("auth.status") }
        await Task.yield()
        connection.close()
        do { _ = try await request.value; XCTFail("Closed requests must fail") } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
    }

    // MARK: a temporary chat while the app is in the background

    func testOnlyAMissingConversationCountsAsGone() {
        XCTAssertTrue(AppStore.isGone(MobileError.rpc(code: -32000, appCode: "not_found", message: "That conversation no longer exists.", fix: nil)))
        XCTAssertFalse(AppStore.isGone(MobileError.rpc(code: -32000, appCode: "not_found", message: "That attachment no longer exists. Attach it again.", fix: nil)))
        XCTAssertFalse(AppStore.isGone(MobileError.rpc(code: -32000, appCode: "forbidden", message: "That conversation no longer exists.", fix: nil)))
        XCTAssertFalse(AppStore.isGone(URLError(.timedOut)))
    }

    func testAnEndedTemporaryChatLeavesTheScreenAndKeepsWhatWasTyped() throws {
        let store = AppStore()
        let snapshot = try JSONDecoder().decode(JSON.self, from: Data(#"{"session":{"id":"t1","temporary":"private","status":"idle"},"messages":[],"seq":1}"#.utf8))
        store.selected = "t1"
        store.transcript = Transcript(snapshot: snapshot)
        store.draft = "my question"
        store.conversationEnded()
        XCTAssertNil(store.selected)
        XCTAssertEqual(store.draft, "my question", "what was typed is kept for a new conversation")
        XCTAssertTrue(ChatHub.of(store).endedNote?.contains("temporary chat") == true)
        // An ordinary conversation that was deleted elsewhere says so in its own words.
        store.selected = "c1"
        store.transcript = Transcript(snapshot: try JSONDecoder().decode(JSON.self, from: Data(#"{"session":{"id":"c1","temporary":null,"status":"idle"},"messages":[],"seq":1}"#.utf8)))
        store.conversationEnded()
        XCTAssertEqual(ChatHub.of(store).endedNote, "That conversation no longer exists.")
        store.newConversation()
        XCTAssertNil(ChatHub.of(store).endedNote)
    }

    func testTheInstallKeepsItsIDAndTheLaunchIsOnePerProcess() {
        XCTAssertEqual(AppStore.installID, AppStore.installID)
        XCTAssertFalse(AppStore.installID.isEmpty)
        XCTAssertEqual(AppStore.launchID, AppStore.launchID)
        XCTAssertNotEqual(AppStore.launchID, AppStore.installID)
    }
}
