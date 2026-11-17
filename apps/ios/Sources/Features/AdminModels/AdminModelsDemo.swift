import SwiftUI

#if DEBUG
/// Canned answers for `--demo` screens of this area, in the shapes the server really sends.
/// `--state empty|error|forbidden|offline|long|busy` shows each state of every page; changes made on screen are kept
/// for the run, so saving, removing and switching things can be tried without a server.
enum AdminModelsDemo {
    /// The demo's own world, edited by the calls it answers. Only the main thread touches it (calls arrive from `Connection.call`).
    nonisolated(unsafe) private static var world = AMDemoWorld(state: Launch.value("--state") ?? "")

    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        try world.respond(method, params)
    }
}

final class AMDemoWorld {
    let state: String
    var settings: JSON
    var statuses: [JSON]
    var secrets: [JSON]
    var mediaStatuses: [JSON] = []
    var savedWorkflows: [JSON] = []
    /// A sign-in is open (set by `signIn`, so `status` can answer while it waits).
    var signingIn = false

    init(state: String) {
        self.state = state
        let empty = state == "empty"
        let long = state == "long"
        var providers = empty ? [] : AMDemoData.providers
        if long { providers += AMDemoData.extraProviders }
        statuses = empty ? [] : AMDemoData.statuses + (long ? AMDemoData.extraStatuses : [])
        secrets = empty ? [] : AMDemoData.secrets
        mediaStatuses = empty ? [] : AMDemoMedia.statuses
        settings = AMDemoData.settings(providers: providers, empty: empty, long: long)
    }

    func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        let handled = AMDemoData.handles(method)
        guard handled else { return nil }
        switch state {
        case "error": throw MobileError.message("The server answered with an error (500). Try again in a moment.")
        case "forbidden": throw MobileError.message("Only admins can do this.")
        case "offline": throw MobileError.message("Not connected. Your draft is kept; reconnect before sending.")
        case "unsupported": throw MobileError.message("Unknown method \(method)")
        default: break
        }
        return try AMDemoData.respond(self, method, params)
    }

    // MARK: Settings

    func setSetting(_ path: [JSON], _ value: JSON?) {
        settings = settings.replacing(["effective"] + path[...], with: value)
    }

    var effective: JSON { settings["effective"] }
    var providers: [JSON] { effective["providers"].array }
    func setProviders(_ list: [JSON]) { settings = settings.replacing(["effective", "providers"], with: .array(list)) }

    func providerStatus(_ id: String) -> JSON? { statuses.first { $0["providerId"].string == id } }
    func setStatus(_ status: JSON) {
        statuses.removeAll { $0["providerId"] == status["providerId"] }
        statuses.append(status)
    }
}

/// The fixtures and the answers. Kept apart from the world so the cases read like the server's procedures.
enum AMDemoData {
    static let methods: Set<String> = [
        "settings.get", "settings.set", "settings.reset", "providers.status", "providers.detect", "providers.test", "providers.save", "providers.remove",
        "providers.refresh", "providers.planUsage", "models.list", "models.probeTools", "secrets.list", "secrets.set", "secrets.delete",
        "chatgpt.status", "chatgpt.signIn", "chatgpt.cancel", "copilot.status", "copilot.signIn", "copilot.cancel",
        "openrouter.connect", "openrouter.status", "openrouter.cancel",
        "search.status", "search.test", "dictation.status", "dictation.prepare",
    ]
    static func handles(_ method: String) -> Bool { methods.contains(method) || AMDemoMedia.handles(method) }

    static func now(_ secondsAgo: Double = 0) -> JSON { .number((Date.now.timeIntervalSince1970 - secondsAgo) * 1000) }

    // MARK: Providers

