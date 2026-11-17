import Foundation

// The logic behind Connectors, Skills and Plugins: how the server's JSON reads, what a form writes back, and how errors
// are put in words. Nothing here touches the network or a view, so all of it is covered by `CustomizeTests`.

// MARK: - Small helpers

enum CustomizeText {
    /// "1 tool", "2 tools".
    static func plural(_ count: Int, _ word: String) -> String { "\(count) \(word)\(count == 1 ? "" : "s")" }

    /// Whether every word of `query` appears in one of `fields` (case and accents ignored). An empty query matches everything.
    static func matches(_ query: String, in fields: [String]) -> Bool {
        let words = query.split(whereSeparator: \.isWhitespace).map { String($0) }
        if words.isEmpty { return true }
        let haystack = fields.joined(separator: "\n")
        return words.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    /// A label in the middle of a sentence: "Personal access token" becomes "personal access token", "API token" stays.
    static func inSentence(_ label: String) -> String {
        guard let first = label.first else { return label }
        let second = label.dropFirst().first
        return second?.isUppercase == true ? label : first.lowercased() + label.dropFirst()
    }

    /// A long name with no spaces may break after its hyphens and underscores, so it wraps instead of being cut.
    static func breakable(_ name: String) -> String {
        name.replacingOccurrences(of: "-", with: "-\u{200B}").replacingOccurrences(of: "_", with: "_\u{200B}")
    }

    /// The part of a log line after its "09:49:12 " time, and that time.
    static func logLine(_ line: String) -> (time: String?, text: String) {
        let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0].count == 8, parts[0].filter({ $0 == ":" }).count == 2, parts[0].allSatisfy({ $0.isNumber || $0 == ":" }) else { return (nil, line) }
        return (String(parts[0]), String(parts[1]))
    }

    /// The server writes times as ISO 8601 ("2026-11-17T10:24:26.123Z").
    static func date(iso: String) -> Date? {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter(); plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }
}

private func strings(_ values: [String]) -> JSON { .array(values.map { JSON.string($0) }) }
private func strings(_ json: JSON) -> [String] { json.array.compactMap { $0.stringOrNil } }
private func stringMap(_ json: JSON) -> [String: String] {
    var result: [String: String] = [:]
    for (key, value) in json.entries { if let text = value.stringOrNil { result[key] = text } }
    return result
}

// MARK: - Errors, in words

enum CustomizeErrors {
    /// What a server's refusal or failure says to a person. The wire keeps only the message, so this reads the message.
    static func message(for error: Error) -> String {
        if error is CancellationError { return "" }
        return describe(error.localizedDescription)
    }

    static func describe(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("Unknown method") { return "This server doesn't support this yet." }
        if text == "Only admins can do this." { return "Only admins can change this." }
        if text.contains("Connection interrupted") { return "The connection to your server dropped. Check that it is still running, then try again." }
        if text.contains("did not acknowledge the request") { return "Your server took too long to answer. Try again in a moment." }
        return text
    }

    /// The server doesn't know the procedure: as it said it, or as `describe` already put it.
    static func isUnsupported(_ error: Error) -> Bool {
        let text = error.localizedDescription
        return text.hasPrefix("Unknown method") || text == "This server doesn't support this yet."
    }

    /// Rewraps a failure so the alert, the toast and the inline text all show the readable version. Cancellation passes through.
    static func translated(_ error: Error) -> Error {
        if error is CancellationError { return error }
        let readable = message(for: error)
        return readable == error.localizedDescription ? error : MobileError.message(readable)
    }

    /// A connector's own failure text, said so a person can act on it. The raw text stays available as "Details".
    static func connector(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        if lower.contains("requires authorization") || lower.contains("http 401") || lower.contains("unauthorized") {
            return "The server didn't accept the sign-in or token. Check the token in Headers, or turn on Sign in with OAuth."
        }
        if lower.contains("http 403") || lower.contains("forbidden") { return "The server says this account isn't allowed to use it." }
        if lower.contains("http 404") || lower.contains("not found") && lower.contains("http") { return "Nothing is at that address. Check the URL." }
        if lower.contains("which only the desktop app does") { return "This connector starts a program on a computer, which only the Atelier desktop app can do. Use the service's web address (HTTP) instead." }
        if text.hasPrefix("It runs a program on your computer") {
            return "This connector runs a program on your computer. Open the Atelier desktop app on that computer, signed in to this server, and allow it in Customize › Connectors."
        }
        if text.hasPrefix("Offline on "), let colon = text.firstIndex(of: ":") {
            return "\(text[text.index(text.startIndex, offsetBy: 11)..<colon]) is offline. It starts again when that computer is back."
        }
        if text.contains("is on your computer or its network, which the server can't reach") {
            let host = text.split(separator: " ").first.map(String.init) ?? "That address"
            return "\(host) is on your computer or its network, which the server can't reach. Open the Atelier desktop app on that computer and allow it in Customize › Connectors."
        }
        if text.hasPrefix("It changed since you allowed it on ") { return text.replacingOccurrences(of: ": allow it in Customize › Connectors in the Atelier desktop app there again.", with: ". Allow it again in Customize › Connectors in the Atelier desktop app on that computer.") }
        if text.hasPrefix("Missing the secret") {
            let name = text.split(separator: "\"").dropFirst().first.map(String.init) ?? "a key"
            return "This connector uses a key that isn't stored: \(name). Add it under Keys and secrets, or edit the connector."
        }
        if text.hasPrefix("Missing the environment variable") { return "This connector refers to a variable the server doesn't have. Edit the connector and fix the value." }
        if lower.contains("version negotiation probe failed") || lower.hasSuffix("fetch failed") { return "Couldn't reach the server. Check the address and that it is running." }
        if lower.contains("timed out") || lower.contains("did not finish within") { return "The server took too long to answer. Try again in a moment." }
        if lower.contains("the server ended the connection") || lower.contains("the connection closed") { return "The server ended the connection. Atelier tries again by itself." }
        return text
    }

