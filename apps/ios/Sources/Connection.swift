import Foundation
import Security

@MainActor final class Connection {
    private var socket: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    var event: ((String, JSON) -> Void)?
    var disconnected: (() -> Void)?
    private var generation = UUID()
    func connect(_ url: URL, token: String?) {
        close()
        let generation = generation
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"; components.path = "/api/ws"
        var request = URLRequest(url: components.url!)
        request.setValue("Atelier Mobile iOS", forHTTPHeaderField: "User-Agent")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        let socket = session.webSocketTask(with: request)
        // Conversation snapshots include full message history and tool results.
        socket.maximumMessageSize = 64 * 1024 * 1024
        self.socket = socket
        socket.resume()
        Task { [weak self] in
            defer { session.invalidateAndCancel() }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard let self, self.generation == generation else { return }
                    let data: Data
                    switch message { case .data(let d): data = d; case .string(let s): data = Data(s.utf8); @unknown default: continue }
                    let value = try JSONDecoder().decode(JSON.self, from: data)
                    let id = value["id"].string
                    if let continuation = self.pending.removeValue(forKey: id) {
                        if value["error"] != .null {
                            let error = value["error"]
                            continuation.resume(throwing: MobileError.rpc(code: error["code"].int, appCode: error["data"]["code"].string, message: error["message"].string, fix: error["data"]["fix"].stringOrNil))
                        }
                        else { continuation.resume(returning: value["result"]) }
                    } else if !value["method"].string.isEmpty { self.event?(value["method"].string, value["params"]) }
                }
            } catch {
                guard let self, self.generation == generation else { return }
                self.failPending(error: error); self.socket = nil; self.disconnected?()
            }
        }
    }
    #if DEBUG
    /// Debug builds: canned answers for `--demo` screens, so the real views can be looked at without a server.
    /// Return nil for a method it doesn't know; throw to show an error state.
    var stub: ((String, [String: JSON]) throws -> JSON?)?
    #endif
    func call(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        #if DEBUG
        if let stub, let result = try stub(method, params) { return result }
        #endif
        guard let socket else { throw MobileError.message("Not connected. Your draft is kept; reconnect before sending.") }
        let id = UUID().uuidString
        let data = try JSONEncoder().encode(JSON.object(["jsonrpc": .string("2.0"), "id": .string(id), "method": .string(method), "params": .object(params)]))
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task { [weak self] in
                do { try await socket.send(.string(String(decoding: data, as: UTF8.self))) }
                catch { self?.pending.removeValue(forKey: id)?.resume(throwing: error) }
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                self?.pending.removeValue(forKey: id)?.resume(throwing: MobileError.message("The server did not acknowledge the request. Refresh before retrying an action."))
            }
        }
    }
    func close() {
        generation = UUID(); socket?.cancel(with: .goingAway, reason: nil); socket = nil; failPending()
    }
    private func failPending(error: Error? = nil) {
        let requests = pending; pending.removeAll()
        let detail = error.map { " \($0.localizedDescription)" } ?? ""
        for c in requests.values { c.resume(throwing: MobileError.message("Connection interrupted.\(detail) An action may have reached the server; refresh before retrying.")) }
    }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum CredentialStore {
    static func read(_ server: String) -> String? {
        var query = base(server); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String, server: String) throws {
        remove(server)
        var query = base(server)
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw MobileError.message("Could not securely store this sign-in (Keychain \(status)).") }
    }
    static func remove(_ server: String) { SecItemDelete(base(server) as CFDictionary) }
    private static func base(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.atelier.mobile", kSecAttrAccount as String: server]
    }
}
