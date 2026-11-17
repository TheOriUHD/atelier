import Foundation
import Observation

/// Everything the Users page shows.
struct AdminUsersSnapshot: Equatable, Sendable {
    var people: [AdminPerson]
    var invites: [AdminInvite]
    /// Why the invite codes could not be listed; nil when they could.
    var invitesProblem: String?
    /// Whether content safeguards are on for everyone, to say what "same as everyone" means; nil when it could not be read.
    var safeguardsOn: Bool?

    var members: [AdminPerson] { AdminPeople.members(people) }
    var waiting: [AdminPerson] { AdminPeople.waiting(people) }
    var openInvites: [AdminInvite] { invites.filter { $0.state() == .open } }
    var pastInvites: [AdminInvite] { invites.filter { $0.state() != .open } }
}

/// A person just created or a password just reset: shown once, never again.
struct AdminIssuedPassword: Identifiable, Equatable, Sendable {
    let id = UUID()
    let name: String
    let username: String
    let password: String
}

/// A new invite code: shown once.
struct AdminIssuedInvite: Identifiable, Equatable, Sendable {
    let id = UUID()
    let invite: AdminInvite
    let code: String
}

/// The Users page's data and what an admin can do to it. Every change asks the server and then shows what it answered.
@MainActor @Observable final class AdminUsersModel {
    private let rpc: Connection
    /// The account this device is signed in with: it cannot demote, disable, reset or delete itself here.
    let selfID: String
    let resource: Resource<AdminUsersSnapshot>
    /// Ids with a change in flight, so their controls wait.
    private(set) var busy: Set<String> = []
    /// A change that did not go through, in words, for the page's alert.
    var failure: String?

    init(rpc: Connection, selfID: String) {
        self.rpc = rpc
        self.selfID = selfID
        resource = Resource { try await Self.load(rpc) }
    }

    static func load(_ rpc: Connection) async throws -> AdminUsersSnapshot {
        if Launch.value("--state") == "loading" { try await Task.sleep(for: .seconds(3600)) }
        async let users = rpc.adminCall("users.list")
        async let invites = Self.optional(rpc, "invites.list")
        async let settings = Self.optional(rpc, "settings.get")
        let people = try await users.array.map(AdminPerson.init)
        let (inviteResult, settingsResult) = await (invites, settings)
        var snapshot = AdminUsersSnapshot(people: people, invites: [], invitesProblem: nil, safeguardsOn: nil)
        switch inviteResult {
        case .success(let json): snapshot.invites = json.array.map(AdminInvite.init)
        case .failure(let error): snapshot.invitesProblem = AdminFailure.message(for: error)
        }
        if case .success(let json) = settingsResult, case .bool(let on) = json["effective"]["safeguards"]["enabled"] { snapshot.safeguardsOn = on }
        return snapshot
    }

    /// A call whose failure is kept, so the page can carry on without it.
    private static func optional(_ rpc: Connection, _ method: String) async -> Result<JSON, Error> {
        do { return .success(try await rpc.adminCall(method)) } catch { return .failure(error) }
    }

    var snapshot: AdminUsersSnapshot? { resource.value }
    func person(_ id: String) -> AdminPerson? { snapshot?.people.first { $0.id == id } }
    func isBusy(_ id: String) -> Bool { busy.contains(id) }

    func reload() async { await resource.reload() }

    // MARK: Changes

    /// Runs a change for one person; a failure goes to `failure` and nothing changes on screen.
    private func run<T>(_ id: String, _ work: () async throws -> T) async -> T? {
        guard !busy.contains(id) else { return nil }
        busy.insert(id); defer { busy.remove(id) }
        do { return try await work() }
        catch is CancellationError { return nil }
        catch { failure = AdminFailure.message(for: error); return nil }
    }

    private func replace(_ updated: AdminPerson) {
        guard var snapshot else { return }
        if let index = snapshot.people.firstIndex(where: { $0.id == updated.id }) { snapshot.people[index] = updated } else { snapshot.people.append(updated) }
        resource.set(snapshot)
    }

    /// Creates the account and returns the temporary password; throws the server's words (taken username …) for the form to show.
    func create(username: String, name: String, role: AdminRole) async throws -> AdminIssuedPassword {
        let result = try await rpc.adminCall("users.create", ["username": .string(AdminUsername.normalized(username)), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "role": .string(role.rawValue)])
        let person = AdminPerson(result["user"])
        replace(person)
        return AdminIssuedPassword(name: person.name, username: person.username, password: result["temporaryPassword"].string)
    }

    /// Sends only what changed. Returns whether it went through.
    @discardableResult
    func update(_ id: String, name: String? = nil, role: AdminRole? = nil, disabled: Bool? = nil, safeguards: AdminSafeguards? = nil, limits: JSON? = nil) async -> Bool {
        var params: [String: JSON] = ["id": .string(id)]
        if let name { params["name"] = .string(name.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if let role { params["role"] = .string(role.rawValue) }
        if let disabled { params["disabled"] = .bool(disabled) }
        if let safeguards { params["safeguards"] = .string(safeguards.rawValue) }
        if let limits { params["limits"] = limits }
        let sent = params
        guard let result = await run(id, { try await rpc.adminCall("users.update", sent) }) else { return false }
        replace(AdminPerson(result))
        return true
    }

    func resetPassword(_ person: AdminPerson) async -> AdminIssuedPassword? {
        guard let result = await run(person.id, { try await rpc.adminCall("users.resetPassword", ["id": .string(person.id)]) }) else { return nil }
        // They are signed out everywhere and must choose a new password.
        await reload()
        return AdminIssuedPassword(name: person.name, username: person.username, password: result["temporaryPassword"].string)
    }

    func delete(_ person: AdminPerson) async -> Bool {
        guard await run(person.id, { try await rpc.adminCall("users.delete", ["id": .string(person.id)]) }) != nil else { return false }
        guard var snapshot else { return true }
        snapshot.people.removeAll { $0.id == person.id }
        resource.set(snapshot)
        return true
    }

    func approve(_ person: AdminPerson) async -> Bool { await update(person.id, role: .user) }
    /// A request that is turned down is deleted.
    func reject(_ person: AdminPerson) async -> Bool { await delete(person) }

    // MARK: Invites

    func createInvite(role: AdminRole) async throws -> AdminIssuedInvite {
        let result = try await rpc.adminCall("invites.create", ["role": .string(role.rawValue)])
        let invite = AdminInvite(result["invite"])
        if var snapshot { snapshot.invites.insert(invite, at: 0); resource.set(snapshot) }
        return AdminIssuedInvite(invite: invite, code: result["code"].string)
    }

    func revoke(_ invite: AdminInvite) async -> Bool {
        guard await run(invite.id, { try await rpc.adminCall("invites.revoke", ["id": .string(invite.id)]) }) != nil else { return false }
        guard var snapshot else { return true }
        snapshot.invites.removeAll { $0.id == invite.id }
        resource.set(snapshot)
        return true
    }
}
