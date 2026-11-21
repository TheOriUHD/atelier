import Foundation

// The Server page's facts: the version and how this server updates, the sign-up policy and the identity providers.
// Parsed from `server.updates`, `settings.get` and `oidc.list`. No views here, so all of it is tested.

enum AdminVersion {
    /// Compares two semver versions (build metadata ignored): negative when `a` is older, positive when newer. The server's rule.
    static func compare(_ a: String, _ b: String) -> Int {
        func split(_ version: String) -> (core: [Int], pre: [String]) {
            var plain = version.hasPrefix("v") ? String(version.dropFirst()) : version
            if let plus = plain.firstIndex(of: "+") { plain = String(plain[..<plus]) }
            if let dash = plain.firstIndex(of: "-") {
                return (plain[..<dash].split(separator: ".").map { Int($0) ?? 0 }, plain[plain.index(after: dash)...].split(separator: ".").map(String.init))
            }
            return (plain.split(separator: ".").map { Int($0) ?? 0 }, [])
        }
        let x = split(a), y = split(b)
        for i in 0..<3 {
            let p = i < x.core.count ? x.core[i] : 0, q = i < y.core.count ? y.core[i] : 0
            if p != q { return p - q }
        }
        // A release ranks above its own pre-releases.
        if x.pre.isEmpty || y.pre.isEmpty { return y.pre.count - x.pre.count }
        for i in 0..<max(x.pre.count, y.pre.count) {
            guard i < x.pre.count else { return -1 }
            guard i < y.pre.count else { return 1 }
            let p = x.pre[i], q = y.pre[i]
            if p == q { continue }
            let pn = Int(p), qn = Int(q)
            if let pn, let qn { return pn - qn }
            if (pn != nil) != (qn != nil) { return pn != nil ? -1 : 1 }
            return p < q ? -1 : 1
        }
        return 0
    }
}

/// The server's version and how it can be updated (`server.updates`).
struct AdminServerUpdate: Equatable, Sendable {
    enum Install: Equatable, Sendable {
        /// The Compose file's updater service can do it.
        case updater
        /// By hand, on the host.
        case manual
        /// Built from source: rebuild its image.
        case source
    }

    struct Progress: Equatable, Sendable {
        let done: Double
        let total: Double
        let percent: Int
        let unpacking: Bool
    }

    struct Job: Equatable, Sendable {
        enum State: String, Sendable { case idle, pulling, restarting, done, failed }
        let state: State
        let message: String?
        let finishedAt: Date?
        let progress: Progress?
    }

    /// How an automatic update stands (`server.updates` › `auto`); nil on a server from before automatic updates.
    struct Auto: Equatable, Sendable {
        enum State: String, Sendable { case idle, downloading, waiting, installing, failed }
        let enabled: Bool
        let state: State
        let version: String?
        let turns: Int
        let background: Int
        let error: String?
        let retryAt: Date?
    }

    let version: String
    let latestVersion: String?
    let checkedAt: Date?
    let latestError: String?
    let install: Install
    let image: String?
    let updaterError: String?
    let job: Job?
    let auto: Auto?

    /// Nil when the server says there is nothing to update here (a desktop app's own backend answers null).
    init?(_ json: JSON) {
        guard json != .null, !json["version"].string.isEmpty else { return nil }
        version = json["version"].string
        latestVersion = json["latest"]["version"].stringOrNil
        checkedAt = json["latest"]["checkedAt"].date
        latestError = json["latestError"].stringOrNil
        switch json["install"].string {
        case "updater": install = .updater
        case "source": install = .source
        default: install = .manual
        }
        image = json["image"].stringOrNil
        updaterError = json["updaterError"].stringOrNil
        if json["auto"] == .null { auto = nil } else {
            let auto = json["auto"]
            self.auto = Auto(enabled: auto["enabled"].bool, state: Auto.State(rawValue: auto["state"].string) ?? .idle, version: auto["version"].stringOrNil, turns: auto["waitingFor"]["turns"].int, background: auto["waitingFor"]["background"].int, error: auto["error"].stringOrNil, retryAt: auto["retryAt"].date)
        }
        if json["job"] == .null { job = nil } else {
            let job = json["job"]
            let progress: Progress? = job["progress"] == .null ? nil : Progress(done: job["progress"]["done"].doubleValue, total: job["progress"]["total"].doubleValue, percent: job["progress"]["percent"].int, unpacking: job["progress"]["unpacking"].bool)
            self.job = Job(state: Job.State(rawValue: job["state"].string) ?? .idle, message: job["message"].stringOrNil, finishedAt: job["finishedAt"].date, progress: progress)
        }
    }