    /// A connector's failure in a few words, for a row in a list. The page itself says it in full.
    static func connectorSummary(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        if lower.contains("requires authorization") || lower.contains("http 401") || lower.contains("unauthorized") { return "The token wasn't accepted" }
        if lower.contains("http 403") || lower.contains("forbidden") { return "Not allowed" }
        if lower.contains("http 404") { return "Nothing at that address" }
        if lower.contains("which only the desktop app does") { return "Needs the desktop app" }
        if text.hasPrefix("It runs a program on your computer") { return "Not allowed on a computer yet" }
        if text.hasPrefix("Offline on ") { return "Its computer is offline" }
        if text.contains("is on your computer or its network, which the server can't reach") { return "Reached only through your computer" }
        if text.hasPrefix("It changed since you allowed it") { return "Changed since you allowed it" }
        if text.hasPrefix("Missing the secret") { return "A stored key is missing" }
        if text.hasPrefix("Missing the environment variable") { return "A variable is missing" }
        if text.hasPrefix("Can't reach"), let colon = text.range(of: ": ") { return String(text[..<colon.lowerBound]) }
        if lower.contains("version negotiation probe failed") || lower.hasSuffix("fetch failed") { return "Couldn't reach the server" }
        if lower.contains("timed out") || lower.contains("did not finish within") { return "Took too long to answer" }
        let sentence = text.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? text
        return sentence.count > 60 ? String(sentence.prefix(57)) + "…" : sentence
    }

    /// The name a "skill already exists" refusal is about: `A skill named “pdf” is already installed from somewhere else.`
    static func existingSkill(in message: String) -> String? {
        guard message.contains("already installed from somewhere else"),
              let open = message.firstIndex(of: "“"), let close = message[message.index(after: open)...].firstIndex(of: "”") else { return nil }
        let name = String(message[message.index(after: open)..<close])
        return name.isEmpty ? nil : name
    }
}

// MARK: - Connectors as the server describes them

enum CustomizeTransport: String, CaseIterable, Identifiable, Sendable {
    case http, sse, stdio
    var id: String { rawValue }
    /// How the desktop names it.
    var label: String { switch self { case .http: "HTTP"; case .sse: "SSE"; case .stdio: "stdio" } }
    /// For a segmented control: plain words.
    var choice: String { switch self { case .http: "HTTP"; case .sse: "SSE"; case .stdio: "Program" } }
}

struct CustomizeTool: Identifiable, Equatable, Sendable {
    let name: String
    let description: String
    let readOnly: Bool
    let enabled: Bool
    var id: String { name }
    init(_ json: JSON) {
        name = json["name"].string
        description = json["description"].string
        readOnly = json["readOnly"].bool
        enabled = json["enabled"] == .bool(false) ? false : true
    }
    init(name: String, description: String = "", readOnly: Bool = false, enabled: Bool = true) {
        self.name = name; self.description = description; self.readOnly = readOnly; self.enabled = enabled
    }
}

/// `mcp.status` for one connector.
struct CustomizeStatus: Equatable, Sendable {
    enum State: String, Sendable { case connecting, ready, error, disabled }
    enum SignIn: String, Sendable { case needed, waiting }
    let name: String
    let type: CustomizeTransport
    let state: State
    let error: String?
    let tools: [CustomizeTool]
    let era: String?
    let signIn: SignIn?
    let personal: Bool
    let device: String?

    init(_ json: JSON) {
        name = json["name"].string
        type = CustomizeTransport(rawValue: json["type"].string) ?? .http
        state = State(rawValue: json["state"].string) ?? .connecting
        error = json["error"].stringOrNil
        tools = json["tools"].array.map(CustomizeTool.init)
        era = json["protocolEra"].stringOrNil
        signIn = json["signIn"].stringOrNil.flatMap(SignIn.init)
        personal = json["personal"].bool
        device = json["device"].stringOrNil
    }

    /// "MCP 2026-07-28" or "MCP 2025 or earlier", when the server said.
    var protocolText: String? {
        switch era { case "modern": "MCP 2026-07-28"; case "legacy": "MCP 2025 or earlier"; default: nil }
    }
}

/// One connector: an admin's (a server entry of the settings) or a person's own.
struct CustomizeConnector: Identifiable, Equatable, Sendable {
    /// The name for an admin's connector, the server's id for a personal one.
    var id: String
    var name: String
    var type: CustomizeTransport
    var url: String?
    var command: String?
    var args: [String]
    /// An admin's connector keeps its values (references like `${secret:id}` mostly); a personal one only the names, the values stay on the server.
    var env: [String: String]
    var headers: [String: String]
    var envKeys: [String]
    var headerKeys: [String]
    var enabled: Bool
    var disabledTools: [String]
    var preset: String?
    var oauth: Bool
    var personal: Bool
    /// An admin's connector of the same name wins over a personal one.
    var clash: Bool

