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
}
