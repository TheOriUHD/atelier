import SwiftUI
import Observation

// MARK: - Plain-language errors

/// What a server error says, turned into something a person can read. The connection keeps only the message of an
/// error (not its code), so this reads the message.
enum ChatError {
    static let unsupported = "This server doesn't support this yet."

    /// The server's own code decides first (the app code `forbidden`, the JSON-RPC code for an unknown procedure); the
    /// message's words are the fallback for older servers and for errors that are not the server's.
    static func text(_ error: Error) -> String {
        if let known = error as? MobileError {
            if known.isUnsupported { return unsupported }
            if known.appCode == "forbidden", !known.localizedDescription.lowercased().hasPrefix("only admins") { return "You don't have permission to do this." }
        }
        return text(error.localizedDescription)
    }

    static func text(_ message: String) -> String {
        let lower = message.lowercased()
        if lower.hasPrefix("unknown method") { return unsupported }
        if lower == "invalid params" || lower.hasPrefix("invalid params") { return "The server did not accept this. Update Atelier and try again." }
        if lower == "internal error" { return "The server ran into a problem. Try again in a moment." }
        if lower == "cancelled" { return "Cancelled." }
        if lower.hasPrefix("only admins") { return "Only admins can do this." }
        if lower.contains("not connected") && lower.contains("draft") { return "You're offline. Your draft is kept." }
        if lower.hasPrefix("connection interrupted") { return "The connection was interrupted. Check the conversation, then try again." }
        if lower.contains("could not connect") || lower.contains("network connection was lost") || lower.contains("the internet connection appears to be offline") { return "Can't reach the server. Check your connection." }
        if lower.contains("certificate") || lower.contains("secure connection") { return "This server's certificate isn't trusted, so the app won't connect." }
        return message
    }

    static func isUnsupported(_ error: Error) -> Bool { (error as? MobileError)?.isUnsupported == true || error.localizedDescription.lowercased().hasPrefix("unknown method") }
    static func isForbidden(_ error: Error) -> Bool { (error as? MobileError)?.appCode == "forbidden" || error.localizedDescription.lowercased().hasPrefix("only admins") }
}

// MARK: - Formatting