    /// Where it lives: its URL, or the command line that starts it.
    var target: String { type == .stdio ? ([command ?? ""] + args).joined(separator: " ") : (url ?? "") }

    static func admin(name: String, config: JSON) -> CustomizeConnector {
        let env = stringMap(config["env"]), headers = stringMap(config["headers"])
        return CustomizeConnector(
            id: name, name: name, type: CustomizeTransport(rawValue: config["type"].string) ?? .stdio,
            url: config["url"].stringOrNil, command: config["command"].stringOrNil, args: strings(config["args"]),
            env: env, headers: headers, envKeys: env.keys.sorted(), headerKeys: headers.keys.sorted(),
            enabled: config["enabled"] == .bool(false) ? false : true, disabledTools: strings(config["disabledTools"]),
            preset: config["preset"].stringOrNil, oauth: config["auth"].string == "oauth", personal: false, clash: false)
    }

    /// From a `connectors.list` entry (`{connector, clash}`).
    static func personal(view: JSON) -> CustomizeConnector {
        let c = view["connector"]
        return CustomizeConnector(
            id: c["id"].string, name: c["name"].string, type: CustomizeTransport(rawValue: c["type"].string) ?? .http,
            url: c["url"].stringOrNil, command: c["command"].stringOrNil, args: strings(c["args"]),
            env: [:], headers: [:], envKeys: strings(c["envKeys"]), headerKeys: strings(c["headerKeys"]),
            enabled: c["enabled"] == .bool(false) ? false : true, disabledTools: strings(c["disabledTools"]),
            preset: nil, oauth: c["auth"].string == "oauth", personal: true, clash: view["clash"].bool)
    }

    /// What `connectors.save` takes to save it again unchanged: every value kept (`null`), with the changes applied.
    func saveInput(enabled: Bool? = nil, disabledTools: [String]? = nil) -> [String: JSON] {
        func keep(_ names: [String]) -> JSON { .object(Dictionary(names.map { ($0, JSON.null) }, uniquingKeysWith: { _, last in last })) }
        var input: [String: JSON] = [
            "id": .string(id), "name": .string(name), "type": .string(type.rawValue), "args": strings(args),
            "env": keep(envKeys), "headers": keep(headerKeys),
            "enabled": .bool(enabled ?? self.enabled), "disabledTools": strings(disabledTools ?? self.disabledTools),
        ]
        if let command, !command.isEmpty { input["command"] = .string(command) }
        if let url, !url.isEmpty { input["url"] = .string(url) }
        if oauth { input["auth"] = "oauth" }
        return input
    }
}

/// How a connector's state reads in a row or a page header.
struct CustomizeStatusPresentation: Equatable {
    enum Tone { case good, warn, bad, neutral }
    var label: String
    var tone: Tone
    var busy: Bool

    static func of(_ connector: CustomizeConnector, _ status: CustomizeStatus?) -> CustomizeStatusPresentation {
        if connector.clash { return .init(label: "Not used", tone: .warn, busy: false) }
        if !connector.enabled { return .init(label: "Off", tone: .neutral, busy: false) }
        guard let status else { return .init(label: "Connecting…", tone: .neutral, busy: true) }
        if status.signIn == .waiting { return .init(label: "Waiting for sign-in", tone: .warn, busy: true) }
        if status.signIn == .needed { return .init(label: "Not signed in", tone: .warn, busy: false) }
        switch status.state {
        case .connecting: return .init(label: "Connecting…", tone: .neutral, busy: true)
        case .ready: return .init(label: status.device.map { "Ready on \($0)" } ?? "Ready", tone: .good, busy: false)
        case .error: return .init(label: "Error", tone: .bad, busy: false)
        case .disabled: return .init(label: "Off", tone: .neutral, busy: false)
        }
    }

    /// A status without its connector (the admin's connectors as an ordinary user sees them).
    static func of(status: CustomizeStatus) -> CustomizeStatusPresentation {
        if status.state == .disabled { return .init(label: "Off", tone: .neutral, busy: false) }
        if status.signIn == .waiting { return .init(label: "Waiting for sign-in", tone: .warn, busy: true) }
        if status.signIn == .needed { return .init(label: "Not signed in", tone: .warn, busy: false) }
        switch status.state {
        case .connecting: return .init(label: "Connecting…", tone: .neutral, busy: true)
        case .ready: return .init(label: "Ready", tone: .good, busy: false)
        case .error: return .init(label: "Error", tone: .bad, busy: false)
        case .disabled: return .init(label: "Off", tone: .neutral, busy: false)
        }
    }

    /// "5 tools" or "3 of 5 tools" once it is ready.
    static func toolSummary(_ connector: CustomizeConnector, _ status: CustomizeStatus?) -> String? {
        guard let status, status.state == .ready, connector.enabled, !connector.clash, status.signIn == nil else { return nil }
        let on = status.tools.filter { !connector.disabledTools.contains($0.name) }.count
        return on == status.tools.count ? CustomizeText.plural(status.tools.count, "tool") : "\(on) of \(CustomizeText.plural(status.tools.count, "tool"))"
    }
}

// MARK: - Permission rules for connector tools

