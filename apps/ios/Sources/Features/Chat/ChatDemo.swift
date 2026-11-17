#if DEBUG
import SwiftUI

/// Canned answers for `--demo` screens: the conversation list, the models, projects and every state of a conversation, in
/// the shapes the server really sends, so the real views run unchanged. `--state <name>` picks what the screen shows:
///   list:   empty, offline, error, loading, long, groups
///   chat:   chat, long, media, tools, notices, errors, queued, versions, plan, permission, question, elicitation, folder,
///           coop, temporary, loading, empty, interrupted, rtl
enum ChatDemo {
    nonisolated(unsafe) private static var prepared = false

    private static func ms(_ ago: Double) -> Double { (Date.now.timeIntervalSince1970 - ago) * 1000 }
    private static func t(_ ago: Double) -> JSON { .number(ms(ago)) }
    static var state: String { Launch.value("--state") ?? "" }

    // MARK: setup

    @MainActor static func prepare(_ store: AppStore) {
        guard !prepared, !state.isEmpty else { return }
        prepared = true
        let hub = ChatHub.of(store)
        let id = state == "empty" ? nil : "c1"
        hub.signedOutMessage = nil
        if state == "empty" { store.selected = nil; store.transcript = Transcript(); return }
        if state == "temporary" { hub.newOptions.temporary = true; store.selected = nil; store.transcript = Transcript(); return }
        if state == "loading" { store.selected = "c1"; store.transcript = Transcript(); return }
        store.selected = id
        store.sessions = sessions().map(Conversation.init)
        store.transcript = Transcript(snapshot: snapshot(state))
        store.models = models
        store.selectedModel = "anthropic/opus"
        if state == "coop" { hub.coop["c1"] = coopState }
        if ["media", "chat", "tools"].contains(state) { seedImages() }
        store.artifacts = artifacts
        hub.settings = settings["effective"]
        hub.prefs = prefs
        hub.mcp = mcp
        hub.imageModels = imageModels
        hub.slash = slash
        if state == "queued" { hub.suggestion["c1"] = "" }
    }

    @MainActor static func prepareSignIn(_ model: ChatSignIn, store: AppStore) {
        guard !prepared else { return }
        if !["", "signedout", "password"].contains(state) { store.address = "https://atelier.example.com" }
        switch state {
        case "unreachable": model.probe = .unreachable("Can't reach the server. Check the address and that it is running.")
        case "certificate": model.probe = .certificate(ChatSignIn.probe(for: URLError(.serverCertificateUntrusted)).failure ?? "")
        case "old": model.probe = .tooOld("This server is too old for the app. Ask an admin to update it to the latest Atelier release.")
        case "wrong": model.probe = .ready; model.error = "Wrong username or password."
        case "setup": model.probe = .ready; model.status = ["setupRequired": true]
        case "invite": model.probe = .ready; model.status = ["signup": "open", "setupRequired": false]; model.screen = .invite
        case "signup": model.probe = .ready; model.status = ["signup": "open", "setupRequired": false]; model.screen = .signup
        case "sso": model.probe = .ready; model.status = ["oidc": [["id": "authentik", "name": "Authentik"]], "signup": "open", "setupRequired": false]; model.info = ["terminalSignIn": true]
        case "approval": model.probe = .ready; model.screen = .approval; model.flow = ["code": "K7QF-3MZD", "interval": 5]
        case "pending": model.screen = .pending
        case "signedout": ChatHub.of(store).signedOutMessage = "Your sign-in ended. Sign in again to carry on."
        case "password": store.signedIn = true; store.authStatus = ["user": ["name": "Mia Member", "mustChangePassword": true]]
        default: break
        }
    }

    // MARK: data

    static let models: [JSON] = [
        ["ref": "anthropic/opus", "providerId": "anthropic", "modelId": "opus", "displayName": "Opus 5.5", "contextLength": 200000, "maxOutput": 32000, "capabilities": ["tools": "native", "vision": true, "pdf": true, "reasoning": "effort", "caching": true], "effortLevels": ["low", "medium", "high", "xhigh", "max"], "hidden": false, "favorite": true, "order": 0],
        ["ref": "anthropic/sonnet", "providerId": "anthropic", "modelId": "sonnet", "displayName": "Sonnet 5.5", "contextLength": 200000, "maxOutput": 32000, "capabilities": ["tools": "native", "vision": true, "pdf": true, "reasoning": "effort", "caching": true], "effortLevels": ["low", "medium", "high"], "hidden": false, "favorite": false, "order": 1],
        ["ref": "ollama/qwen3", "providerId": "ollama", "modelId": "qwen3", "displayName": "qwen3:30b", "contextLength": 131072, "maxOutput": 8192, "capabilities": ["tools": "native", "vision": false, "pdf": false, "reasoning": "toggle", "caching": false], "hidden": false, "favorite": false, "order": 2],
        ["ref": "mistral/large", "providerId": "mistral", "modelId": "large", "displayName": "Mistral Large", "contextLength": 128000, "maxOutput": 8192, "capabilities": ["tools": "native", "vision": false, "pdf": false, "reasoning": "none", "caching": false], "hidden": false, "favorite": false, "order": 3],
        ["ref": "u-home/llama", "providerId": "u-home", "modelId": "llama", "displayName": "llama3.3 70b", "contextLength": 65536, "maxOutput": 4096, "capabilities": ["tools": "prompted", "vision": false, "pdf": false, "reasoning": "none", "caching": false], "hidden": false, "favorite": false, "order": 4, "available": false, "personal": ["deviceId": "d1", "deviceName": "Home desktop"]],
    ]

