import SwiftUI

// Text providers as the app reads and writes them: the types, what a provider looks like, the form the wizard fills in.
// A port of the desktop's provider-form.ts, so the same things are valid on both.

// MARK: - Types

enum AMProviderType: String, CaseIterable, Identifiable, Sendable {
    case ollama, llamacpp, anthropic, openai
    case openaiCompatible = "openai-compatible"
    case chatgpt
    case chatgptChat = "chatgpt-chat"
    case copilot, mistral
    case mistralVibe = "mistral-vibe"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ollama: "Ollama"
        case .llamacpp: "llama.cpp"
        case .anthropic: "Anthropic"
        case .openai: "OpenAI"
        case .openaiCompatible: "OpenAI-compatible"
        case .chatgpt: "ChatGPT Plan"
        case .chatgptChat: "ChatGPT Chat"
        case .copilot: "GitHub Copilot"
        case .mistral: "Mistral"
        case .mistralVibe: "Mistral Vibe"
        }
    }

    var summary: String {
        switch self {
        case .ollama: "Local models served by Ollama."
        case .llamacpp: "A llama.cpp server (llama-server)."
        case .openaiCompatible: "LM Studio, vLLM, OpenRouter or any OpenAI-compatible API."
        case .anthropic: "Claude models through the Anthropic API."
        case .openai: "GPT models through the OpenAI API."
        case .chatgpt: "The models in your ChatGPT plan, signed in with your account."
        case .chatgptChat: "Experimental: use ChatGPT itself through a private browser session."
        case .copilot: "The models in your GitHub Copilot plan, signed in with GitHub."
        case .mistral: "Mistral's models through its API, priced per token."
        case .mistralVibe: "The models in your Le Chat Pro or Team plan, with your Vibe key."
        }
    }

    var defaultURL: String {
        switch self {
        case .ollama: "http://localhost:11434"
        case .llamacpp: "http://localhost:8080"
        case .anthropic: "https://api.anthropic.com"
        case .openai: "https://api.openai.com"
        case .openaiCompatible: "http://localhost:1234/v1"
        case .chatgpt: "https://chatgpt.com/backend-api/codex"
        case .chatgptChat: "https://chatgpt.com"
        case .copilot: "https://api.githubcopilot.com"
        case .mistral, .mistralVibe: "https://api.mistral.ai"
        }
    }

    /// Hosted services run elsewhere; the others run on a computer you control.
    var hosted: Bool {
        switch self {
        case .anthropic, .openai, .chatgpt, .chatgptChat, .copilot, .mistral, .mistralVibe: true
        case .ollama, .llamacpp, .openaiCompatible: false
        }
    }

    /// Hosted APIs reject requests without a key; local servers usually don't need one.
    var keyRequired: Bool { self == .anthropic || self == .openai || self == .mistral || self == .mistralVibe }

    /// Sign-in providers have no form: signing in is the whole setup.
    var signsIn: Bool { self == .chatgpt || self == .copilot || self == .chatgptChat }

    var symbol: String { hosted ? "cloud" : "server.rack" }

    /// The types the wizard offers on a phone. ChatGPT Chat drives a browser window on a desktop, so it is not among them.
    static let choosable: [AMProviderType] = [.ollama, .llamacpp, .openaiCompatible, .anthropic, .openai, .mistral, .mistralVibe]
}

/// Hosted services the wizard offers by name: each is an OpenAI-compatible provider at the service's address.
struct AMTextPreset: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let summary: String
    let baseURL: String
    let keyURL: String

    static let all: [AMTextPreset] = [
        AMTextPreset(id: "openrouter", name: "OpenRouter", summary: "Hundreds of hosted models, some of them free. Connect with your account in one tap.", baseURL: "https://openrouter.ai/api/v1", keyURL: "https://openrouter.ai/keys"),
        AMTextPreset(id: "opencode-zen", name: "OpenCode Zen", summary: "Hosted models through an OpenCode Console key.", baseURL: "https://opencode.ai/inference/openai/v1", keyURL: "https://opencode.ai"),
    ]

    /// The preset an address belongs to, by its host.
    static func of(baseURL: String) -> AMTextPreset? {
        guard let host = URL(string: baseURL)?.host?.replacingOccurrences(of: "www.", with: "") else { return nil }
        switch host {
        case "openrouter.ai": return all.first { $0.id == "openrouter" }
        case "opencode.ai": return all.first { $0.id == "opencode-zen" }
        default: return nil
        }
    }
}

