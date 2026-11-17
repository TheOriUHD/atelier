import Foundation

// The admin activity log as the Activity page shows it: events from `audit.list`, the words each kind is shown in, the
// filters and the way a day's events are grouped. The server writes a plain sentence for every event (`summary`); the
// page adds a short title for the kind, an icon, and the details in words instead of keys. No views here, so it is tested.

/// What the log is filtered by, and how it is named. A kind is `<category>.<what happened>`.
enum AdminAuditCategory: String, CaseIterable, Identifiable, Sendable {
    case signin, account, invite, identity, settings, provider, secret, connector, plugin, skill, model, limits, server, audit
    var id: String { rawValue }

    var title: String {
        switch self {
        case .signin: "Sign-ins"
        case .account: "Accounts"
        case .invite: "Invites"
        case .identity: "Single sign-on"
        case .settings: "Settings"
        case .provider: "Providers"
        case .secret: "Keys and secrets"
        case .connector: "Connectors"
        case .plugin: "Plugins"
        case .skill: "Skills"
        case .model: "Models"
        case .limits: "Limits"
        case .server: "Server"
        case .audit: "This log"
        }
    }
    var symbol: String {
        switch self {
        case .signin: "person.badge.key"
        case .account: "person.crop.circle"
        case .invite: "ticket"
        case .identity: "person.badge.shield.checkmark"
        case .settings: "gearshape"
        case .provider: "bolt.horizontal"
        case .secret: "key"
        case .connector: "powerplug"
        case .plugin: "puzzlepiece.extension"
        case .skill: "wand.and.stars"
        case .model: "square.stack.3d.up"
        case .limits: "gauge.with.dots.needle.50percent"
        case .server: "server.rack"
        case .audit: "doc.text"
        }
    }

    /// The part of a kind before the dot; nil for one this app does not know (a newer server writes more).
    static func of(kind: String) -> AdminAuditCategory? {
        AdminAuditCategory(rawValue: kind.split(separator: ".", maxSplits: 1).first.map(String.init) ?? kind)
    }
}

struct AdminAuditRow: Equatable, Sendable, Identifiable {
    let label: String
    let value: String
    var id: String { label }
}

struct AdminAuditEvent: Identifiable, Equatable, Sendable {
    let id: String
    let at: Date
    let kind: String
    let actor: String?
    let target: String?
    let summary: String
    let detail: [String: JSON]
    let ip: String?

    init(_ json: JSON) {
        id = json["id"].string
        at = json["at"].date ?? .distantPast
        kind = json["kind"].string
        actor = json["actor"].stringOrNil
        target = json["target"].stringOrNil
        summary = json["summary"].string
        if case .object(let o) = json["detail"] { detail = o } else { detail = [:] }
        ip = json["ip"].stringOrNil
    }

    var category: AdminAuditCategory? { AdminAuditCategory.of(kind: kind) }
    var title: String { AdminAuditText.title(forKind: kind) }
    /// The server's sentence, with a settings path written the way the page names it: "Changed Sign-up: invite → open".
    var sentence: String {
        guard category == .settings || category == .limits, case .string(let path)? = detail["path"], !path.isEmpty else { return summary }
        return summary.replacingOccurrences(of: path, with: AdminAuditText.settingName(path))
    }
    var symbol: String { category?.symbol ?? "clock.arrow.circlepath" }

    enum Tone: Sendable { case normal, warning, danger }
    /// Sign-in trouble stands out; the rest is plain.
    var tone: Tone {
        switch kind {
        case "signin.blocked": .danger
        case "signin.failed": .warning
        default: .normal
        }
    }

    /// "Maya Lindqvist · Created the account member" reads from the summary; this is the who, for the second line.
    var byline: String {
        [actor.map { "by \($0)" }, AdminFormat.dateTime(at)].compactMap { $0 }.joined(separator: " · ")
    }

    var rows: [AdminAuditRow] { AdminAuditText.rows(for: self) }
}

struct AdminAuditDay: Identifiable, Equatable, Sendable {
    let day: Date
    let title: String
    let events: [AdminAuditEvent]
    var id: Date { day }
}

