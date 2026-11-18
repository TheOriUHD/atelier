#if DEBUG
import SwiftUI

/// Sample data for looking at the screens without a server: launch with `--demo <screen>`
/// (signin, home, code, new, conversation, running, permission, question, settings, model, usage, artifacts).
enum Demo {
    static var requested: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--demo"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    static func json(_ text: String) -> JSON { (try? JSONDecoder().decode(JSON.self, from: Data(text.utf8))) ?? .null }

    private static func ms(_ secondsAgo: Double) -> Double { (Date.now.timeIntervalSince1970 - secondsAgo) * 1000 }

    @MainActor static func store() -> AppStore {
        let store = AppStore()
        guard let screen = requested else { return store }
        if screen == "signin" { return store }
        store.signedIn = true
        store.connected = true
        store.userName = "Maya Lindqvist"
        store.address = "https://atelier.example.com"
        store.authStatus = .obj(["user": .obj(["id": "u1", "name": "Maya Lindqvist", "username": "maya", "role": .string(Launch.role)]), "local": .bool(false), "setupRequired": .bool(false)])
        store.info = .obj(["name": "Atelier", "version": "0.10.1", "surface": "web", "imageGeneration": .bool(true), "videoGeneration": .bool(true), "audioGeneration": .bool(true), "auditLog": .bool(true), "usageLimits": .bool(true), "unifiedChat": .bool(true), "planAuto": .bool(true), "terminalSignIn": .bool(true)])
        store.rpc.stub = { method, params in
            let responders: [(String, [String: JSON]) throws -> JSON?] = [ChatDemo.respond, PersonalDemo.respond, CustomizeDemo.respond, CodeDemo.respond, AdminModelsDemo.respond, AdminServerDemo.respond]
            for respond in responders { if let result = try respond(method, params) { return result } }
            return nil
        }
        store.models = [
            json(#"{"ref":"anthropic/opus","displayName":"Opus 5.5","providerId":"anthropic","providerName":"Anthropic","effortLevels":["low","medium","high","max"]}"#),
            json(#"{"ref":"anthropic/sonnet","displayName":"Sonnet 5.5","providerId":"anthropic","providerName":"Anthropic","effortLevels":["low","medium","high"]}"#),
            json(#"{"ref":"ollama/qwen3","displayName":"qwen3:30b","providerId":"ollama","providerName":"Ollama (home server)"}"#),
            json(#"{"ref":"mistral/large","displayName":"Mistral Large","providerId":"mistral","providerName":"Mistral"}"#),
        ]
        store.selectedModel = "anthropic/opus"
        store.projects = [json(#"{"id":"p1","name":"Launch 0.11"}"#), json(#"{"id":"p2","name":"Home lab"}"#)]
        func session(_ id: String, _ title: String, _ mode: String, _ status: String, _ ago: Double, pinned: Bool = false, unseen: Bool = false, model: String = "anthropic/opus") -> Conversation {
            Conversation(raw: .object([
                "id": .string(id), "title": .string(title), "mode": .string(mode), "status": .string(status), "model": .string(model),
                "updatedAt": .number(ms(ago)), "workspaceId": mode == "code" ? .string("w1") : .null, "pinnedAt": pinned ? .number(ms(ago)) : .null, "finishedUnseen": .bool(unseen), "projectId": id == "s1" ? .string("p1") : .null,
            ]))
        }
        store.sessions = [
            session("s1", "Launch plan for 0.11", "chat", "idle", 3 * 3600, pinned: true),
            session("s2", "Refactor the dictation engine", "code", "running", 120, model: "ollama/qwen3"),
            session("s3", "Migrate settings to the new schema", "code", "waiting", 900),
            session("s4", "Trip to Lisbon in March", "chat", "idle", 2400, unseen: true, model: "anthropic/sonnet"),
            session("s5", "Summarize the Q3 report", "chat", "idle", 5 * 3600, model: "anthropic/sonnet"),
            session("s6", "Fix the flaky e2e test", "code", "idle", 26 * 3600),
            session("s7", "Draft a reply to Anna", "chat", "idle", 30 * 3600, model: "mistral/large"),
            session("s8", "Compare three self-hosted wikis", "chat", "idle", 4 * 86400, model: "ollama/qwen3"),
            session("s9", "Explain how the updater verifies a download", "chat", "idle", 9 * 86400),
            session("s10", "Rename the gym playlist", "chat", "idle", 40 * 86400, model: "mistral/large"),
        ]
        switch screen {
        case "home", "settings", "signin": break
        case "code": break
        case "new": store.selected = nil
        case "preview-list":
            store.sessions = PreviewReel.sessions(selected: false).map(Conversation.init)
            store.selected = nil
        case "preview-chat":
            store.sessions = PreviewReel.sessions(selected: true).map(Conversation.init)
            store.selected = "c1"
            store.transcript = Transcript(snapshot: PreviewReel.conversation())
            store.draft = ""
        default:
            store.selected = "s2"
            store.transcript = Transcript(snapshot: conversation(screen))
            store.draft = ""
        }
        return store
    }

    private static func conversation(_ screen: String) -> JSON {
        let running = screen == "running"
        var pending = "null"
        if screen == "permission" {
            pending = #"{"id":"i1","kind":"permission","payload":{"toolName":"Bash","reason":"This command runs outside the folder's allowed list.","input":{"command":"npm test -- --grep health && git push origin HEAD"},"warning":"Pushes to a remote."}}"#
        } else if screen == "question" {
            pending = #"{"id":"i2","kind":"question","payload":{"questions":[{"question":"Which approach should I take for the health check?","multiSelect":false,"options":[{"label":"Wait for the port","description":"Poll until the server answers, with a 5 second limit."},{"label":"Start the server in the test","description":"Own the process, so nothing else can race it."},{"label":"Retry the request","description":"Quickest, but it can hide a real failure."}]}]}}"#
        }
        let text = #"""
        The test is flaky because it starts the server and sends the request in the same tick. On a slow machine the request lands before the port is open.

        ## What I changed

        - The test now **waits for the port** before it sends anything.
        - The helper returns the server once it is listening, so `await start()` is enough.
        - A failure now says which step timed out.

        ```js
        export async function start() {
          const server = http.createServer(handler);
          await new Promise((resolve) => server.listen(0, resolve));
          return server;
        }
        ```

        | Run | Before | After |
        |---|---|---|
        | CI, 20 runs | 6 failures | 0 failures |
        | Laptop, 50 runs | 2 failures | 0 failures |

        > A retry would have hidden this. Waiting for the port removes the race itself.

        Want me to apply the same change to the other three tests that start a server?
        """#
        let messages = [
            ("u1", "user", screen == "attachment" ? #"[{"type":"image","blob":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mime":"image/png","name":"Photo.png"},{"type":"text","text":"What do you see here? Can you find out why it fails?"}]"# : #"[{"type":"text","text":"The health endpoint test fails about one run in five. Can you find out why and fix it?"}]"#),
            ("a1", "assistant", #"[{"type":"thinking","text":"A flaky test usually means a race. I should check how the server is started and when the request is sent."},{"type":"text","text":"I'll start with the test and the server it talks to."},{"type":"tool_call","id":"c1","name":"Read","input":{"file_path":"/repo/test/server.test.js"}},{"type":"tool_call","id":"c2","name":"Read","input":{"file_path":"/repo/src/server.js"}},{"type":"tool_call","id":"c3","name":"Grep","input":{"pattern":"listen\\("}}]"#),
            ("t1", "tool", #"[{"type":"tool_result","callId":"c1","content":[{"type":"text","text":"import test from 'node:test';\n..."}]},{"type":"tool_result","callId":"c2","content":[{"type":"text","text":"export function handler(req, res) {...}"}]},{"type":"tool_result","callId":"c3","content":[{"type":"text","text":"src/server.js:14:  server.listen(port)"}]}]"#),
            ("a2", "assistant", #"[{"type":"tool_call","id":"c4","name":"Bash","input":{"command":"npm test -- --grep health","description":"Run the health tests"}},{"type":"tool_call","id":"c5","name":"Edit","input":{"file_path":"/repo/test/server.test.js","old_string":"const server = start();\nconst res = await get(url);","new_string":"const server = await start();\nconst res = await get(url);"}}]"#),
            ("t2", "tool", #"[{"type":"tool_result","callId":"c4","content":[{"type":"text","text":"✔ health reports status and uptime (12ms)\n✖ health answers while starting (timeout)"}],"isError":true},{"type":"tool_result","callId":"c5","content":[{"type":"text","text":"Edited."}]}]"#),
        ]
        var json = messages.map { id, role, parts in #"{"id":"\#(id)","role":"\#(role)","kind":"normal","parts":\#(parts),"error":null}"# }
        let final = Demo.escape(text)
        json.append(#"{"id":"a3","role":"assistant","kind":"normal","parts":[{"type":"text","text":"\#(running ? "The test is flaky because it starts the server and sends the request in the same tick. On a slow machine" : final)"}],"error":null}"#)
        let todos = #"[{"content":"Reproduce the failure","status":"completed","activeForm":"Reproducing the failure"},{"content":"Find the race in the test helper","status":"completed","activeForm":"Finding the race"},{"content":"Wait for the port before the first request","status":"in_progress","activeForm":"Waiting for the port in the helper"},{"content":"Run the whole suite","status":"pending","activeForm":"Running the whole suite"}]"#
        return Demo.json(#"{"session":{"id":"s2","status":"\#(running ? "running" : screen == "permission" || screen == "question" ? "waiting" : "idle")","title":"Fix the flaky e2e test","model":"anthropic/opus"},"seq":9,"messages":[\#(json.joined(separator: ","))],"pending":\#(pending),"todos":\#(running || screen == "permission" ? todos : "[]"),"context":{"used":152000,"limit":200000,"threshold":170000,"categories":{"systemPrompt":9000,"systemTools":14000,"mcpTools":6000,"skills":3000,"messages":120000}}}"#)
    }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
    }
}

struct DemoRoot: View {
    @Bindable var store: AppStore
    @State private var sheet = false
    var body: some View {
        screen
            .overlay { PreviewOverlay() }
            .task { if let scene = Demo.requested, scene.hasPrefix("preview-") { await PreviewDirector.run(scene, store: store) } }
    }

    @ViewBuilder private var screen: some View {
        switch Demo.requested ?? "" {
        case "signin": SignInView(store: store)
        case "home", "split", "conversation-root", "preview-list", "preview-chat": RootView(store: store)
        case "code": RootViewInCode(store: store)
        case "settings": SettingsView(store: store)
        case "model": ConversationView(store: store).sheet(isPresented: .constant(true)) { ModelPicker(store: store) }
        case "usage": NavigationStack { ConversationView(store: store) }.sheet(isPresented: .constant(true)) { UsageView(store: store) }
        default: NavigationStack { ConversationView(store: store) }
        }
    }
}

/// The home list with Code chosen: a thin wrapper so the demo can open it that way.
struct RootViewInCode: View {
    let store: AppStore
    var body: some View { RootView(store: store, startIn: .code) }
}
#endif
