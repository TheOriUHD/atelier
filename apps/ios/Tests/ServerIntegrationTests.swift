import XCTest
@testable import Atelier

@MainActor final class ServerIntegrationTests: XCTestCase {
    func testAuthenticatedServerRoundTrip() async throws {
        guard let address = ProcessInfo.processInfo.environment["ATELIER_TEST_SERVER"],
              let username = ProcessInfo.processInfo.environment["ATELIER_TEST_USER"],
              let password = ProcessInfo.processInfo.environment["ATELIER_TEST_PASSWORD"] else {
            throw XCTSkip("Set isolated HTTPS server credentials to run native integration tests")
        }
        let store = AppStore()
        store.address = address
        print("Native integration: login")
        try await store.login(username: username, password: password)
        print("Native integration: create session")
        XCTAssertTrue(store.signedIn)
        XCTAssertTrue(store.connected)
        _ = try await store.rpc.call("providers.save", ["id": .string("mobile-test"), "type": .string("openai-compatible"), "name": .string("Mobile Test"), "baseUrl": .string("http://127.0.0.1:17351/v1")])
        try await store.refresh()
        let created = try await store.rpc.call("sessions.create", ["mode": .string("chat"), "model": .string("mobile-test/mobile-test")])
        let id = created["id"].string
        XCTAssertFalse(id.isEmpty)
        print("Native integration: subscribe")
        try await store.open(id)
        XCTAssertEqual(store.transcript.snapshot["session"]["id"].string, id)
        store.draft = "Hello from native iOS"
        try await store.send()
        let reply = NSPredicate { _, _ in MainActor.assumeIsolated { store.transcript.messages.contains { $0["role"].string == "assistant" && $0["parts"].array.contains { $0["text"].string.contains("Native streaming verified") } } } }
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: reply, object: nil)], timeout: 15)
        XCTAssertEqual(store.transcript.messages.filter { $0["role"].string == "user" }.count, 1)
        let project = try await store.rpc.call("projects.create", ["name": .string("Native integration")])
        try await store.refresh()
        XCTAssertTrue(store.projects.contains { $0["id"] == project["id"] })
        try await store.upload(Data("Native attachment".utf8), name: "sample.txt", mime: "text/plain")
        XCTAssertEqual(store.attachments.count, 1)
        _ = try await store.rpc.call("projects.delete", ["id": project["id"]])
        store.selected = nil
        _ = try await store.rpc.call("sessions.delete", ["id": .string(id)])
        print("Native integration: logout")
        try await store.logout()
        XCTAssertFalse(store.signedIn)
    }
}