/// When a connector tool may run. Connector tools ask unless a rule says otherwise.
enum CustomizePolicy: String, CaseIterable, Identifiable, Sendable {
    case allow, ask, deny
    var id: String { rawValue }
    var title: String { switch self { case .allow: "Always allow"; case .ask: "Ask"; case .deny: "Block" } }
    var detail: String {
        switch self {
        case .allow: "It runs without asking, in any mode except plan mode."
        case .ask: "It follows the conversation's permission mode: you are asked, or the reviewing model decides first."
        case .deny: "It is refused, and the model is told your settings rule it out."
        }
    }
}

/// The system's three permission lists, as far as connector tools go (`mcp__server__tool`).
struct CustomizePermissions: Equatable, Sendable {
    var allow: [String] = []
    var ask: [String] = []
    var deny: [String] = []

    init(allow: [String] = [], ask: [String] = [], deny: [String] = []) { self.allow = allow; self.ask = ask; self.deny = deny }
    init(json: JSON) { self.init(allow: strings(json["allow"]), ask: strings(json["ask"]), deny: strings(json["deny"])) }

    func list(_ policy: CustomizePolicy) -> [String] { switch policy { case .allow: allow; case .ask: ask; case .deny: deny } }

    func policy(for rule: String) -> CustomizePolicy { deny.contains(rule) ? .deny : allow.contains(rule) ? .allow : .ask }

    /// Ask is the default for connector tools, so it needs no rule.
    func setting(_ rule: String, to policy: CustomizePolicy) -> CustomizePermissions {
        var next = filtered { $0 != rule }
        switch policy { case .allow: next.allow.append(rule); case .deny: next.deny.append(rule); case .ask: break }
        return next
    }

    /// Drops the rules of a removed server's tools (`mcp__name`, `mcp__name__…`).
    func forgetting(server: String) -> CustomizePermissions {
        let prefix = CustomizeNames.toolName(server: server, tool: "")
        let bare = String(prefix.dropLast(2))
        return filtered { $0 != bare && !$0.hasPrefix(prefix) }
    }

    private func filtered(_ keep: (String) -> Bool) -> CustomizePermissions {
        CustomizePermissions(allow: allow.filter(keep), ask: ask.filter(keep), deny: deny.filter(keep))
    }

    /// The lists that differ from `other`, in the order they are written.
    func changes(from other: CustomizePermissions) -> [CustomizePolicy] { CustomizePolicy.allCases.filter { list($0) != other.list($0) } }
}

enum CustomizeNames {
    /// The model-facing name of a server's tool, as Claude Code builds it: `mcp__<server>__<tool>`, other characters `_`, at most 64.
    static func toolName(server: String, tool: String) -> String {
        func clean(_ text: String) -> String {
            String(text.unicodeScalars.map { scalar -> Character in
                let ok = (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122) || scalar == "_" || scalar == "-"
                return ok ? Character(scalar) : "_"
            })
        }
        return String("mcp__\(clean(server))__\(clean(tool))".prefix(64))
    }

    static func isValidConnectorName(_ name: String) -> Bool {
        (1...64).contains(name.count) && name.unicodeScalars.allSatisfy { ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) || $0 == "_" || $0 == "-" }
    }

    /// An environment variable's name: letters, digits and `_`, not starting with a digit.
    static func isValidEnvName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, name.count <= 200 else { return false }
        let letter: (Unicode.Scalar) -> Bool = { ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) || $0 == "_" }
        return letter(first) && name.unicodeScalars.allSatisfy { letter($0) || ($0.value >= 48 && $0.value <= 57) }
    }

    /// An HTTP header name: the token characters of RFC 9110.
    static func isValidHeaderName(_ name: String) -> Bool {
        guard (1...256).contains(name.count) else { return false }
        let allowed = Set("!#$%&'*+.^_`|~-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        return name.allSatisfy { allowed.contains($0) }
    }
}

// MARK: - Ready-made connectors

struct CustomizePreset: Identifiable, Sendable {
    struct Field: Sendable { let id: String; let label: String; let placeholder: String }
    let id: String
    let name: String
    let description: String
    let symbol: String
    let tokenLabel: String
    let tokenURL: String
    let tokenHelp: String
    let fields: [Field]
    /// The token setup runs a program on a computer, so only the desktop app's backend offers it.
    let desktopOnly: Bool
    /// The hosted server to sign in to instead of pasting a token.
    let oauthURL: String?
    let note: String?
    let build: @Sendable (_ secretRef: String, _ fields: [String: String]) -> JSON

    func server(secretRef: String, fields: [String: String]) -> JSON { build(secretRef, fields) }

