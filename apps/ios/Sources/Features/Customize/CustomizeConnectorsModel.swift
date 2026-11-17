import Foundation
import Observation

/// Everything the Connectors screens do with the server: the admin's connectors (settings) or the person's own, their live
/// status, and the changes. Views stay thin and read this; it is exercised without views by `CustomizeTests`.
@MainActor @Observable final class CustomizeConnectorsModel {
    enum Scope: Sendable { case admin, personal }
    typealias Phase = CustomizePhase

    let scope: Scope
    let store: AppStore
    var phase: Phase = .loading
    var connectors: [CustomizeConnector] = []
    var statuses: [CustomizeStatus] = []
    var permissions = CustomizePermissions()
    /// Connector ids with a change in flight, for spinners.
    var working: Set<String> = []
    /// A sign-in that could not start or finish, by connector id.
    var signInIssue: [String: String] = [:]
    /// Bumped whenever something starts connecting, so the screen's watcher runs again.
    var watchToken = 0
    /// The connector whose sign-in page is open now.
    private(set) var signingIn: String?
    private let web = CustomizeWebSignIn()

    init(store: AppStore, scope: Scope) { self.store = store; self.scope = scope }

    var admin: Bool { scope == .admin }
    /// An Atelier desktop app's own backend runs programs (stdio); a server never does.
    var runsPrograms: Bool { store.info["surface"].string == "desktop" }

    // MARK: Reading

    private func call(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        do { return try await store.rpc.call(method, params) } catch { throw CustomizeErrors.translated(error) }
    }

