#if DEBUG
import Foundation

/// Canned answers for the admin server pages, so the real views can be looked at without a server (`--demo settings --open settings/users`).
/// The state of the demo changes as you use it (a person you add stays in the list). Launch with `--state <name>` for a variant:
///   empty, long, error, offline, forbidden, unsupported, loading                      (every page)
///   available (default), uptodate, manual, source, updating, restarting, failed,
///   nocheck, shared, nooidc                                                          (the Server page)
enum AdminServerDemo {
    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        guard AdminDemoState.methods.contains(method) else { return nil }
        return try AdminDemoState.shared.respond(method, params)
    }
}

final class AdminDemoState: @unchecked Sendable {
    static let shared = AdminDemoState()
    static let methods: Set<String> = ["users.list", "users.create", "users.update", "users.resetPassword", "users.delete", "invites.list", "invites.create", "invites.revoke", "limits.everyone", "settings.get", "settings.set", "settings.reset", "server.updates", "server.update", "oidc.list", "oidc.save", "oidc.remove", "audit.list", "audit.export", "app.info"]

    private let lock = NSLock()
    private let variant = Launch.value("--state") ?? ""
    private let launched = Date.now
    private var users: [[String: JSON]] = []
    private var invites: [[String: JSON]] = []
    private var providers: [[String: JSON]] = []
    private var limits: [String: Double] = ["tokensPerDay": 200_000, "costUsdPerDay": 5, "requestsPerHour": 30]
    private var signup = "invite"
    private var autoUpdate = false
    private var retention = 90
    private var updateStarted: Date?
    private var version = "0.10.1"

    private init() {
        seedUsers()
        seedInvites()
        seedProviders()
        if variant == "empty" { limits = [:] }
    }

    // MARK: Time

    private static func ms(_ secondsAgo: Double) -> JSON { .number(((Date.now.timeIntervalSince1970 - secondsAgo) * 1000).rounded()) }
    private static func msAhead(_ seconds: Double) -> JSON { ms(-seconds) }

    // MARK: Seed

    private func person(_ id: String, _ username: String, _ name: String, role: String = "user", disabled: Bool = false, must: Bool = false, password: Bool = true, safeguards: String = "inherit", own: JSON? = nil, active: Double? = nil, created: Double = 86400 * 40) -> [String: JSON] {
        var out: [String: JSON] = ["id": .string(id), "username": .string(username), "name": .string(name), "role": .string(role), "avatar": .null, "mustChangePassword": .bool(must), "hasPassword": .bool(password), "disabled": .bool(disabled), "safeguards": .string(safeguards), "createdAt": Self.ms(created), "lastActiveAt": active.map(Self.ms) ?? .null]
        if let own { out["limits"] = own }
        return out
    }

    private func seedUsers() {
        users = [person("u1", "maya", "Maya Lindqvist", role: "admin", active: 20, created: 86400 * 90)]
        if variant == "empty" { return }
        users += [
            person("u2", "mia.member", "Mia Member", must: true),
            person("u3", "jonas", "Jonas Weber", own: ["tokensPerDay": 500_000], active: 2 * 3600),
            person("u4", "anna", "Anna Keller", role: "admin", own: ["costUsdPerDay": .null], active: 26 * 3600),
            person("u5", "leo", "Leo Fischer", disabled: true, active: 12 * 86400),
            person("u6", "sam", "Sam Okafor", password: false, safeguards: "on", own: ["exempt": true], active: 3 * 86400),
            person("u7", "priya", "Priya Raman", role: "pending", created: 3 * 3600),
            person("u8", "tom", "Tom Becker", role: "pending", created: 26 * 3600),
        ]
        if variant == "long" {
            let names = ["Maximilian Alexander von Hohenzollern-Sigmaringen", "Charlotte Ann-Marie Delacroix", "Bartholomew Featherstonehaugh", "Ingrid Solveig Haraldsdottir", "Chen Wei", "Oluwaseun Adeyemi-Johnson", "Zoe", "Katarzyna Wojciechowska", "Hiroshi Tanaka", "Fatima Al-Sayed", "Lucas Oliveira", "Elena Petrova", "Noah Williams", "Aiko Yamamoto", "David Cohen", "Sofia Rossi"]
            for (i, name) in names.enumerated() {
                let username = String(name.lowercased().filter { $0.isLetter || $0 == " " }.replacingOccurrences(of: " ", with: ".").prefix(32))
                users.append(person("l\(i)", username, name, role: i % 7 == 0 ? "admin" : "user", disabled: i % 9 == 4, must: i % 5 == 2, active: i % 4 == 3 ? nil : Double(i + 1) * 5400))
            }
        }
    }