    static let all: [CustomizePreset] = [
        CustomizePreset(
            id: "cloudflare", name: "Cloudflare", description: "Workers, DNS, R2, D1 and the rest of your Cloudflare account, through Cloudflare's API server.", symbol: "cloud",
            tokenLabel: "API token", tokenURL: "https://dash.cloudflare.com/profile/api-tokens", tokenHelp: "Grant only what you need. Account tokens need “Account Resources: Read”; IP-filtered tokens don't work.",
            fields: [], desktopOnly: false, oauthURL: "https://mcp.cloudflare.com/mcp", note: nil,
            build: { ref, _ in ["type": "http", "url": "https://mcp.cloudflare.com/mcp", "headers": ["Authorization": .string("Bearer \(ref)")]] }),
        CustomizePreset(
            id: "github", name: "GitHub", description: "Issues, pull requests, code search and Actions in your repositories.", symbol: "arrow.triangle.branch",
            tokenLabel: "Personal access token", tokenURL: "https://github.com/settings/personal-access-tokens/new", tokenHelp: "Fine-grained tokens work; classic ones need the repo and read:org scopes.",
            fields: [], desktopOnly: false, oauthURL: nil, note: "GitHub's hosted server may need Copilot on your account.",
            build: { ref, _ in ["type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": ["Authorization": .string("Bearer \(ref)")]] }),
        CustomizePreset(
            id: "notion", name: "Notion", description: "Search, read and update pages and databases shared with your integration.", symbol: "note.text",
            tokenLabel: "Integration secret", tokenURL: "https://www.notion.so/profile/integrations", tokenHelp: "Give it read (and insert/update) content access, then share the pages it should see with the integration.",
            fields: [], desktopOnly: true, oauthURL: "https://mcp.notion.com/mcp", note: "Runs Notion's open-source server with npx (needs Node.js). Signing in uses Notion's hosted server instead.",
            build: { ref, _ in ["type": "stdio", "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"], "env": ["NOTION_TOKEN": .string(ref)]] }),
        CustomizePreset(
            id: "linear", name: "Linear", description: "Issues, projects and cycles in your Linear workspace.", symbol: "checklist",
            tokenLabel: "Personal API key", tokenURL: "https://linear.app/settings/account/security", tokenHelp: "Linear › Settings › Security and access › Personal API keys.",
            fields: [], desktopOnly: false, oauthURL: "https://mcp.linear.app/mcp", note: nil,
            build: { ref, _ in ["type": "http", "url": "https://mcp.linear.app/mcp", "headers": ["Authorization": .string("Bearer \(ref)")]] }),
        CustomizePreset(
            id: "brave-search", name: "Brave Search", description: "Web, news and image search through Brave's API.", symbol: "magnifyingglass",
            tokenLabel: "API key", tokenURL: "https://api-dashboard.search.brave.com/app/keys", tokenHelp: "The free plan is enough to try it.",
            fields: [], desktopOnly: true, oauthURL: nil, note: "Runs Brave's server with npx (needs Node.js). On a server, use the built-in web search with Brave instead (Settings › Admin › Capabilities).",
            build: { ref, _ in ["type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server"], "env": ["BRAVE_API_KEY": .string(ref)]] }),
        CustomizePreset(
            id: "home-assistant", name: "Home Assistant", description: "Your devices, sensors and automations, through Home Assistant's MCP server.", symbol: "house",
            tokenLabel: "Long-lived access token", tokenURL: "https://www.home-assistant.io/docs/authentication/#your-account-profile",
            tokenHelp: "Create it under your Home Assistant profile › Security, as an admin user, and enable the “Model Context Protocol Server” integration.",
            fields: [Field(id: "url", label: "Home Assistant address", placeholder: "http://homeassistant.local:8123")], desktopOnly: false, oauthURL: nil, note: nil,
            build: { ref, fields in
                var base = (fields["url"] ?? "").trimmingCharacters(in: .whitespaces)
                while base.hasSuffix("/") { base.removeLast() }
                return ["type": "http", "url": .string("\(base)/api/mcp"), "headers": ["Authorization": .string("Bearer \(ref)")]]
            }),
    ]

    static func named(_ id: String?) -> CustomizePreset? { id.flatMap { id in all.first { $0.id == id } } }
    /// The tile symbol for a connector set up from `preset`; custom ones get the generic one.
    static func symbol(for preset: String?) -> String { named(preset)?.symbol ?? "square.grid.2x2" }
}

// MARK: - What a form writes

/// A credential to store before the entry that refers to it is written.
struct CustomizeNewSecret: Equatable, Sendable {
    let id: String
    let label: String
    let kind: String
    let value: String
    var params: [String: JSON] { ["id": .string(id), "label": .string(label), "kind": .string(kind), "value": .string(value)] }
}

/// A header (HTTP, SSE) or environment variable (stdio). `secret` nil: kept as a secret when its name looks like a credential.
struct CustomizePair: Identifiable, Equatable, Sendable {
    var id = UUID()
    var name = ""
    var value = ""
    var secret: Bool?
    /// Edited connector of one's own: the value was saved before, an empty value keeps it.
    var saved = false

    var wantsSecret: Bool { secret ?? CustomizeSecrets.looksLikeCredential(name) }
    /// Whether the value goes to the secret store: not a reference (`${…}`), not empty.
    var storesSecret: Bool { wantsSecret && !value.trimmingCharacters(in: .whitespaces).isEmpty && !value.contains("${") }
    var isReference: Bool { value.contains("${") }
}

enum CustomizeSecrets {
    /// Names of headers and variables that usually hold credentials.
    static func looksLikeCredential(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["token", "key", "secret", "passw", "credential", "auth"].contains { lower.contains($0) }
    }

    /// A valid secret id (`[a-z0-9-]`, at most 64) from its parts, e.g. `mcp-github-authorization`.
    static func id(_ parts: String...) -> String {
        var out = "", previousDash = true
        for scalar in parts.joined(separator: "-").lowercased().unicodeScalars {
            let ok = (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 97 && scalar.value <= 122)
            if ok { out.unicodeScalars.append(scalar); previousDash = false } else if !previousDash { out.append("-"); previousDash = true }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(64))
    }

    static func reference(_ id: String) -> String { "${secret:\(id)}" }
    static func kind(for name: String) -> String { name.lowercased().contains("key") ? "api_key" : "token" }