struct AdminAuditPage: Equatable, Sendable {
    let events: [AdminAuditEvent]
    let next: String?
    let retentionDays: Int
    init(_ json: JSON) {
        events = json["events"].array.map(AdminAuditEvent.init)
        next = json["next"].stringOrNil
        retentionDays = json["retentionDays"].int
    }
}

/// The filters of the list and of the export under it.
struct AdminAuditFilter: Equatable, Sendable {
    var category: AdminAuditCategory?
    var person = ""
    var from: Date?
    var to: Date?

    var isActive: Bool { category != nil || !trimmedPerson.isEmpty || from != nil || to != nil }
    var trimmedPerson: String { person.trimmingCharacters(in: .whitespaces) }

    /// `audit.list`'s and `audit.export`'s filter: the start of the first day and the last millisecond of the last one.
    func params(calendar: Calendar = .current) -> [String: JSON] {
        var out: [String: JSON] = [:]
        if let category { out["kind"] = .string(category.rawValue) }
        if !trimmedPerson.isEmpty { out["user"] = .string(trimmedPerson) }
        if let from { out["from"] = .number((calendar.startOfDay(for: from).timeIntervalSince1970 * 1000).rounded()) }
        if let to, let end = calendar.date(byAdding: DateComponents(day: 1, second: -1), to: calendar.startOfDay(for: to)) { out["to"] = .number((end.timeIntervalSince1970 * 1000).rounded() + 999) }
        return out
    }

    /// A line for the chips under the search field: "Accounts · Nov 3 to Nov 9".
    var summary: String {
        var parts: [String] = []
        if let category { parts.append(category.title) }
        if let from, let to { parts.append("\(AdminFormat.date(from)) to \(AdminFormat.date(to))") }
        else if let from { parts.append("From \(AdminFormat.date(from))") }
        else if let to { parts.append("Until \(AdminFormat.date(to))") }
        return parts.joined(separator: " · ")
    }
}

enum AdminAudit {
    static let pageSize = 50
    /// The retention choices; a stored value that is none of these shows as itself.
    static let retentionChoices = [7, 14, 30, 60, 90, 180, 365]

    /// Events grouped by the day they happened, newest day first, in the order they came.
    static func days(_ events: [AdminAuditEvent], calendar: Calendar = .current, now: Date = .now) -> [AdminAuditDay] {
        var order: [Date] = []
        var buckets: [Date: [AdminAuditEvent]] = [:]
        for event in events {
            let day = calendar.startOfDay(for: event.at)
            if buckets[day] == nil { order.append(day) }
            buckets[day, default: []].append(event)
        }
        return order.map { day in AdminAuditDay(day: day, title: dayTitle(day, calendar: calendar, now: now), events: buckets[day] ?? []) }
    }

    static func dayTitle(_ day: Date, calendar: Calendar = .current, now: Date = .now) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) { return "Yesterday" }
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        return sameYear ? day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) : day.formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// The file an export is saved as: `atelier-activity-2026-11-17.json`.
    static func exportFileName(now: Date = .now, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "atelier-activity-%04d-%02d-%02d.json", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}

// MARK: - Words

enum AdminAuditText {
    /// The kind in two or three words: "Failed sign-in", "Role changed". A kind this app does not know reads from its own name.
    static func title(forKind kind: String) -> String {
        if let known = titles[kind] { return known }
        let parts = kind.split(separator: ".", maxSplits: 1).map(String.init)
        let what = parts.count > 1 ? parts[1].replacingOccurrences(of: "_", with: " ") : kind
        if let category = AdminAuditCategory.of(kind: kind), parts.count > 1 { return "\(category.title): \(what)" }
        return capitalized(what)
    }

