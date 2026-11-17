import SwiftUI

// The pieces every admin page of this area shares: how a failed call reads, the settings document, small formatters.
// Everything here is plain and testable without a view.

// MARK: - Failures

/// A failed call as a person should read it. The server's own messages are already plain; these three are the ones the
/// app has to word itself.
enum AMFailure: LocalizedError, Equatable {
    case forbidden
    case unsupported
    case message(String)

    var errorDescription: String? {
        switch self {
        case .forbidden: "Only admins of this server can do this."
        case .unsupported: "This server doesn't support this yet."
        case .message(let text): text
        }
    }

    /// The kind comes from the server's own codes (`forbidden`, "method not found"); the wording is the fallback for canned data.
    static func from(_ error: Error) -> AMFailure {
        if let failure = error as? AMFailure { return failure }
        if let served = error as? MobileError {
            if served.isUnsupported { return .unsupported }
            if served.appCode == "forbidden" { return .forbidden }
        }
        let text = error.localizedDescription
        if text.hasPrefix("Unknown method") { return .unsupported }
        if text.hasPrefix("Only admins") { return .forbidden }
        // The server's catch-all for a failure it has no words for.
        if text == "Internal error" { return .message("The server ran into a problem it can't describe. Try again, and check the server's log if it keeps happening.") }
        return .message(text)
    }
}

/// The connection, with failures turned into `AMFailure`.
@MainActor struct AMAPI {
    let store: AppStore
    func call(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        do {
            #if DEBUG
            // In the demo this area's own canned data answers first: other areas' demos answer some of the same methods
            // (`settings.get`, `imageModels.list`, `dictation.status`) with their own, smaller data.
            if Launch.value("--demo") != nil, let canned = try AdminModelsDemo.respond(method, params) { return canned }
            #endif
            return try await store.rpc.call(method, params)
        }
        catch is CancellationError { throw CancellationError() }
        catch { throw AMFailure.from(error) }
    }
    /// A read that may be missing on an older server: nil then, instead of a failure.
    func optional(_ method: String, _ params: [String: JSON] = [:]) async -> JSON? {
        do { return try await call(method, params) } catch { return nil }
    }
}

// MARK: - JSON paths

extension JSON {
    /// The value at a settings path: names go into objects, numbers into lists.
    func at(_ path: [JSON]) -> JSON {
        var node = self
        for key in path {
            switch key {
            case .string(let name): node = node[name]
            case .number(let n):
                let list = node.array
                let i = Int(n)
                node = i >= 0 && i < list.count ? list[i] : .null
            default: return .null
            }
        }
        return node
    }

    /// A copy with the value at `path` set, or removed when `value` is nil.
    func replacing(_ path: ArraySlice<JSON>, with value: JSON?) -> JSON {
        guard let head = path.first else { return value ?? .null }
        let rest = path.dropFirst()
        switch head {
        case .string(let name):
            var object: [String: JSON] = [:]
            if case .object(let existing) = self { object = existing }
            if rest.isEmpty, value == nil { object.removeValue(forKey: name) }
            else { object[name] = (object[name] ?? .null).replacing(rest, with: value) }
            return .object(object)
        case .number(let n):
            var list = array
            let i = Int(n)
            guard i >= 0, i < list.count else { return self }
            list[i] = list[i].replacing(rest, with: value)
            return .array(list)
        default: return self
        }
    }

    var doubleOrNil: Double? { if case .number(let n) = self { n } else { nil } }
    var isNull: Bool { self == .null }
    var strings: [String] { array.compactMap(\.stringOrNil) }
}

// MARK: - The settings document

/// `settings.get` as a page keeps it: the effective values, with writes that show at once and are undone if the server refuses.
@MainActor @Observable final class AMSettings {
    private(set) var effective: JSON = .null
    private(set) var loaded = false
    private let api: AMAPI
    init(store: AppStore) { api = AMAPI(store: store) }