    /// Moves the literal `value` named `name` into a secret of `server`, returning what the entry keeps instead.
    /// `Authorization: Bearer …` keeps its scheme in the entry; only the token is the secret.
    static func move(server: String, name: String, value: String, into secrets: inout [CustomizeNewSecret]) -> String {
        let secretId = Self.id("mcp", server, name)
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var scheme: String?, token = trimmed
        for candidate in ["Bearer", "Basic", "Token"] {
            let prefix = candidate.lowercased() + " "
            if trimmed.lowercased().hasPrefix(prefix) {
                let rest = String(trimmed.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
                if !rest.isEmpty { scheme = candidate; token = rest }
                break
            }
        }
        secrets.append(CustomizeNewSecret(id: secretId, label: "\(name) for \(server)", kind: kind(for: name), value: token))
        return scheme.map { "\($0) \(reference(secretId))" } ?? reference(secretId)
    }
}

struct CustomizeConnectorForm: Equatable, Sendable {
    enum Field: Hashable, Sendable { case name, url, command, pairs }
    var name = ""
    var type: CustomizeTransport = .http
    var url = ""
    var command = ""
    /// One argument per line.
    var args = ""
    var pairs: [CustomizePair] = []
    /// HTTP and SSE: sign in with OAuth.
    var oauth = false

    static func from(_ connector: CustomizeConnector) -> CustomizeConnectorForm {
        let values = connector.type == .stdio ? connector.env : connector.headers
        let keys = connector.type == .stdio ? connector.envKeys : connector.headerKeys
        let pairs = keys.map { key -> CustomizePair in
            connector.personal ? CustomizePair(name: key, value: "", secret: true, saved: true) : CustomizePair(name: key, value: values[key] ?? "")
        }
        return CustomizeConnectorForm(name: connector.name, type: connector.type, url: connector.url ?? "", command: connector.command ?? "", args: connector.args.joined(separator: "\n"), pairs: pairs, oauth: connector.oauth)
    }

    var argumentLines: [String] { args.split(separator: "\n", omittingEmptySubsequences: true).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    /// `taken`: the names of the other connectors.
    static func nameError(_ name: String, taken: Set<String>, personal: Bool = false) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "Give it a name." }
        if !CustomizeNames.isValidConnectorName(trimmed) { return "Use up to 64 letters, digits, - and _." }
        if taken.contains(trimmed) { return personal ? "You have a connector called \(trimmed) already." : "There is a connector with this name already." }
        return nil
    }

    static func urlLooksValid(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.contains("${") { return !trimmed.isEmpty }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else { return false }
        return true
    }

    func errors(taken: Set<String>, personal: Bool = false) -> [Field: String] {
        var errors: [Field: String] = [:]
        if let message = Self.nameError(name, taken: taken, personal: personal) { errors[.name] = message }
        if type == .stdio {
            if command.trimmingCharacters(in: .whitespaces).isEmpty { errors[.command] = "Enter the command that starts the server." }
        } else if !Self.urlLooksValid(url) {
            errors[.url] = "Enter the server's URL, like https://example.com/mcp."
        }
        if pairs.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty && !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }) {
            errors[.pairs] = "Every value needs a name."
        } else if let bad = pairs.first(where: { pair in
            let name = pair.name.trimmingCharacters(in: .whitespaces)
            return !name.isEmpty && !(type == .stdio ? CustomizeNames.isValidEnvName(name) : CustomizeNames.isValidHeaderName(name))
        }) {
            errors[.pairs] = type == .stdio ? "“\(bad.name)” isn't a variable name: use letters, digits and _, not starting with a digit." : "“\(bad.name)” isn't a header name: use letters, digits and -."
        } else if Set(pairs.map { $0.name.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }).count < pairs.filter({ !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }).count {
            errors[.pairs] = "Two entries have the same name."
        }
        return errors
    }

    /// An admin's entry (`mcpServers.<name>`, Claude Code's shape) and the secrets to store first. `keep` carries what the form
    /// doesn't edit (enabled, disabled tools, preset) over from the entry being edited.
    func adminEntry(keeping: CustomizeConnector? = nil) -> (entry: JSON, secrets: [CustomizeNewSecret]) {
        let server = name.trimmingCharacters(in: .whitespaces)
        var secrets: [CustomizeNewSecret] = []
        var values: [String: JSON] = [:]
        for pair in pairs {
            let key = pair.name.trimmingCharacters(in: .whitespaces)
            if key.isEmpty { continue }
            values[key] = .string(pair.storesSecret ? CustomizeSecrets.move(server: server, name: key, value: pair.value, into: &secrets) : pair.value)
        }
        var entry: [String: JSON] = ["type": .string(type.rawValue)]
        if type == .stdio {
            entry["command"] = .string(command.trimmingCharacters(in: .whitespaces)); entry["args"] = strings(argumentLines); entry["env"] = .object(values)
        } else {
            entry["url"] = .string(url.trimmingCharacters(in: .whitespaces)); entry["headers"] = .object(values)
            if oauth { entry["auth"] = "oauth" }
        }
        if let keeping {
            entry["enabled"] = .bool(keeping.enabled); entry["disabledTools"] = strings(keeping.disabledTools)
            if let preset = keeping.preset { entry["preset"] = .string(preset) }
        }
        return (.object(entry), secrets)
    }

    /// What `connectors.save` takes: values by name, `null` keeps the one saved before.
    func personalInput(existing: CustomizeConnector?) -> [String: JSON] {
        var values: [String: JSON] = [:]
        for pair in pairs {
            let key = pair.name.trimmingCharacters(in: .whitespaces)
            if key.isEmpty { continue }
            values[key] = pair.saved && pair.value.isEmpty ? .null : .string(pair.value)
        }
        var input: [String: JSON] = ["name": .string(name.trimmingCharacters(in: .whitespaces)), "type": .string(type.rawValue)]
        if let existing {
            input["id"] = .string(existing.id); input["enabled"] = .bool(existing.enabled); input["disabledTools"] = strings(existing.disabledTools)
        }
        if type == .stdio {
            input["command"] = .string(command.trimmingCharacters(in: .whitespaces)); input["args"] = strings(argumentLines); input["env"] = .object(values); input["headers"] = .object([:])
        } else {
            input["url"] = .string(url.trimmingCharacters(in: .whitespaces)); input["env"] = .object([:]); input["headers"] = .object(values)
            if oauth { input["auth"] = "oauth" }
        }
        return input
    }
}