    private static let titles: [String: String] = [
        "signin.success": "Signed in", "signin.failed": "Failed sign-in", "signin.blocked": "Sign-in blocked",
        "signin.terminal_approved": "Terminal signed in", "signin.terminal_denied": "Terminal turned away",
        "account.created": "Account created", "account.updated": "Account changed", "account.role_changed": "Role changed",
        "account.disabled": "Account disabled", "account.enabled": "Account enabled", "account.deleted": "Account deleted", "account.password_reset": "Password reset",
        "invite.created": "Invite created", "invite.revoked": "Invite revoked", "invite.used": "Invite used",
        "identity.saved": "Single sign-on saved", "identity.removed": "Single sign-on removed",
        "settings.changed": "Setting changed", "settings.reset": "Setting reset", "settings.instructions": "Instructions changed",
        "provider.added": "Provider added", "provider.changed": "Provider changed", "provider.removed": "Provider removed",
        "provider.connected": "Provider connected", "provider.disconnected": "Provider disconnected",
        "secret.created": "Secret added", "secret.rotated": "Secret replaced", "secret.deleted": "Secret deleted",
        "connector.added": "Connector added", "connector.changed": "Connector changed", "connector.removed": "Connector removed",
        "connector.signed_in": "Connector signed in", "connector.signed_out": "Connector signed out",
        "plugin.installed": "Plugin installed", "plugin.removed": "Plugin removed", "plugin.enabled": "Plugin turned on", "plugin.disabled": "Plugin turned off", "plugin.changed": "Plugin changed",
        "skill.installed": "Skills installed", "skill.removed": "Skill removed",
        "model.hidden": "Model hidden", "model.unhidden": "Model shown", "model.changed": "Model changed",
        "limits.changed": "Limits changed",
        "server.update_started": "Server update started",
        "audit.exported": "Activity exported",
    ]

    /// "tokensPerDay" as "Tokens per day"; "single_sign_on" as "Single sign on".
    static func humanize(_ key: String) -> String {
        var out = ""
        for (index, character) in key.enumerated() {
            if character == "_" || character == "-" || character == "." { out += " "; continue }
            if character.isUppercase && index > 0 { out += " " }
            out.append(character.lowercased())
        }
        return capitalized(out)
    }

    private static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// A settings path in words. The few the admin pages edit read as their page does; the rest read from the path.
    static func settingName(_ path: String) -> String {
        let known: [String: String] = [
            "server.signup": "Sign-up", "audit.retentionDays": "Keep activity for",
            "limits.tokensPerDay": "Tokens per person per day", "limits.tokensPer30Days": "Tokens per person per 30 days",
            "limits.costUsdPerDay": "Cost per person per day", "limits.costUsdPer30Days": "Cost per person per 30 days", "limits.requestsPerHour": "Requests per person per hour",
            "safeguards.enabled": "Content safeguards",
        ]
        if let name = known[path] { return name }
        return path.split(separator: ".").map { humanize(String($0)) }.joined(separator: " › ")
    }

    private static func isOpaqueID(_ text: String) -> Bool {
        text.count == 36 && text.filter { $0 == "-" }.count == 4 && text.allSatisfy { $0.isHexDigit || $0 == "-" }
    }

    /// What this kind's target is: the account, the provider, the secret.
    private static func targetLabel(_ kind: String) -> String {
        switch AdminAuditCategory.of(kind: kind) {
        case .signin: kind.hasPrefix("signin.terminal") ? "Device" : "Account"
        case .account: "Account"
        case .identity: "Provider"
        case .settings: "Setting"
        case .provider: "Provider"
        case .secret: "Secret"
        case .connector: "Connector"
        case .plugin: "Plugin"
        case .skill: "Skill"
        case .model: "Model"
        default: "About"
        }
    }

    /// The event's facts as labelled rows: when, who, from where, about what, then its own details in words.
    static func rows(for event: AdminAuditEvent) -> [AdminAuditRow] {
        var rows: [AdminAuditRow] = [AdminAuditRow(label: "When", value: event.at.formatted(date: .abbreviated, time: .standard))]
        if let actor = event.actor { rows.append(AdminAuditRow(label: event.kind == "signin.failed" ? "Name tried" : "By", value: actor)) }
        if let ip = event.ip { rows.append(AdminAuditRow(label: "Address", value: ip)) }
        if let target = event.target, !isOpaqueID(target), target != event.actor {
            let value = event.category == .settings ? settingName(target) : target
            rows.append(AdminAuditRow(label: targetLabel(event.kind), value: value))
        }
        for (key, value) in event.detail.sorted(by: { $0.key < $1.key }) {
            if let row = detailRow(kind: event.kind, key: key, value: value) { rows.append(row) }
        }
        // Two rows with the same label would be the same id; the first wins.
        var seen = Set<String>()
        return rows.filter { seen.insert($0.label).inserted }
    }

