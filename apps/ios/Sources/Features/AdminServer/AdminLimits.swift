import Foundation

// Usage limits for text models on a shared server: what they are, how an amount is typed and shown, and how a person's own
// limits are drafted. No views here, so all of it is tested. The rules are the server's (`packages/protocol/src/limits.ts`).

enum AdminLimitKey: String, CaseIterable, Identifiable, Sendable {
    case tokensPerDay, tokensPer30Days, costUsdPerDay, costUsdPer30Days, requestsPerHour
    var id: String { rawValue }

    enum Unit: Sendable { case tokens, usd, requests }
    enum Period: Sendable { case day, thirtyDays, hour }

    var unit: Unit {
        switch self {
        case .tokensPerDay, .tokensPer30Days: .tokens
        case .costUsdPerDay, .costUsdPer30Days: .usd
        case .requestsPerHour: .requests
        }
    }
    var period: Period {
        switch self {
        case .tokensPerDay, .costUsdPerDay: .day
        case .tokensPer30Days, .costUsdPer30Days: .thirtyDays
        case .requestsPerHour: .hour
        }
    }
    /// The limit's name, as the desktop's admin page has it.
    var title: String {
        switch self {
        case .tokensPerDay: "Tokens per day"
        case .tokensPer30Days: "Tokens per 30 days"
        case .costUsdPerDay: "Cost per day"
        case .costUsdPer30Days: "Cost per 30 days"
        case .requestsPerHour: "Requests per hour"
        }
    }
    /// A shorter name, for a row with little room.
    var short: String {
        switch self {
        case .tokensPerDay: "Tokens a day"
        case .tokensPer30Days: "Tokens in 30 days"
        case .costUsdPerDay: "Cost a day"
        case .costUsdPer30Days: "Cost in 30 days"
        case .requestsPerHour: "Requests an hour"
        }
    }
    /// What it counts, in a sentence.
    var explanation: String {
        switch self {
        case .tokensPerDay: "Input, output and cache tokens of text models, across all of a person's conversations, including deleted ones. A day is a UTC day and resets at 00:00 UTC."
        case .tokensPer30Days: "The same count over today and the 29 days before it."
        case .costUsdPerDay: "In dollars. Counts only requests to models that have a price. Local models cost nothing here, so limit them by tokens."
        case .costUsdPer30Days: "In dollars over today and the 29 days before it, for requests to models that have a price."
        case .requestsPerHour: "Model requests in the last 60 minutes, including titles, memory updates and sub-agents. Requests under way count too."
        }
    }
    var unitWord: String {
        switch unit {
        case .tokens: "tokens"
        case .usd: "dollars"
        case .requests: "requests"
        }
    }
    /// The words under a field that holds something that isn't an amount.
    var problem: String {
        switch unit {
        case .tokens: "Enter a whole number like 500000, or 500k or 2M. Leave it empty for no limit."
        case .usd: "Enter dollars like 5 or 0.50, or leave it empty for no limit."
        case .requests: "Enter a whole number, or leave it empty for no limit."
        }
    }
    var keyboardExample: String {
        switch unit {
        case .tokens: "500k"
        case .usd: "5.00"
        case .requests: "30"
        }
    }
}

enum AdminLimitAmount {
    /// "500000", "500,000", "500k" and "2M" for tokens and counts; "5", "$5" and "0.50" for dollars. Nil when it isn't a positive amount.
    static func parse(_ key: AdminLimitKey, _ text: String) -> Double? {
        var clean = text.lowercased().filter { !$0.isWhitespace && $0 != "," && $0 != "_" }
        if key.unit == .usd {
            if clean.hasPrefix("$") { clean.removeFirst() }
            guard isDecimal(clean, wholeOptional: true), let value = Double(clean.hasPrefix(".") ? "0" + clean : clean), value > 0 else { return nil }
            return value
        }
        var multiplier = 1.0
        if clean.hasSuffix("k") { multiplier = 1_000; clean.removeLast() } else if clean.hasSuffix("m") { multiplier = 1_000_000; clean.removeLast() }
        guard isDecimal(clean, wholeOptional: false), let value = Double(clean) else { return nil }
        let amount = (value * multiplier).rounded()
        return amount >= 1 ? amount : nil
    }

