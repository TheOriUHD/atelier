import Foundation

// The people of a server as the Users page sees them: parsed from `users.list` and `invites.list`, with the words each
// state is shown in. No views here, so all of it is tested.

enum AdminRole: String, CaseIterable, Identifiable, Sendable {
    case admin, user, pending
    var id: String { rawValue }
    var title: String {
        switch self {
        case .admin: "Admin"
        case .user: "User"
        case .pending: "Waiting for approval"
        }
    }
    /// What the role lets a person do, for the picker's footer.
    var explanation: String {
        switch self {
        case .admin: "Admins can change everything on this server: people, models, providers and settings. They still cannot read other people's conversations."
        case .user: "Users have their own conversations, projects and settings, and use the models you set up."
        case .pending: "They asked for an account and cannot sign in until you approve them."
        }
    }
}

/// A person's own choice about content safeguards, over the server's switch.
enum AdminSafeguards: String, CaseIterable, Identifiable, Sendable {
    case inherit, on, off
    var id: String { rawValue }
    func title(serverOn: Bool?) -> String {
        switch self {
        case .inherit: serverOn.map { "Default (\($0 ? "on" : "off"))" } ?? "Default"
        case .on: "On"
        case .off: "Off"
        }
    }
}

struct AdminPerson: Identifiable, Equatable, Sendable {
    let id: String
    let username: String
    let name: String
    let role: AdminRole
    let disabled: Bool
    let mustChangePassword: Bool
    let hasPassword: Bool
    let safeguards: AdminSafeguards
    /// The admin's own limits for this person, as the server stores them (`UserLimits`); empty when there are none.
    let limits: JSON
    let createdAt: Date?
    let lastActiveAt: Date?

    init(_ json: JSON) {
        id = json["id"].string
        username = json["username"].string
        name = json["name"].string.isEmpty ? json["username"].string : json["name"].string
        role = AdminRole(rawValue: json["role"].string) ?? .user
        disabled = json["disabled"].bool
        mustChangePassword = json["mustChangePassword"].bool
        hasPassword = json["hasPassword"] == .bool(false) ? false : true
        safeguards = AdminSafeguards(rawValue: json["safeguards"].string) ?? .inherit
        limits = json["limits"] == .null ? .object([:]) : json["limits"]
        createdAt = json["createdAt"].date
        lastActiveAt = json["lastActiveAt"].date
    }

    enum Status: Equatable { case active, disabled, temporaryPassword }
    var status: Status { disabled ? .disabled : (mustChangePassword ? .temporaryPassword : .active) }

    /// "Active 3 min ago", "Never signed in".
    var activity: String { lastActiveAt.map { "Active \($0.relative)" } ?? "Never signed in" }

    /// What this person's sign-in looks like, for the detail page.
    var passwordState: String {
        if !hasPassword { return "None. They sign in through single sign-on." }
        return mustChangePassword ? "Temporary. They choose their own at the next sign-in." : "Chosen by them"
    }

    /// Whether the admin set limits of their own for this person.
    var hasOwnLimits: Bool { AdminLimitDraft.hasOverrides(limits) }
    var isExempt: Bool { limits["exempt"].bool }
}

