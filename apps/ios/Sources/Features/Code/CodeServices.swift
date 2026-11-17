import Foundation
import Observation
import SwiftUI

// MARK: - What the Code screens share: server events, preferences, system settings, the open session's folder

/// Server events the Code screens need (terminal output, SSH questions, folder changes). `AppStore` keeps one handler for
/// everything the server pushes and ignores what it doesn't know, so this wraps it once: the store's own handler still
/// runs first, then every observer here.
@MainActor final class CodeEvents {
    static let shared = CodeEvents()
    private var handlers: [UUID: @MainActor (String, JSON) -> Void] = [:]
    private var installed: ObjectIdentifier?

    /// Starts listening on this store's connection (once per connection).
    func install(on store: AppStore) {
        let id = ObjectIdentifier(store.rpc)
        guard installed != id else { return }
        installed = id
        let previous = store.rpc.event
        store.rpc.event = { [weak self] method, value in
            previous?(method, value)
            self?.emit(method, value)
        }
    }

    /// Returns what to pass to `remove` when the observer goes away.
    @discardableResult
    func observe(_ handler: @escaping @MainActor (String, JSON) -> Void) -> UUID {
        let id = UUID()
        handlers[id] = handler
        return id
    }
    func remove(_ id: UUID) { handlers[id] = nil }

    func emit(_ method: String, _ value: JSON) {
        for handler in handlers.values { handler(method, value) }
    }
}

/// Runs a call and turns what goes wrong into words a person reads.
func codeCall(_ store: AppStore, _ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
    do { return try await store.rpc.call(method, params) }
    catch is CancellationError { throw CancellationError() }
    catch { throw MobileError.message(CodeFailure.words(error)) }
}

/// The server's own idea of itself that decides which Code controls make sense here.
@MainActor struct CodeCapabilities {
    let store: AppStore
    /// A desktop's own backend shared on the network (it runs commands on its own machine and reaches SSH hosts itself).
    var isDesktopBackend: Bool {
        #if DEBUG
        if Launch.value("--code-surface") == "desktop" { return true }
        #endif
        return store.info["surface"].string == "desktop"
    }
    /// Plan mode can be answered by the Auto reviewer.
    var planAuto: Bool { store.offers("planAuto") }
    /// Folders on the person's computers come from their desktop app connected to this server.
    var addsFoldersOnServer: Bool { !isDesktopBackend }
}

// MARK: Personal preferences

/// `prefs.get` / `prefs.set`: the person's own Code preferences, with the change shown at once and put back when the server refuses.
@MainActor @Observable final class CodePrefs {
    private(set) var prefs: JSON = .null
    var loadError: String?
    private let store: AppStore
    private var observer: UUID?

    init(store: AppStore) {
        self.store = store
        CodeEvents.shared.install(on: store)
        observer = CodeEvents.shared.observe { [weak self] method, value in
            guard method == "prefs.changed" else { return }
            self?.prefs = value
        }
    }
    isolated deinit { if let observer { CodeEvents.shared.remove(observer) } }

    var loaded: Bool { prefs != .null }

    func load() async {
        do { prefs = try await codeCall(store, "prefs.get"); loadError = nil }
        catch is CancellationError { return }
        catch { loadError = error.localizedDescription }
    }

    func string(_ path: [String], default fallback: String = "") -> String {
        var node = prefs
        for key in path { node = node[key] }
        return node.stringOrNil ?? fallback
    }
    func bool(_ path: [String], default fallback: Bool = false) -> Bool {
        var node = prefs
        for key in path { node = node[key] }
        return node.boolOrNil ?? fallback
    }
    func list(_ path: [String]) -> [String] {
        var node = prefs
        for key in path { node = node[key] }
        return node.array.map(\.string)
    }

    /// Sets one preference. Returns whether the server accepted it; a refusal shows as the shared alert.
    @discardableResult
    func set(_ path: [String], _ value: JSON) async -> Bool {
        let before = prefs
        prefs = Self.setting(prefs, path, value)
        do {
            prefs = try await codeCall(store, "prefs.set", ["path": .array(path.map(JSON.string)), "value": value])
            return true
        } catch is CancellationError { prefs = before; return false }
        catch {
            prefs = before
            store.error = error.localizedDescription
            return false
        }
    }

