import Foundation
import Observation

/// The Server page's data and what an admin can do on it: check for and install an update, choose how people sign up, and
/// manage the identity providers.
@MainActor @Observable final class AdminServerModel {
    private let store: AppStore
    private var rpc: Connection { store.rpc }
    let resource: Resource<AdminServerSnapshot>
    /// A change that did not go through, in words, for the page's alert.
    var failure: String?
    private(set) var checking = false
    private(set) var starting = false
    private(set) var savingSignup = false
    private(set) var savingAutoUpdate = false
    /// The server stopped answering while it updates: it is restarting.
    private(set) var reconnecting = false
    private var watching: Task<Void, Never>?
    /// What the version was when the update started, to know the restart brought the new one.
    private var versionBefore: String?

    init(store: AppStore) {
        self.store = store
        let rpc = store.rpc
        let address = store.address
        resource = Resource { try await Self.load(rpc, address: address) }
    }

    static func load(_ rpc: Connection, address: String) async throws -> AdminServerSnapshot {
        if Launch.value("--state") == "loading" { try await Task.sleep(for: .seconds(3600)) }
        async let info = rpc.adminCall("app.info")
        async let updates = optional(rpc, "server.updates")
        async let settings = optional(rpc, "settings.get")
        async let oidc = optional(rpc, "oidc.list")
        var snapshot = AdminServerSnapshot()
        let about = try await info
        snapshot.sharedComputer = about["sharedComputer"].bool
        snapshot.version = about["version"].string
        snapshot.platform = AdminServerSnapshot.platformName(about["platform"].string)
        snapshot.dataDir = about["dataDir"].string
        snapshot.address = address
        let (updateResult, settingsResult, oidcResult) = await (updates, settings, oidc)
        if case .success(let json) = updateResult { snapshot.update = AdminServerUpdate(json) }
        if case .success(let json) = settingsResult { snapshot.signup = AdminSignup(rawValue: json["effective"]["server"]["signup"].string) }
        if case .success(let json) = oidcResult, json != .null {
            snapshot.redirectBase = json["redirectBase"].string
            snapshot.providers = json["providers"].array.map(AdminProvider.init)
        }
        return snapshot
    }

    private static func optional(_ rpc: Connection, _ method: String) async -> Result<JSON, Error> {
        do { return .success(try await rpc.adminCall(method)) } catch { return .failure(error) }
    }

    var snapshot: AdminServerSnapshot? { resource.value }
    func reload() async { await resource.reload() }

    private func mutate(_ change: (inout AdminServerSnapshot) -> Void) {
        guard var snapshot else { return }
        change(&snapshot)
        resource.set(snapshot)
    }

    // MARK: Updates

    /// Asks the server for the newest version, skipping its 10-minute memory.
    func check() async {
        guard !checking else { return }
        checking = true; defer { checking = false }
        do {
            let status = try await rpc.adminCall("server.updates", ["refresh": .bool(true)])
            mutate { $0.update = AdminServerUpdate(status) }
        } catch is CancellationError { return } catch { failure = AdminFailure.message(for: error) }
    }

    /// Asks the server's updater to install the newest version, and watches it do so.
    func startUpdate() async {
        guard !starting, let before = snapshot?.update?.version else { return }
        starting = true; defer { starting = false }
        do {
            versionBefore = before
            let status = try await rpc.adminCall("server.update")
            mutate { $0.update = AdminServerUpdate(status) }
            watch()
        } catch is CancellationError { return } catch { failure = AdminFailure.message(for: error) }
    }

    /// Follows a running update every two seconds, through the restart, until it ends; stops when the page goes.
    func watch() {
        guard watching == nil, snapshot?.update?.isRunning == true else { return }
        watching = Task { [weak self] in
            var silent = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                do {
                    let status = try await self.rpc.call("server.updates")
                    self.reconnecting = false; silent = 0
                    let update = AdminServerUpdate(status)
                    self.mutate { $0.update = update }
                    if update?.isRunning != true { await self.finishedUpdate(update); return }
                } catch is CancellationError { return } catch {
                    // The server is restarting: carry on for a few minutes, the app reconnects by itself.
                    self.reconnecting = true; silent += 1
                    if silent > 150 { self.reconnecting = false; self.watching = nil; return }
                }
            }
        }
    }

    func stopWatching() { watching?.cancel(); watching = nil }

    private func finishedUpdate(_ update: AdminServerUpdate?) async {
        watching = nil
        if let fresh = try? await rpc.call("app.info"), !fresh["version"].string.isEmpty { store.info = fresh }
        await reload()
        if let update, update.job?.state == .failed { return }
        if let now = snapshot?.version, let before = versionBefore, now != before { store.notify("Updated to Atelier \(now)") }
    }

    /// Turns the automatic update on or off: the server downloads a new version as soon as it is out and installs it when nothing runs.
    func setAutoUpdate(_ on: Bool) async {
        guard !savingAutoUpdate, snapshot?.update?.auto?.enabled != on else { return }
        savingAutoUpdate = true; defer { savingAutoUpdate = false }
        do {
            _ = try await rpc.adminCall("settings.set", ["layer": "global", "path": .array([.string("server"), .string("autoUpdate")]), "value": .bool(on)])
            // The server looks at once: read what it says now.
            let status = try await rpc.adminCall("server.updates")
            mutate { $0.update = AdminServerUpdate(status) }
            store.notify("Saved")
        } catch is CancellationError { return } catch { failure = AdminFailure.message(for: error) }
    }

    // MARK: Sign-up

    func setSignup(_ policy: AdminSignup) async {
        guard !savingSignup, snapshot?.signup != policy else { return }
        savingSignup = true; defer { savingSignup = false }
        do {
            _ = try await rpc.adminCall("settings.set", ["layer": "global", "path": .array([.string("server"), .string("signup")]), "value": .string(policy.rawValue)])
            mutate { $0.signup = policy }
            store.notify("Saved")
        } catch is CancellationError { return } catch { failure = AdminFailure.message(for: error) }
    }

    // MARK: Identity providers

    /// Adds a provider (no `id`) or changes one; throws the server's words (it reads the provider's configuration before it saves).
    @discardableResult
    func saveProvider(_ draft: AdminProviderDraft, id: String?) async throws -> AdminProvider {
        let result = try await rpc.adminCall("oidc.save", draft.params(id: id))
        let provider = AdminProvider(result)
        mutate { snapshot in
            if let index = snapshot.providers.firstIndex(where: { $0.id == provider.id }) { snapshot.providers[index] = provider } else { snapshot.providers.append(provider) }
        }
        return provider
    }

    func removeProvider(_ provider: AdminProvider) async throws {
        _ = try await rpc.adminCall("oidc.remove", ["id": .string(provider.id)])
        mutate { $0.providers.removeAll { $0.id == provider.id } }
    }
}