enum AdminPeople {
    /// People who can sign in first (admins, then by name), then nobody else: the waiting ones are a section of their own.
    static func members(_ all: [AdminPerson]) -> [AdminPerson] {
        all.filter { $0.role != .pending }.sorted {
            if $0.role != $1.role { return $0.role == .admin }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
    /// Requests newest first.
    static func waiting(_ all: [AdminPerson]) -> [AdminPerson] {
        all.filter { $0.role == .pending }.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
}

// MARK: - Entering a new person

enum AdminUsername {
    /// 2 to 32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.
    static func isValid(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard (2...32).contains(scalars.count), let first = scalars.first, isAlnum(first) else { return false }
        return scalars.allSatisfy { isAlnum($0) || $0 == "." || $0 == "_" || $0 == "-" }
    }
    private static func isAlnum(_ s: Unicode.Scalar) -> Bool { (s >= "a" && s <= "z") || (s >= "0" && s <= "9") }

    /// What is sent: trimmed and lowercased, as the server does.
    static func normalized(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// A username suggested by a name: "Mia Member" is "mia.member".
    static func suggest(from name: String) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        var out = ""
        for scalar in folded.unicodeScalars {
            if isAlnum(scalar) || scalar == "_" || scalar == "-" { out.unicodeScalars.append(scalar) }
            else if scalar == " " || scalar == "." { if !out.hasSuffix(".") && !out.isEmpty { out += "." } }
        }
        while out.hasSuffix(".") { out.removeLast() }
        return String(out.prefix(32))
    }

    /// The helper under the field, or nil when it is fine (or still empty).
    static func problem(_ text: String) -> String? {
        let name = normalized(text)
        if name.isEmpty { return nil }
        if name.count < 2 { return "Use at least 2 characters." }
        if name.count > 32 { return "Use at most 32 characters." }
        if !isValid(name) { return "Use letters, digits, dots, dashes or underscores, starting with a letter or digit." }
        return nil
    }
}

// MARK: - Invites

struct AdminInvite: Identifiable, Equatable, Sendable {
    let id: String
    let role: AdminRole
    /// The last group of the code, so admins can tell codes apart; nil for links made before there were codes.
    let hint: String?
    let createdAt: Date?
    let expiresAt: Date?
    let usedAt: Date?
    /// The id of the account the code created.
    let usedBy: String?

    init(_ json: JSON) {
        id = json["id"].string
        role = AdminRole(rawValue: json["role"].string) ?? .user
        hint = json["hint"].stringOrNil
        createdAt = json["createdAt"].date
        expiresAt = json["expiresAt"].date
        usedAt = json["usedAt"].date
        usedBy = json["usedBy"].stringOrNil
    }

    enum State: Equatable { case open, used, expired }
    func state(now: Date = .now) -> State {
        if usedAt != nil { return .used }
        if let expiresAt, expiresAt <= now { return .expired }
        return .open
    }

    /// Only the last group of a code is kept: `••••-••••-••••-9BJY`.
    var maskedCode: String { hint.map { "••••-••••-••••-\($0)" } ?? "Invite link" }

    /// "Works once, expires in 6 days", "Used by Mia Member on Nov 12", "Expired on Nov 3".
    func detail(now: Date = .now, people: [AdminPerson]) -> String {
        switch state(now: now) {
        case .open: return expiresAt.map { "\(role.title), expires \(AdminFormat.relative($0))" } ?? role.title
        case .used:
            let who = usedBy.flatMap { id in people.first { $0.id == id }?.name } ?? "a person who has since been deleted"
            return "Used by \(who)\(usedAt.map { " on \(AdminFormat.date($0))" } ?? "")"
        case .expired: return "Expired\(expiresAt.map { " on \(AdminFormat.date($0))" } ?? "")"
        }
    }
}

enum AdminInviteCode {
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// The 16 symbols of a code however it was typed, or nil when it can't be one (the server's own rule).
    static func normalize(_ input: String) -> String? {
        var code = ""
        for character in input.uppercased() {
            if character.isWhitespace || "-\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}".contains(character) { continue }
            code.append(character == "O" ? "0" : (character == "I" || character == "L") ? "1" : character)
        }
        return code.count == 16 && code.allSatisfy { alphabet.contains($0) } ? code : nil
    }

    /// `A1B2C3D4E5F6G7H8` as `A1B2-C3D4-E5F6-G7H8`.
    static func format(_ code: String) -> String {
        stride(from: 0, to: code.count, by: 4).map { start in
            let from = code.index(code.startIndex, offsetBy: start)
            let to = code.index(from, offsetBy: min(4, code.count - start))
            return String(code[from..<to])
        }.joined(separator: "-")
    }

    /// The link a browser opens to join with this code: `<server>/#/invite/<code>`.
    static func link(server: String, code: String) -> URL? {
        guard let compact = normalize(code) else { return nil }
        var base = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard base.hasPrefix("https://") || base.hasPrefix("http://") else { return nil }
        return URL(string: "\(base)/#/invite/\(compact)")
    }

    /// The message that goes with the code when an admin shares it.
    static func message(server: String, code: String, role: AdminRole, expiresAt: Date?) -> String {
        let host = URL(string: server)?.host ?? server
        var lines = ["You are invited to Atelier on \(host)."]
        if let link = link(server: server, code: code) {
            lines.append("")
            lines.append("Open this link in a browser to create your \(role == .admin ? "admin " : "")account:")
            lines.append(link.absoluteString)
        }
        lines.append("")
        lines.append("Or choose “I have a code” on the sign-in screen and enter:")
        lines.append(code)
        lines.append("")
        lines.append("The code works once\(expiresAt.map { " and expires on \(AdminFormat.date($0))" } ?? "").")
        return lines.joined(separator: "\n")
    }
}

/// The message that goes with a temporary password when an admin shares it.
enum AdminTemporaryPassword {
    static func message(server: String, username: String, password: String) -> String {
        let host = URL(string: server)?.host ?? server
        return """
        Your Atelier account on \(host) is ready.

        Username: \(username)
        Temporary password: \(password)

        Sign in with it, then choose a password of your own.
        """
    }
}