let amMistralKeyURL = "https://console.mistral.ai/api-keys"
let amMistralVibeKeyURL = "https://chat.mistral.ai/code/extensions"

// MARK: - A provider and its status

struct AMProvider: Identifiable, Equatable, Sendable {
    let id: String
    let typeID: String
    let name: String
    let baseURL: String
    /// Usually `${secret:<id>}`: a reference, never the key.
    let apiKey: String?
    let headers: [String: String]
    let enabled: Bool
    let parallelRequests: Int?
    let modelsAtOnce: Int?
    let vramGiB: Double?
    let temporaryChat: Bool?

    init(json: JSON) {
        id = json["id"].string
        typeID = json["type"].string
        name = json["name"].string
        baseURL = json["baseUrl"].string
        apiKey = json["apiKey"].stringOrNil
        var headers: [String: String] = [:]
        for (key, value) in json["headers"].entries { if let text = value.stringOrNil { headers[key] = text } }
        self.headers = headers
        enabled = json["enabled"].boolOrNil ?? true
        parallelRequests = json["parallelRequests"].intOrNil
        modelsAtOnce = json["modelsAtOnce"].intOrNil
        vramGiB = json["vramGiB"].doubleOrNil
        temporaryChat = json["temporaryChat"].boolOrNil
    }

    var type: AMProviderType? { AMProviderType(rawValue: typeID) }
    var typeLabel: String { type?.label ?? typeID }
    var preset: AMTextPreset? { typeID == "openai-compatible" ? AMTextPreset.of(baseURL: baseURL) : nil }
    var symbol: String { type?.symbol ?? "server.rack" }
    /// Signing in is the setup for these, so there is nothing to edit.
    var editable: Bool { !(type?.signsIn ?? false) }
}

struct AMProviderStatus: Equatable, Sendable {
    let providerID: String
    let ok: Bool
    let latencyMs: Double?
    let version: String?
    let modelCount: Int
    let warnings: [String]
    let error: String?
    let checkedAt: Double
    let parallel: Int?
    let modelsAtOnce: Int?

    init(json: JSON) {
        providerID = json["providerId"].string
        ok = json["ok"].bool
        latencyMs = json["latencyMs"].doubleOrNil
        version = json["version"].stringOrNil
        modelCount = json["modelCount"].int
        warnings = json["warnings"].strings
        error = json["error"].stringOrNil
        checkedAt = json["checkedAt"].doubleOrNil ?? 0
        parallel = json["queue"]["parallel"].intOrNil
        modelsAtOnce = json["queue"]["modelsAtOnce"].intOrNil
    }
}

/// A provider's state in one word, for its row and its page.
enum AMHealth: Equatable {
    case disabled, notChecked, unreachable, warnings, connected

    init(enabled: Bool, status: AMProviderStatus?) {
        if !enabled { self = .disabled }
        else if let status, status.checkedAt > 0 {
            if !status.ok { self = .unreachable } else if !status.warnings.isEmpty { self = .warnings } else { self = .connected }
        } else { self = .notChecked }
    }

    var label: String {
        switch self {
        case .disabled: "Turned off"
        case .notChecked: "Not checked yet"
        case .unreachable: "Can't connect"
        case .warnings: "Connected, with notes"
        case .connected: "Connected"
        }
    }
    var tone: StatusBadge.Tone {
        switch self { case .disabled, .notChecked: .neutral; case .unreachable: .bad; case .warnings: .warn; case .connected: .good }
    }
    var color: Color {
        switch self {
        case .disabled, .notChecked: Theme.inkMuted.opacity(0.55)
        case .unreachable: Theme.danger
        case .warnings: Color(hex: 0xB77800)
        case .connected: Theme.success
        }
    }
}