    func load() async throws {
        effective = try await api.call("settings.get")["effective"]
        loaded = true
    }

    func value(_ path: [JSON]) -> JSON { effective.at(path) }

    /// Writes one path of the global layer. The page shows the new value straight away; a refusal puts the old one back and throws.
    func set(_ path: [JSON], _ value: JSON) async throws {
        let before = effective
        effective = effective.replacing(path[...], with: value)
        do { _ = try await api.call("settings.set", ["layer": "global", "path": .array(path), "value": value]) }
        catch { effective = before; throw error }
    }

    /// Deletes one path of the global layer, so the default applies again.
    func reset(_ path: [JSON]) async throws {
        let before = effective
        effective = effective.replacing(path[...], with: nil)
        do { _ = try await api.call("settings.reset", ["layer": "global", "path": .array(path)]) }
        catch { effective = before; throw error }
    }

    /// A switch bound to a setting. A write that fails shows the shared alert and the switch goes back.
    func toggle(_ store: AppStore, _ path: [JSON], default fallback: Bool) -> Binding<Bool> {
        Binding(
            get: { self.effective.at(path).boolOrNil ?? fallback },
            set: { on in Task { await store.attempt { try await self.set(path, .bool(on)) } } }
        )
    }
}

// MARK: - Formatting

enum AMFormat {
    /// 200000 as "200K", 1000000 as "1M".
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return "\(trimmed(Double(n) / 1_000_000))M" }
        if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))K" }
        return String(n)
    }
    private static func trimmed(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }
    static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
    /// "715 MB", "1.2 GB".
    static func bytes(_ n: Double) -> String {
        if n >= 1e9 { return "\(trimmed(n / 1e9)) GB" }
        return "\(Int((n / 1e6).rounded())) MB"
    }
    /// "12 ms", "1.4 s".
    static func duration(ms: Double) -> String { ms < 1000 ? "\(Int(ms.rounded())) ms" : "\(trimmed(ms / 1000)) s" }
    /// "in about 3 minutes".
    static func minutes(_ ms: Double) -> String {
        let n = max(1, Int((ms / 60_000).rounded()))
        return "\(n) minute\(n == 1 ? "" : "s")"
    }
    /// A host and port without the scheme: "localhost:11434".
    static func address(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    /// A date the server writes in milliseconds, as "3 days ago" or a dash.
    static func ago(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "Never" }
        return Date(timeIntervalSince1970: ms / 1000).relative
    }
}

// MARK: - Form text helpers (the desktop's provider form, ported)

enum AMForm {
    /// Lowercase letters, digits and dashes, starting with a letter or digit, at most 48 long.
    static func slugify(_ text: String) -> String {
        let folded = text.lowercased().folding(options: .diacriticInsensitive, locale: .current)
        var slug = ""
        var pendingDash = false
        for scalar in folded.unicodeScalars {
            if (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57) {
                if pendingDash, !slug.isEmpty { slug.append("-") }
                pendingDash = false
                slug.unicodeScalars.append(scalar)
            } else { pendingDash = true }
        }
        return String(slug.prefix(48)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    /// `base`, or `base-2`, `base-3` … when taken.
    static func uniqueID(_ base: String, taken: Set<String>) -> String {
        let root = base.isEmpty ? "provider" : base
        if !taken.contains(root) { return root }
        var n = 2
        while true {
            let suffix = "-\(n)"
            let candidate = String(root.prefix(48 - suffix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "-")) + suffix
            if !taken.contains(candidate) { return candidate }
            n += 1
        }
    }

    /// Whether this is a provider id the server takes: lowercase letters, digits and dashes, 1 to 48 long, not starting with a dash.
    static func isValidID(_ id: String) -> Bool {
        guard (1...48).contains(id.count), let first = id.unicodeScalars.first, first != "-" else { return false }
        return id.unicodeScalars.allSatisfy { ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57) || $0 == "-" }
    }

    static func isHTTPURL(_ text: String) -> Bool {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return !(url.host ?? "").isEmpty
    }

    /// A whole number from 1 to `max`: nil when empty (automatic), `.invalid` otherwise wrong.
    enum Count: Equatable { case automatic, value(Int), invalid }
    static func count(_ text: String, max: Int) -> Count {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .automatic }
        guard let n = Int(trimmed), n >= 1, n <= max else { return .invalid }
        return .value(n)
    }