    private func seedInvites() {
        if variant == "empty" { return }
        invites = [
            ["id": "i1", "role": "user", "hint": "9BJY", "createdAt": Self.ms(86400), "expiresAt": Self.msAhead(86400 * 6), "usedAt": .null, "usedBy": .null],
            ["id": "i2", "role": "admin", "hint": "K2M4", "createdAt": Self.ms(5 * 86400), "expiresAt": Self.msAhead(86400 * 2), "usedAt": .null, "usedBy": .null],
            ["id": "i3", "role": "user", "hint": "7QWE", "createdAt": Self.ms(6 * 86400), "expiresAt": Self.msAhead(86400), "usedAt": Self.ms(3 * 86400), "usedBy": "u6"],
            ["id": "i4", "role": "user", "hint": "XH3P", "createdAt": Self.ms(12 * 86400), "expiresAt": Self.ms(5 * 86400), "usedAt": .null, "usedBy": .null],
        ]
    }

    private func seedProviders() {
        if variant == "empty" { return }
        providers = [
            ["id": "authentik", "name": "Authentik", "issuer": "https://auth.example.com/application/o/atelier/", "clientId": "atelier-prod-8f2c1d", "secret": "••••3f9a", "newAccounts": "pending", "people": 3],
            ["id": "google", "name": "Google", "issuer": "https://accounts.google.com", "clientId": "1234567890-abc.apps.googleusercontent.com", "secret": "••••wQ7z", "newAccounts": "none", "people": 12],
        ]
    }

    // MARK: Failures by variant

    private func failIfNeeded() throws {
        switch variant {
        case "error": throw MobileError.message("The server hit a problem and could not finish. Try again in a moment.")
        case "offline": throw MobileError.message("Not connected. Your draft is kept; reconnect before sending.")
        case "forbidden": throw MobileError.message("Only admins can do this.")
        case "unsupported": throw MobileError.message("Unknown method users.list")
        default: break
        }
    }

    // MARK: Dispatch