    func load() async {
        if phase != .ready { phase = .loading }
        do {
            switch scope {
            case .admin:
                let settings = try await call("settings.get")
                connectors = Self.adminConnectors(settings["effective"]["mcpServers"])
                permissions = CustomizePermissions(json: settings["effective"]["permissions"])
            case .personal:
                connectors = try await call("connectors.list").array.map(CustomizeConnector.personal(view:))
            }
            statuses = try await call("mcp.status").array.map(CustomizeStatus.init)
            phase = .ready
            watchToken += 1
        } catch is CancellationError {
        } catch {
            // Keep what is on screen when only a refresh failed; say so in the shared alert.
            if phase == .ready { store.error = CustomizeErrors.message(for: error) }
            else { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
        }
    }

    static func adminConnectors(_ servers: JSON) -> [CustomizeConnector] {
        servers.entries.map { CustomizeConnector.admin(name: $0.0, config: $0.1) }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func refreshStatuses() async {
        guard let list = try? await call("mcp.status") else { return }
        statuses = list.array.map(CustomizeStatus.init)
        if let id = signingIn, let connector = connectors.first(where: { $0.id == id }), status(for: connector)?.signIn != .waiting {
            web.cancel(); signingIn = nil
            if status(for: connector)?.state == .ready { store.notify("Signed in to \(connector.name)") }
        }
    }

    func connector(_ id: String) -> CustomizeConnector? { connectors.first { $0.id == id } }

    /// The live status of one of this screen's connectors (an admin's and a person's own may share a name).
    func status(for connector: CustomizeConnector) -> CustomizeStatus? {
        statuses.first { $0.name == connector.name && $0.personal == connector.personal }
    }

    func presentation(_ connector: CustomizeConnector) -> CustomizeStatusPresentation { .of(connector, status(for: connector)) }

    /// What the admin set up, as everyone else sees it: names, states and tool names.
    var sharedStatuses: [CustomizeStatus] { statuses.filter { !$0.personal } }

    /// Whether something is still connecting or waiting for a sign-in, so the screen keeps asking.
    var needsWatching: Bool {
        connectors.contains { connector in
            guard connector.enabled, !connector.clash else { return false }
            let status = status(for: connector)
            return status == nil || status?.state == .connecting || status?.signIn == .waiting
        }
    }

    /// Asks again every two seconds while something is connecting; ends by itself, and when the screen goes away.
    func keepFresh() async {
        var rounds = 0
        while !Task.isCancelled, needsWatching, rounds < 90 {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            await refreshStatuses()
            rounds += 1
        }
    }

    // MARK: Changing

    func setEnabled(_ shown: CustomizeConnector, _ on: Bool) async {
        // What the screen holds may be a moment old: a change builds on what is current.
        let connector = self.connector(shown.id) ?? shown
        update(connector.id) { $0.enabled = on }
        let ok = await store.attempt { [self] in
            if admin { _ = try await call("settings.set", ["layer": "global", "path": ["mcpServers", .string(connector.name), "enabled"], "value": .bool(on)]) }
            else { _ = try await call("connectors.save", connector.saveInput(enabled: on)) }
        }
        if !ok { update(connector.id) { $0.enabled = !on } }
        await refreshStatuses()
        watchToken += 1
    }

    func setTool(_ shown: CustomizeConnector, tool: String, enabled: Bool) async {
        let connector = self.connector(shown.id) ?? shown
        let before = connector.disabledTools
        var after = before.filter { $0 != tool }
        if !enabled { after.append(tool) }
        update(connector.id) { $0.disabledTools = after }
        let ok = await store.attempt { [self] in
            if admin { _ = try await call("settings.set", ["layer": "global", "path": ["mcpServers", .string(connector.name), "disabledTools"], "value": .array(after.map { JSON.string($0) })]) }
            else { _ = try await call("connectors.save", connector.saveInput(disabledTools: after)) }
        }
        if !ok { update(connector.id) { $0.disabledTools = before } }
    }

    func policy(_ connector: CustomizeConnector, tool: String) -> CustomizePolicy {
        permissions.policy(for: CustomizeNames.toolName(server: connector.name, tool: tool))
    }

    func setPolicy(_ connector: CustomizeConnector, tool: String, _ policy: CustomizePolicy) async {
        let before = permissions
        await writePermissions(before.setting(CustomizeNames.toolName(server: connector.name, tool: tool), to: policy), from: before)
    }

    private func writePermissions(_ next: CustomizePermissions, from before: CustomizePermissions) async {
        permissions = next
        let ok = await store.attempt { [self] in
            for kind in next.changes(from: before) {
                _ = try await call("settings.set", ["layer": "global", "path": ["permissions", .string(kind.rawValue)], "value": .array(next.list(kind).map { JSON.string($0) })])
            }
        }
        if !ok { permissions = before; await load() }
    }

    func test(_ connector: CustomizeConnector) async -> CustomizeStatus? {
        working.insert(connector.id); defer { working.remove(connector.id) }
        var result: CustomizeStatus?
        await store.attempt { [self] in
            let json = admin ? try await call("mcp.test", ["name": .string(connector.name)]) : try await call("connectors.test", ["id": .string(connector.id)])
            result = CustomizeStatus(json)
        }
        if let result {
            if let i = statuses.firstIndex(where: { $0.name == result.name && $0.personal == result.personal }) { statuses[i] = result } else { statuses.append(result) }
            if result.state == .ready { store.notify("Connected: \(CustomizeText.plural(result.tools.count, "tool"))") }
        }
        return result
    }

    func remove(_ connector: CustomizeConnector) async -> Bool {
        working.insert(connector.id); defer { working.remove(connector.id) }
        let before = permissions
        let ok = await store.attempt { [self] in
            if admin {
                _ = try await call("settings.reset", ["layer": "global", "path": ["mcpServers", .string(connector.name)]])
                let next = before.forgetting(server: connector.name)
                for kind in next.changes(from: before) {
                    _ = try await call("settings.set", ["layer": "global", "path": ["permissions", .string(kind.rawValue)], "value": .array(next.list(kind).map { JSON.string($0) })])
                }
                permissions = next
            } else {
                _ = try await call("connectors.remove", ["id": .string(connector.id)])
            }
        }
        if ok { connectors.removeAll { $0.id == connector.id }; store.notify("Removed \(connector.name)") }
        await refreshStatuses()
        return ok
    }

    func signOut(_ connector: CustomizeConnector) async {
        working.insert(connector.id); defer { working.remove(connector.id) }
        if await store.attempt({ [self] in _ = try await call("mcp.signOut", ["name": .string(connector.name)]) }) { store.notify("Signed out of \(connector.name)") }
        await refreshStatuses()
        watchToken += 1
    }

    func logs(_ connector: CustomizeConnector) async throws -> [String] {
        let json = admin ? try await call("mcp.logs", ["name": .string(connector.name)]) : try await call("connectors.logs", ["id": .string(connector.id)])
        return json["lines"].array.compactMap { $0.stringOrNil }
    }

    // MARK: Signing in

    /// Starts an OAuth connector's sign-in and opens its page in the system's sign-in sheet. The sheet closes by itself
    /// once the server says it is signed in; closing it earlier leaves the connector waiting ("Open it again", "Cancel").
    func signIn(_ connector: CustomizeConnector) async {
        signInIssue[connector.id] = nil
        working.insert(connector.id); defer { working.remove(connector.id) }
        do {
            let json = admin ? try await call("mcp.signIn", ["name": .string(connector.name)]) : try await call("connectors.signIn", ["id": .string(connector.id)])
            guard let url = CustomizeSignIn.safeURL(json["url"].string) else { throw MobileError.message("The server gave a sign-in address Atelier won't open.") }
            await refreshStatuses()
            signingIn = connector.id
            watchToken += 1
            web.start(url) { [weak self] in
                guard let self else { return }
                Task { @MainActor in
                    if self.signingIn == connector.id { self.signingIn = nil }
                    await self.refreshStatuses()
                    self.watchToken += 1
                }
            }
        } catch is CancellationError {
        } catch {
            signingIn = nil
            signInIssue[connector.id] = CustomizeErrors.message(for: error)
            await refreshStatuses()
        }
    }

    func cancelSignIn(_ connector: CustomizeConnector) async {
        web.cancel(); signingIn = nil
        if admin { await store.attempt { [self] in _ = try await call("mcp.cancelSignIn", ["name": .string(connector.name)]) } }
        await refreshStatuses()
    }

    // MARK: Adding and editing

    /// Writes the secrets first so the references resolve once the connector connects, then the entry.
    private func writeAdmin(name: String, entry: JSON, secrets: [CustomizeNewSecret]) async throws {
        for secret in secrets { _ = try await call("secrets.set", secret.params) }
        _ = try await call("settings.set", ["layer": "global", "path": ["mcpServers", .string(name)], "value": entry])
    }

    /// Saves the custom form: a new connector, or changes to `existing`. Returns the connector's id, or throws what to show under the form.
    @discardableResult
    func save(_ form: CustomizeConnectorForm, existing: CustomizeConnector?) async throws -> String {
        let name = form.name.trimmingCharacters(in: .whitespaces)
        var id = name
        if admin {
            let built = form.adminEntry(keeping: existing)
            try await writeAdmin(name: name, entry: built.entry, secrets: built.secrets)
        } else {
            let saved = try await call("connectors.save", form.personalInput(existing: existing))
            id = saved["id"].string
        }
        await load()
        store.notify(existing == nil ? "Added \(name)" : "Saved \(name)")
        if existing == nil, form.type != .stdio, form.oauth, let added = connector(id) { Task { await signIn(added) } }
        return id
    }

    /// Adds a ready-made connector (admin only): a pasted token, or the hosted server to sign in to.
    @discardableResult
    func addPreset(_ preset: CustomizePreset, name: String, token: String, fields: [String: String], signIn viaOAuth: Bool) async throws -> String {
        let name = name.trimmingCharacters(in: .whitespaces)
        if viaOAuth { try await writeAdmin(name: name, entry: CustomizePresetEntry.signIn(preset), secrets: []) }
        else { let built = CustomizePresetEntry.token(preset, name: name, token: token, fields: fields); try await writeAdmin(name: name, entry: built.entry, secrets: built.secrets) }
        await load()
        store.notify("Added \(name)")
        if viaOAuth, let added = connector(name) { Task { await signIn(added) } }
        return name
    }

    // MARK: Importing from Claude Code

    func importable() async throws -> [CustomizeImportEntry] {
        try await call(admin ? "mcp.import" : "connectors.import").array.map(CustomizeImportEntry.init)
    }

    /// Adds the chosen ones. What was written before a failure stays, and the list is read again either way.
    func runImport(_ entries: [CustomizeImportEntry]) async throws {
        do {
            for entry in entries {
                if admin { let built = entry.adminEntry(); try await writeAdmin(name: entry.name, entry: built.entry, secrets: built.secrets) }
                else { _ = try await call("connectors.save", entry.personalInput()) }
            }
        } catch {
            await load()
            throw error
        }
        await load()
        store.notify("Imported \(CustomizeText.plural(entries.count, "connector"))")
    }

    // MARK: Helpers

    private func update(_ id: String, _ change: (inout CustomizeConnector) -> Void) {
        if let i = connectors.firstIndex(where: { $0.id == id }) { change(&connectors[i]) }
    }

    /// The names already used by the connectors on this screen, other than `except`.
    func takenNames(except: String? = nil) -> Set<String> { Set(connectors.map(\.name)).subtracting(except.map { [$0] } ?? []) }
}
