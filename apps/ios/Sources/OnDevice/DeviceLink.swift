import Foundation
import UIKit

/// The phone as a device of the person's account: a second connection to the server (`/api/devices/link`) over which the
/// server can ask for what this device lends. Here that is one thing: the models that run on the phone, answered as an
/// OpenAI-compatible server on an address only this device can reach. The frames are the ones the desktop app speaks
/// (packages/protocol/src/device-link.ts).
@MainActor final class DeviceLink {
    struct Identity {
        let deviceID: String
        let name: String
        let providerID: String
    }

    /// The address the server believes the models are at. Nothing listens there: the device answers instead.
    static let lentBaseURL = "http://127.0.0.1:1/v1"

    private let address: String
    private let identity: Identity
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var runner: Task<Void, Never>?
    private var requests: [String: Task<Void, Never>] = [:]
    private var lastHeard = Date()
    private var watchdog: Task<Void, Never>?
    /// Whether the server accepted the link and knows what it lends.
    private(set) var connected = false
    var onChange: (() -> Void)?

    init(address: String, identity: Identity) {
        self.address = address
        self.identity = identity
    }

    func start() {
        guard runner == nil else { return }
        runner = Task { [weak self] in await self?.keepConnected() }
    }

    func stop() {
        runner?.cancel()
        runner = nil
        watchdog?.cancel()
        close()
    }

    private func close() {
        for request in requests.values { request.cancel() }
        requests = [:]
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        if connected { connected = false; onChange?() }
    }

    // MARK: connecting

    private func keepConnected() async {
        var failures = 0
        while !Task.isCancelled {
            do {
                try await connectOnce()
                failures = 0
            } catch is CancellationError {
                return
            } catch MobileError.message(let text) where text == "refused" {
                // The server turned the token down: nothing to do until someone signs in again.
                return
            } catch {
                failures += 1
                NSLog("DEVICELINK failed (%d in a row): %@, close code %d", failures, error.localizedDescription, task?.closeCode.rawValue ?? -1)
                print("DEVICELINK failed (\(failures) in a row): \(error.localizedDescription), close code \(task?.closeCode.rawValue ?? -1)")
            }
            close()
            let delays: [Double] = [1, 2, 4, 8, 10]
            try? await Task.sleep(for: .seconds(delays[min(max(failures, 1), delays.count) - 1]))
        }
    }

    private func connectOnce() async throws {
        guard let token = CredentialStore.read(address), let base = try? serverURL(address) else { throw MobileError.message("refused") }
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.scheme = base.scheme == "http" ? "ws" : "wss"
        parts.path = "/api/devices/link"
        var request = URLRequest(url: parts.url!)
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(identity.deviceID, forHTTPHeaderField: "x-atelier-device-id")
        request.setValue(identity.name, forHTTPHeaderField: "x-atelier-device-name")
        request.setValue("ios", forHTTPHeaderField: "x-atelier-device-platform")
        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task
        task.maximumMessageSize = 64 * 1024 * 1024
        task.resume()
        lastHeard = Date()
        NSLog("DEVICELINK connecting to %@", parts.url?.absoluteString ?? "")
        try await send(hello())
        NSLog("DEVICELINK hello sent")
        // The server pings every ten seconds; two missed pings and the link is taken for dead.
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if let self, Date().timeIntervalSince(self.lastHeard) > 25 { self.task?.cancel(with: .goingAway, reason: nil); return }
            }
        }
        if !connected { connected = true; onChange?() }
        while !Task.isCancelled {
            let message = try await task.receive()
            lastHeard = Date()
            if case .string(let text) = message { handle(text) }
        }
    }

    private func hello() -> [String: Any] {
        [
            "t": "hello",
            "hello": [
                "protocol": 2,
                "app": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0",
                "services": ["http"],
                "lending": [
                    "scratch": false, "ssh": [Any](), "connectors": [Any](),
                    "http": [["id": identity.providerID, "baseUrl": Self.lentBaseURL]],
                    "chatgptChat": false, "home": false,
                ],
                "home": "/", "sep": "/", "os": "ios", "arch": "arm64",
            ] as [String: Any],
        ]
    }

    private func send(_ frame: [String: Any]) async throws {
        guard let data = try? JSONSerialization.data(withJSONObject: frame), let text = String(data: data, encoding: .utf8) else { return }
        try await task?.send(.string(text))
    }

    private func post(_ frame: [String: Any]) { Task { try? await send(frame) } }

    // MARK: what the server asks

    private func handle(_ text: String) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any], let kind = object["t"] as? String else { return }
        switch kind {
        case "ping":
            post(["t": "pong"])
        case "start":
            guard let channel = object["channel"] as? String, requests[channel] == nil else { return }
            guard let service = object["service"] as? [String: Any] else { return }
            start(channel: channel, service: service)
        case "close":
            if let channel = object["channel"] as? String { requests[channel]?.cancel(); requests[channel] = nil }
        case "open":
            // A runner for a folder: this device has none.
            if let channel = object["channel"] as? String { post(["t": "closed", "channel": channel, "reason": "This iPhone has no folders to lend."]) }
        case "req":
            if let id = object["id"] as? Int { post(["t": "res", "id": id, "ok": false, "code": "unsupported", "error": "This iPhone lends its models only."]) }
        default:
            break
        }
    }

    private func start(channel: String, service: [String: Any]) {
        guard service["kind"] as? String == "http", service["target"] as? String == identity.providerID,
              let method = service["method"] as? String, let urlText = service["url"] as? String, let url = URL(string: urlText),
              urlText.hasPrefix(Self.lentBaseURL) || urlText.hasPrefix("http://127.0.0.1:1/") else {
            post(["t": "closed", "channel": channel, "reason": "This iPhone lends its models only."])
            return
        }
        let body = (service["body"] as? String).flatMap { Data(base64Encoded: $0) }
        requests[channel] = Task { [weak self] in
            guard let self else { return }
            await self.serve(channel: channel, request: OnDeviceAPI.Request(method: method, url: url, body: body))
            self.requests[channel] = nil
        }
    }

    private func serve(channel: String, request: OnDeviceAPI.Request) async {
        try? await send(["t": "opened", "channel": channel])
        func line(_ object: [String: Any]) async {
            guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
            try? await send(["t": "line", "channel": channel, "line": text])
        }
        do {
            for try await event in OnDeviceAPI.respond(to: request) {
                if Task.isCancelled { break }
                switch event {
                case .head(let status, let headers): await line(["head": ["status": status, "headers": headers]])
                case .body(let data): await line(["chunk": data.base64EncodedString()])
                }
            }
            try? await send(["t": "closed", "channel": channel, "reason": "done"])
        } catch {
            await line(["error": error.localizedDescription])
            try? await send(["t": "closed", "channel": channel, "reason": "failed"])
        }
    }
}