    func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        lock.lock(); defer { lock.unlock() }
        if method == "app.info" { return info() }
        try failIfNeeded()
        switch method {
        case "users.list": return .array(users.map(JSON.object))
        case "users.create": return try create(params)
        case "users.update": return try update(params)
        case "users.resetPassword": return try resetPassword(params)
        case "users.delete": return try delete(params)
        case "invites.list": return .array(invites.map(JSON.object))
        case "invites.create": return createInvite(params)
        case "invites.revoke": invites.removeAll { $0["id"]?.string == params["id"]?.string }; return ["ok": true]
        case "limits.everyone": return .array(users.filter { $0["role"]?.string != "pending" }.enumerated().map { limitsRow($0.element, index: $0.offset) })
        case "settings.get": return settings()
        case "settings.set": return try setSetting(params)
        case "settings.reset": return try resetSetting(params)
        case "server.updates": return updates()
        case "server.update": return try startUpdate()
        case "oidc.list": return variant == "nooidc" || variant == "shared" ? .null : ["redirectBase": "https://atelier.example.com/api/auth/oidc", "providers": .array(providers.map(JSON.object))]
        case "oidc.save": return try saveProvider(params)
        case "oidc.remove": providers.removeAll { $0["id"]?.string == params["id"]?.string }; return ["ok": true]
        case "audit.list": return auditList(params)
        case "audit.export": return auditExport(params)
        default: return nil
        }
    }

    private func info() -> JSON {
        var out: [String: JSON] = ["name": "Atelier", "version": .string(version), "surface": "web", "platform": "linux", "dataDir": "/data", "imageGeneration": true, "unifiedChat": true, "planAuto": true, "auditLog": true, "usageLimits": true, "terminalSignIn": true]
        if variant == "shared" { out["sharedComputer"] = true; out["platform"] = "darwin"; out["dataDir"] = "/Users/mia/.atelier"; out["auditLog"] = false }
        return .object(out)
    }

    // MARK: People

    private func index(_ id: String?) throws -> Int {
        guard let index = users.firstIndex(where: { $0["id"]?.string == id }) else { throw MobileError.message("No such user.") }
        return index
    }

    private func create(_ params: [String: JSON]) throws -> JSON {
        let username = params["username"]?.string ?? ""
        if users.contains(where: { $0["username"]?.string == username }) { throw MobileError.message("The username “\(username)” is taken.") }
        let new = person("n\(users.count + 1)", username, params["name"]?.string ?? username, role: params["role"]?.string ?? "user", must: true, created: 0)
        users.append(new)
        return ["user": .object(new), "temporaryPassword": "Xk4Pq-9vTmZ-7Wt2L"]
    }

    private func update(_ params: [String: JSON]) throws -> JSON {
        let i = try index(params["id"]?.string)
        let admins = users.filter { $0["role"]?.string == "admin" && $0["disabled"]?.bool != true }.count
        if users[i]["role"]?.string == "admin", admins <= 1, (params["role"].map { $0.string != "admin" } ?? false) || params["disabled"]?.bool == true {
            throw MobileError.message("This is the only admin. Make someone else an admin first.")
        }
        for key in ["name", "role", "disabled", "safeguards"] { if let value = params[key] { users[i][key] = value } }
        if let limits = params["limits"] {
            if case .object(let o) = limits, o.values.contains(where: { $0 != .bool(false) }) { users[i]["limits"] = limits } else { users[i]["limits"] = nil }
        }
        return .object(users[i])
    }

    private func resetPassword(_ params: [String: JSON]) throws -> JSON {
        let i = try index(params["id"]?.string)
        users[i]["mustChangePassword"] = true
        return ["temporaryPassword": "Rn8Hc-2yBdF-5Qj9V"]
    }

    private func delete(_ params: [String: JSON]) throws -> JSON {
        let i = try index(params["id"]?.string)
        users.remove(at: i)
        return ["ok": true]
    }

    private func createInvite(_ params: [String: JSON]) -> JSON {
        let role = params["role"]?.string ?? "user"
        let invite: [String: JSON] = ["id": .string("i\(invites.count + 10)"), "role": .string(role), "hint": "9BJY", "createdAt": Self.ms(0), "expiresAt": Self.msAhead(86400 * 7), "usedAt": .null, "usedBy": .null]
        invites.insert(invite, at: 0)
        return ["invite": .object(invite), "code": "267N-2WSH-SP99-9BJY"]
    }

    // MARK: Limits

    private func settings() -> JSON {
        var lim: [String: JSON] = [:]
        for (key, value) in limits { lim[key] = .number(value) }
        return ["effective": ["limits": .object(lim), "server": ["signup": .string(signup)], "audit": ["retentionDays": .number(Double(retention))], "safeguards": ["enabled": false]], "origins": [:], "projectRoot": .null, "errors": []]
    }

    private func setSetting(_ params: [String: JSON]) throws -> JSON {
        let path = params["path"]?.array.map(\.string) ?? []
        let value = params["value"] ?? .null
        switch path {
        case ["server", "signup"]: signup = value.string
        case ["server", "autoUpdate"]: autoUpdate = value.bool
        case ["audit", "retentionDays"]:
            guard value.int >= 7 else { throw MobileError.message("audit.retentionDays: Too small: expected number to be >=7") }
            retention = value.int
        default:
            guard path.count == 2, path[0] == "limits" else { throw MobileError.message("Unknown setting.") }
            guard case .number(let n) = value, n > 0 else { throw MobileError.message("limits.\(path[1]): Too small: expected number to be >0") }
            limits[path[1]] = n
        }
        return ["ok": true]
    }

    private func resetSetting(_ params: [String: JSON]) throws -> JSON {
        let path = params["path"]?.array.map(\.string) ?? []
        if path.count == 2, path[0] == "limits" { limits[path[1]] = nil }
        return ["ok": true]
    }

    /// Each person's usage against the limits that apply to them: made up, but steady from one call to the next.
    private func limitsRow(_ user: [String: JSON], index: Int) -> JSON {
        let own = user["limits"] ?? .object([:])
        var rows: [JSON] = []
        let exempt = own["exempt"].bool
        if !exempt {
            let resets: JSON = Self.msAhead(Double(86400 - Int(Date.now.timeIntervalSince1970) % 86400))
            for key in AdminLimitKey.allCases {
                var max: Double? = limits[key.rawValue]
                var overridden = false
                switch own[key.rawValue] {
                case .number(let n): max = n; overridden = true
                case .null: if own.entries.contains(where: { $0.0 == key.rawValue }) { max = nil; overridden = true }
                default: break
                }
                guard let max else { continue }
                let id = user["id"]?.string ?? ""
                let fraction: Double = id == "u3" && key == .tokensPerDay ? 0.86 : id == "u4" && key == .requestsPerHour ? 1.0 : 0.08 + Double((index * 7 + key.rawValue.count) % 40) / 100
                let used = key.unit == .usd ? (max * fraction * 100).rounded() / 100 : (max * fraction).rounded()
                var row: [String: JSON] = ["key": .string(key.rawValue), "used": .number(used), "max": .number(max), "resetsAt": key == .requestsPerHour ? .null : resets, "reached": .bool(fraction >= 1), "near": .bool(fraction >= 0.8)]
                if overridden { row["overridden"] = true }
                rows.append(.object(row))
            }
        }
        let status: JSON = ["exempt": .bool(exempt), "rows": .array(rows), "unpriced": rows.contains { $0["key"].string.hasPrefix("cost") } ? 14 : 0]
        return .object(["id": user["id"] ?? "", "username": user["username"] ?? "", "name": user["name"] ?? "", "disabled": user["disabled"] ?? false, "status": status, "own": own])
    }

    // MARK: Server

    private func updates() -> JSON {
        if variant == "shared" { return .null }
        let now = Date.now
        var latest: JSON = ["version": "0.11.0", "checkedAt": Self.ms(120)]
        var latestError: JSON = .null
        var install = "updater"
        var updaterError: JSON = .null
        var job: JSON = .null
        switch variant {
        case "uptodate": latest = ["version": "0.10.1", "checkedAt": Self.ms(300)]
        case "manual": install = "manual"; updaterError = "The updater can’t be reached at http://updater:7341."
        case "source": install = "source"
        case "nocheck": latest = .null; latestError = "Could not reach the update feed. Check the server's internet connection."
        case "updating": job = ["state": "pulling", "message": .null, "startedAt": Self.ms(30), "finishedAt": .null, "progress": ["done": 126_000_000, "total": 300_000_000, "percent": 42, "unpacking": false]]
        case "restarting": job = ["state": "restarting", "message": .null, "startedAt": Self.ms(60), "finishedAt": .null, "progress": .null]
        case "failed": job = ["state": "failed", "message": "pull access denied for ghcr.io/theoriuhd/atelier, repository does not exist or may require authorization", "startedAt": Self.ms(600), "finishedAt": Self.ms(590), "progress": .null]
        default: break
        }
        if let started = updateStarted {
            let elapsed = now.timeIntervalSince(started)
            if elapsed < 10 {
                let percent = Int(min(99, elapsed / 10 * 100))
                job = ["state": "pulling", "message": .null, "startedAt": Self.ms(elapsed), "finishedAt": .null, "progress": ["done": .number(Double(percent) * 3_000_000), "total": 300_000_000, "percent": .number(Double(percent)), "unpacking": false]]
            } else if elapsed < 13 {
                job = ["state": "restarting", "message": .null, "startedAt": Self.ms(elapsed), "finishedAt": .null, "progress": .null]
            } else {
                version = "0.11.0"
                latest = ["version": "0.11.0", "checkedAt": Self.ms(1)]
                job = ["state": "done", "message": .null, "startedAt": Self.ms(elapsed), "finishedAt": Self.ms(elapsed - 13), "progress": .null]
            }
        }
        // Automatic updates, as a server that has them says it: waiting for a reply that is being written.
        let auto: JSON = ["enabled": .bool(autoUpdate), "state": autoUpdate && install == "updater" ? "waiting" : "idle", "version": autoUpdate ? "0.11.0" : .null, "waitingFor": autoUpdate ? ["turns": 1, "background": 0] : .null, "error": .null, "retryAt": .null, "downloadsAhead": true]
        return .object(["auto": auto, "version": .string(version), "latest": latest, "latestError": latestError, "install": .string(install), "image": install == "updater" ? "ghcr.io/theoriuhd/atelier:latest" : .null, "updaterError": updaterError, "job": job])
    }

    private func startUpdate() throws -> JSON {
        if variant == "source" { throw MobileError.message("This server was built from source; update it by rebuilding its image.") }
        updateStarted = .now
        return updates()
    }

    private func saveProvider(_ params: [String: JSON]) throws -> JSON {
        let name = params["name"]?.string ?? ""
        let id = params["id"]?.string ?? AdminSSO.providerID(for: name)
        if params["id"] == nil, providers.contains(where: { $0["id"]?.string == id }) { throw MobileError.message("A provider with this name already exists.") }
        if (params["issuer"]?.string ?? "").contains("unreachable") { throw MobileError.message("Could not read the provider's configuration at that address.") }
        let existing = providers.first { $0["id"]?.string == id }
        let secret: JSON = (params["clientSecret"]?.string).map { _ in "••••new1" } ?? existing?["secret"] ?? .null
        let provider: [String: JSON] = ["id": .string(id), "name": .string(name), "issuer": params["issuer"] ?? "", "clientId": params["clientId"] ?? "", "secret": secret, "newAccounts": params["newAccounts"] ?? "pending", "people": existing?["people"] ?? 0]
        if let i = providers.firstIndex(where: { $0["id"]?.string == id }) { providers[i] = provider } else { providers.append(provider) }
        return .object(provider)
    }

    // MARK: Activity

    private struct Template { let kind: String; let actor: String?; let target: String?; let summary: String; let detail: JSON; let ip: String? }

    private static let templates: [Template] = [
        Template(kind: "signin.success", actor: "maya", target: "maya", summary: "maya signed in", detail: ["method": "password", "client": "mobile"], ip: "203.0.113.24"),
        Template(kind: "signin.failed", actor: "jonas", target: "jonas", summary: "Failed sign-in as jonas", detail: ["reason": "wrong password"], ip: "198.51.100.7"),
        Template(kind: "account.created", actor: "maya", target: "mia.member", summary: "Created the account mia.member", detail: ["role": "user", "via": "admin"], ip: "203.0.113.24"),
        Template(kind: "settings.changed", actor: "maya", target: "server.signup", summary: "Changed server.signup: invite → open", detail: ["path": "server.signup", "from": "invite", "to": "open"], ip: "203.0.113.24"),
        Template(kind: "signin.blocked", actor: nil, target: "admin", summary: "Sign-in as admin blocked after repeated failures", detail: ["limit": 8], ip: "192.0.2.99"),
        Template(kind: "invite.created", actor: "anna", target: "i1", summary: "Created an invite for a user", detail: ["role": "user", "expiresAt": .number(Double(Int(Date.now.timeIntervalSince1970 * 1000)) + 604_800_000)], ip: "203.0.113.31"),
        Template(kind: "account.role_changed", actor: "maya", target: "anna", summary: "Changed the role of anna from user to admin", detail: ["from": "user", "to": "admin"], ip: "203.0.113.24"),
        Template(kind: "provider.added", actor: "anna", target: "mistral", summary: "Added provider Mistral", detail: ["family": "text", "type": "mistral", "host": "api.mistral.ai", "enabled": true], ip: "203.0.113.31"),
        Template(kind: "secret.rotated", actor: "anna", target: "mistral-key", summary: "Replaced the secret mistral-key", detail: [:], ip: "203.0.113.31"),
        Template(kind: "limits.changed", actor: "maya", target: "limits.tokensPerDay", summary: "Changed limits.tokensPerDay: 100000 → 200000", detail: ["path": "limits.tokensPerDay", "from": 100000, "to": 200000], ip: "203.0.113.24"),
        Template(kind: "invite.used", actor: "sam", target: "i3", summary: "sam used an invite", detail: ["role": "user"], ip: "198.51.100.12"),
        Template(kind: "account.password_reset", actor: "maya", target: "mia.member", summary: "Reset the password of mia.member", detail: [:], ip: "203.0.113.24"),
        Template(kind: "plugin.installed", actor: "anna", target: "docs-helper", summary: "Installed plugin docs-helper", detail: ["source": "github.com/example/docs-helper"], ip: "203.0.113.31"),
        Template(kind: "server.update_started", actor: "maya", target: nil, summary: "Started a server update", detail: [:], ip: "203.0.113.24"),
        Template(kind: "audit.exported", actor: "maya", target: nil, summary: "Exported the activity log (212 events)", detail: ["events": 212], ip: "203.0.113.24"),
        Template(kind: "account.disabled", actor: "maya", target: "leo", summary: "Disabled the account leo", detail: [:], ip: "203.0.113.24"),
        Template(kind: "identity.saved", actor: "maya", target: "authentik", summary: "Saved the single sign-on provider Authentik", detail: ["newAccounts": "pending"], ip: "203.0.113.24"),
        Template(kind: "model.hidden", actor: "anna", target: "ollama/qwen3", summary: "Hid model ollama/qwen3", detail: ["family": "text"], ip: "203.0.113.31"),
        Template(kind: "signin.terminal_approved", actor: "maya", target: "Maya's MacBook", summary: "maya signed in a terminal on Maya's MacBook", detail: ["from": "203.0.113.24", "platform": "darwin"], ip: "203.0.113.24"),
        Template(kind: "connector.added", actor: "anna", target: "github", summary: "Added connector github", detail: [:], ip: "203.0.113.31"),
        Template(kind: "skill.installed", actor: "anna", target: "pdf, xlsx", summary: "Installed 2 skills", detail: ["source": "github.com/example/skills"], ip: "203.0.113.31"),
        Template(kind: "settings.instructions", actor: "maya", target: "AGENTS.md", summary: "Changed the system instructions", detail: ["characters": 2412], ip: "203.0.113.24"),
        Template(kind: "account.deleted", actor: "maya", target: "old.test", summary: "Deleted the account old.test and everything it owned", detail: ["role": "user"], ip: "203.0.113.24"),
        Template(kind: "plugin.futureevent", actor: "anna", target: "x", summary: "Did something a newer server records", detail: ["someNewKey": "value", "enabled": false], ip: "203.0.113.31"),
    ]

    private func allEvents() -> [JSON] {
        if variant == "empty" { return [] }
        let count = variant == "long" ? 140 : 58
        return (0..<count).map { i in
            let t = Self.templates[i % Self.templates.count]
            let ago = Double(i) * (variant == "long" ? 2700 : 5200) + 60 + Double(i % 5) * 311
            var summary = t.summary
            if variant == "long", i % 6 == 3 { summary += ". This one is deliberately long so the row wraps over several lines and shows how a lengthy sentence reads on a narrow screen."}
            return .object(["id": .string("e\(i)"), "at": Self.ms(ago), "kind": .string(t.kind), "actorId": t.actor == nil ? .null : "u1", "actor": t.actor.map(JSON.string) ?? .null, "target": t.target.map(JSON.string) ?? .null, "summary": .string(summary), "detail": t.detail, "ip": t.ip.map(JSON.string) ?? .null])
        }
    }

    private func filtered(_ params: [String: JSON]) -> [JSON] {
        allEvents().filter { event in
            if let kind = params["kind"]?.string, !event["kind"].string.hasPrefix(kind) { return false }
            if let user = params["user"]?.string.lowercased(), !user.isEmpty, !(event["actor"].string.lowercased().contains(user) || event["target"].string.lowercased().contains(user)) { return false }
            if case .number(let from)? = params["from"], event["at"].doubleValue < from { return false }
            if case .number(let to)? = params["to"], event["at"].doubleValue > to { return false }
            return true
        }
    }

    private func auditList(_ params: [String: JSON]) -> JSON {
        let matching = filtered(params)
        let limit = params["limit"]?.int ?? 50
        let start = params["cursor"].flatMap { Int($0.string) } ?? 0
        let page = Array(matching.dropFirst(start).prefix(limit))
        let end = start + page.count
        return ["events": .array(page), "next": end < matching.count ? .string(String(end)) : .null, "retentionDays": .number(Double(retention))]
    }

    private func auditExport(_ params: [String: JSON]) -> JSON {
        ["exportedAt": Self.ms(0), "retentionDays": .number(Double(retention)), "truncated": .bool(variant == "long"), "events": .array(filtered(params))]
    }
}
#endif