    /// Digits with at most one dot; `1.`, `.5` and `5` are fine for dollars, tokens need digits on both sides of a dot.
    private static func isDecimal(_ text: String, wholeOptional: Bool) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 2, parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }) else { return false }
        if parts.count == 1 { return !parts[0].isEmpty }
        if wholeOptional { return !(parts[0].isEmpty && parts[1].isEmpty) }
        return !parts[0].isEmpty && !parts[1].isEmpty
    }

    /// What goes back in a field for an amount: `500000`, `2.5`.
    static func text(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    private static let us = Locale(identifier: "en_US")

    /// "420", "420K", "1.2M".
    static func tokens(_ value: Double) -> String {
        value < 1000 ? value.formatted(.number.locale(us).precision(.fractionLength(0))) : value.formatted(.number.notation(.compactName).locale(us))
    }
    /// "$0.42", "$1,280.00"; under a cent reads "<$0.01".
    static func usd(_ value: Double) -> String {
        if value > 0 && value < 0.005 { return "<$0.01" }
        return value.formatted(.currency(code: "USD").locale(us))
    }
    static func whole(_ value: Double) -> String { value.formatted(.number.locale(us).precision(.fractionLength(0))) }

    /// "420K of 1M tokens", "$2.40 of $5.00", "12 of 30 requests".
    static func used(_ key: AdminLimitKey, used: Double, max: Double) -> String {
        switch key.unit {
        case .usd: "\(usd(used)) of \(usd(max))"
        case .tokens: "\(tokens(used)) of \(tokens(max)) tokens"
        case .requests: "\(whole(used)) of \(whole(max)) \(max == 1 ? "request" : "requests")"
        }
    }

    /// "200,000 tokens", "$5.00", "30 requests": a limit by itself.
    static func limit(_ key: AdminLimitKey, _ value: Double) -> String {
        switch key.unit {
        case .usd: value.formatted(.currency(code: "USD").locale(us))
        case .tokens: "\(whole(value)) tokens"
        case .requests: "\(whole(value)) \(value == 1 ? "request" : "requests")"
        }
    }
}

// MARK: - Usage against limits

struct AdminLimitRow: Equatable, Sendable, Identifiable {
    let key: AdminLimitKey
    let used: Double
    let max: Double
    let resetsAt: Date?
    let reached: Bool
    let near: Bool
    let overridden: Bool
    var id: String { key.rawValue }
    var fraction: Double { max > 0 ? Swift.min(1, used / max) : 0 }
    var percent: Int { Int((fraction * 100).rounded()) }
    var amounts: String { AdminLimitAmount.used(key, used: used, max: max) }

    /// Nil for a key this app does not know (a newer server's limit).
    init?(_ json: JSON) {
        guard let key = AdminLimitKey(rawValue: json["key"].string) else { return nil }
        self.key = key
        used = json["used"].doubleValue
        max = json["max"].doubleValue
        resetsAt = json["resetsAt"].date
        reached = json["reached"].bool
        near = json["near"].bool
        overridden = json["overridden"].bool
    }

    /// When it lets requests through again: "at 2:00 AM" within a day, "on Nov 9 at 2:00 AM" later.
    static func resetText(_ date: Date, now: Date = .now) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if date.timeIntervalSince(now) < 86_400 { return "at \(time)" }
        return "on \(date.formatted(.dateTime.month(.abbreviated).day())) at \(time)"
    }

    /// The line under a meter, by where the person stands.
    func note(now: Date = .now) -> String {
        if reached {
            return "Limit reached. " + (resetsAt.map { "It lifts \(Self.resetText($0, now: now))." } ?? "It lifts when the running requests finish.")
        }
        if near { return "\(percent)% used." + (resetsAt.map { " Resets \(Self.resetText($0, now: now))." } ?? "") }
        switch key.period {
        case .day: return resetsAt.map { "Resets \(Self.resetText($0, now: now)) (00:00 UTC)." } ?? "Resets at 00:00 UTC."
        case .hour: return "Counts the last 60 minutes."
        case .thirtyDays: return "Counts today and the 29 days before it."
        }
    }
}

extension JSON {
    /// A number as a double, 0 for anything else.
    var doubleValue: Double { if case .number(let n) = self { n } else { 0 } }
}

/// One person's row on the Limits page: their usage against the limits that apply to them.
struct AdminPersonLimits: Identifiable, Equatable, Sendable {
    let id: String
    let username: String
    let name: String
    let disabled: Bool
    let exempt: Bool
    let rows: [AdminLimitRow]
    let unpriced: Int
    /// Their override as stored (`UserLimits`).
    let own: JSON

    init(_ json: JSON) {
        id = json["id"].string
        username = json["username"].string
        name = json["name"].string.isEmpty ? json["username"].string : json["name"].string
        disabled = json["disabled"].bool
        exempt = json["status"]["exempt"].bool
        rows = json["status"]["rows"].array.compactMap(AdminLimitRow.init)
        unpriced = json["status"]["unpriced"].int
        own = json["own"] == .null ? .object([:]) : json["own"]
    }