/// A preset's entries: the pasted token stored as `mcp-<name>`, or the hosted server to sign in to.
enum CustomizePresetEntry {
    static func token(_ preset: CustomizePreset, name: String, token: String, fields: [String: String]) -> (entry: JSON, secrets: [CustomizeNewSecret]) {
        let id = CustomizeSecrets.id("mcp", name)
        var entry = preset.server(secretRef: CustomizeSecrets.reference(id), fields: fields.mapValues { $0.trimmingCharacters(in: .whitespaces) })
        entry = entry.setting("preset", .string(preset.id))
        return (entry, [CustomizeNewSecret(id: id, label: "\(preset.tokenLabel) for \(name)", kind: CustomizeSecrets.kind(for: preset.tokenLabel), value: token.trimmingCharacters(in: .whitespacesAndNewlines))])
    }

    static func signIn(_ preset: CustomizePreset) -> JSON {
        ["type": "http", "url": .string(preset.oauthURL ?? ""), "auth": "oauth", "preset": .string(preset.id)]
    }

    /// The Home Assistant address (or any other field) must be filled in before the token form is valid.
    static func errors(_ preset: CustomizePreset, token: String, fields: [String: String], oauth: Bool) -> (token: String?, fields: [String: String]) {
        if oauth { return (nil, [:]) }
        var fieldErrors: [String: String] = [:]
        for field in preset.fields {
            let value = (fields[field.id] ?? "").trimmingCharacters(in: .whitespaces)
            if value.isEmpty { fieldErrors[field.id] = "Enter the \(field.label)." }
            else if field.id == "url", !CustomizeConnectorForm.urlLooksValid(value) { fieldErrors[field.id] = "Enter the address with http:// or https://, like \(field.placeholder)." }
        }
        return (token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Paste your \(CustomizeText.inSentence(preset.tokenLabel))." : nil, fieldErrors)
    }

    /// A free name from `name`: `name`, `name-2`, `name-3` …
    static func freeName(_ name: String, taken: Set<String>) -> String {
        var candidate = name, n = 2
        while taken.contains(candidate) { candidate = "\(name)-\(n)"; n += 1 }
        return candidate
    }
}

/// A connector found in Claude Code's settings, converted by the server (`mcp.import`).
struct CustomizeImportEntry: Identifiable, Equatable, Sendable {
    let name: String
    let config: CustomizeConnector
    /// Paths into the config of literal credentials to move into the secret store.
    let secretPaths: [[String]]
    let source: String
    var id: String { name }

    init(_ json: JSON) {
        name = json["name"].string
        config = CustomizeConnector.admin(name: json["name"].string, config: json["config"])
        secretPaths = json["secrets"].array.map { strings($0) }
        source = json["source"].string
    }

    /// An admin's entry with the literal credentials the server flagged moved into secrets.
    func adminEntry() -> (entry: JSON, secrets: [CustomizeNewSecret]) {
        var secrets: [CustomizeNewSecret] = []
        var url = config.url, env = config.env, headers = config.headers
        for path in secretPaths {
            guard let field = path.first else { continue }
            if field == "url", let current = url { url = CustomizeSecrets.move(server: name, name: "URL", value: current, into: &secrets) }
            if field == "env", path.count > 1, let current = env[path[1]] { env[path[1]] = CustomizeSecrets.move(server: name, name: path[1], value: current, into: &secrets) }
            if field == "headers", path.count > 1, let current = headers[path[1]] { headers[path[1]] = CustomizeSecrets.move(server: name, name: path[1], value: current, into: &secrets) }
        }
        var entry: [String: JSON] = ["type": .string(config.type.rawValue), "enabled": .bool(config.enabled), "disabledTools": strings(config.disabledTools)]
        if let command = config.command { entry["command"] = .string(command) }
        entry["args"] = strings(config.args)
        if let url { entry["url"] = .string(url) }
        entry["env"] = .object(env.mapValues { JSON.string($0) })
        entry["headers"] = .object(headers.mapValues { JSON.string($0) })
        if config.oauth { entry["auth"] = "oauth" }
        return (.object(entry), secrets)
    }