    /// A positive number, as typed.
    static func positive(_ text: String, max: Double) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let n = Double(trimmed), n.isFinite, n > 0, n <= max else { return nil }
        return n
    }

    /// What to show for a stored key without revealing it: the masked tail of a stored secret, an environment reference as written, else dots.
    static func keyHint(_ apiKey: String?, secrets: [AMSecret]) -> String? {
        guard let apiKey, !apiKey.isEmpty else { return nil }
        if apiKey.hasPrefix("${secret:"), apiKey.hasSuffix("}") {
            let id = String(apiKey.dropFirst(9).dropLast())
            return secrets.first { $0.id == id }?.masked ?? "••••"
        }
        if apiKey.hasPrefix("${"), apiKey.hasSuffix("}"), !apiKey.contains("secret:") { return apiKey }
        return "••••"
    }
}

// MARK: - A secret as the server lists it

struct AMSecret: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let kind: String
    /// The masked tail, "••••3f9a". The plain value never leaves the server.
    let masked: String
    let usedBy: [String]
    let createdAt: Double
    let rotatedAt: Double?
    let lastUsedAt: Double?

    init(json: JSON) {
        id = json["id"].string
        label = json["label"].string
        kind = json["kind"].string
        masked = json["masked"].string
        usedBy = json["usedBy"].strings
        createdAt = json["createdAt"].doubleOrNil ?? 0
        rotatedAt = json["rotatedAt"].doubleOrNil
        lastUsedAt = json["lastUsedAt"].doubleOrNil
    }

    var kindLabel: String {
        switch kind {
        case "api_key": "API key"
        case "token": "Token"
        case "mcp_oauth": "Sign-in token"
        case "github": "GitHub"
        case "oidc": "Client secret"
        default: "Secret"
        }
    }

    /// What refers to this secret, as people know it: "Connector github", "Provider Anthropic", "Web search".
    func usedByLabels(providers: [String: String]) -> [String] {
        var labels: [String] = []
        for path in usedBy {
            let parts = path.split(separator: ".").map(String.init)
            let label: String
            if parts.first == "mcpServers", parts.count > 1 { label = "Connector \(parts[1])" }
            else if parts.first == "providers", parts.count > 1 { label = "Provider \(providers[parts[1]] ?? parts[1])" }
            else if parts.first == "imageProviders", parts.count > 1 { label = "Media provider \(providers[parts[1]] ?? parts[1])" }
            else if path.hasPrefix("capabilities.webSearch.") { label = "Web search" }
            else { label = path }
            if !labels.contains(label) { labels.append(label) }
        }
        return labels
    }
}

// MARK: - Blobs the server made (a test picture or sound)

@MainActor enum AMBlob {
    /// Downloads a blob the way attachments are downloaded: with the sign-in, into a protected temporary file.
    static func download(_ sha: String, mime: String, store: AppStore) async throws -> URL {
        guard sha.count == 64, sha.allSatisfy({ $0.isHexDigit }) else { throw AMFailure.message("The server sent a file reference this app can't read.") }
        let server = try serverURL(store.address)
        var request = URLRequest(url: server.appending(path: "api/blobs/\(sha)"))
        guard let token = CredentialStore.read(store.address) else { throw AMFailure.message("Sign in again to open this file.") }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (temporary, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw AMFailure.message("The server didn't give the file back.") }
        let ext = mime.split(separator: "/").last.map(String.init)?.replacingOccurrences(of: "mpeg", with: "mp3") ?? "bin"
        let destination = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString).appendingPathExtension(ext)
        try FileManager.default.moveItem(at: temporary, to: destination)
        return destination
    }
}