    private static func detailRow(kind: String, key: String, value: JSON) -> AdminAuditRow? {
        let text = display(value)
        switch key {
        case "method": return AdminAuditRow(label: "Sign-in method", value: methods[text] ?? humanize(text))
        case "client": return AdminAuditRow(label: "App", value: clients[text] ?? humanize(text))
        case "role": return AdminAuditRow(label: "Role", value: roleWord(text))
        case "via": return AdminAuditRow(label: "How", value: vias[text] ?? humanize(text))
        case "from" where kind == "account.role_changed": return AdminAuditRow(label: "Was", value: roleWord(text))
        case "to" where kind == "account.role_changed": return AdminAuditRow(label: "Now", value: roleWord(text))
        case "from" where kind.hasPrefix("signin."): return AdminAuditRow(label: "Address", value: text)
        case "from": return AdminAuditRow(label: "Was", value: text)
        case "to": return AdminAuditRow(label: "Now", value: text)
        case "platform": return AdminAuditRow(label: "Platform", value: text)
        case "reason": return AdminAuditRow(label: "Reason", value: capitalized(text))
        case "fields": return AdminAuditRow(label: "Changed", value: text.split(separator: ",").map { humanize($0.trimmingCharacters(in: .whitespaces)) }.joined(separator: ", "))
        case "safeguards": return AdminAuditRow(label: "Safeguards", value: ["inherit": "Same as everyone", "on": "On", "off": "Off"][text] ?? humanize(text))
        case "characters": return AdminAuditRow(label: "Length", value: "\(text) characters")
        case "family": return AdminAuditRow(label: "Kind", value: text == "image" ? "Image" : (text == "text" ? "Text" : humanize(text)))
        case "type": return AdminAuditRow(label: "Type", value: text)
        case "host": return AdminAuditRow(label: "Address", value: text)
        case "enabled": return AdminAuditRow(label: "Turned on", value: text)
        case "expiresAt":
            if case .number = value, let date = value.date { return AdminAuditRow(label: "Expires", value: AdminFormat.dateTime(date)) }
            return AdminAuditRow(label: "Expires", value: text)
        case "minutes": return AdminAuditRow(label: "After", value: text == "0" ? "Never" : "\(text) minutes")
        case "newAccounts": return AdminAuditRow(label: "New people", value: AdminNewAccounts(rawValue: text)?.short ?? humanize(text))
        case "source": return AdminAuditRow(label: "Source", value: text)
        case "limit": return AdminAuditRow(label: "Attempts allowed", value: text)
        case "path": return AdminAuditRow(label: "Setting", value: settingName(text))
        case "layer": return AdminAuditRow(label: "Applies to", value: text == "global" ? "Everyone" : humanize(text))
        case "reset": return value.bool ? AdminAuditRow(label: "Reset", value: "Back to its default") : nil
        case "field": return AdminAuditRow(label: "Field", value: humanize(text))
        default: return AdminAuditRow(label: humanize(key), value: text)
        }
    }

    private static let methods = ["password": "Password", "setup": "First account setup", "passkey": "Passkey", "invite": "Invite code", "terminal": "Terminal app"]
    private static let clients = ["web": "Web browser", "desktop": "Desktop app", "cli": "Terminal app", "mobile": "iPhone or iPad app"]
    private static let vias = ["admin": "Added by an admin", "setup": "First account", "invite": "Invite code", "single sign-on": "Single sign-on", "open sign-up": "Open sign-up"]

    private static func roleWord(_ raw: String) -> String { AdminRole(rawValue: raw)?.title ?? humanize(raw) }

    /// A detail value in words: yes and no instead of true and false, a dash for nothing.
    static func display(_ value: JSON) -> String {
        switch value {
        case .string(let s): return s
        case .bool(let b): return b ? "Yes" : "No"
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .null: return "—"
        default: return ""
        }
    }
}