    /// The limit they are closest to.
    var closest: AdminLimitRow? { rows.max { $0.fraction < $1.fraction } }
    var hasOwn: Bool { AdminLimitDraft.hasOverrides(own) }

    /// The note about cost limits that skip unpriced requests, when it applies.
    var unpricedNote: String? {
        guard unpriced > 0, rows.contains(where: { $0.key.unit == .usd }) else { return nil }
        return "\(AdminLimitAmount.whole(Double(unpriced))) \(unpriced == 1 ? "request" : "requests") in the last 30 days had no price (models without one, such as local models). A cost limit does not count them; a token limit does."
    }

    /// Who is at a limit first, then who is near one, then by name; people who cannot sign in are left out.
    static func ordered(_ people: [AdminPersonLimits]) -> [AdminPersonLimits] {
        people.filter { !$0.disabled }.sorted {
            let a = $0.closest, b = $1.closest
            if (a?.reached ?? false) != (b?.reached ?? false) { return a?.reached ?? false }
            if (a?.near ?? false) != (b?.near ?? false) { return a?.near ?? false }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

/// What everyone's limits and usage come to: one list from `limits.everyone`, the defaults from the settings.
struct AdminLimitsSnapshot: Equatable, Sendable {
    var people: [AdminPersonLimits]
    var system: [AdminLimitKey: Double]

    init(people: [AdminPersonLimits], system: [AdminLimitKey: Double]) { self.people = people; self.system = system }

    /// `settings.get`'s effective `limits` object: only the keys that are set.
    static func system(from settings: JSON) -> [AdminLimitKey: Double] {
        var out: [AdminLimitKey: Double] = [:]
        for key in AdminLimitKey.allCases { if case .number(let n) = settings["effective"]["limits"][key.rawValue] { out[key] = n } }
        return out
    }

    var anyLimitSet: Bool { !system.isEmpty || people.contains { $0.hasOwn } }
}

// MARK: - A person's own limits

/// An admin's override for one person, as it is edited: for each limit, follow everyone, set an own one, or lift it.
struct AdminLimitDraft: Equatable, Sendable {
    enum Choice: String, CaseIterable, Identifiable, Sendable {
        case inherit, custom, off
        var id: String { rawValue }
        var title: String {
            switch self {
            case .inherit: "Like everyone"
            case .custom: "Own limit"
            case .off: "No limit"
            }
        }
    }

    var exempt = false
    var choice: [AdminLimitKey: Choice] = [:]
    var amount: [AdminLimitKey: String] = [:]

    init(own: JSON = .object([:])) {
        exempt = own["exempt"].bool
        for key in AdminLimitKey.allCases {
            switch own[key.rawValue] {
            case .null: choice[key] = own.entries.contains { $0.0 == key.rawValue } ? .off : .inherit
            case .number(let n): choice[key] = .custom; amount[key] = AdminLimitAmount.text(n)
            default: choice[key] = .inherit
            }
        }
    }

    func choice(_ key: AdminLimitKey) -> Choice { choice[key] ?? .inherit }
    func amount(_ key: AdminLimitKey) -> String { amount[key] ?? "" }

    /// The first limit whose own amount is not a positive number.
    var problem: AdminLimitKey? {
        guard !exempt else { return nil }
        return AdminLimitKey.allCases.first { choice($0) == .custom && AdminLimitAmount.parse($0, amount($0)) == nil }
    }

    /// What `users.update` takes as `limits`: absent follows everyone, `null` lifts the limit, a number replaces it.
    var json: JSON {
        var out: [String: JSON] = [:]
        if exempt { out["exempt"] = .bool(true) }
        for key in AdminLimitKey.allCases {
            switch choice(key) {
            case .inherit: break
            case .off: out[key.rawValue] = .null
            case .custom: if let value = AdminLimitAmount.parse(key, amount(key)) { out[key.rawValue] = .number(value) }
            }
        }
        return .object(out)
    }

    /// Whether the stored override changes anything: any value other than `false` (a lifted limit is `null`).
    static func hasOverrides(_ json: JSON) -> Bool { json.entries.contains { $0.1 != .bool(false) } }

    /// How a person's limits read in one line.
    static func summary(own: JSON, system: [AdminLimitKey: Double]) -> String {
        if own["exempt"].bool { return "No limits" }
        guard hasOverrides(own) else { return system.isEmpty ? "No limits set" : "Like everyone" }
        return "Own limits"
    }
}