    /// What `connectors.save` takes for the person's own copy: exactly what runs, values by name.
    func personalInput() -> [String: JSON] {
        var input: [String: JSON] = ["name": .string(name), "type": .string(config.type.rawValue)]
        if config.type == .stdio {
            input["command"] = .string(config.command ?? ""); input["args"] = strings(config.args)
            input["env"] = .object(config.env.mapValues { JSON.string($0) }); input["headers"] = .object([:])
        } else {
            input["url"] = .string(config.url ?? ""); input["env"] = .object([:]); input["headers"] = .object(config.headers.mapValues { JSON.string($0) })
            if config.oauth { input["auth"] = "oauth" }
        }
        return input
    }
}

// MARK: - Sign-in pages

enum CustomizeSignIn {
    /// The page the server says to sign in at. Only https is opened (plain http only for the machine itself, as the server allows it).
    static func safeURL(_ text: String) -> URL? {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        if scheme == "https" { return url }
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        return scheme == "http" && loopback ? url : nil
    }
}

// MARK: - Skills and plugins

struct CustomizeSkill: Identifiable, Equatable, Sendable {
    enum Scope: String, Sendable, CaseIterable {
        case project, global, plugin
        var title: String { switch self { case .project: "Project"; case .global: "Global"; case .plugin: "Plugin" } }
        /// What a section of this scope is called on the page.
        var sectionTitle: String { switch self { case .project: "From the folder"; case .global: "Installed here"; case .plugin: "From plugins" } }
    }
    struct Installed: Equatable, Sendable { let source: String; let sha: String; let installedAt: String }
    let name: String
    let description: String
    let scope: Scope
    let manualOnly: Bool
    let warnings: [String]
    let installed: Installed?
    let device: String?
    var id: String { name }

    init(_ json: JSON) {
        name = json["name"].string
        description = json["description"].string
        scope = Scope(rawValue: json["scope"].string) ?? .global
        manualOnly = json["manualOnly"].bool
        warnings = strings(json["warnings"])
        let i = json["installed"]
        installed = i == .null ? nil : Installed(source: i["source"].string, sha: i["sha"].string, installedAt: i["installedAt"].string)
        device = json["device"].stringOrNil
    }

    /// A project's skills win over global ones, and those over plugins'.
    static func precedes(_ a: CustomizeSkill, _ b: CustomizeSkill) -> Bool {
        let order = Scope.allCases
        let (x, y) = (order.firstIndex(of: a.scope) ?? 0, order.firstIndex(of: b.scope) ?? 0)
        return x != y ? x < y : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }

    var shortSha: String { String(installed?.sha.prefix(7) ?? "") }
}

struct CustomizeCommand: Identifiable, Equatable, Sendable {
    let name: String
    let description: String
    let argumentHint: String?
    var id: String { name }
    init(_ json: JSON) { name = json["name"].string; description = json["description"].string; argumentHint = json["argumentHint"].stringOrNil }
}

struct CustomizePlugin: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let description: String
    let version: String
    /// Installed with Atelier (it can be uninstalled here) or by Claude Code (only switched on and off).
    let fromClaudeCode: Bool
    var enabled: Bool
    let skills: [String]
    let commands: [String]
    let agents: [String]
    let device: String?

    init(_ json: JSON) {
        id = json["id"].string; name = json["name"].string; description = json["description"].string; version = json["version"].string
        fromClaudeCode = json["source"].string == "claude-code"
        enabled = json["enabled"].bool
        skills = strings(json["skills"]); commands = strings(json["commands"]); agents = strings(json["agents"])
        device = json["device"].stringOrNil
    }

    /// One on the person's own computer is theirs to switch; the others are the admin's, for everyone.
    var own: Bool { device != nil }
    var canUninstall: Bool { !fromClaudeCode }
    var isEmpty: Bool { skills.isEmpty && commands.isEmpty && agents.isEmpty }

    /// "2 skills · 1 command · 3 agents".
    var contents: String {
        [(skills.count, "skill"), (commands.count, "command"), (agents.count, "agent")].filter { $0.0 > 0 }.map { CustomizeText.plural($0.0, $0.1) }.joined(separator: " · ")
    }
}

struct CustomizeMarketPlugin: Identifiable, Equatable, Sendable {
    let name: String
    let description: String
    let version: String
    let unsupported: String?
    var id: String { name }
    init(_ json: JSON) { name = json["name"].string; description = json["description"].string; version = json["version"].string; unsupported = json["unsupported"].stringOrNil }
}

enum CustomizeMarketplace {
    /// `owner/repo`, or a github.com address of one, with an optional path after it.
    static func looksValid(_ text: String) -> Bool {
        var t = text.trimmingCharacters(in: .whitespaces)
        for prefix in ["https://github.com/", "http://github.com/", "github.com/"] where t.hasPrefix(prefix) { t = String(t.dropFirst(prefix.count)); break }
        let parts = t.split(separator: "/", omittingEmptySubsequences: false)
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")
        guard parts.count >= 2, !parts[0].isEmpty, !parts[1].isEmpty, parts[0].allSatisfy({ allowed.contains($0) }), parts[1].allSatisfy({ allowed.contains($0) || $0 == "@" }) else { return false }
        return t.count >= 3
    }

    /// The marketplaces plugins were installed from before, as `owner/repo`.
    static func known(from settings: JSON) -> [String] {
        let repos = settings["effective"]["extraKnownMarketplaces"].entries.compactMap { $0.1["source"]["repo"].stringOrNil }
        var seen = Set<String>()
        return repos.filter { seen.insert($0).inserted }
    }

    static func isInstalled(_ plugin: CustomizeMarketPlugin, marketplace: String, in installed: [CustomizePlugin]) -> Bool {
        installed.contains { $0.id == "\(plugin.name)@\(marketplace)" }
    }
}