    /// The newest version when it is newer than this one.
    var newerVersion: String? {
        guard let latestVersion, AdminVersion.compare(latestVersion, version) > 0 else { return nil }
        return latestVersion
    }

    /// An update is being installed right now.
    var isRunning: Bool { job?.state == .pulling || job?.state == .restarting }

    /// The line under the version.
    var versionDetail: String {
        if let newerVersion { return "Atelier \(newerVersion) is available." }
        if latestVersion != nil { return checkedAt.map { "Up to date. Checked \($0.relative)." } ?? "Up to date." }
        return latestError ?? "Checking for a newer version…"
    }

    /// What the update row says: progress while it runs, otherwise what to do (or why nothing can be done here).
    var updateDetail: String? {
        if let job, isRunning { return Self.progressText(job) }
        switch install {
        case .source: return "This server was built from source. Update it by rebuilding its image."
        case .manual:
            let why = updaterError.map { "\($0) " } ?? "This server has no updater service. "
            return "\(why)To update, run the command below on its host, in the folder with compose.yaml."
        case .updater:
            if let auto, auto.enabled, let line = autoDetail(auto) { return line }
            if job?.state == .done, let finished = job?.finishedAt { return "Updated \(finished.relative)." }
            return newerVersion != nil ? "Downloads the new version and restarts the server." : nil
        }
    }

    /// What an automatic update is doing, in words; nil when it has nothing to say (up to date).
    private func autoDetail(_ auto: Auto) -> String? {
        let version = auto.version ?? newerVersion ?? "the new version"
        switch auto.state {
        case .idle: return newerVersion != nil ? "Atelier \(version) is available. It downloads in a moment and installs by itself." : nil
        case .downloading: return "Downloading Atelier \(version) in the background."
        case .waiting:
            var busy: [String] = []
            if auto.turns > 0 { busy.append(auto.turns == 1 ? "1 reply" : "\(auto.turns) replies") }
            if auto.background > 0 { busy.append(auto.background == 1 ? "1 background task" : "\(auto.background) background tasks") }
            return busy.isEmpty ? "Atelier \(version) is downloaded and installs in a moment." : "Atelier \(version) is downloaded and installs as soon as nothing is running (\(busy.joined(separator: ", ")))."
        case .installing: return "Installing Atelier \(version). The app reconnects in a moment."
        case .failed: return "\(auto.error ?? "The automatic update failed.")\(auto.retryAt.map { " Trying again \($0.relative)." } ?? "")"
        }
    }

    /// Why the last update did not work, if it did not.
    var failure: String? {
        guard job?.state == .failed else { return nil }
        return "The last update failed: \(job?.message ?? "no reason given")."
    }

    /// Why the last update failed, without the sentence around it.
    var failureReason: String? { job?.state == .failed ? (job?.message ?? "No reason was given.") : nil }

    static let manualCommand = "docker compose pull && docker compose up -d"

    static func megabytes(_ bytes: Double) -> String {
        let value = bytes / 1_000_000
        return String(format: bytes < 10_000_000 ? "%.1f MB" : "%.0f MB", value)
    }

    /// While an update runs: what it does and how much of the new version is down.
    static func progressText(_ job: Job) -> String {
        if job.state == .restarting { return "This takes a minute or so. The app reconnects by itself when the server is back." }
        if let progress = job.progress {
            if progress.unpacking { return "Unpacking the new version…" }
            return "Downloading the new version… \(progress.percent)% · \(megabytes(progress.done)) of \(megabytes(progress.total))"
        }
        // An updater from before 0.7.1 says only the last line it printed.
        return "Downloading the new version…" + (job.message.map { " \($0)" } ?? "")
    }

    /// 0 to 1: full while the server restarts.
    var progressFraction: Double? {
        guard let job, isRunning else { return nil }
        if job.state == .restarting { return 1 }
        return job.progress.map { Double(min(100, max(0, $0.percent))) / 100 }
    }
}

// MARK: - Sign-up

enum AdminSignup: String, CaseIterable, Identifiable, Sendable {
    case invite, open
    var id: String { rawValue }
    var title: String { self == .invite ? "Invite only" : "Open, with approval" }
    var explanation: String {
        switch self {
        case .invite: "Admins add people or give them invite codes."
        case .open: "Anyone who can reach this server can ask for an account. Each request waits for you to approve it under Users."
        }
    }
}

