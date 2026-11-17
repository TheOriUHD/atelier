#if DEBUG
import Foundation

/// Canned answers for `--demo` screens, in the shapes the server really sends. `--state empty|error|long|unsupported` changes what they say.
enum PersonalDemo {
    nonisolated(unsafe) private static var prefs: JSON = defaultPrefs
    nonisolated(unsafe) private static var account: JSON?
    nonisolated(unsafe) private static var sessions: [JSON]?
    nonisolated(unsafe) private static var devices: [JSON]?
    nonisolated(unsafe) private static var passkeys: [JSON]?
    nonisolated(unsafe) private static var identities: JSON?
    nonisolated(unsafe) private static var pricing: JSON = json(#"{"anthropic/opus":{"input":15,"output":75,"cacheRead":1.5,"cacheWrite":18.75},"anthropic/sonnet":{"input":3,"output":15},"mistral/large":{"input":2,"output":6,"cacheRead":0.2}}"#)

    private static var state: String { Launch.value("--state") ?? "" }
    private static func ago(_ seconds: Double) -> JSON { .number((Date.now.timeIntervalSince1970 - seconds) * 1000) }
    static func json(_ text: String) -> JSON { Demo.json(text) }

    private static let defaultPrefs: JSON = json(#"""
    {"appearance":{"theme":"system","chatFont":"serif","interfaceFont":"sans","textSize":"m","transcriptWidth":"medium","motion":"system"},
     "code":{"font":"","syntaxTheme":{"light":"atelier-light","dark":"atelier-dark"},"transcriptView":"normal","suggestions":true,"permanentGoalMode":false,"explainChanges":false},
     "sidebar":{"status":"active","environments":["local","cloud","remote","ssh"],"groupBy":"folder","sortBy":"activity","showEmptyGroups":false},
     "remoteControl":true,"thinking":true,"language":"en","defaultMode":"chat","notifications":{"taskFinished":true,"permissionNeeded":true},"callMe":"Phil",
     "personalization":{"instructions":"I work in TypeScript and prefer short answers with code first.","responseStyle":"concise","personality":{"selected":"custom:tutor","customModes":[{"id":"tutor","name":"Patient tutor","instructions":"Be a patient tutor. Ask one guiding question at a time."}]},"atelierMd":"# How I work\n\n- Explain a plan before large changes.\n- Write commit messages in English."},
     "models":{"chat":"anthropic/sonnet"},"personalModels":{},"chat":{"coworkOffer":true},"permissions":{"allow":[]},"privacy":{"historyRetentionDays":90,"temporaryChats":"private"},
     "git":{"authorName":"","authorEmail":""},"memory":{"searchChats":true,"generate":true,"sensitive":false},"ssh":{"connections":[]},"whatsNew":{"seen":null,"from":null},
     "shortcuts":{"search":"Mod+Shift+K","report-issue":null},"connectors":[],"dictation":{"language":"de","holdToRecord":true},"plugins":{"enabled":{}}}
    """#)

    private static let blank: JSON = json(#"{"appearance":{"theme":"system","chatFont":"serif","textSize":"m","transcriptWidth":"medium","motion":"system"},"remoteControl":true,"callMe":"","notifications":{"taskFinished":true,"permissionNeeded":true},"personalization":{"instructions":"","responseStyle":"default","personality":{"selected":"atelier","customModes":[]},"atelierMd":""},"models":{},"privacy":{"historyRetentionDays":null,"temporaryChats":"private"},"memory":{"searchChats":true,"generate":true,"sensitive":false},"shortcuts":{},"dictation":{"language":"auto","holdToRecord":true}}"#)

    private static func path(_ params: [String: JSON]) -> [String] { params["path"]?.array.map(\.string) ?? [] }

    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        if state == "error", method != "prefs.set" { throw MobileError.message("Couldn't reach your server. Check your connection and try again.") }
        if state == "unsupported", method != "prefs.get" { throw MobileError.message("Unknown method \(method)") }
        if let result = try respondAccount(method, params) { return result }
        if let result = try respondPrefs(method, params) { return result }
        return try respondData(method, params)
    }

    // MARK: Preferences and the server's settings

    private static func respondPrefs(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        switch method {
        case "prefs.get":
            if state == "empty" && prefs == defaultPrefs { prefs = blank }
            return prefs
        case "prefs.set":
            if state == "readonly" { throw MobileError.message("appearance.theme: not a preference") }
            prefs = prefs.personalSetting(params["value"] ?? .null, at: path(params)); return prefs
        case "prefs.reset":
            prefs = prefs.personalSetting(blank.personalValue(at: path(params)), at: path(params)); return prefs
        case "settings.get":
            let base = json(#"""
            {"effective":{"providers":[{"id":"anthropic","type":"anthropic","name":"Anthropic","enabled":true},{"id":"ollama","type":"ollama","name":"Ollama (home server)","enabled":true},{"id":"mistral","type":"mistral","name":"Mistral","enabled":true},{"id":"vibe","type":"mistral-vibe","name":"Mistral Vibe","enabled":true},{"id":"chatgpt","type":"chatgpt","name":"ChatGPT Plan","enabled":true}],
              "models":{"defaults":{"chat":"anthropic/opus","image":"comfy/flux"},"aliases":{},"overrides":{}},
              "imageProviders":[{"id":"comfy","name":"ComfyUI (studio)"},{"id":"eleven","name":"ElevenLabs"}],
              "imageGeneration":{"enabled":true,"maxImagesPerTurn":8,"videoEnabled":true,"maxVideosPerTurn":2},"dictation":{"enabled":true},
              "safeguards":{"enabled":true,"categories":{"sexual":true,"hate":false,"harassment":true,"selfHarm":true},"profile":"adult","crisisResources":""},
              "memory":{"manualEditing":true},"reports":{"enabled":true}},"origins":{},"projectRoot":null,"errors":[]}
            """#)
            return base.setting("effective", base["effective"].setting("pricing", pricing))
        case "imageModels.list":
            if state == "empty" { return [] }
            return json(#"""
            [{"ref":"comfy/flux","providerId":"comfy","modelId":"flux","displayName":"FLUX.1 dev","capabilities":{"family":"flux","promptStyle":"natural"},"source":"detected","hidden":false,"favorite":false,"order":1},
             {"ref":"comfy/sdxl","providerId":"comfy","modelId":"sdxl","displayName":"SDXL Turbo","capabilities":{"family":"sdxl","promptStyle":"natural"},"source":"detected","hidden":false,"favorite":false,"order":2},
             {"ref":"comfy/wan","providerId":"comfy","modelId":"wan","displayName":"Wan 2.2","capabilities":{"output":"video","family":"wan","promptStyle":"natural"},"source":"detected","hidden":false,"favorite":false,"order":3},
             {"ref":"eleven/tts","providerId":"eleven","modelId":"tts","displayName":"Eleven Multilingual","capabilities":{"output":"audio","audio":{"kinds":["speech"]},"family":"hosted","promptStyle":"natural"},"source":"catalog","hidden":false,"favorite":false,"order":4}]
            """#)
        case "dictation.status":
            return json(#"{"enabled":true,"source":{"id":"builtin","label":"Nemotron 3.5 ASR","provider":"Atelier, on this server","live":true},"sources":[{"id":"text:mistral:voxtral","label":"Voxtral Realtime","provider":"Mistral","live":true},{"id":"text:openai:whisper","label":"Whisper","provider":"OpenAI","live":false}],"chosen":null,"builtin":{"state":"missing","bytes":716286037}}"#)
        case "dictation.prepare":
            return json(#"{"enabled":true,"source":null,"sources":[],"chosen":null,"builtin":{"state":"downloading","received":214000000,"total":716286037}}"#)
        case "settings.set", "settings.reset":
            if params["path"] == ["pricing"], let value = params["value"] { pricing = value }
            return json(#"{"ok":true}"#)
        default: return nil
        }
    }

    // MARK: Account

    private static func respondAccount(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        switch method {
        case "account.get":
            if account == nil {
                account = json(#"{"id":"u1","username":"philipp","name":"Philipp Buss","role":"admin","avatar":null,"mustChangePassword":false,"hasPassword":true,"disabled":false,"safeguards":"inherit","createdAt":1700000000000,"lastActiveAt":1700000000000}"#)
                if state == "mustchange" { account = account?.setting("mustChangePassword", .bool(true)) }
            }
            return account
        case "account.update":
            if let name = params["name"] { account = account?.setting("name", name) }
            if let avatar = params["avatar"] { account = account?.setting("avatar", avatar) }
            return account
        case "account.changePassword":
            if params["current"]?.string == "wrong" { throw MobileError.message("The current password is wrong.") }
            return json(#"{"ok":true}"#)
        case "account.sessions":
            if sessions == nil { sessions = makeSessions() }
            return .array(sessions ?? [])
        case "account.revokeSession":
            sessions?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "account.devices":
            if devices == nil { devices = makeDevices() }
            return .array(devices ?? [])
        case "account.removeDevice":
            devices?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "account.passkeys":
            if passkeys == nil { passkeys = state == "empty" ? [] : [
                .obj(["id": "k1", "name": "iPhone (Face ID)", "createdAt": ago(40 * 86400), "lastUsedAt": ago(3 * 3600)]),
                .obj(["id": "k2", "name": "YubiKey 5C", "createdAt": ago(200 * 86400), "lastUsedAt": .null]),
            ] }
            return .array(passkeys ?? [])
        case "account.removePasskey":
            passkeys?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "account.identities":
            if identities == nil { identities = state == "empty" ? json(#"{"connected":[],"available":[]}"#) : json(#"{"connected":[{"id":"i1","providerId":"authentik","provider":"Authentik","label":"philipp@studio.example.com","createdAt":1700000000000,"lastUsedAt":1700500000000}],"available":[{"id":"google","name":"Google"}]}"#) }
            return identities
        case "account.removeIdentity":
            identities = identities?.setting("connected", .array(identities?["connected"].array.filter { $0["id"] != params["id"] } ?? [])); return json(#"{"ok":true}"#)
        case "account.logoutEverywhere": return json(#"{"ok":true}"#)
        case "files.upload": return json(#"{"blob":"\#(String(repeating: "a", count: 64))","name":"profile.jpg","mime":"image/jpeg","size":1000}"#)
        case "auth.terminalRequest":
            let code = params["code"]?.string ?? "K7QF-3MZD"
            if code.uppercased().hasPrefix("ZZZZ") { throw MobileError.message("No terminal is waiting with this code. It may have expired: start the sign-in in the terminal again.") }
            return .obj(["code": .string(code), "deviceName": "studio-mac", "platform": "darwin", "ip": "192.168.1.24", "createdAt": ago(95), "expiresAt": .number((Date.now.timeIntervalSince1970 + 500) * 1000)])
        case "auth.terminalDecide": return json(#"{"ok":true}"#)
        default: return nil
        }
    }

    private static func makeSessions() -> [JSON] {
        var list: [JSON] = [
            .obj(["id": "s1", "clientKind": "mobile", "userAgent": "Atelier Mobile iOS", "ip": "192.168.1.40", "createdAt": ago(2 * 86400), "lastSeenAt": ago(10), "current": true]),
            .obj(["id": "s2", "clientKind": "web", "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "ip": "192.168.1.24", "createdAt": ago(9 * 86400), "lastSeenAt": ago(3600), "current": false]),
            .obj(["id": "s3", "clientKind": "desktop", "userAgent": "Atelier/0.10.1 Electron/41 darwin", "ip": "192.168.1.24", "createdAt": ago(30 * 86400), "lastSeenAt": ago(120), "current": false]),
            .obj(["id": "s4", "clientKind": "cli", "userAgent": "atelier-cli/0.6.0 linux", "ip": "10.0.0.7", "createdAt": ago(3 * 86400), "lastSeenAt": ago(86400), "current": false]),
        ]
        if state == "long" { for i in 0..<8 { list.append(.obj(["id": .string("x\(i)"), "clientKind": "web", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0 Safari/537.36 Edg/142.0", "ip": .string("203.0.113.\(i)"), "createdAt": ago(Double(i + 4) * 86400), "lastSeenAt": ago(Double(i + 1) * 7200), "current": false])) } }
        return list
    }

    private static func makeDevices() -> [JSON] {
        if state == "empty" { return [] }
        var list: [JSON] = [
            .obj(["id": "d1", "name": "Philipp's MacBook Pro", "platform": "darwin", "createdAt": ago(60 * 86400), "lastSeenAt": ago(30), "current": false, "online": true]),
            .obj(["id": "d2", "name": "Studio Windows PC with a very long machine name that keeps going", "platform": "win32", "createdAt": ago(120 * 86400), "lastSeenAt": ago(5 * 86400), "current": false, "online": false]),
        ]
        if state == "long" { for i in 0..<6 { list.append(.obj(["id": .string("dv\(i)"), "name": .string("Build machine \(i + 1)"), "platform": "linux", "createdAt": ago(Double(i + 5) * 86400), "lastSeenAt": ago(Double(i + 1) * 3600), "current": false, "online": .bool(i % 2 == 0)])) } }
        return list
    }

    // MARK: The other pages

    nonisolated(unsafe) private static var memory: [JSON]?
    nonisolated(unsafe) private static var providers: [JSON]?
    nonisolated(unsafe) private static var imageServers: [JSON]?

    private static func adminOnly() throws { if Launch.role == "user" { throw MobileError.message("Only admins can do this.") } }

    private static func respondData(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        switch method {
        case "privacy.export": return json(#"{"sha256":"\#(String(repeating: "b", count: 64))","name":"atelier-export-2026-11-17.zip"}"#)
        case "privacy.deleteConversations": return json(#"{"deleted":12}"#)
        case "memory.list": return .obj(["entries": .array(entries())])
        case "memory.get": return entries().first { $0["id"] == params["id"] } ?? .null
        case "memory.delete": memory?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "memory.update":
            if let id = params["id"], var list = memory, let index = list.firstIndex(where: { $0["id"] == id }) {
                for key in ["title", "summary", "details"] { if let value = params[key] { list[index] = list[index].setting(key, value) } }
                list[index] = list[index].setting("updatedAt", ago(5))
                memory = list
                return list[index]
            }
            return json(#"{"id":"new","section":"preferences","title":"Preferences","summary":"","details":"","projectId":null,"sensitive":false,"source":"settings","sourceSessionId":null,"createdAt":1,"updatedAt":1}"#)
        case "memory.instruct":
            let new = memoryEntry("m-\(entries().count + 1)", "topic", "Beans the dog", "Your dog, a two-year-old terrier", "- Beans is a terrier\n- Likes long walks", nil, 5)
            memory = entries() + [new]
            return .obj(["changes": .array([.obj(["op": "created", "id": new["id"], "title": new["title"], "section": "topic"])])])
        case "memory.import":
            return .obj(["changes": .array([.obj(["op": "created", "id": "i1", "title": "Career", "section": "profile"]), .obj(["op": "updated", "id": "profile", "title": "Profile", "section": "profile"])])])
        case "usage.summary": return .array(usageRows(days: params["days"]?.int ?? 30))
        case "stats.summary": return stats(mode: params["mode"]?.string ?? "chat", days: params["days"]?.intOrNil)
        case "limits.mine": return limits()
        case "chatgpt.status":
            try adminOnly()
            return json(#"{"available":true,"signedIn":true,"signingIn":false,"email":"phil@example.com","plan":"plus","limits":{"primary":{"usedPercent":62,"windowMinutes":300,"resetsAt":\#(Int(Date.now.timeIntervalSince1970 * 1000) + 5_400_000)},"secondary":{"usedPercent":18,"windowMinutes":10080,"resetsAt":\#(Int(Date.now.timeIntervalSince1970 * 1000) + 400_000_000)}}}"#)
        case "providers.planUsage":
            try adminOnly()
            return json(#"{"usedPercent":93,"resetsAt":\#(Int(Date.now.timeIntervalSince1970 * 1000) + 900_000_000),"plan":"Le Chat Pro","overage":true}"#)
        case "personalProviders.list":
            if providers == nil { providers = makeProviders() }
            return .array(providers ?? [])
        case "personalImageProviders.list":
            if imageServers == nil { imageServers = makeImageServers() }
            return .array(imageServers ?? [])
        case "personalProviders.refresh", "personalImageProviders.refresh": return json("[]")
        case "personalProviders.save":
            if var list = providers, let index = list.firstIndex(where: { $0["id"] == params["id"] }) {
                for (k, v) in params { list[index] = v == .null ? list[index] : list[index].setting(k, v) }
                providers = list
                return list[index]
            }
            return .null
        case "personalImageProviders.save":
            if var list = imageServers, let index = list.firstIndex(where: { $0["id"] == params["id"] }) {
                for (k, v) in params { list[index] = v == .null ? list[index] : list[index].setting(k, v) }
                imageServers = list
                return list[index]
            }
            return .null
        case "personalProviders.remove": providers?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "personalImageProviders.remove": imageServers?.removeAll { $0["id"] == params["id"] }; return json(#"{"ok":true}"#)
        case "reports.prepare":
            let chat = params["chatSessionId"] == nil || params["chatSessionId"] == .null ? "null" : #"{"session":{"mode":"chat","title":"Launch plan for 0.11","status":"idle","createdAt":1,"updatedAt":2},"coverage":{"total":42,"included":30,"omitted":[{"from":10,"to":21}],"shortened":2},"messages":[{"index":0,"role":"user","kind":"normal","createdAt":1,"parts":[{"type":"text","text":"Plan the week"}]}]}"#
            return json(#"{"diagnostics":{"collectedAt":1794909016146,"backend":{"kind":"server","os":{"platform":"linux","name":"Ubuntu 24.04.3 LTS","arch":"x64"},"hardware":{"cpu":{"model":"AMD EPYC","cores":8},"memory":{"totalBytes":16000000000}},"runtime":{"node":"v26.9.0"},"container":true},"providers":[{"type":"anthropic","host":"api.anthropic.com","enabled":true,"keySet":true},{"type":"ollama","host":"private network","enabled":true,"keySet":false,"status":{"ok":true,"modelCount":6}}],"notes":{"update channel":"stable"}},"chat":\#(chat)}"#)
        case "reports.submit": return json(#"{"id":"I-7F3K2Q","receivedAt":1794909016146}"#)
        default: return nil
        }
    }

    // MARK: Canned data

    private static func memoryEntry(_ id: String, _ section: String, _ title: String, _ summary: String, _ details: String, _ project: String?, _ minutes: Double) -> JSON {
        .obj(["id": .string(id), "section": .string(section), "title": .string(title), "summary": .string(summary), "details": .string(details), "projectId": project.map { .string($0) } ?? .null,
              "sensitive": false, "source": "chat", "sourceSessionId": .null, "createdAt": ago(minutes * 120), "updatedAt": ago(minutes * 60)])
    }

    private static func entries() -> [JSON] {
        if let memory { return memory }
        var list: [JSON] = []
        if state != "empty" {
            list = [
                memoryEntry("e1", "preferences", "Preferences", "How Phil wants Atelier to respond", "- Keep lists under five things\n- Answer in German when asked in German\n- Code first, then a short explanation", nil, 240),
                memoryEntry("e2", "profile", "Profile", "Who Phil is", "- Lives in Hamburg\n- Works as a developer\n- Speaks German and English", nil, 4000),
                memoryEntry("e3", "topic", "Sourdough baking", "Weekly bakes, a rye starter named Rudi", "- Bakes on Saturdays\n- Starter is 14 months old", nil, 3000),
                memoryEntry("e4", "topic", "Learning Japanese", "N5 level, uses an app daily", "- Started in March 2026", nil, 9000),
                memoryEntry("e5", "area", "Atelier iOS app", "The native app he builds with a team of agents", "- Targets iOS 26\n- Settings parity with the desktop is the current goal", nil, 60),
                memoryEntry("e6", "person", "Anna", "Colleague, plans the offsite", "- Likes oat milk\n- Birthday on June 3", nil, 700),
                memoryEntry("e7", "person", "Beans", "His dog", "- Two years old", nil, 80),
                memoryEntry("e8", "project", "Release checklist", "Steps for a release", "- Run the rehearsal first", "p1", 45),
                memoryEntry("e9", "project", "Launch date", "The date is the 24th", "- Announce a day before", "p1", 100),
                memoryEntry("e10", "project", "Server rack", "A 12U rack with a UPS", "- Fans are loud", "p2", 1500),
            ]
            if state == "long" {
                list[2] = memoryEntry("e3", "topic", "A long title about sourdough baking and everything that goes with it every week at the weekend", "A very long summary that goes on and on to see how the row wraps on a narrow phone screen and still reads well at larger text sizes", "- Bakes on Saturdays", nil, 3000)
                for i in 0..<12 { list.append(memoryEntry("l\(i)", "topic", "Topic number \(i + 1)", "Something Atelier learned about topic \(i + 1)", "- Fact", nil, Double(i + 10) * 30)) }
            }
        }
        memory = list
        return list
    }

    private static func makeProviders() -> [JSON] {
        if state == "empty" { return [] }
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        var list: [JSON] = [
            json(#"{"id":"u-abc1234567","type":"ollama","name":"Ollama on the MacBook","baseUrl":"http://localhost:11434","enabled":true,"deviceId":"d1","deviceName":"Philipp's MacBook Pro","online":true,"hasKey":false,"status":{"providerId":"u-abc1234567","ok":true,"latencyMs":42,"version":"0.12.3","modelCount":6,"warnings":[],"checkedAt":\#(now - 120000)},"createdAt":1700000000000}"#),
            json(#"{"id":"u-def2345678","type":"llamacpp","name":"llama.cpp (studio)","baseUrl":"http://192.168.1.50:8080","enabled":true,"deviceId":"d2","deviceName":"Studio Windows PC with a very long machine name that keeps going","online":false,"hasKey":false,"createdAt":1700000000000}"#),
            json(#"{"id":"u-ghi3456789","type":"openai-compatible","name":"LM Studio","baseUrl":"http://localhost:1234/v1","enabled":true,"deviceId":"d1","deviceName":"Philipp's MacBook Pro","online":true,"hasKey":true,"status":{"providerId":"u-ghi3456789","ok":false,"latencyMs":null,"modelCount":0,"warnings":[],"error":"Connection refused: nothing answers on that port.","checkedAt":\#(now - 60000)},"createdAt":1700000000000}"#),
            json(#"{"id":"u-jkl4567890","type":"chatgpt-chat","name":"ChatGPT Chat","baseUrl":"https://chatgpt.com","enabled":false,"deviceId":"d1","deviceName":"Philipp's MacBook Pro","online":true,"hasKey":false,"createdAt":1700000000000}"#),
        ]
        if state == "long" { for i in 0..<5 { list.append(json(#"{"id":"u-x\#(i)00000000","type":"ollama","name":"Ollama box \#(i + 1)","baseUrl":"http://10.0.0.\#(i + 10):11434","enabled":true,"deviceId":"d1","deviceName":"Lab machine \#(i + 1)","online":true,"hasKey":false,"createdAt":1}"#)) } }
        return list
    }

    private static func makeImageServers() -> [JSON] {
        if state == "empty" { return [] }
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        return [json(#"{"id":"u-img1234567","type":"comfyui","preset":"comfyui","name":"ComfyUI (studio)","baseUrl":"http://127.0.0.1:8188","enabled":true,"deviceId":"d1","deviceName":"Philipp's MacBook Pro","online":true,"hasKey":false,"status":{"providerId":"u-img1234567","ok":true,"latencyMs":80,"modelCount":9,"warnings":[],"checkedAt":\#(now - 300000)},"createdAt":1}"#)]
    }

    private static func usageRows(days: Int) -> [JSON] {
        if state == "empty" { return [] }
        var rows: [JSON] = []
        let models: [(String, String, String, Double, Double)] = [("anthropic", "opus", "chat", 38_000, 0.42), ("anthropic", "sonnet", "chat", 21_000, 0.09), ("ollama", "qwen3", "code", 54_000, 0), ("mistral", "large", "chat", 8_000, 0.03)]
        for offset in 0..<days where offset % 2 == 0 || state == "long" {
            let date = Calendar.current.date(byAdding: .day, value: -offset, to: .now) ?? .now
            let day = localDay(date)
            for (index, m) in models.enumerated() where (offset + index) % 3 != 1 {
                let scale = 0.4 + Double((offset * 7 + index * 3) % 10) / 10
                let input = Int(m.3 * scale), output = Int(m.3 * scale / 4)
                rows.append(.obj(["day": .string(day), "providerId": .string(m.0), "modelId": .string(m.1), "mode": .string(m.2), "requests": .number(Double(3 + (offset + index) % 5)), "input": .number(Double(input)), "output": .number(Double(output)),
                                  "cacheRead": .number(Double(input / 3)), "cacheWrite": 0, "reasoning": 0, "costUsd": m.4 == 0 ? .null : .number(m.4 * scale), "unpriced": m.4 == 0 ? .number(3) : 0, "tokensPerSecond": m.4 == 0 ? .number(31) : .number(78), "timed": 3]))
            }
        }
        rows.append(.obj(["day": .string(localDay(.now)), "providerId": "comfy", "modelId": "flux", "mode": "chat", "requests": 5, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "costUsd": .null, "unpriced": 0, "images": 14, "tokensPerSecond": .null, "timed": 0]))
        rows.append(.obj(["day": .string(localDay(.now)), "providerId": "comfy", "modelId": "wan", "mode": "chat", "requests": 2, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "costUsd": .number(0.8), "estimatedUsd": .number(0.8), "unpriced": 0, "videos": 2, "videoSeconds": 12, "tokensPerSecond": .null, "timed": 0]))
        rows.append(.obj(["day": .string(localDay(.now)), "providerId": "eleven", "modelId": "tts", "mode": "chat", "requests": 3, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "costUsd": .number(0.12), "unpriced": 0, "audios": 3, "audioSeconds": 95, "audioChars": 1800, "tokensPerSecond": .null, "timed": 0]))
        return rows
    }

    private static func localDay(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func stats(mode: String, days: Int?) -> JSON {
        if state == "empty" { return json(#"{"sessions":0,"messages":0,"activeDays":0,"tokens":0,"peakHour":null,"favoriteModel":null,"days":[],"models":[]}"#) }
        var cells: [JSON] = []
        for offset in 0..<180 where (offset * 37 + (mode == "code" ? 11 : 0)) % 5 < 3 {
            let date = Calendar.current.date(byAdding: .day, value: -offset, to: .now) ?? .now
            cells.append(.obj(["day": .string(localDay(date)), "sessions": .number(Double(1 + offset % 3)), "messages": .number(Double(2 + (offset * 13) % 40))]))
        }
        return .obj(["sessions": mode == "code" ? 18 : 64, "messages": mode == "code" ? 410 : 1280, "tokens": mode == "code" ? 3_200_000 : 1_850_000, "activeDays": 41, "peakHour": 15, "favoriteModel": "anthropic/opus", "days": .array(cells),
                     "models": json(#"[{"ref":"anthropic/opus","tokens":900000,"requests":120}]"#)])
    }

    private static func limits() -> JSON {
        if state == "empty" { return json(#"{"exempt":false,"rows":[],"unpriced":0}"#) }
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        return json(#"{"exempt":false,"unpriced":14,"rows":[{"key":"tokensPerDay","used":412000,"max":1000000,"resetsAt":\#(now + 10_800_000),"reached":false,"near":false},{"key":"costUsdPer30Days","used":4.1,"max":5,"resetsAt":\#(now + 86_400_000 * 6),"reached":false,"near":true},{"key":"requestsPerHour","used":30,"max":30,"resetsAt":\#(now + 1_200_000),"reached":true,"near":true}]}"#)
    }
}
#endif