    static let settings: JSON = ["effective": ["providers": [["id": "anthropic", "type": "anthropic", "name": "Anthropic"], ["id": "ollama", "type": "ollama", "name": "Ollama (home server)"], ["id": "mistral", "type": "mistral", "name": "Mistral"]], "models": ["defaults": [:]], "capabilities": ["webSearch": ["enabled": true]], "imageProviders": [["id": "comfy", "name": "ComfyUI"], ["id": "openai-img", "name": "OpenAI"]], "imageGeneration": ["enabled": true], "ultracode": ["enabled": true]]]
    static let prefs: JSON = ["callMe": "", "thinking": true, "privacy": ["temporaryChats": "private"], "sidebar": ["status": "active", "groupBy": "folder", "sortBy": "activity", "showEmptyGroups": false], "models": [:], "dictation": ["language": "auto"]]
    static let mcp: [JSON] = [["name": "github", "state": "ready"], ["name": "notion", "state": "error"], ["name": "filesystem", "state": "disabled"]]
    static let imageModels: [JSON] = [["ref": "comfy/flux", "providerId": "comfy", "displayName": "FLUX.1 dev", "hidden": false, "favorite": true, "order": 0], ["ref": "openai-img/gpt-image", "providerId": "openai-img", "displayName": "GPT Image", "hidden": false, "favorite": false, "order": 1]]
    static let slash: [JSON] = [["name": "review", "description": "Review the staged changes", "kind": "command", "argumentHint": "[focus]"], ["name": "pdf", "description": "Read, fill and merge PDF files", "kind": "skill"], ["name": "frontend-design", "description": "Guidance for distinctive, intentional visual design", "kind": "skill"]]
    static let groups: [JSON] = [["id": "g1", "name": "Work", "collapsed": false, "createdAt": 1], ["id": "g2", "name": "Personal", "collapsed": false, "createdAt": 2], ["id": "g3", "name": "Ideas", "collapsed": true, "createdAt": 3]]
    static let artifacts: [JSON] = [["id": "ar1", "sessionId": "c1", "identifier": "launch-plan", "type": "markdown", "title": "Launch plan for 0.11", "language": .null, "version": 2, "versions": 2, "updatedAt": 1], ["id": "ar2", "sessionId": "c1", "identifier": "status-page", "type": "html", "title": "Status page", "language": .null, "version": 1, "versions": 1, "updatedAt": 1], ["id": "ar3", "sessionId": "c1", "identifier": "helper", "type": "code", "title": "Port helper", "language": "swift", "version": 1, "versions": 1, "updatedAt": 1]]

    static func session(_ id: String, _ title: String, _ mode: String = "chat", status: String = "idle", ago: Double, pinned: Bool = false, unseen: Bool = false, model: String = "anthropic/opus", project: String? = nil, group: String? = nil, archived: Bool = false, produced: Bool = false, coop: JSON = .null) -> JSON {
        .obj(["id": .string(id), "mode": .string(mode), "workspaceId": mode == "code" ? "w1" : .null, "permissionMode": mode == "code" ? "default" : .null, "title": .string(title), "projectId": project.map(JSON.string) ?? .null, "model": .string(model), "effort": .null, "thinking": true, "remoteControl": true, "connectorsOff": [], "research": false, "status": .string(status), "finishedUnseen": .bool(unseen), "groupId": group.map(JSON.string) ?? .null, "archivedAt": archived ? .number(ms(ago)) : .null, "temporary": .null, "pinnedAt": pinned ? .number(ms(ago)) : .null, "createdAt": .number(ms(ago + 3600)), "updatedAt": .number(ms(ago)), "produced": .bool(produced), "coop": coop])
    }