// MARK: - Single sign-on

/// What happens to someone the identity provider vouches for who has no account here.
enum AdminNewAccounts: String, CaseIterable, Identifiable, Sendable {
    case pending, user, none
    var id: String { rawValue }
    var title: String {
        switch self {
        case .pending: "Create an account an admin approves"
        case .user: "Create an account right away"
        case .none: "Turn them away"
        }
    }
    var short: String {
        switch self {
        case .pending: "With approval"
        case .user: "Right away"
        case .none: "Existing accounts only"
        }
    }
}

struct AdminProvider: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let issuer: String
    let clientId: String
    /// The client secret's masked tail; nil for a public client.
    let secret: String?
    let newAccounts: AdminNewAccounts
    /// How many accounts sign in with it.
    let people: Int

    init(_ json: JSON) {
        id = json["id"].string
        name = json["name"].string
        issuer = json["issuer"].string
        clientId = json["clientId"].string
        secret = json["secret"].stringOrNil
        newAccounts = AdminNewAccounts(rawValue: json["newAccounts"].string) ?? .pending
        people = json["people"].int
    }
}

enum AdminSSO {
    /// The id a new provider gets from its name. It is part of the redirect URI, so it stays when the name changes (the server's rule).
    static func providerID(for name: String) -> String {
        let folded = name.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !(0x0300...0x036F).contains($0.value) }
        var id = ""
        var pendingDash = false
        for scalar in String(String.UnicodeScalarView(folded)).lowercased().unicodeScalars {
            if (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") {
                if pendingDash && !id.isEmpty { id += "-" }
                pendingDash = false
                id.unicodeScalars.append(scalar)
            } else { pendingDash = true }
        }
        id = String(id.prefix(40))
        while id.hasSuffix("-") { id.removeLast() }
        return id.isEmpty ? "sso" : id
    }

    /// The address to register at the identity provider: `<base>/<id>/callback`.
    static func redirectURI(base: String, id: String) -> String {
        var trimmed = base
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return "\(trimmed)/\(id)/callback"
    }
}

/// A provider as it is typed in the form, with the checks the desktop makes.
struct AdminProviderDraft: Equatable, Sendable {
    var name = ""
    var issuer = ""
    var clientId = ""
    var secret = ""
    var newAccounts: AdminNewAccounts = .pending

    init() {}
    init(_ provider: AdminProvider) { name = provider.name; issuer = provider.issuer; clientId = provider.clientId; newAccounts = provider.newAccounts }

    var nameProblem: String? { name.trimmingCharacters(in: .whitespaces).isEmpty ? "Name it: the sign-in page says “Continue with” this name." : (name.trimmingCharacters(in: .whitespaces).count > 60 ? "Use at most 60 characters." : nil) }
    var issuerProblem: String? {
        let text = issuer.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = url.host, !host.isEmpty else {
            return "Enter the issuer's address, starting with https://."
        }
        return nil
    }
    var clientIdProblem: String? { clientId.trimmingCharacters(in: .whitespaces).isEmpty ? "Enter the client ID from your provider." : nil }
    var isValid: Bool { nameProblem == nil && issuerProblem == nil && clientIdProblem == nil }

    /// `oidc.save`'s input: no `clientSecret` keeps the stored one.
    func params(id: String?) -> [String: JSON] {
        var out: [String: JSON] = ["name": .string(name.trimmingCharacters(in: .whitespaces)), "issuer": .string(issuer.trimmingCharacters(in: .whitespaces)), "clientId": .string(clientId.trimmingCharacters(in: .whitespaces)), "newAccounts": .string(newAccounts.rawValue)]
        if let id { out["id"] = .string(id) }
        if !secret.isEmpty { out["clientSecret"] = .string(secret) }
        return out
    }
}

/// The Server page's facts, each fetched on its own: a server that lacks one still shows the rest.
struct AdminServerSnapshot: Equatable, Sendable {
    var update: AdminServerUpdate?
    var signup: AdminSignup?
    var redirectBase: String?
    var providers: [AdminProvider] = []
    /// This connection reaches a desktop app's own backend over the network: one person, no accounts, no updater.
    var sharedComputer = false
    var version = ""
    var platform = ""
    var dataDir = ""
    var address = ""

    /// The platform's name as a person says it.
    static func platformName(_ raw: String) -> String {
        switch raw {
        case "darwin": "macOS"
        case "win32": "Windows"
        case "linux": "Linux"
        case "": ""
        default: raw
        }
    }
}