    static func setting(_ node: JSON, _ path: [String], _ value: JSON) -> JSON { CodeJSONPath.setting(node, path, value) }
}

/// Setting one value inside nested JSON by its path.
enum CodeJSONPath {
    static func setting(_ node: JSON, _ path: [String], _ value: JSON) -> JSON {
        guard let first = path.first else { return value }
        let base: JSON = { if case .object = node { return node }; return .object([:]) }()
        return base.setting(first, setting(base[first], Array(path.dropFirst()), value))
    }
}

// MARK: System settings (admins write, everyone reads)

/// `settings.get` / `settings.set`: what Code does for everyone on this server.
@MainActor @Observable final class CodeSystemSettings {
    private(set) var effective: JSON = .null
    var loadError: String?
    private let store: AppStore
    private var observer: UUID?

    init(store: AppStore) {
        self.store = store
        CodeEvents.shared.install(on: store)
        observer = CodeEvents.shared.observe { [weak self] method, value in
            guard method == "settings.changed" else { return }
            self?.effective = value["effective"]
        }
    }
    isolated deinit { if let observer { CodeEvents.shared.remove(observer) } }

    var loaded: Bool { effective != .null }

    func load() async {
        do { effective = try await codeCall(store, "settings.get")["effective"]; loadError = nil }
        catch is CancellationError { return }
        catch { loadError = error.localizedDescription }
    }

    func value(_ path: [String]) -> JSON {
        var node = effective
        for key in path { node = node[key] }
        return node
    }
    func string(_ path: [String], default fallback: String = "") -> String { value(path).stringOrNil ?? fallback }
    func bool(_ path: [String], default fallback: Bool) -> Bool { value(path).boolOrNil ?? fallback }
    func list(_ path: [String]) -> [String] { value(path).array.map(\.string) }

    /// The permission mode new sessions start in.
    var defaultMode: CodeMode { CodeMode(rawValue: string(["permissions", "defaultMode"], default: "auto")) ?? .auto }

    @discardableResult
    func set(_ path: [String], _ value: JSON) async -> Bool {
        let before = effective
        effective = CodePrefs.setting(effective, path, value)
        do {
            _ = try await codeCall(store, "settings.set", ["layer": .string("global"), "path": .array(path.map(JSON.string)), "value": value])
            return true
        } catch is CancellationError { effective = before; return false }
        catch {
            effective = before
            store.error = error.localizedDescription
            return false
        }
    }
    @discardableResult
    func reset(_ path: [String]) async -> Bool {
        let before = effective
        do {
            _ = try await codeCall(store, "settings.reset", ["layer": .string("global"), "path": .array(path.map(JSON.string))])
            await load()
            return true
        } catch is CancellationError { effective = before; return false }
        catch {
            effective = before
            store.error = error.localizedDescription
            return false
        }
    }
}

// MARK: The open session's folder

/// The Code session on screen and the folder it works in. Panels read it to know what to ask the server.
@MainActor struct CodeSession {
    let store: AppStore
    var id: String? { store.selected }
    var summary: Conversation? { store.sessions.first { $0.id == store.selected } }
    var isCode: Bool { summary?.mode == "code" }
    var title: String { summary?.title ?? "Session" }
    var running: Bool { store.transcript.status == "running" }
    var workspaceId: String? {
        summary?.raw["workspaceId"].stringOrNil ?? store.transcript.snapshot["session"]["workspaceId"].stringOrNil
    }
    /// The session's own mode; nil follows the system default.
    var permissionMode: CodeMode? { (summary?.raw["permissionMode"].stringOrNil ?? store.transcript.snapshot["session"]["permissionMode"].stringOrNil).flatMap(CodeMode.init(rawValue:)) }
    var tasks: [CodeTask] {
        #if DEBUG
        // Canned screens (`--demo`): the demo conversation carries no background tasks of its own.
        if Demo.requested != nil, store.transcript.snapshot["tasks"].array.isEmpty { return CodeDemo.tasks.map { CodeTask(raw: $0) } }
        #endif
        return store.transcript.snapshot["tasks"].array.map { CodeTask(raw: $0) }
    }
    var todos: [JSON] { store.transcript.snapshot["todos"].array }
    var messages: [JSON] {
        #if DEBUG
        if Demo.requested != nil { return store.transcript.messages + CodeDemo.extraMessages }
        #endif
        return store.transcript.messages
    }
}