/// A server or key found on this machine.
struct AMDetected: Identifiable, Equatable, Sendable {
    let type: AMProviderType
    let baseURL: String
    let label: String
    let envVar: String?
    var id: String { "\(type.rawValue)|\(baseURL)" }

    init?(json: JSON) {
        guard let type = AMProviderType(rawValue: json["type"].string) else { return nil }
        self.type = type
        baseURL = json["baseUrl"].string
        label = json["label"].string
        envVar = json["envVar"].stringOrNil
    }

    /// "Running at localhost:11434" or "ANTHROPIC_API_KEY is set in the environment".
    var whereFound: String {
        if let envVar { return "\(envVar) is set on the server" }
        return "Running at \(AMFormat.address(baseURL))"
    }
}

// MARK: - The form

/// What the add and edit screens hold while a person types. The key is only here while it is being entered.
struct AMProviderForm: Equatable, Sendable {
    struct Header: Equatable, Identifiable, Sendable { let id: UUID; var name: String; var value: String
        init(name: String = "", value: String = "") { id = UUID(); self.name = name; self.value = value }
    }
    enum Field: Hashable { case name, id, baseURL, apiKey, headers, parallel, modelsAtOnce, vram }

    var type: AMProviderType
    var preset: AMTextPreset?
    var name: String
    var id: String
    var idEdited = false
    var baseURL: String
    var apiKey = ""
    /// Imports the key from this environment variable on the server instead.
    var apiKeyFromEnv: String?
    var headers: [Header] = []
    var enabled = true
    var parallelRequests = ""
    var modelsAtOnce = ""
    /// As typed, in GB. 1 GB here is 1e9 bytes, as the desktop counts it.
    var vramGB = ""

    var label: String { preset?.name ?? type.label }
    var needsKey: Bool { type.keyRequired || preset != nil }
    /// Memory budgeting is for servers on a computer you run; hosted APIs have none.
    var showsMemoryBudget: Bool { !type.hosted && preset == nil }

    static func new(_ type: AMProviderType, taken: Set<String>, name: String? = nil, baseURL: String? = nil, apiKeyFromEnv: String? = nil) -> AMProviderForm {
        let shownName = name ?? type.label
        var form = AMProviderForm(type: type, name: shownName, id: AMForm.uniqueID(AMForm.slugify(shownName), taken: taken), baseURL: baseURL ?? type.defaultURL)
        form.apiKeyFromEnv = apiKeyFromEnv
        return form
    }

    static func preset(_ preset: AMTextPreset, taken: Set<String>) -> AMProviderForm {
        var form = AMProviderForm.new(.openaiCompatible, taken: taken, name: preset.name, baseURL: preset.baseURL)
        form.preset = preset
        return form
    }

    static func detected(_ found: AMDetected, taken: Set<String>) -> AMProviderForm {
        .new(found.type, taken: taken, name: found.label, baseURL: found.baseURL, apiKeyFromEnv: found.envVar)
    }

    init(type: AMProviderType, name: String, id: String, baseURL: String) {
        self.type = type; self.name = name; self.id = id; self.baseURL = baseURL
    }

    init(config: AMProvider) {
        type = config.type ?? .openaiCompatible
        preset = config.preset
        name = config.name
        id = config.id
        idEdited = true
        baseURL = config.baseURL
        headers = config.headers.sorted { $0.key < $1.key }.map { Header(name: $0.key, value: $0.value) }
        enabled = config.enabled
        parallelRequests = config.parallelRequests.map(String.init) ?? ""
        modelsAtOnce = config.modelsAtOnce.map(String.init) ?? ""
        vramGB = config.vramGiB.map { AMProviderForm.formatGB($0 * 1_073_741_824 / 1e9) } ?? ""
    }

    private static func formatGB(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }

    /// Renaming also renames the id, until the id has been edited by hand.
    mutating func rename(_ newName: String, taken: Set<String>) {
        name = newName
        if !idEdited { id = AMForm.uniqueID(AMForm.slugify(newName), taken: taken) }
    }

    // MARK: Validation

    static func validHeaderName(_ name: String) -> Bool {
        let punctuation = Set("!#$%&'*+.^_`|~-".unicodeScalars)
        return !name.isEmpty && name.unicodeScalars.allSatisfy { scalar in
            punctuation.contains(scalar) || (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122)
        }
    }

