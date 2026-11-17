#if DEBUG || E2E
import Foundation

/// `--e2e-send "<text>"`: once this device's models are offered to the server, starts a conversation on one of them and
/// sends the text, then prints what came back (`E2E …` lines). For trying the whole path without touching the screen.
enum OnDeviceDebug {
    @MainActor static func run(_ store: AppStore) async {
        guard let text = Launch.value("--e2e-send") else { return }
        func say(_ line: String) { NSLog("E2E %@", line); print("E2E \(line)") }
        // Signed in? (An autologin that failed says why.)
        for _ in 0..<40 where !(store.signedIn && store.connected) { try? await Task.sleep(for: .milliseconds(500)) }
        guard store.signedIn, store.connected else { say("not signed in or not connected: \(store.error ?? "no error")"); return }
        say("signed in; device status \(OnDeviceHub.shared.status)")
        // Wait for the link, the provider and the model list.
        var reference: String?
        for _ in 0..<80 {
            if OnDeviceHub.shared.status == .ready, let models = try? await store.rpc.call("models.list", [:]) {
                reference = models.array.first { $0["personal"]["exclusive"].bool && $0["available"] != .bool(false) }?["ref"].stringOrNil
                if reference != nil { break }
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard let reference else { say("no model of this device appeared; status \(OnDeviceHub.shared.status)"); return }
        say("model \(reference) is listed on this device")
        do {
            let created = try await store.rpc.call("sessions.create", ["mode": "chat", "model": .string(reference)])
            let id = created["id"].string
            try await store.open(id)
            store.draft = text
            try await store.send()
            say("sent in \(id)")
            for _ in 0..<120 {
                try? await Task.sleep(for: .milliseconds(500))
                let reply = store.transcript.messages.last { $0["role"].string == "assistant" }
                let words = reply?["parts"].array.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined() ?? ""
                if store.transcript.status == "idle", !words.isEmpty { say("reply: \(words)"); say("thinking: \(reply?["parts"].array.filter { $0["type"].string == "thinking" }.count ?? 0) part(s)"); return }
                if store.transcript.status == "error" || (store.transcript.status == "idle" && reply != nil && words.isEmpty) { say("failed: \(reply?.pretty ?? "no reply")"); return }
            }
            say("timed out waiting for the reply")
        } catch { say("failed: \(error)") }
    }
}
#endif