enum ChatText {
    /// "950", "200K", "1.5M".
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 {
            let value = Double(n) / 1_000_000
            return (value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)) + "M"
        }
        if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))K" }
        return String(n)
    }

    /// The desktop's long token count: "152,000" in a table, "152K" in a sentence.
    static func count(_ n: Int) -> String { n.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) }

    static func percent(_ part: Int, of whole: Int) -> String {
        guard whole > 0 else { return "0%" }
        let value = Double(part) / Double(whole) * 100
        return value.rounded() == value ? "\(Int(value))%" : String(format: "%.1f%%", value)
    }

    static func usd(_ value: Double) -> String { value < 0.01 && value > 0 ? "<$0.01" : value.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US"))) }

    /// "12s", "36m 32s", "2h 5m".
    static func elapsed(_ milliseconds: Double) -> String {
        let total = max(0, Int(milliseconds / 1000))
        if total < 60 { return "\(total)s" }
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }

    static func bytes(_ n: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }

    static func plural(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
}

// MARK: - Sessions as the lists see them

extension Conversation {
    var projectID: String? { raw["projectId"].stringOrNil }
    var groupID: String? { raw["groupId"].stringOrNil }
    var workspaceID: String? { raw["workspaceId"].stringOrNil }
    var archived: Bool { raw["archivedAt"] != .null }
    var isTemporary: Bool { raw["temporary"] != .null }
    var madeSomething: Bool { raw["produced"].bool }
    var created: Date { Date(timeIntervalSince1970: Double(raw["createdAt"].int) / 1000) }
    var pinnedAt: Date? { raw["pinnedAt"].date }
    /// Co-op: this person's part ("host", "editor", "viewer"), and the host's name; empty for a session of one.
    var coopRole: String { raw["coop"]["role"].string }
    var coopHost: String { raw["coop"]["hostName"].string }
    var coopEnded: Bool { raw["coop"]["ended"].bool }
    var isGuest: Bool { !coopRole.isEmpty && coopRole != "host" }
    var isShared: Bool { raw["coop"] != .null }
    var research: Bool { raw["research"].bool }
    var connectorsOff: [String] { raw["connectorsOff"].array.map(\.string) }
    var imageModel: String { raw["imageModel"].string }
    var effort: String { raw["effort"].string }
    var thinking: Bool { raw["thinking"] == .null ? true : raw["thinking"].bool }
    var remoteControl: Bool { raw["remoteControl"] == .null ? true : raw["remoteControl"].bool }
    var noun: String { mode == "code" ? "session" : "conversation" }
    /// What the list shows when the server has not titled it yet.
    var displayTitle: String { raw["title"].string.trimmingCharacters(in: .whitespaces).isEmpty ? "New \(noun)" : raw["title"].string }
}

// MARK: - Sidebar arrangement

enum ChatDayGroup: Int, CaseIterable {
    case today, yesterday, week, month, older
    var title: String {
        switch self {
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .week: "Previous 7 days"
        case .month: "Previous 30 days"
        case .older: "Older"
        }
    }
    static func of(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> ChatDayGroup {
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 1 { return .yesterday }
        return days <= 7 ? .week : days <= 30 ? .month : .older
    }
}

enum ChatGrouping: String, CaseIterable, Identifiable {
    case date, folder, state, custom, none
    var id: String { rawValue }
    var title: String {
        switch self {
        case .date: "Date"
        case .folder: "Folder"
        case .state: "Status"
        case .custom: "Your groups"
        case .none: "None"
        }
    }
}

enum ChatSorting: String, CaseIterable, Identifiable {
    case activity, created, name
    var id: String { rawValue }
    var title: String {
        switch self {
        case .activity: "Last activity"
        case .created: "Created"
        case .name: "Name"
        }
    }
}

/// One header and its rows in the sidebar.
struct ChatListGroup: Identifiable {
    let id: String
    let title: String
    var sessions: [Conversation]
    /// The person's own group, which can be renamed, collapsed and deleted.
    var custom: JSON?
    var collapsed: Bool { custom?["collapsed"].bool ?? false }
}

enum ChatArrange {
    static func sort(_ list: [Conversation], by sorting: ChatSorting) -> [Conversation] {
        switch sorting {
        case .activity: list.sorted { $0.updated > $1.updated }
        case .created: list.sorted { $0.created > $1.created }
        case .name: list.sorted { ($0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending) }
        }
    }

    /// Pinned first (newest pin first), then the rest in the order and grouping the person chose.
    static func arrange(_ sessions: [Conversation], grouping: ChatGrouping, sorting: ChatSorting, groups: [JSON], workspaces: [JSON], showEmptyGroups: Bool, now: Date = .now) -> (pinned: [Conversation], groups: [ChatListGroup]) {
        let pinned = sessions.filter(\.pinned).sorted { ($0.pinnedAt ?? .distantPast) > ($1.pinnedAt ?? .distantPast) }
        let rest = sort(sessions.filter { !$0.pinned }, by: sorting)
        switch grouping {
        case .none:
            return (pinned, rest.isEmpty ? [] : [ChatListGroup(id: "all", title: "Recents", sessions: rest)])
        case .date:
            var buckets: [ChatDayGroup: [Conversation]] = [:]
            for session in rest {
                let stamp = sorting == .created ? session.created : session.updated
                buckets[ChatDayGroup.of(stamp, now: now), default: []].append(session)
            }
            return (pinned, ChatDayGroup.allCases.compactMap { group in buckets[group].map { ChatListGroup(id: "date:\(group.title)", title: group.title, sessions: $0) } })
        case .state:
            let states: [(String, String, (Conversation) -> Bool)] = [
                ("waiting", "Needs your attention", { $0.status == "waiting" }),
                ("running", "Running", { $0.status == "running" }),
                ("unread", "Finished", { $0.unseen }),
                ("idle", "Idle", { _ in true }),
            ]
            var left = rest
            var out: [ChatListGroup] = []
            for (key, title, has) in states {
                let mine = left.filter(has)
                left.removeAll(where: has)
                if !mine.isEmpty { out.append(ChatListGroup(id: "state:\(key)", title: title, sessions: mine)) }
            }
            return (pinned, out)
        case .custom:
            var out: [ChatListGroup] = groups.map { group in
                ChatListGroup(id: "group:\(group["id"].string)", title: group["name"].string, sessions: rest.filter { $0.groupID == group["id"].string }, custom: group)
            }
            if !showEmptyGroups { out.removeAll { $0.sessions.isEmpty } }
            let known = Set(groups.map { $0["id"].string })
            let loose = rest.filter { $0.groupID == nil || !known.contains($0.groupID ?? "") }
            if !loose.isEmpty { out.append(ChatListGroup(id: "ungrouped", title: out.isEmpty ? "Recents" : "Ungrouped", sessions: loose)) }
            return (pinned, out)
        case .folder:
            var byFolder: [String: [Conversation]] = [:]
            var order: [String] = []
            for session in rest {
                // Every session without a folder (each with a scratch folder of its own) is one group.
                let workspace = workspaces.first { $0["id"].string == session.workspaceID }
                let key = workspace == nil || workspace?["scratch"].bool == true ? "" : (session.workspaceID ?? "")
                if byFolder[key] == nil { order.append(key) }
                byFolder[key, default: []].append(session)
            }
            var out = order.map { key -> ChatListGroup in
                let name = ChatFolders.name(workspaces.first { $0["id"].string == key })
                return ChatListGroup(id: "folder:\(key)", title: name, sessions: byFolder[key] ?? [])
            }
            if sorting == .name { out.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending } }
            return (pinned, out)
        }
    }
}

/// How a folder is named in lists.
enum ChatFolders {
    /// The last part of a folder's path, whether it is written with / or with \ (the Windows paths a computer reports), and
    /// "No folder" for a scratch folder or none at all.
    static func short(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    static func name(_ workspace: JSON?) -> String {
        guard let workspace, !workspace["scratch"].bool else { return "No folder" }
        let name = short(workspace["name"].string)
        return name.isEmpty ? "No folder" : name
    }
}

// MARK: - Branches: which messages are on screen, and which versions exist

/// The conversation as a person reads it: one branch, root to head, and the versions of each message (the "2/3" control).
struct ChatBranch: Equatable {
    var messages: [JSON]
    var siblings: [String: [String]]
}

enum Branching {
    /// The server's snapshot is one branch, and each run event appends to it. A retry or an edit adds a message whose
    /// parent already has a child: the new one replaces the old branch from that point and the two become versions of
    /// each other (the desktop does the same when it applies the event).
    static func resolve(messages: [JSON], siblings: JSON) -> ChatBranch {
        var result: [JSON] = []
        var groups: [String: [String]] = [:]
        for (key, value) in siblings.entries { groups[key] = value.array.map(\.string) }
        for message in messages {
            let id = message["id"].string
            let parent = message["parentId"].string
            if let existing = result.firstIndex(where: { $0["id"].string == id }) { result[existing] = message; continue }
            guard !parent.isEmpty, let parentIndex = result.firstIndex(where: { $0["id"].string == parent }) else { result.append(message); continue }
            let next = parentIndex + 1
            if next < result.count, result[next]["parentId"].string == parent, result[next]["kind"].string != "compaction_summary", message["kind"].string != "compaction_summary" {
                let replaced = result[next]["id"].string
                let group = (groups[replaced] ?? [replaced]).filter { $0 != id } + [id]
                for member in group { groups[member] = group }
                result = Array(result[...parentIndex]) + [message]
            } else {
                result.append(message)
            }
        }
        return ChatBranch(messages: result, siblings: groups.filter { $0.value.count > 1 })
    }
}

// MARK: - Effort (the same rules as the desktop's packages/protocol/src/effort.ts)

enum ChatEffort {
    static let order = ["low", "medium", "high", "xhigh", "max", "ultracode"]
    static let levels = ["low", "medium", "high", "xhigh", "max"]
    static let ultracodeLevel = "xhigh"

    static func label(_ effort: String) -> String {
        switch effort {
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra"
        case "max": "Max"
        case "ultracode": "Ultracode"
        default: effort.capitalized
        }
    }

    static let help: [String: String] = [
        "low": "Fastest replies, fewest tool calls. Quick questions and small, well-defined edits.",
        "medium": "Balanced depth and speed for everyday work with a clear scope.",
        "high": "More thinking and checking. Bug fixes and changes where edge cases matter.",
        "xhigh": "Deep reasoning for long, multi-step work. Slower and uses more tokens.",
        "max": "Everything the model has, for the hardest problems. Can be slow and costly.",
        "ultracode": "Plans each task, investigates in parallel with sub-agents and has others check the results, within a per-request budget. Much slower, far more tokens.",
    ]

    static let warnings: [String: String] = [
        "max": "Max uses about 3.5 times more tokens.",
        "ultracode": "Ultracode uses far more tokens and takes much longer.",
    ]

    private static func rank(_ effort: String) -> Int { order.firstIndex(of: effort) ?? 0 }

    static func stops(_ model: JSON?) -> [JSON] { model?["effortStops"].array ?? [] }

    /// The levels the model's own setting tells apart.
    static func native(_ model: JSON?) -> [String] {
        guard let model else { return [] }
        let stops = stops(model)
        if !stops.isEmpty { return stops.map { $0["effort"].string } }
        let reasoning = model["capabilities"]["reasoning"].string
        guard reasoning == "effort" || reasoning == "budget" else { return [] }
        let listed = levels.filter { model["effortLevels"].array.map(\.string).contains($0) }
        if !listed.isEmpty { return listed }
        return reasoning == "budget" ? levels : ["low", "medium", "high"]
    }

    static func modelEfforts(_ model: JSON?) -> [String] {
        guard let model else { return [] }
        let stops = stops(model)
        return stops.isEmpty ? levels : stops.map { $0["effort"].string }
    }

    static func offersUltracode(_ model: JSON?, mode: String, ultracode: Bool = true) -> Bool {
        ultracode && mode == "code" && model != nil && stops(model).isEmpty
    }

    static func choices(_ model: JSON?, mode: String, ultracode: Bool = true) -> [String] {
        let base = modelEfforts(model)
        return offersUltracode(model, mode: mode, ultracode: ultracode) ? base + ["ultracode"] : base
    }

    static func clamp(_ effort: String, to choices: [String]) -> String? {
        let wanted = rank(effort)
        return choices.last(where: { rank($0) <= wanted }) ?? choices.first
    }

    static func recommended(_ model: JSON?, mode: String) -> String? {
        let natives = native(model)
        let preferred = model?["recommendedEffort"][mode].stringOrNil ?? "medium"
        return clamp(preferred, to: natives.isEmpty ? modelEfforts(model) : natives)
    }

    /// The stop of the effort control a session is at: its own level, else the recommended one.
    static func shown(_ effort: String?, model: JSON?, mode: String, ultracode: Bool = true) -> String? {
        guard let model else { return nil }
        guard let effort, !effort.isEmpty else { return recommended(model, mode: mode) }
        let available = choices(model, mode: mode, ultracode: ultracode)
        let wanted = effort == "ultracode" && !available.contains("ultracode") ? (mode == "code" ? ultracodeLevel : "max") : effort
        return clamp(wanted, to: available)
    }

    static func name(_ level: String, model: JSON?) -> String {
        stops(model).first { $0["effort"].string == level }?["label"].string ?? label(level)
    }

    static func warning(_ level: String, model: JSON?) -> String? {
        stops(model).first { $0["effort"].string == level }?["warning"].stringOrNil ?? warnings[level]
    }

    /// What a level means for this model, in the person's terms.
    static func explanation(_ level: String, model: JSON?, mode: String) -> String {
        if let custom = stops(model).first(where: { $0["effort"].string == level })?["help"].stringOrNil { return custom }
        if level == "ultracode" {
            let under = explanation(ultracodeLevel, model: model, mode: mode)
            return under == help[ultracodeLevel] ? (help["ultracode"] ?? "") : "\(help["ultracode"] ?? "") \(under)"
        }
        let guidance = guidanceText(level, model: model, mode: mode)
        let asked = guidance.map { "The model is asked to \($0)." }
        switch model?["capabilities"]["reasoning"].string {
        case "toggle":
            let thinking = ["xhigh", "max"].contains(level) ? "Thinking is always on at this level." : "Thinking is controlled separately and is recommended."
            return "\(thinking) \(asked ?? "The model answers as it usually does.")"
        case "none":
            return asked ?? "The model answers as it usually does."
        default:
            guard let guidance else { return help[level] ?? "" }
            let natives = native(model)
            if level == "low" || natives.isEmpty { return "\(label(natives.first ?? "low")) is the lowest setting the model has, so it is also asked to \(guidance)." }
            return "\(label(natives.last ?? "high")) is the highest setting the model has: it runs there and is asked to \(guidance)."
        }
    }

    private static func guidanceText(_ level: String, model: JSON?, mode: String) -> String? {
        let shown = shown(level, model: model, mode: mode)
        let effective = shown == "ultracode" ? ultracodeLevel : shown
        guard let effective else { return nil }
        let table = ["low": "answer directly and keep it short", "high": "think the problem through and check its result before answering", "xhigh": "work step by step, try more than one approach and check each claim", "max": "apply the most rigor it can and verify everything it can, then re-check its answer"]
        if effective == "low" { return table["low"] }
        let natives = native(model)
        if natives.isEmpty { return table[effective] }
        if natives.contains(effective) { return nil }
        guard let top = natives.last, rank(effective) > rank(top) else { return nil }
        return table[effective]
    }
}

// MARK: - Models

struct ChatModelGroup: Identifiable {
    let id: String
    let label: String
    let models: [JSON]
    let offline: Bool
}

enum ChatModels {
    /// "200K context · vision · reasoning"; a personal model whose computer is away says so.
    static func subtitle(_ model: JSON) -> String {
        if model["available"] == .bool(false) { return "\(model["personal"]["deviceName"].stringOrNil ?? "Its computer") isn't connected" }
        var parts = ["\(ChatText.tokens(model["contextLength"].int)) context"]
        let capabilities = model["capabilities"]
        if capabilities["vision"].bool { parts.append("vision") }
        if capabilities["reasoning"].string != "none", !capabilities["reasoning"].string.isEmpty { parts.append("reasoning") }
        if capabilities["tools"].string == "prompted" { parts.append("prompted tools") } else if capabilities["tools"].string == "none" { parts.append("no tools") }
        if model["free"].bool { parts.append("free") }
        return parts.joined(separator: " · ")
    }

    static func name(_ ref: String, in models: [JSON]) -> String {
        models.first { $0["ref"].string == ref }?["displayName"].string ?? (ref.split(separator: "/").last.map(String.init) ?? ref)
    }

    /// Visible models by provider, favourites first; a person's own models by the computer they run on.
    static func groups(_ models: [JSON], providerNames: [String: String], matching query: String = "") -> [ChatModelGroup] {
        var order: [String] = []
        var buckets: [String: [JSON]] = [:]
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        for model in models where !model["hidden"].bool {
            if !needle.isEmpty, !(model["displayName"].string.lowercased().contains(needle) || model["ref"].string.lowercased().contains(needle) || (providerNames[model["providerId"].string] ?? "").lowercased().contains(needle)) { continue }
            let key = model["personal"] != .null ? "device:\(model["personal"]["deviceId"].string)" : model["providerId"].string
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(model)
        }
        return order.map { key in
            let list = (buckets[key] ?? []).sorted {
                if $0["favorite"].bool != $1["favorite"].bool { return $0["favorite"].bool }
                if $0["order"].int != $1["order"].int { return $0["order"].int < $1["order"].int }
                return $0["displayName"].string.localizedCaseInsensitiveCompare($1["displayName"].string) == .orderedAscending
            }
            let label = list.first?["personal"]["deviceName"].stringOrNil ?? providerNames[key] ?? list.first?["providerName"].stringOrNil ?? key
            return ChatModelGroup(id: key, label: label, models: list, offline: list.allSatisfy { $0["available"] == .bool(false) })
        }
    }
}

// MARK: - Slash commands

struct ChatSlashCommand: Identifiable, Equatable {
    enum Kind: Equatable { case builtIn, skill, command }
    let name: String
    let detail: String
    var hint = ""
    var kind: Kind = .builtIn
    var id: String { name }
    var symbol: String {
        switch name {
        case "compact": "arrow.down.right.and.arrow.up.left"
        case "clear": "square.and.pencil"
        case "model": "cpu"
        case "btw": "bubble.left.and.text.bubble.right"
        case "loop": "repeat"
        default: kind == .skill ? "text.book.closed" : "slash.circle"
        }
    }
}

enum ChatSlash {
    /// Names starting with what was typed first, then names containing it.
    static func filter(_ commands: [ChatSlashCommand], query: String) -> [ChatSlashCommand] {
        let needle = query.lowercased()
        let starts = commands.filter { $0.name.lowercased().hasPrefix(needle) }
        return starts + commands.filter { !starts.contains($0) && $0.name.lowercased().contains(needle) }
    }

    /// `/name args` at the start of the draft, with nothing before it.
    static func parse(_ text: String) -> (name: String, args: String)? {
        guard text.hasPrefix("/") else { return nil }
        let body = text.dropFirst()
        let name = body.prefix { !$0.isWhitespace }
        guard !name.isEmpty else { return nil }
        return (String(name), body.dropFirst(name.count).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The text of a `/` menu: the characters typed after the slash while still on the command's name.
    static func menuQuery(_ text: String) -> String? {
        guard text.hasPrefix("/"), !text.contains(where: { $0.isWhitespace }) else { return nil }
        return String(text.dropFirst())
    }

    /// The word the caret is in when it starts with `@` (a file mention in a Code session).
    static func mention(in text: String) -> String? {
        guard let last = text.split(separator: " ", omittingEmptySubsequences: false).last, last.hasPrefix("@"), !text.hasSuffix(" ") else { return nil }
        let word = last.split(separator: "\n", omittingEmptySubsequences: false).last ?? last
        guard word.hasPrefix("@") else { return nil }
        return String(word.dropFirst())
    }

    static func replacingMention(in text: String, with path: String) -> String {
        guard let range = text.range(of: "@", options: .backwards) else { return text }
        return String(text[..<range.lowerBound]) + "@\(path) "
    }
}

// MARK: - /loop

enum ChatLoop {
    enum Command: Equatable {
        case list
        case stop(String?)
        case start(interval: Int, prompt: String)
        case error(String)
    }
    static let defaultInterval = 10 * 60_000
    static let maxInterval = 24 * 3_600_000

    static func interval(_ text: String) -> Int? {
        guard !text.isEmpty else { return nil }
        var total = 0
        var number = ""
        var seen = Set<Character>()
        let units: [Character: Int] = ["d": 86_400_000, "h": 3_600_000, "m": 60_000, "s": 1000]
        let order: [Character] = ["d", "h", "m", "s"]
        var lastIndex = -1
        for character in text.lowercased() {
            if character.isNumber { number.append(character); continue }
            guard let unit = units[character], let index = order.firstIndex(of: character), index > lastIndex, !number.isEmpty, let value = Int(number), !seen.contains(character) else { return nil }
            total += value * unit; seen.insert(character); lastIndex = index; number = ""
        }
        return number.isEmpty ? total : nil
    }

    static func format(_ milliseconds: Int) -> String {
        var rest = max(0, Int((Double(milliseconds) / 1000).rounded()))
        var parts: [String] = []
        for (unit, size) in [("d", 86_400), ("h", 3_600), ("m", 60), ("s", 1)] {
            let n = rest / size
            rest -= n * size
            if n > 0 { parts.append("\(n)\(unit)") }
        }
        return parts.isEmpty ? "0s" : parts.joined(separator: " ")
    }

    static func parse(_ args: String) -> Command {
        let text = args.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.lowercased() == "list" { return .list }
        let words = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if words.first?.lowercased() == "stop", words.count <= 2 { return .stop(words.count == 2 ? words[1] : nil) }
        guard let first = words.first, let milliseconds = interval(first) else { return .start(interval: defaultInterval, prompt: text) }
        let prompt = text.dropFirst(first.count).trimmingCharacters(in: .whitespaces)
        if words.count < 2 || prompt.isEmpty { return .error("Add what to send every \(format(milliseconds)), like \"/loop \(first) check the deploy\".") }
        if milliseconds <= 0 { return .error("The interval has to be longer than zero.") }
        if milliseconds > maxInterval { return .error("The longest interval is \(format(maxInterval)).") }
        return .start(interval: milliseconds, prompt: prompt)
    }
}

// MARK: - Context breakdown

struct ChatContextRow: Identifiable {
    let id: String
    let label: String
    let tokens: Int
    let color: Color
}

enum ChatContext {
    /// The categories the desktop lists, then the room kept for the reply, then what is left; they fill the window.
    static func rows(_ context: JSON) -> [ChatContextRow] {
        let limit = context["limit"].int, used = context["used"].int, threshold = context["threshold"].int
        let categories = context["categories"]
        return [
            ChatContextRow(id: "messages", label: "Messages", tokens: categories["messages"].int, color: Theme.clay),
            ChatContextRow(id: "mcpTools", label: "Connector tools", tokens: categories["mcpTools"].int, color: Color(hex: 0x7A6FD0)),
            ChatContextRow(id: "systemTools", label: "System tools", tokens: categories["systemTools"].int, color: Theme.success),
            ChatContextRow(id: "skills", label: "Skills", tokens: categories["skills"].int, color: Theme.waiting),
            ChatContextRow(id: "systemPrompt", label: "System prompt", tokens: categories["systemPrompt"].int, color: Theme.inkMuted),
            ChatContextRow(id: "buffer", label: "Reserved for compaction", tokens: max(0, min(limit - threshold, limit - used)), color: Theme.fillStrong),
            ChatContextRow(id: "free", label: "Free space", tokens: max(0, threshold - used), color: Theme.fill),
        ]
    }
}

// MARK: - Settings pages a message error can point at

extension SettingsPageID {
    /// `settings/providers` (the `fix` of a message error) as a page; nil for a page the app doesn't have.
    static func fix(_ link: String) -> SettingsPageID? {
        SettingsPageID(rawValue: link.replacingOccurrences(of: "settings/", with: ""))
            ?? ["connection": SettingsPageID.server, "customize": SettingsPageID.skills][link.replacingOccurrences(of: "settings/", with: "")]
    }
}