// MARK: - Shared small views

/// A result line: a symbol, the words, and the colour of what happened (the words carry the meaning too).
struct AMOutcome: View {
    enum Kind { case good, bad, warn, info }
    let kind: Kind
    let text: String
    private var symbol: String {
        switch kind { case .good: "checkmark.circle"; case .bad: "exclamationmark.circle"; case .warn: "exclamationmark.triangle"; case .info: "info.circle" }
    }
    private var color: Color {
        switch kind { case .good: Theme.success; case .bad: Theme.danger; case .warn: Color(hex: 0xB77800); case .info: Theme.inkMuted }
    }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(color)
            Text(text).font(.subheadline).foregroundStyle(kind == .bad ? Theme.danger : Theme.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A red helper line under a field.
struct AMFieldError: View {
    let text: String?
    var body: some View {
        if let text {
            Text(text).font(.footnote).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Problem: \(text)")
        }
    }
}

/// A row that opens an address in the browser.
struct AMLinkRow: View {
    let title: String
    let url: String
    @Environment(\.openURL) private var openURL
    var body: some View {
        Button {
            if let target = URL(string: url) { openURL(target) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.up.right.square").frame(width: 22)
                Text(title)
                Spacer()
            }
            .foregroundStyle(Theme.clay)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The ink-coloured explanation under a section: plain sentences.
struct AMNote: View {
    let text: String
    var body: some View { Text(text).font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true) }
}

/// A calm state for a page that can't load: the person is not an admin, the server is older, or the call failed.
struct AMPageProblem: View {
    let message: String
    var retry: (() -> Void)?
    var body: some View {
        let forbidden = message == AMFailure.forbidden.errorDescription
        let unsupported = message == AMFailure.unsupported.errorDescription
        if forbidden || unsupported {
            EmptyState(title: forbidden ? "Admins only" : "Not available here", symbol: forbidden ? "lock" : "clock.arrow.circlepath",
                       message: forbidden ? "Only admins of this server can see and change this. Ask an admin to do it for you." : message)
        } else {
            InlineError(message: message, retry: retry)
        }
    }
}

/// An admin page over a `Resource`: the four states of the shared kit, with a calm message for "admins only" and
/// "this server doesn't have it", pull to refresh, and the page's sections as content.
struct AMResourcePage<Value, Content: View>: View {
    let title: String
    let resource: Resource<Value>
    @ViewBuilder var content: (Value) -> Content
    var body: some View {
        Group {
            switch resource.state {
            case .idle, .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ScrollView { AMPageProblem(message: message) { Task { await resource.reload() } }.padding(.top, 60) }
            case .loaded(let value):
                List { content(value) }.listStyle(.insetGrouped)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.sunken)
        .refreshable { await resource.reload() }
        .task { if case .idle = resource.state { await resource.reload() } }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .tint(Theme.clay)
    }
}

/// Debug builds can be launched straight into a deeper screen, for looking at it without tapping:
///   --am provider/<id> | add | add/form-<type> | add/signin-chatgpt | edit/<id> | model/<ref> | secret/<id> | secret-add | instructions …
///   --am-flags start,test,touch   what to do once there (run the sign-in, run a test, mark every field as used)
/// Release builds ignore both.
enum AMLaunch {
    static var route: String? { Launch.value("--am") }
    static func has(_ flag: String) -> Bool { (Launch.value("--am-flags") ?? "").split(separator: ",").contains { $0 == flag } }
    /// "provider/openai" as ("provider", "openai").
    static var parts: (head: String, tail: String)? {
        guard let route else { return nil }
        let pieces = route.split(separator: "/", maxSplits: 1).map(String.init)
        return (pieces[0], pieces.count > 1 ? pieces[1] : "")
    }
}