    static func sessions() -> [JSON] {
        if state == "empty" || state == "offline" { return [] }
        var list: [JSON] = [
            session("c1", "Launch plan for 0.11", ago: 3 * 3600, pinned: true, project: "p1", group: "g1", produced: true),
            session("c8", "Plan the offsite agenda", status: "running", ago: 90, model: "anthropic/sonnet", group: "g1"),
            session("c2", "Trip to Lisbon in March", ago: 2400, unseen: true, model: "anthropic/sonnet", group: "g2"),
            session("c3", "Summarize the Q3 report", ago: 5 * 3600, model: "anthropic/sonnet", group: "g1"),
            session("c9", "Migrate the notes app", status: "waiting", ago: 7200, group: "g1"),
            session("c10", "Roadmap review", ago: 9000, model: "anthropic/sonnet", coop: ["role": "editor", "hostName": "Ben", "participants": 3]),
            session("c4", "Draft a reply to Anna", ago: 30 * 3600, model: "mistral/large"),
            session("c5", "Compare three self-hosted wikis", ago: 4 * 86400, model: "ollama/qwen3"),
            session("c6", "Explain how the updater verifies a download", ago: 9 * 86400),
            session("c7", "Rename the gym playlist", ago: 40 * 86400, model: "mistral/large", group: "g2"),
            session("s2", "Refactor the dictation engine", "code", status: "running", ago: 120, model: "ollama/qwen3"),
            session("s3", "Migrate settings to the new schema", "code", status: "waiting", ago: 900),
            session("s6", "Fix the flaky e2e test", "code", ago: 26 * 3600),
        ]
        if state == "long" || state == "rtl" {
            list.insert(session("l1", "Please explain in detail how the whole distributed lock manager in the platform team's service mesh decides which replica wins", ago: 600), at: 0)
            list.insert(session("l2", "ما هي أفضل طريقة لتنظيم الملفات؟", ago: 1200), at: 1)
            list.insert(session("l3", "מה התוכנית לשבוע הבא", ago: 1800), at: 2)
            for index in 0..<24 { list.append(session("x\(index)", "Older conversation number \(index + 1)", ago: Double(50 + index) * 86400)) }
        }
        return list
    }

    static let archived: [JSON] = [session("a1", "Old notes about the garden", ago: 60 * 86400, archived: true), session("a2", "Holiday packing list", ago: 90 * 86400, archived: true)]

    static let coopState: JSON = ["sessionId": "c1", "me": "account:u1", "role": "editor", "via": "server", "hostAway": false, "ended": false, "invite": .null, "knocking": [], "sharedUse": ["requests": 3, "spentUsd": 0.12],
        "participants": [["id": "account:u2", "kind": "account", "name": "Ben Archer", "avatar": .null, "role": "host", "models": "host", "model": "anthropic/opus", "trusted": true, "online": true, "joinedAt": 1], ["id": "account:u1", "kind": "account", "name": "Maya Lindqvist", "avatar": .null, "role": "editor", "models": "host", "model": "anthropic/sonnet", "trusted": false, "online": true, "joinedAt": 2], ["id": "account:u3", "kind": "account", "name": "Cy Ito", "avatar": .null, "role": "viewer", "models": "host", "model": .null, "trusted": false, "online": false, "joinedAt": 3]],
        "settings": ["shareModels": true, "sharedRequestsPerDay": 50, "sharedSpendPerDayUsd": 2, "guestsKeepCopy": true, "allowGuestModels": true, "navigator": .null], "hostModels": [["ref": "anthropic/opus", "displayName": "Opus 5.5"], ["ref": "anthropic/sonnet", "displayName": "Sonnet 5.5"]]]

    // MARK: images

    static let blobA = String(repeating: "a1", count: 32)
    static let blobB = String(repeating: "b2", count: 32)
    static let blobC = String(repeating: "c3", count: 32)