/// Loads the folders and says what the session's folder allows. One per panel that needs a folder.
@MainActor @Observable final class CodeFolders {
    private(set) var all: [CodeWorkspace] = []
    private(set) var devices: [JSON] = []
    private(set) var state: CodeFolderState = .loading
    private(set) var workspace: CodeWorkspace?
    private(set) var didLoad = false
    var error: String?
    private let store: AppStore
    private var observer: UUID?

    init(store: AppStore) {
        self.store = store
        CodeEvents.shared.install(on: store)
        observer = CodeEvents.shared.observe { [weak self] method, value in
            guard method == "workspaces.changed" else { return }
            self?.apply(value.array.map(CodeWorkspace.init))
        }
    }
    isolated deinit { if let observer { CodeEvents.shared.remove(observer) } }

    /// Folders of the person's own, without the scratch folders sessions started with no folder.
    var folders: [CodeWorkspace] { CodeWorkspace.recent(all.filter { !$0.scratch }) }

    func load(devices wantDevices: Bool = false) async {
        do {
            apply(try await codeCall(store, "workspaces.list").array.map(CodeWorkspace.init))
            if wantDevices { devices = (try? await codeCall(store, "account.devices").array) ?? [] }
            error = nil
        } catch is CancellationError { return }
        catch { self.error = error.localizedDescription; if all.isEmpty { state = .missing } }
    }

    private func apply(_ list: [CodeWorkspace]) {
        all = list
        didLoad = true
        let session = CodeSession(store: store)
        var id = session.workspaceId
        #if DEBUG
        // Canned screens (`--demo`) have a session without a folder: look at its panels on the first one.
        if id == nil, Demo.requested != nil, session.isCode { id = list.first(where: { !$0.scratch })?.id }
        #endif
        guard let id else { workspace = nil; state = session.id == nil ? .loading : .none; return }
        guard let found = list.first(where: { $0.id == id }) else { workspace = nil; state = .missing; return }
        workspace = found
        state = found.available ? .ready : .offline(found.kind == .codespace ? "This codespace is stopped or can't be reached." : "This folder's computer is offline.")
    }
}

/// Shows a panel's content once the session has a folder that can be reached; says why when it doesn't.
struct CodeFolderGate<Content: View>: View {
    let folders: CodeFolders
    @ViewBuilder var content: (CodeWorkspace) -> Content

    var body: some View {
        switch folders.state {
        case .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .none:
            EmptyState(title: "No folder", symbol: "folder.badge.questionmark", message: "This session has no folder. Start a Code session in a folder to see its files and changes.").frame(maxHeight: .infinity)
        case .missing:
            if let error = folders.error { InlineError(message: error) { Task { await folders.load() } }.frame(maxHeight: .infinity) }
            else { EmptyState(title: "Folder not found", symbol: "folder.badge.minus", message: "This session's folder is no longer in your list.").frame(maxHeight: .infinity) }
        case .offline(let message):
            EmptyState(title: "Folder unavailable", symbol: "wifi.slash", message: message).frame(maxHeight: .infinity)
        case .ready:
            if let workspace = folders.workspace { content(workspace) }
        }
    }
}

// MARK: Code appearance

/// The syntax themes the person chose (Settings › Code), for the file viewer and the changes.
@MainActor @Observable final class CodeAppearance {
    static let shared = CodeAppearance()
    private(set) var light = "atelier-light"
    private(set) var dark = "atelier-dark"
    private var loaded = false

    func theme(dark isDark: Bool) -> CodeSyntaxTheme { CodeSyntaxTheme.resolve(isDark ? dark : light, dark: isDark) }

    func load(store: AppStore) async {
        guard !loaded else { return }
        guard let prefs = try? await store.rpc.call("prefs.get") else { return }
        loaded = true
        let theme = prefs["code"]["syntaxTheme"]
        if let value = theme["light"].stringOrNil { light = value }
        if let value = theme["dark"].stringOrNil { dark = value }
    }
}

/// A line of code colored in the person's theme, off the main thread.
enum CodeHighlighting {
    static func lines(_ lines: [String], language: String?, theme: CodeSyntaxTheme) async -> [AttributedString] {
        await Task.detached(priority: .userInitiated) { CodeSyntax.highlight(lines, language: language, theme: theme) }.value
    }
}