    static let providers: [JSON] = [
        ["id": "anthropic", "type": "anthropic", "name": "Anthropic", "baseUrl": "https://api.anthropic.com", "apiKey": "${secret:provider-anthropic}", "headers": [:], "enabled": true],
        ["id": "ollama", "type": "ollama", "name": "Ollama (home server)", "baseUrl": "http://192.168.1.20:11434", "headers": [:], "enabled": true, "vramGiB": 22.35, "parallelRequests": 2, "modelsAtOnce": 1],
        ["id": "openai", "type": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com", "apiKey": "${secret:provider-openai}", "headers": [:], "enabled": true],
        ["id": "mistral", "type": "mistral", "name": "Mistral", "baseUrl": "https://api.mistral.ai", "apiKey": "${secret:provider-mistral}", "headers": [:], "enabled": true],
        ["id": "chatgpt", "type": "chatgpt", "name": "ChatGPT Plan", "baseUrl": "https://chatgpt.com/backend-api/codex", "headers": [:], "enabled": true],
        ["id": "copilot", "type": "copilot", "name": "GitHub Copilot", "baseUrl": "https://api.githubcopilot.com", "headers": [:], "enabled": true],
        ["id": "openrouter", "type": "openai-compatible", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "${secret:provider-openrouter}", "headers": ["HTTP-Referer": "https://atelier.example.com"], "enabled": true],
        ["id": "llamacpp", "type": "llamacpp", "name": "llama.cpp (workstation)", "baseUrl": "http://192.168.1.31:8080", "headers": [:], "enabled": false],
    ]
    static let extraProviders: [JSON] = [
        ["id": "vibe", "type": "mistral-vibe", "name": "Mistral Vibe with a very long name for the whole design team in Lisbon", "baseUrl": "https://api.mistral.ai", "apiKey": "${secret:provider-vibe}", "headers": [:], "enabled": true],
        ["id": "lmstudio", "type": "openai-compatible", "name": "LM Studio on the studio machine next to the printer", "baseUrl": "http://studio-machine-with-a-long-host-name.local:1234/v1", "headers": [:], "enabled": true],
    ]
    static let statuses: [JSON] = [
        ["providerId": "anthropic", "ok": true, "latencyMs": 212, "modelCount": 14, "warnings": [], "checkedAt": now(120)],
        ["providerId": "ollama", "ok": true, "latencyMs": 8, "version": "0.12.3", "modelCount": 9, "warnings": [], "checkedAt": now(60), "queue": ["parallel": 1, "modelsAtOnce": 1]],
        ["providerId": "openai", "ok": false, "latencyMs": nil, "modelCount": 0, "warnings": [], "error": "OpenAI rejected the key (401). Check it at platform.openai.com/api-keys.", "checkedAt": now(300)],
        ["providerId": "mistral", "ok": true, "latencyMs": 340, "modelCount": 21, "warnings": ["Mistral's free plan limits requests to one a second. Long tasks may be slow."], "checkedAt": now(90)],
        ["providerId": "chatgpt", "ok": true, "latencyMs": 480, "modelCount": 6, "warnings": [], "checkedAt": now(200)],
        ["providerId": "copilot", "ok": true, "latencyMs": 390, "modelCount": 11, "warnings": [], "checkedAt": now(220)],
        ["providerId": "openrouter", "ok": true, "latencyMs": 270, "modelCount": 312, "warnings": [], "checkedAt": now(400)],
        ["providerId": "llamacpp", "ok": false, "latencyMs": nil, "modelCount": 0, "warnings": [], "checkedAt": 0],
    ]
    static let extraStatuses: [JSON] = [
        ["providerId": "vibe", "ok": true, "latencyMs": 1480, "modelCount": 5, "warnings": [], "checkedAt": now(100)],
        ["providerId": "lmstudio", "ok": false, "modelCount": 0, "warnings": [], "error": "Could not reach studio-machine-with-a-long-host-name.local:1234. Is the server running, and is it on the same network as this server?", "checkedAt": now(100)],
    ]
    static let secrets: [JSON] = [
        ["id": "provider-anthropic", "label": "Anthropic API key", "kind": "api_key", "masked": "••••3f9a", "usedBy": ["providers.anthropic.apiKey"], "createdAt": now(86400 * 40), "rotatedAt": now(86400 * 6), "lastUsedAt": now(300)],
        ["id": "provider-openai", "label": "OpenAI API key", "kind": "api_key", "masked": "••••b7c1", "usedBy": ["providers.openai.apiKey"], "createdAt": now(86400 * 38), "rotatedAt": nil, "lastUsedAt": now(86400 * 2)],
        ["id": "provider-mistral", "label": "Mistral API key", "kind": "api_key", "masked": "••••19de", "usedBy": ["providers.mistral.apiKey"], "createdAt": now(86400 * 12), "rotatedAt": nil, "lastUsedAt": now(3600)],
        ["id": "provider-openrouter", "label": "OpenRouter API key", "kind": "api_key", "masked": "••••55aa", "usedBy": ["providers.openrouter.apiKey"], "createdAt": now(86400 * 9), "rotatedAt": nil, "lastUsedAt": now(7200)],
        ["id": "web-search-brave", "label": "Brave Search API key", "kind": "api_key", "masked": "••••90fe", "usedBy": ["capabilities.webSearch.apiKey"], "createdAt": now(86400 * 3), "rotatedAt": nil, "lastUsedAt": nil],
        ["id": "github-token", "label": "GitHub token for the docs connector", "kind": "token", "masked": "••••d204", "usedBy": ["mcpServers.github.headers.Authorization", "mcpServers.docs.env.TOKEN"], "createdAt": now(86400 * 90), "rotatedAt": now(86400 * 20), "lastUsedAt": now(86400)],
        ["id": "old-staging-key", "label": "Old staging key", "kind": "api_key", "masked": "••••0001", "usedBy": [], "createdAt": now(86400 * 200), "rotatedAt": nil, "lastUsedAt": nil],
    ]

    // MARK: Settings

    static func settings(providers: [JSON], empty: Bool, long: Bool) -> JSON {
        var overrides: [String: JSON] = [:]
        if !empty {
            overrides["anthropic/opus"] = ["displayName": "Opus 5.5", "favorite": true]
            overrides["ollama/qwen3:30b"] = ["contextLength": 65536, "toolCalling": "prompted"]
            overrides["ollama/llama3.2:3b"] = ["hidden": true]
            overrides["openai/gpt-5-custom"] = ["manual": true]
        }
        return ["effective": [
            "providers": .array(providers),
            "models": ["defaults": empty ? [:] : ["chat": "anthropic/opus", "small": "anthropic/haiku", "image": "openai-images/gpt-image-1"], "aliases": empty ? [:] : ["opus": "anthropic/opus"], "overrides": .object(overrides)],
            "capabilities": ["webSearch": ["enabled": true, "provider": "auto"], "webFetch": true, "webFetchPrivateNetworks": false, "unifiedChat": false],
            "imageProviders": .array(empty ? [] : AMDemoMedia.providers),
            "imageModels": ["overrides": empty ? [:] : ["comfyui/sdxl-turbo": ["favorite": true], "openai-images/gpt-image-1": ["description": "Posters and anything with text in it."]]],
            "imageGeneration": ["enabled": true, "maxImagesPerTurn": 8, "videoEnabled": true, "maxVideosPerTurn": 2, "maxImagesPerUserPerDay": 40, "audioEnabled": true, "maxAudioPerTurn": 6],
            "dictation": ["enabled": true],
            "prompts": ["organizationInstructions": .string(long ? String(repeating: "We are Acme Gardens, a nursery in Leeds. Answer in British English and give prices in pounds. ", count: 12) : empty ? "" : "We are Acme Gardens, a nursery in Leeds. Answer in British English and give prices in pounds.")],
            "safeguards": ["enabled": false, "categories": ["sexual": true, "hate": true, "harassment": false, "selfHarm": false], "profile": "adult", "crisisResources": ""],
            "memory": ["manualEditing": false],
        ], "origins": [:], "projectRoot": nil, "errors": []]
    }

    // MARK: Models

    static func model(_ ref: String, _ name: String, context: Int, output: Int = 8192, tools: String = "native", vision: Bool = false, reasoning: String = "none", free: Bool = false, hidden: Bool = false, favorite: Bool = false, manual: Bool = false, efforts: [String]? = nil, source: String = "detected") -> JSON {
        let parts = ref.split(separator: "/", maxSplits: 1).map(String.init)
        var json: [String: JSON] = [
            "ref": .string(ref), "providerId": .string(parts[0]), "modelId": .string(parts[1]), "displayName": .string(name),
            "contextLength": .number(Double(context)), "maxOutput": .number(Double(output)),
            "capabilities": ["tools": .string(tools), "vision": .bool(vision), "pdf": .bool(vision), "reasoning": .string(reasoning), "caching": false],
            "tier": .string(context < 40_000 ? "compact" : "full"), "source": .string(source), "hidden": .bool(hidden), "favorite": .bool(favorite), "order": 1000,
        ]
        if free { json["free"] = true }
        if manual { json["manual"] = true }
        if let efforts { json["effortLevels"] = .array(efforts.map { .string($0) }); json["recommendedEffort"] = ["chat": "medium", "work": "high", "code": "high"] }
        return .object(json)
    }

    static func models(_ world: AMDemoWorld) -> [JSON] {
        if world.state == "empty" { return [] }
        let overrides = world.effective["models"]["overrides"]
        var list: [JSON] = [
            model("anthropic/opus", "Opus 5.5", context: 1_000_000, output: 64000, vision: true, reasoning: "effort", favorite: true, efforts: ["low", "medium", "high", "xhigh", "max"]),
            model("anthropic/sonnet", "Sonnet 5.5", context: 1_000_000, output: 64000, vision: true, reasoning: "effort", efforts: ["low", "medium", "high"]),
            model("anthropic/haiku", "Haiku 5", context: 200_000, output: 32000, vision: true, reasoning: "toggle"),
            model("ollama/qwen3:30b", "qwen3:30b", context: 32768, tools: "native", reasoning: "toggle", source: "override"),
            model("ollama/llama3.2:3b", "llama3.2:3b", context: 8192, tools: "prompted", hidden: true),
            model("ollama/gemma3:27b", "gemma3:27b", context: 131072, vision: true),
            model("openai/gpt-5", "GPT-5", context: 400_000, output: 128_000, vision: true, reasoning: "effort", efforts: ["low", "medium", "high"], source: "catalog"),
            model("openai/gpt-5-custom", "gpt-5-custom", context: 32768, tools: "none", manual: true, source: "default"),
            model("mistral/large", "Mistral Large", context: 128_000, tools: "native"),
            model("openrouter/deepseek-chat:free", "DeepSeek Chat (free)", context: 65536, free: true),
            model("chatgpt/gpt-5-codex", "GPT-5 Codex", context: 272_000, vision: true, reasoning: "effort", efforts: ["low", "medium", "high"]),
            model("copilot/gpt-4.1", "GPT-4.1", context: 128_000, vision: true),
        ]
        if world.state == "long" {
            for n in 1...24 { list.append(model("openrouter/vendor-\(n)/model-with-a-rather-long-name-\(n):free", "Vendor \(n) Model with a rather long display name \(n)", context: 16384 * n, free: n % 3 == 0)) }
        }
        // Overrides the page changed show in the list, as the server applies them.
        return list.map { json in
            var model = json
            for (key, value) in overrides[json["ref"].string].entries {
                switch key {
                case "displayName": model = model.setting("displayName", value)
                case "hidden": model = model.setting("hidden", value)
                case "favorite": model = model.setting("favorite", value)
                case "contextLength": model = model.setting("contextLength", value)
                case "maxOutputTokens": model = model.setting("maxOutput", value)
                case "toolCalling": model = model.setting("capabilities", model["capabilities"].setting("tools", value))
                case "vision": model = model.setting("capabilities", model["capabilities"].setting("vision", value))
                case "promptTier": model = model.setting("tier", value)
                default: break
                }
            }
            return model
        }
    }

    // MARK: Answers

    static func respond(_ world: AMDemoWorld, _ method: String, _ params: [String: JSON]) throws -> JSON? {
        if let media = try AMDemoMedia.respond(world, method, params) { return media }
        switch method {
        case "settings.get": return world.settings
        case "settings.set":
            world.setSetting(params["path"]?.array ?? [], params["value"])
            return ["ok": true]
        case "settings.reset":
            world.setSetting(params["path"]?.array ?? [], nil)
            return ["ok": true]
        case "providers.status": return .array(world.statuses)
        case "providers.detect": return .array(world.state == "nodetect" ? [] : detected)
        case "providers.test":
            let id = params["id"]?.string ?? "x"
            if params["baseUrl"]?.string.contains("fail") == true { return ["status": ["providerId": .string(id), "ok": false, "latencyMs": nil, "modelCount": 0, "warnings": [], "error": "Could not reach that address. Is the server running, and can this server reach it?", "checkedAt": now()], "models": []] }
            return ["status": ["providerId": .string(id), "ok": true, "latencyMs": 41, "modelCount": 7, "warnings": [], "checkedAt": now()], "models": []]
        case "providers.save":
            var config: [String: JSON] = [:]
            for key in ["id", "type", "name", "baseUrl", "headers", "enabled", "vramGiB", "parallelRequests", "modelsAtOnce"] { if let value = params[key] { config[key] = value } }
            let id = params["id"]?.string ?? ""
            var list = world.providers
            if params["apiKey"] != nil || params["apiKeyFromEnv"] != nil { config["apiKey"] = .string("${secret:provider-\(id)}") }
            else if let existing = list.first(where: { $0["id"].string == id }), existing["apiKey"] != .null { config["apiKey"] = existing["apiKey"] }
            if let index = list.firstIndex(where: { $0["id"].string == id }) { list[index] = .object(config) } else { list.append(.object(config)) }
            world.setProviders(list)
            world.setStatus(["providerId": .string(id), "ok": true, "latencyMs": 55, "modelCount": 4, "warnings": [], "checkedAt": now()])
            return .object(config)
        case "providers.remove":
            let id = params["id"]?.string ?? ""
            world.setProviders(world.providers.filter { $0["id"].string != id })
            world.statuses.removeAll { $0["providerId"].string == id }
            return ["ok": true]
        case "providers.refresh":
            if let id = params["id"]?.string, var status = world.providerStatus(id) {
                if status["checkedAt"].doubleOrNil == 0 || id == "openai" { status = status.setting("checkedAt", now()) }
                else { status = status.setting("checkedAt", now()) }
                world.setStatus(status)
            }
            return .array(world.statuses)
        case "providers.planUsage": return ["usedPercent": 42, "resetsAt": now(-86400 * 11), "plan": "pro", "overage": false]
        case "models.list": return .array(models(world))
        case "models.probeTools":
            if params["ref"]?.string.contains("llama3") == true { return ["native": false, "detail": "llama3.2:3b ignored the tools it was given, so Atelier describes them in the prompt instead."] }
            return ["native": true, "detail": "Tool calling works natively on this model."]
        case "secrets.list": return .array(world.secrets)
        case "secrets.set":
            let id = params["id"]?.string ?? "secret"
            let value = params["value"]?.string ?? ""
            let existing = world.secrets.first { $0["id"].string == id }
            let item: JSON = ["id": .string(id), "label": params["label"] ?? .string(id), "kind": params["kind"] ?? "api_key", "masked": .string("••••" + String(value.suffix(4))), "usedBy": existing?["usedBy"] ?? [], "createdAt": existing?["createdAt"] ?? now(), "rotatedAt": existing == nil ? nil : now(), "lastUsedAt": existing?["lastUsedAt"] ?? nil]
            world.secrets.removeAll { $0["id"].string == id }
            world.secrets.append(item)
            return item
        case "secrets.delete":
            let id = params["id"]?.string ?? ""
            if let used = world.secrets.first(where: { $0["id"].string == id })?["usedBy"].array, !used.isEmpty { throw MobileError.message("This secret is still referenced in settings. Remove those references first.") }
            world.secrets.removeAll { $0["id"].string == id }
            return ["ok": true]
        case "chatgpt.status":
            if world.state == "signinwait", world.signingIn { return ["available": true, "signedIn": false, "signingIn": true, "device": ["url": "https://auth.openai.com/codex/device", "userCode": "ABCD-EFGH"]] }
            return ["available": true, "signedIn": true, "signingIn": false, "email": "philipp@example.com", "plan": "prolite",
                    "limits": ["primary": ["usedPercent": 18, "windowMinutes": 300, "resetsAt": now(-3 * 3600)], "secondary": ["usedPercent": 61, "windowMinutes": 10080, "resetsAt": now(-3 * 86400)]]]
        case "chatgpt.signIn": world.signingIn = true; return ["url": "https://auth.openai.com/codex/device", "userCode": "ABCD-EFGH"]
        case "chatgpt.cancel", "copilot.cancel", "openrouter.cancel": world.signingIn = false; return ["ok": true]
        case "copilot.status":
            if world.state == "signinwait", world.signingIn { return ["signedIn": false, "signingIn": true, "userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device"] }
            if world.state == "signinfail", world.signingIn { return ["signedIn": false, "signingIn": false, "error": "GitHub said the code expired before it was used. Start again."] }
            return ["signedIn": true, "signingIn": false, "login": "theoriuhd"]
        case "copilot.signIn": world.signingIn = true; return ["userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device", "expiresAt": now(-900)]
        case "openrouter.connect": return ["url": "https://openrouter.ai/auth?callback_url=https%3A%2F%2Fexample.com"]
        case "openrouter.status": return world.state == "signinwait" ? ["connecting": true] : ["connecting": false, "provider": ["id": "openrouter", "type": "openai-compatible", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1", "headers": [:], "enabled": true]]
        case "search.status":
            return ["mode": "auto", "engines": [
                ["id": "ddg", "name": "DuckDuckGo", "kind": "web", "state": "ok", "lastOkAt": now(60)],
                ["id": "brave", "name": "Brave", "kind": "web", "state": "limited", "retryAt": now(-150)],
                ["id": "bing", "name": "Bing", "kind": "web", "state": "unknown"],
                ["id": "bingnews", "name": "Bing News", "kind": "news", "state": "ok"],
                ["id": "hn", "name": "Hacker News", "kind": "dev", "state": "unknown"],
            ]]
        case "search.test":
            if world.state == "searchfail" { throw MobileError.message("No search engine answered. The engines may be limiting this server; try again in a few minutes.") }
            return ["engine": "DuckDuckGo", "ms": 840, "results": [["title": "Atelier", "url": "https://atelierhq.dev"], ["title": "Docs", "url": "https://docs.atelierhq.dev"]]]
        case "dictation.status":
            let builtin: JSON = world.state == "download" ? ["state": "downloading", "received": 214_000_000, "total": 715_000_000] : world.state == "failed" ? ["state": "failed", "bytes": 715_000_000, "error": "The download was interrupted. Check the server's connection."] : ["state": "missing", "bytes": 715_000_000]
            return ["enabled": .bool(world.effective["dictation"]["enabled"].boolOrNil ?? true), "source": nil,
                    "sources": [["id": "text:mistral:voxtral-realtime", "label": "Voxtral Realtime", "provider": "Mistral", "live": true], ["id": "media:groq-speech:whisper-large-v3", "label": "Whisper large v3", "provider": "Groq speech", "live": false]],
                    "chosen": world.effective["dictation"]["source"] != .null ? world.effective["dictation"]["source"] : nil, "builtin": builtin]
        case "dictation.prepare":
            return ["enabled": true, "source": nil, "sources": [], "chosen": nil, "builtin": ["state": "downloading", "received": 12_000_000, "total": 715_000_000]]
        default: return nil
        }
    }

    static let detected: [JSON] = [
        ["type": "anthropic", "baseUrl": "https://api.anthropic.com", "label": "Anthropic", "via": "env", "envVar": "ANTHROPIC_API_KEY"],
        ["type": "ollama", "baseUrl": "http://localhost:11434", "label": "Ollama", "via": "port"],
    ]
}
#else
enum AdminModelsDemo {
    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? { nil }
}
#endif