    func errors(taken: Set<String>, editing: Bool, hasStoredKey: Bool) -> [Field: String] {
        var errors: [Field: String] = [:]
        if name.trimmingCharacters(in: .whitespaces).isEmpty { errors[.name] = "Enter a name." }
        if !AMForm.isValidID(id) { errors[.id] = "Use lowercase letters, digits and dashes, starting with a letter or digit." }
        else if !editing, taken.contains(id) { errors[.id] = "Another provider already uses this short name." }
        if !AMForm.isHTTPURL(baseURL.trimmingCharacters(in: .whitespaces)) { errors[.baseURL] = "Enter an address starting with http:// or https://." }
        if needsKey, apiKey.trimmingCharacters(in: .whitespaces).isEmpty, apiKeyFromEnv == nil, !(editing && hasStoredKey) { errors[.apiKey] = "\(label) needs an API key." }
        let named = headers.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty || !$0.value.isEmpty }
        if named.contains(where: { !Self.validHeaderName($0.name.trimmingCharacters(in: .whitespaces)) }) { errors[.headers] = "A header needs a name without spaces." }
        else if Set(named.map { $0.name.trimmingCharacters(in: .whitespaces).lowercased() }).count != named.count { errors[.headers] = "Each header can only be set once." }
        if AMForm.count(parallelRequests, max: 64) == .invalid { errors[.parallel] = "Leave empty for automatic, or enter 1 to 64." }
        if AMForm.count(modelsAtOnce, max: 16) == .invalid { errors[.modelsAtOnce] = "Leave empty for automatic, or enter 1 to 16." }
        if !vramGB.trimmingCharacters(in: .whitespaces).isEmpty, AMForm.positive(vramGB, max: 1_048_576) == nil { errors[.vram] = "Leave empty for the default, or enter the available memory in GB." }
        return errors
    }

    // MARK: The request

    /// What `providers.test` and `providers.save` take. The key goes along only when one was typed or imported.
    func draft() -> [String: JSON] {
        var draft: [String: JSON] = [
            "id": .string(id), "type": .string(type.rawValue), "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "baseUrl": .string(baseURL.trimmingCharacters(in: .whitespaces)), "enabled": .bool(enabled),
        ]
        var headerObject: [String: JSON] = [:]
        for header in headers where !header.name.trimmingCharacters(in: .whitespaces).isEmpty { headerObject[header.name.trimmingCharacters(in: .whitespaces)] = .string(header.value) }
        draft["headers"] = .object(headerObject)
        if let gb = AMForm.positive(vramGB, max: 1_048_576) { draft["vramGiB"] = .number(gb * 1e9 / 1_073_741_824) }
        if case .value(let n) = AMForm.count(parallelRequests, max: 64) { draft["parallelRequests"] = .number(Double(n)) }
        if case .value(let n) = AMForm.count(modelsAtOnce, max: 16) { draft["modelsAtOnce"] = .number(Double(n)) }
        if let apiKeyFromEnv { draft["apiKeyFromEnv"] = .string(apiKeyFromEnv) }
        else if !apiKey.trimmingCharacters(in: .whitespaces).isEmpty { draft["apiKey"] = .string(apiKey.trimmingCharacters(in: .whitespaces)) }
        return draft
    }

    /// The draft without any key, for OpenRouter's connect (which makes the key itself).
    func connectDraft() -> [String: JSON] {
        var draft = self.draft()
        draft.removeValue(forKey: "apiKey"); draft.removeValue(forKey: "apiKeyFromEnv")
        return draft
    }
}

/// What a test of a provider found, in words.
struct AMTestOutcome: Equatable {
    let ok: Bool
    let summary: String
    let warnings: [String]

    init(status: AMProviderStatus) {
        ok = status.ok
        warnings = status.warnings
        if status.ok {
            summary = ["Connected", AMFormat.plural(status.modelCount, "model"), status.latencyMs.map { AMFormat.duration(ms: $0) }].compactMap { $0 }.joined(separator: " · ")
        } else { summary = status.error ?? "Could not connect." }
    }
}