    @MainActor static func seedImages() {
        func gradient(_ colors: [UIColor], size: CGSize) -> UIImage {
            UIGraphicsImageRenderer(size: size).image { context in
                let space = CGColorSpaceCreateDeviceRGB()
                guard let gradient = CGGradient(colorsSpace: space, colors: colors.map(\.cgColor) as CFArray, locations: nil) else { return }
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
        }
        ChatBlobs.shared.seed(sha: blobA, image: gradient([UIColor(red: 0.93, green: 0.55, blue: 0.38, alpha: 1), UIColor(red: 0.25, green: 0.2, blue: 0.4, alpha: 1)], size: CGSize(width: 1024, height: 1024)))
        ChatBlobs.shared.seed(sha: blobB, image: gradient([UIColor(red: 0.3, green: 0.6, blue: 0.7, alpha: 1), UIColor(red: 0.95, green: 0.9, blue: 0.6, alpha: 1)], size: CGSize(width: 1024, height: 1024)))
        ChatBlobs.shared.seed(sha: blobC, image: gradient([UIColor(red: 0.2, green: 0.2, blue: 0.25, alpha: 1), UIColor(red: 0.6, green: 0.7, blue: 0.4, alpha: 1)], size: CGSize(width: 1200, height: 800)))
    }

    // MARK: transcripts

    private static func message(_ id: String, _ role: String, _ parts: [JSON], parent: String? = nil, model: String? = nil, error: JSON = .null, kind: String = "normal", stop: JSON = .null, author: String? = nil, ago: Double = 100) -> JSON {
        var value: [String: JSON] = ["id": .string(id), "sessionId": "c1", "parentId": parent.map(JSON.string) ?? .null, "role": .string(role), "parts": .array(parts), "model": model.map(JSON.string) ?? .null, "usage": .null, "stopReason": stop, "error": error, "kind": .string(kind), "summarizesThroughId": .null, "createdAt": .number(ms(ago))]
        if let author { value["author"] = .string(author) }
        return .object(value)
    }
    private static func text(_ value: String) -> JSON { ["type": "text", "text": .string(value)] }
    private static func call(_ id: String, _ name: String, _ input: JSON) -> JSON { ["type": "tool_call", "id": .string(id), "name": .string(name), "input": input] }
    private static func result(_ id: String, _ value: String, error: Bool = false, extra: [String: JSON] = [:]) -> JSON {
        var object: [String: JSON] = ["type": "tool_result", "callId": .string(id), "content": [["type": "text", "text": .string(value)]], "isError": .bool(error)]
        for (key, item) in extra { object[key] = item }
        return .object(object)
    }

    private static let reply = """
    A launch plan works best as a **short list of decisions**, not a long list of tasks.

    ## What I would do

    - Freeze the scope on Monday, so the week is only about *finishing*.
    - Run the full suite twice: once on `main`, once on the release branch.
    - Write the changelog while the diff is still fresh.

    1. Ship the settings change
    2. Verify the updater on a clean machine
    3. Tag the release

    ```swift
    func release(_ version: String) async throws {
        try await suite.run(on: "main")
        try await tag(version)
    }
    ```

    | Step | Owner | Done |
    |---|---|---|
    | Freeze scope | Anna | Yes |
    | Verify updater | Ben | No |

    > Small steps, done in order, beat a heroic Friday.

    The area of a circle is $A = \\pi r^2$, and for the whole formula:

    $$E = mc^2 + \\frac{a}{b}$$

    Want me to turn this into a checklist? See [the docs](https://docs.atelierhq.dev/getting-started/) or https://atelierhq.dev for more.
    """

    private static func baseMessages() -> [JSON] {
        [
            message("u1", "user", [text("Help me plan the launch week for 0.11. What should I decide first?")], ago: 900),
            message("a1", "assistant", [["type": "thinking", "text": "The person wants a plan. I should ask what is fixed and what is flexible, but a first pass is more useful.\nStart with decisions, not tasks."], call("w1", "WebSearch", ["query": "release week checklist"]), text(reply)], parent: "u1", model: "anthropic/opus", stop: "end", ago: 800),
            message("t1", "tool", [result("w1", "1. Release checklist for small teams\nhttps://example.com/release-checklist\nA short list of what to decide before a release goes out.\n\n2. How we ship every Tuesday\nhttps://blog.example.org/ship-tuesdays\nPublished: Oct 13, 2026 (4 days ago) · Example Blog\nFreeze early, review late.\n\n(via DuckDuckGo · 2 results)")], parent: "a1", ago: 790),
        ]
    }

    static func snapshot(_ state: String) -> JSON {
        var messages = baseMessages()
        var pending: JSON = .null
        var status = "idle"
        var extra: [String: JSON] = [:]
        var title = "Launch plan for 0.11"
        switch state {
        case "long":
            let code = (1...60).map { "    let value\($0) = compute(\($0)) // a comment that makes this line quite a bit longer than the screen is wide, for the scroll" }.joined(separator: "\n")
            messages = [
                message("u1", "user", [text("Explain the whole thing, with the full source, and a very long line: https://example.com/a/very/long/path/that/never/ends/and/keeps/going/and/going/and/going/until/it/is/longer/than/the/screen?query=1&other=2")], ago: 900),
                message("a1", "assistant", [text("Here is everything.\n\n```swift\n\(code)\n```\n\n" + (1...12).map { "- Point number \($0): a sentence that is long enough to wrap onto a second line on a phone, to see how lists hold up." }.joined(separator: "\n") + "\n\n" + "A paragraph of ordinary length repeated so that the message is truly long. ".repeated(14))], parent: "u1", model: "anthropic/opus", stop: "end", ago: 800),
                message("u2", "user", [text("وماذا عن المجلدات؟")], parent: "a1", ago: 700),
                message("a2", "assistant", [text("المجلدات تساعد على تنظيم الملفات حسب المشروع. استخدم أسماء واضحة، ولا تجعل التسلسل أعمق من ثلاثة مستويات.\n\n- أنشئ مجلداً لكل مشروع\n- أضف تاريخاً إلى الأسماء")], parent: "u2", model: "anthropic/opus", stop: "end", ago: 600),
                message("u3", "user", [text("ומה לגבי עברית?")], parent: "a2", ago: 500),
                message("a3", "assistant", [text("בעברית הכיוון הוא מימין לשמאל, והטקסט מתיישר לימין. Mixed text like **Atelier** keeps working.")], parent: "u3", model: "anthropic/opus", stop: "end", ago: 400),
            ]
        case "rtl": messages = Array(snapshot("long")["messages"].array.suffix(4))
        case "media":
            messages = [
                message("u1", "user", [text("Make me a poster of a calm harbour at dawn, a short clip and a jingle."), ["type": "image", "mime": "image/png", "blob": .string(blobC)]], ago: 900),
                message("a1", "assistant", [text("Here is the poster, a clip and a jingle."), call("g1", "GenerateImage", ["prompt": "A calm harbour at dawn"]), call("g2", "GenerateVideo", ["prompt": "A calm harbour at dawn"]), call("g3", "GenerateAudio", ["kind": "music", "prompt": "A calm jingle"]), call("v1", "inline_visual", ["title": "Tide chart", "html": "<div style='font:16px serif;padding:20px'><h3>Tide chart</h3><p>High at 6:12, low at 12:40.</p></div>"]), call("ar", "artifact", ["identifier": "launch-plan", "title": "Launch plan for 0.11", "type": "markdown"]), text("Anything you would change?")], parent: "u1", model: "anthropic/opus", stop: "end", ago: 800),
                message("t1", "tool", [
                    result("g1", "Made 2 images.", extra: ["generated": [["id": "img_a1a1a1a1", "blob": .string(blobA), "mime": "image/png", "width": 1024, "height": 1024, "prompt": "A calm harbour at dawn, soft light, wooden boats", "ref": "comfy/flux", "modelName": "FLUX.1 dev", "seed": 42, "durationMs": 18400, "kind": "image"], ["id": "img_b2b2b2b2", "blob": .string(blobB), "mime": "image/png", "width": 1024, "height": 1024, "prompt": "A calm harbour at dawn, soft light, wooden boats", "ref": "comfy/flux", "modelName": "FLUX.1 dev", "kind": "image", "costUsd": 0.04]]]),
                    result("g2", "Made a clip.", extra: ["generated": [["id": "vid_c3c3c3c3", "blob": .string(blobC), "mime": "video/mp4", "width": 1280, "height": 720, "seconds": 6, "prompt": "A calm harbour at dawn", "ref": "comfy/ltx", "modelName": "LTX Video", "kind": "video"]]]),
                    result("g3", "Made a sound.", extra: ["generated": [["id": "aud_d4d4d4d4", "blob": .string(blobA), "mime": "audio/mpeg", "width": 0, "height": 0, "seconds": 24, "prompt": "A calm jingle", "ref": "x/music", "modelName": "Music model", "kind": "audio", "audioKind": "music"]]]),
                    result("v1", "Shown."), result("ar", "Created."),
                ], parent: "a1", ago: 790),
            ]
        case "tools":
            messages = [
                message("u1", "user", [text("Fix the flaky test and tell me what you found.")], ago: 900),
                message("a1", "assistant", [text("I'll look at the test first."), call("c1", "Read", ["file_path": "/repo/test/server.test.js"]), call("c2", "Grep", ["pattern": "listen\\("]), call("c3", "Bash", ["command": "npm test -- --grep health", "description": "Run the health tests"]), call("c4", "Edit", ["file_path": "/repo/test/server.test.js", "old_string": "const server = start();\nawait get(url);", "new_string": "const server = await start();\nawait get(url);"]), call("c5", "WebFetch", ["url": "https://nodejs.org/api/http.html"]), call("c6", "mcp__github__create_issue", ["title": "Flaky health test"]), text("The test started the server and sent the request in the same tick.")], parent: "u1", model: "anthropic/opus", stop: "end", ago: 800),
                message("t1", "tool", [result("c1", "import test from 'node:test';\n..."), result("c2", "src/server.js:14:  server.listen(port)"), result("c3", "✔ health reports status (12ms)\n✖ health answers while starting (timeout)", error: true), result("c4", "Edited."), result("c5", "Fetched."), result("c6", "Created issue #214")], parent: "a1", ago: 790),
            ]
            extra["todos"] = [["content": "Reproduce the failure", "status": "completed", "activeForm": "Reproducing"], ["content": "Wait for the port", "status": "in_progress", "activeForm": "Waiting for the port in the helper"], ["content": "Run the whole suite", "status": "pending", "activeForm": "Running the suite"]]
        case "notices":
            messages = [
                message("u0", "user", [["type": "context", "text": "", "notice": ["kind": "loop", "loopId": "l", "run": 3]], text("Check the deploy and report.")], ago: 2000),
                message("a0", "assistant", [text("The deploy is healthy."), call("ag", "Agent", ["description": "Check staging"])], parent: "u0", model: "anthropic/opus", stop: "end", ago: 1900),
                message("n0", "user", [["type": "context", "text": "Agent finished", "notice": ["kind": "agent", "taskId": "t", "title": "Check staging", "status": "done", "sessionId": "x"]]], parent: "a0", ago: 1850),
                message("s0", "user", [["type": "context", "text": "Earlier summary", "notice": ["kind": "compaction", "saved": 666200]], text("The conversation so far: the launch plan was agreed, the updater needs verifying, and Anna owns the changelog.")], parent: "n0", kind: "compaction_summary", ago: 1500),
                message("u1", "user", [["type": "context", "text": "", "notice": ["kind": "quote", "text": "Anna owns the changelog."]], text("Who writes the release notes then?")], parent: "s0", ago: 1000),
                message("a1", "assistant", [text("Anna, as you quoted. I'll note it in the plan.")], parent: "u1", model: "anthropic/opus", stop: "end", ago: 900),
                message("u2", "user", [["type": "context", "text": "", "notice": ["kind": "command", "command": "/compact keep the decisions"]]], parent: "a1", ago: 800),
                message("m0", "user", [["type": "context", "text": "", "notice": ["kind": "moved", "from": ["workspaceId": "w1", "root": "/home/me/projects/app"], "to": ["workspaceId": "w2", "root": "/home/me/projects/website"]]]], parent: "u2", ago: 700),
            ]
        case "errors":
            messages = [
                message("u1", "user", [text("Summarize the attached report.")], ago: 900),
                message("a1", "assistant", [], parent: "u1", model: "anthropic/opus", error: ["code": "no_provider", "message": "The model provider isn't connected. Check its key and try again.", "fix": "settings/providers", "retryable": true], ago: 800),
                message("u2", "user", [text("Try again with less.")], parent: "a1", ago: 700),
                message("a2", "assistant", [], parent: "u2", model: "anthropic/opus", error: ["code": "limit_reached", "message": "You've reached your limit of 200,000 tokens per day. It starts again tomorrow.", "retryable": false], ago: 600),
                message("u3", "user", [text("What about this one?")], parent: "a2", ago: 500),
                message("a3", "assistant", [text("I can't help with that.")], parent: "u3", model: "anthropic/opus", stop: "refusal", ago: 400),
            ]
        case "interrupted":
            messages = Array(baseMessages().prefix(1)) + [message("a1", "assistant", [text("A plan works best as")], parent: "u1", model: "anthropic/opus", ago: 800)]
            status = "interrupted"
        case "queued":
            messages = [message("u1", "user", [text("Plan the offsite agenda for two days.")], ago: 900), message("a1", "assistant", [["type": "thinking", "text": "Two days, so a morning and an afternoon each."], text("Day one starts with")], parent: "u1", model: "anthropic/opus", ago: 800)]
            status = "running"
            title = "Plan the offsite agenda"
            extra["outbox"] = [["id": "o1", "parts": [text("Also include a team dinner on the first night.")], "author": "", "joinTurn": false]]
            extra["queued"] = 2
        case "versions":
            messages = [message("u1", "user", [text("Give me a tagline for Atelier.")], ago: 900), message("a1c", "assistant", [text("A quiet place to think out loud, on your own server.")], parent: "u1", model: "anthropic/opus", stop: "end", ago: 800)]
            extra["siblings"] = ["u1": ["u1", "u1b"], "a1c": ["a1a", "a1b", "a1c"]]
        case "plan":
            messages = [message("u1", "user", [text("Plan the migration to the new settings schema.")], ago: 900), message("a1", "assistant", [text("I've written a plan for your approval."), call("pl", "ExitPlanMode", ["plan": "## Goal\nMove every setting to the new schema without losing data.\n\n## Steps\n1. Write a migration that reads the old keys.\n2. Add a fallback so old servers still work.\n3. Run the full suite on both schemas.\n\n## Risks\nA user with a very old config could lose a custom shortcut."])], parent: "u1", model: "anthropic/opus", ago: 800)]
            status = "waiting"
            pending = ["id": "i9", "kind": "permission", "payload": ["callId": "pl", "toolName": "ExitPlanMode", "input": ["plan": "## Goal\nMove every setting to the new schema without losing data.\n\n## Steps\n1. Write a migration that reads the old keys.\n2. Add a fallback so old servers still work.\n3. Run the full suite on both schemas.\n\n## Risks\nA user with a very old config could lose a custom shortcut."], "reason": "", "suggestedRule": ""]]
        case "permission":
            status = "waiting"
            messages = [message("u1", "user", [text("Run the health tests and push if they pass.")], ago: 900), message("a1", "assistant", [text("Running them now."), call("b1", "Bash", ["command": "npm test -- --grep health && git push origin HEAD", "description": "Run the health tests and push"])], parent: "u1", model: "anthropic/opus", ago: 800)]
            pending = ["id": "i1", "kind": "permission", "payload": ["callId": "b1", "toolName": "Bash", "input": ["command": "npm test -- --grep health && git push origin HEAD", "description": "Run the health tests and push"], "reason": "This command runs outside the folder's allowed list.", "warning": "Pushes to a remote.", "suggestedRule": ""]]
        case "edit":
            status = "waiting"
            pending = ["id": "i1", "kind": "permission", "payload": ["callId": "e1", "toolName": "Edit", "input": ["file_path": "/repo/src/server.js", "old_string": "server.listen(0);\nreturn server;", "new_string": "await new Promise((r) => server.listen(0, r));\nreturn server;", "reason": "Wait for the port to open before returning."], "reason": "Edits ask first in this mode.", "suggestedRule": "Edit(/repo/src/*)"]]
        case "question":
            status = "waiting"
            pending = ["id": "i2", "kind": "question", "payload": ["callId": "q1", "questions": [["question": "Which approach should I take for the health check?", "header": "Approach", "multiSelect": false, "options": [["label": "Wait for the port", "description": "Poll until the server answers, with a 5 second limit."], ["label": "Start the server in the test", "description": "Own the process, so nothing else can race it."], ["label": "Retry the request", "description": "Quickest, but it can hide a real failure."]]]]]]
        case "elicitation":
            status = "waiting"
            pending = ["id": "i3", "kind": "elicitation", "payload": ["server": "notion", "message": "Which workspace and page should I use?", "requestedSchema": ["type": "object", "required": ["workspace"], "properties": ["workspace": ["type": "string", "title": "Workspace", "description": "The name of the workspace."], "pages": ["type": "integer", "title": "How many pages", "minimum": 1, "maximum": 20], "public": ["type": "boolean", "title": "Make it public"], "kind": ["type": "string", "title": "Kind", "enum": ["notes", "docs", "wiki"]]]]]]
        case "folder":
            status = "waiting"
            pending = ["id": "i4", "kind": "permission", "payload": ["callId": "f1", "toolName": "ChangeDirectory", "input": ["path": "/home/me/projects/website", "from": "/home/me/projects/app", "reason": "The change belongs in the website repository."], "reason": "", "suggestedRule": ""]]
        case "coop":
            messages = [
                message("u1", "user", [text("Can we decide who owns the changelog?")], author: "account:u2", ago: 900),
                message("a1", "assistant", [text("Anna could own it, since she wrote the last three. Do you agree?")], parent: "u1", model: "anthropic/opus", stop: "end", author: "account:u2", ago: 800),
                message("u2", "user", [text("I agree, add it to the plan.")], parent: "a1", author: "account:u1", ago: 700),
                message("a2", "assistant", [text("Added: Anna owns the changelog.")], parent: "u2", model: "anthropic/sonnet", stop: "end", author: "account:u1", ago: 600),
            ]
            extra["reactions"] = ["a1": [["emoji": "👍", "participants": ["account:u1", "account:u3"]], ["emoji": "🎉", "participants": ["account:u2"]]]]
        default: break
        }
        var object: [String: JSON] = ["session": session("c1", title, status: status, ago: 60, model: "anthropic/opus", project: "p1", group: "g1", produced: true), "messages": .array(messages), "siblings": [:], "streamingMessageId": .null, "pending": pending, "todos": [], "tasks": [], "toolOutput": [:], "toolProgress": [:], "context": ["used": 152000, "limit": 200000, "threshold": 170000, "categories": ["systemPrompt": 9000, "systemTools": 14000, "mcpTools": 6000, "skills": 3000, "messages": 120000], "charsPerToken": 4], "compacting": false, "queued": .null, "phase": .null, "outbox": [], "seq": 9]
        if state == "coop" { object["session"] = session("c1", "Roadmap review", ago: 60, model: "anthropic/sonnet", coop: ["role": "editor", "hostName": "Ben", "participants": 3]) }
        for (key, value) in extra { object[key] = value }
        return .object(object)
    }

    // MARK: answers

    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        switch method {
        case "sessions.list":
            if state == "error" || state == "list-error" { throw MobileError.message("The server did not answer in time.") }
            let all = sessions()
            switch params["archived"]?.string {
            case "archived": return .array(archived)
            case "all":
                let query = params["query"]?.string.lowercased() ?? ""
                return .array((all + archived).filter { query.isEmpty || $0["title"].string.lowercased().contains(query) || (query == "plan" && $0["id"].string == "c8") })
            default:
                if let project = params["projectId"]?.string { return .array(all.filter { $0["projectId"].string == project }) }
                return .array(all)
            }
        case "models.list": return .array(models)
        case "projects.list":
            return .array([["id": "p1", "name": "Launch 0.11", "description": "Everything for the next release: plan, notes, the changelog and the checklist.", "instructions": "Write like a calm release manager. Short sentences.", "pinnedAt": t(3600), "createdAt": t(9e5), "updatedAt": t(7200), "fileCount": 2, "sessionCount": 4], ["id": "p2", "name": "Home lab", "description": "", "instructions": "", "pinnedAt": .null, "createdAt": t(9e5), "updatedAt": t(40 * 86400), "fileCount": 0, "sessionCount": 1]])
        case "projects.get":
            return ["id": params["id"] ?? "p1", "name": "Launch 0.11", "description": "Everything for the next release: plan, notes, the changelog and the checklist.", "instructions": "Write like a calm release manager. Short sentences.", "pinnedAt": t(3600), "createdAt": t(9e5), "updatedAt": t(7200), "files": [["id": "f1", "name": "release-notes-draft.md", "mime": "text/markdown", "size": 8123, "blob": .string(blobA), "kind": "project", "tokens": 2300, "createdAt": t(1e5)], ["id": "f2", "name": "roadmap.pdf", "mime": "application/pdf", "size": 912000, "blob": .string(blobB), "kind": "project", "tokens": 61000, "createdAt": t(9e4)], ["id": "f3", "name": "logo.png", "mime": "image/png", "size": 41000, "blob": .string(blobC), "kind": "project", "tokens": .null, "createdAt": t(8e4)]]]
        case "groups.list": return .array(state == "groups-empty" ? [] : groups)
        case "settings.get": return settings
        case "prefs.get": return prefs
        case "mcp.status": return .array(mcp)
        case "imageModels.list": return .array(imageModels)
        case "workspaces.list": return .array([["id": "w1", "kind": "local", "name": "app", "root": "/home/me/projects/app", "available": true, "scratch": false, "lastUsedAt": 1]])
        case "slash.list": return .array(slash)
        case "dictation.status": return ["enabled": true]
        case "sessions.subscribe": return snapshot(state.isEmpty ? "chat" : state)
        case "sessions.unsubscribe", "sessions.markSeen", "sessions.delete", "groups.delete", "chat.stop", "chat.respond", "chat.retry", "chat.send", "chat.queue", "chat.edit", "chat.compact", "chat.react", "coop.admit", "coop.leave", "coop.end", "coop.typing", "projects.delete", "projects.removeFile": return ["ok": true]
        case "sessions.update": return session(params["id"]?.string ?? "c1", "Launch plan for 0.11", ago: 60)
        case "sessions.fork": return session("c1f", "Fork of Launch plan for 0.11", ago: 5)
        case "groups.create": return ["id": "g9", "name": params["name"] ?? "New", "collapsed": false, "createdAt": 9]
        case "groups.update": return ["id": params["id"] ?? "g1", "name": params["name"] ?? "Work", "collapsed": params["collapsed"] ?? false, "createdAt": 1]
        case "artifacts.list": return .array(artifacts)
        case "artifacts.get":
            let id = params["id"]?.string ?? "ar1"
            let summary = artifacts.first { $0["id"].string == id } ?? artifacts[0]
            let content: String
            switch summary["type"].string {
            case "html": content = "<html><body style='font-family:-apple-system;padding:24px'><h1>Status page</h1><p>All systems <b>operational</b>.</p></body></html>"
            case "code": content = "func port(_ base: Int, _ offset: Int) -> Int {\n    base + offset\n}\n"
            default: content = "# Launch plan for 0.11\n\n- Freeze scope on Monday\n- Verify the updater\n- Tag the release\n\nThe **changelog** is Anna's."
            }
            return summary.setting("content", ["artifactId": summary["id"], "version": summary["version"], "content": .string(content), "messageId": .null, "createdAt": 1])
        case "artifacts.listAll":
            if state == "artifacts-empty" { return ["items": [], "nextCursor": .null] }
            let items: [JSON] = artifacts.map { $0.setting("sessionTitle", "Launch plan for 0.11").setting("sessionMode", "chat") }
            return ["items": .array(items), "nextCursor": .null]
        case "generatedImages.list":
            if state == "images-empty" { return ["items": [], "next": .null, "totalBytes": 0] }
            var items: [JSON] = []
            let blobs = [blobA, blobB, blobC]
            for index in 0..<9 {
                let kind = index == 4 ? "video" : index == 7 ? "audio" : "image"
                var item: [String: JSON] = ["id": .string("img_\(index)"), "blob": .string(blobs[index % 3]), "mime": "image/png", "width": 1024, "height": 1024]
                item["prompt"] = .string("A calm harbour at dawn \(index + 1)")
                item["ref"] = "comfy/flux"
                item["modelName"] = "FLUX.1 dev"
                item["kind"] = .string(kind)
                item["seconds"] = 6
                item["sessionId"] = "c1"
                item["sessionTitle"] = "Launch plan"
                item["sessionMode"] = "chat"
                item["createdAt"] = t(Double(index) * 3600)
                items.append(.object(item))
            }
            return ["items": .array(items), "next": .null, "totalBytes": 48_300_000]
        case "chat.contextBreakdown":
            return ["context": snapshot(state.isEmpty ? "chat" : state)["context"], "usage": ["requests": 14, "input": 182000, "output": 21000, "cacheRead": 90000, "cacheWrite": 12000, "costUsd": 1.42, "tokensPerSecond": 38.2]]
        case "sideChats.list": return .array([["id": "sc1", "mode": "chat", "title": "What does 'freeze scope' mean here?", "status": "idle", "updatedAt": t(1200), "createdAt": t(1300)]])
        case "sideChats.start": return session("sc2", "Side chat", ago: 5)
        case "coop.state": return state == "coop" ? coopState : .null
        case "coop.directory": return .array([["userId": "u2", "name": "Ben Archer", "avatar": .null], ["userId": "u3", "name": "Cy Ito", "avatar": .null], ["userId": "u4", "name": "Dana Moss", "avatar": .null]])
        case "coop.start", "coop.add", "coop.settings", "coop.participant", "coop.models": return coopState
        case "coop.invite": return ["url": "https://atelierhq.dev/join#v1.demo", "expiresAt": t(-86400)]
        case "auth.status": return ["setupRequired": false, "signup": "invite", "user": ["id": "u1", "name": "Maya Lindqvist", "username": "maya", "role": .string(Launch.role)], "local": false, "oidc": []]
        case "chat.changePreview", "chat.editPreview": return ["state": "ready", "rows": [["kind": "context", "text": "export function start() {", "line": 1], ["kind": "remove", "text": "  server.listen(0);", "line": 3], ["kind": "add", "text": "  await new Promise((r) => server.listen(0, r));", "line": 3], ["kind": "context", "text": "  return server;", "line": 4]]]
        default: return nil
        }
    }
}

private extension String {
    func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
#endif
