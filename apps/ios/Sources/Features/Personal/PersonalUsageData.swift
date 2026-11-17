import Foundation

// MARK: - Usage: totals, days and models from `usage.summary` rows (one per day, model and mode), ported from usage-data.ts

struct PersonalUsageRow: Equatable {
    let day: String
    let providerID: String
    let modelID: String
    let mode: String
    let requests: Int
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let costUSD: Double?
    let unpriced: Int
    let images: Int
    let videos: Int
    let videoSeconds: Double
    let audios: Int
    let audioSeconds: Double
    let audioChars: Int
    let estimatedUSD: Double
    let tokensPerSecond: Double?
    let timed: Int

    init(_ json: JSON) {
        func number(_ key: String) -> Double { if case .number(let n) = json[key] { n } else { 0 } }
        day = json["day"].string; providerID = json["providerId"].string; modelID = json["modelId"].string; mode = json["mode"].string
        requests = Int(number("requests")); input = Int(number("input")); output = Int(number("output")); cacheRead = Int(number("cacheRead")); cacheWrite = Int(number("cacheWrite"))
        if case .number(let cost) = json["costUsd"] { costUSD = cost } else { costUSD = nil }
        unpriced = Int(number("unpriced")); images = Int(number("images")); videos = Int(number("videos")); videoSeconds = number("videoSeconds")
        audios = Int(number("audios")); audioSeconds = number("audioSeconds"); audioChars = Int(number("audioChars")); estimatedUSD = number("estimatedUsd")
        if case .number(let speed) = json["tokensPerSecond"] { tokensPerSecond = speed } else { tokensPerSecond = nil }
        timed = Int(number("timed"))
    }

    /// Every token a request processed: its whole prompt (`input` excludes cache reads and writes) and its output.
    var tokens: Int { input + cacheRead + cacheWrite + output }
    var isImage: Bool { images > 0 }
    var isVideo: Bool { videos > 0 }
    var isAudio: Bool { audios > 0 }
    /// Pictures, clips and sounds have no tokens: none of them is a request to a text model.
    var isMedia: Bool { isImage || isVideo || isAudio }
    var ref: String { "\(providerID)/\(modelID)" }
}

enum PersonalUsage {
    enum Mode: String, CaseIterable { case chat, code, other
        var label: String { switch self { case .chat: "Chat"; case .code: "Code"; case .other: "Other" } }
    }

    /// Chat and Cowork are one: an old Cowork task's tokens count as Chat's.
    static func mode(of row: PersonalUsageRow) -> Mode {
        row.mode == "work" ? .chat : Mode(rawValue: row.mode) ?? .other
    }

    struct Totals: Equatable {
        var requests = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, tokens = 0
        var images = 0, videos = 0, audios = 0
        var videoSeconds = 0.0, audioSeconds = 0.0
        var cost = 0.0, estimated = 0.0
        var priced = 0, unpriced = 0
    }

    static func totals(_ rows: [PersonalUsageRow]) -> Totals {
        var t = Totals()
        for r in rows {
            t.cost += r.costUSD ?? 0
            t.estimated += r.estimatedUSD
            if r.isMedia {
                t.images += r.images; t.videos += r.videos; t.videoSeconds += r.videoSeconds; t.audios += r.audios; t.audioSeconds += r.audioSeconds
                t.priced += r.requests - r.unpriced
                continue
            }
            t.requests += r.requests; t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite
            t.tokens += r.tokens; t.priced += r.requests - r.unpriced; t.unpriced += r.unpriced
        }
        return t
    }

    struct Day: Identifiable, Equatable {
        let day: String
        let date: Date
        var tokens: [Mode: Int]
        var id: String { day }
    }

    /// `YYYY-MM-DD` in local time, as `usage.summary` names days.
    static func localDay(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Tokens per mode for each of the last `days` days, oldest first, with the quiet days at zero.
    static func tokensByDay(_ rows: [PersonalUsageRow], days: Int, now: Date = .now, calendar: Calendar = .current) -> [Day] {
        let today = calendar.startOfDay(for: now)
        var list: [Day] = (0..<days).reversed().compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: -offset, to: today) else { return nil }
            return Day(day: localDay(date, calendar: calendar), date: date, tokens: [.chat: 0, .code: 0, .other: 0])
        }
        let index = Dictionary(uniqueKeysWithValues: list.enumerated().map { ($1.day, $0) })
        for r in rows where !r.isMedia { if let i = index[r.day] { list[i].tokens[mode(of: r), default: 0] += r.tokens } }
        return list
    }

    /// Each mode's share of the tokens, for the modes that were used, largest first.
    static func modeShares(_ rows: [PersonalUsageRow]) -> [(mode: Mode, share: Double)] {
        var sums: [Mode: Int] = [:]
        for r in rows where !r.isMedia { sums[mode(of: r), default: 0] += r.tokens }
        let all = sums.values.reduce(0, +)
        guard all > 0 else { return [] }
        return Mode.allCases.filter { (sums[$0] ?? 0) > 0 }.map { ($0, Double(sums[$0] ?? 0) / Double(all)) }.sorted { $0.share > $1.share }
    }

    struct ModelUsage: Identifiable, Equatable {
        let ref: String
        let providerID: String
        let modelID: String
        var requests = 0
        var tokens = 0
        var cost: Double?
        var unpriced = 0
        var tokensPerSecond: Double?
        var id: String { ref }
    }

    /// One entry per text model, most tokens first.
    static func byModel(_ rows: [PersonalUsageRow]) -> [ModelUsage] {
        var models: [String: ModelUsage] = [:]
        var timed: [String: Int] = [:]
        for r in rows where !r.isMedia {
            var m = models[r.ref] ?? ModelUsage(ref: r.ref, providerID: r.providerID, modelID: r.modelID)
            m.requests += r.requests; m.tokens += r.tokens; m.unpriced += r.unpriced
            if let cost = r.costUSD { m.cost = (m.cost ?? 0) + cost }
            if let speed = r.tokensPerSecond {
                let before = timed[r.ref] ?? 0
                let total = before + r.timed
                if total > 0 { m.tokensPerSecond = ((m.tokensPerSecond ?? 0) * Double(before) + speed * Double(r.timed)) / Double(total) }
                timed[r.ref] = total
            }
            models[r.ref] = m
        }
        return models.values.sorted { $0.tokens != $1.tokens ? $0.tokens > $1.tokens : $0.ref < $1.ref }
    }

    struct ProviderUsage: Identifiable, Equatable {
        let providerID: String
        var tokens = 0
        var cost: Double?
        var id: String { providerID }
    }

    /// Tokens and cost per provider, most tokens first.
    static func byProvider(_ rows: [PersonalUsageRow]) -> [ProviderUsage] {
        var providers: [String: ProviderUsage] = [:]
        for r in rows where !r.isMedia {
            var p = providers[r.providerID] ?? ProviderUsage(providerID: r.providerID)
            p.tokens += r.tokens
            if let cost = r.costUSD { p.cost = (p.cost ?? 0) + cost }
            providers[r.providerID] = p
        }
        return providers.values.sorted { $0.tokens != $1.tokens ? $0.tokens > $1.tokens : $0.providerID < $1.providerID }
    }

    struct MediaUsage: Identifiable, Equatable {
        let ref: String
        let providerID: String
        let modelID: String
        var count = 0
        var seconds = 0.0
        var chars = 0
        var cost: Double?
        var estimated = 0.0
        var id: String { ref }
    }

    enum Media { case image, video, audio }

    /// One entry per image, video or sound model, most made first.
    static func byMedia(_ rows: [PersonalUsageRow], _ kind: Media) -> [MediaUsage] {
        var models: [String: MediaUsage] = [:]
        for r in rows {
            let count: Int, seconds: Double
            switch kind {
            case .image: count = r.images; seconds = 0
            case .video: count = r.videos; seconds = r.videoSeconds
            case .audio: count = r.audios; seconds = r.audioSeconds
            }
            guard count > 0 else { continue }
            var m = models[r.ref] ?? MediaUsage(ref: r.ref, providerID: r.providerID, modelID: r.modelID)
            m.count += count; m.seconds += seconds; m.chars += kind == .audio ? r.audioChars : 0; m.estimated += r.estimatedUSD
            if let cost = r.costUSD { m.cost = (m.cost ?? 0) + cost }
            models[r.ref] = m
        }
        return models.values.sorted { $0.count != $1.count ? $0.count > $1.count : $0.ref < $1.ref }
    }

    // MARK: Words and numbers

    /// "980", "12.4K", "3.1M".
    static func tokens(_ n: Int) -> String {
        if n < 1000 { return n.formatted(.number.locale(Locale(identifier: "en_US"))) }
        let units: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e3, "K")]
        for (size, suffix) in units where Double(n) >= size {
            let value = (Double(n) / size * 10).rounded() / 10
            return (value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)) + suffix
        }
        return String(n)
    }

    /// "$0.42", "$1,280.00"; amounts under a cent read "<$0.01".
    static func usd(_ n: Double) -> String {
        if n > 0 && n < 0.005 { return "<$0.01" }
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"; f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n)) ?? "$\(n)"
    }

    /// "45 s", "2 min 5 s", "1 h 10 min": the length of video or sound made.
    static func seconds(_ value: Double) -> String {
        let whole = Int(value.rounded())
        if whole < 60 { return "\(whole) s" }
        if whole < 3600 { return "\(whole / 60) min\(whole % 60 > 0 ? " \(whole % 60) s" : "")" }
        let minutes = (whole % 3600) / 60
        return "\(whole / 3600) h\(minutes > 0 ? " \(minutes) min" : "")"
    }

    /// 12,400: grouped the way the rest of the app's English copy is, whatever the device's region.
    static func number(_ n: Int) -> String { n.formatted(.number.locale(Locale(identifier: "en_US"))) }

    static func count(_ n: Int, _ one: String, _ many: String) -> String { "\(number(n)) \(n == 1 ? one : many)" }

    private static func join(_ items: [String]) -> String {
        switch items.count {
        case 0: ""
        case 1: items[0]
        case 2: "\(items[0]) and \(items[1])"
        default: items.dropLast().joined(separator: ", ") + ", and " + (items.last ?? "")
        }
    }

    /// One statement line: "12 requests, 48.2K tokens, and about $0.42 in the last 30 days."
    static func statement(_ t: Totals, days: Int) -> String {
        if t.requests == 0 && t.images == 0 && t.videos == 0 && t.audios == 0 { return "No usage in the last \(days) days." }
        var parts: [String] = []
        if t.requests > 0 { parts += [count(t.requests, "request", "requests"), "\(tokens(t.tokens)) tokens"] }
        if t.images > 0 { parts.append(count(t.images, "image", "images")) }
        if t.videos > 0 { parts.append("\(count(t.videos, "video", "videos")) (\(seconds(t.videoSeconds)))") }
        if t.audios > 0 { parts.append("\(count(t.audios, "sound", "sounds")) (\(seconds(t.audioSeconds)))") }
        if t.priced > 0 { parts.append("\(t.estimated > 0 ? "about " : "")\(usd(t.cost))") }
        return "\(join(parts)) in the last \(days) days."
    }

    // MARK: Limits

    struct Limit: Equatable {
        let key: String
        let used: Double
        let max: Double
        let resetsAt: Date?
        let reached: Bool
        let near: Bool

        init(_ json: JSON) {
            key = json["key"].string
            if case .number(let n) = json["used"] { used = n } else { used = 0 }
            if case .number(let n) = json["max"] { max = n } else { max = 1 }
            resetsAt = json["resetsAt"].date
            reached = json["reached"].bool
            near = json["near"].bool
        }

        var label: String {
            ["tokensPerDay": "Tokens per day", "tokensPer30Days": "Tokens per 30 days", "costUsdPerDay": "Cost per day", "costUsdPer30Days": "Cost per 30 days", "requestsPerHour": "Requests per hour"][key] ?? key
        }
        var fraction: Double { max > 0 ? Swift.min(1, used / max) : 0 }
        var percent: Int { Int((fraction * 100).rounded()) }
        var isDaily: Bool { key.hasSuffix("PerDay") }
        var isHourly: Bool { key == "requestsPerHour" }

        /// "420K of 1M tokens", "$2.40 of $5.00", "12 of 30 requests".
        var amounts: String {
            if key.hasPrefix("costUsd") { return "\(PersonalUsage.usd(used)) of \(PersonalUsage.usd(max))" }
            if key.hasPrefix("tokens") { return "\(PersonalUsage.tokens(Int(used))) of \(PersonalUsage.tokens(Int(max))) tokens" }
            return "\(PersonalUsage.number(Int(used))) of \(PersonalUsage.number(Int(max))) \(max == 1 ? "request" : "requests")"
        }
    }

    /// "at 2:00 AM" for the next day, "on Nov 9 at 2:00 AM" later, in the viewer's time zone.
    static func resetText(_ date: Date, now: Date = .now) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if date.timeIntervalSince(now) < 24 * 3600 { return "at \(time)" }
        return "on \(date.formatted(.dateTime.month(.abbreviated).day())) at \(time)"
    }

    static func limitNote(_ limit: Limit) -> String {
        if limit.reached { return "Limit reached. " + (limit.resetsAt.map { "It lifts \(resetText($0))." } ?? "It lifts when your running requests finish.") }
        if limit.near { return "\(limit.percent)% used." + (limit.resetsAt.map { " Resets \(resetText($0))." } ?? "") }
        if limit.isDaily, let reset = limit.resetsAt { return "Resets \(resetText(reset)) (00:00 UTC)." }
        return limit.isHourly ? "Counts the last 60 minutes." : "Counts today and the 29 days before it."
    }

    // MARK: Activity heatmap

    struct Cell: Identifiable, Equatable {
        /// Column: weeks back from this one (0 is this week).
        let week: Int
        /// Row: 0 is Monday.
        let weekday: Int
        let messages: Int
        let date: Date
        var id: Int { week * 7 + weekday }
    }

    /// The last `weeks` weeks of days with their messages, oldest week first; days after today are left out.
    static func heatmap(_ days: [JSON], weeks: Int = 26, now: Date = .now) -> [Cell] {
        var calendar = Calendar(identifier: .gregorian); calendar.firstWeekday = 2
        let today = calendar.startOfDay(for: now)
        guard let thisWeek = calendar.dateInterval(of: .weekOfYear, for: today)?.start else { return [] }
        var byDay: [String: Int] = [:]
        for d in days { byDay[d["day"].string] = d["messages"].int }
        var cells: [Cell] = []
        for week in 0..<weeks {
            for weekday in 0..<7 {
                guard let date = calendar.date(byAdding: .day, value: -(weeks - 1 - week) * 7 + weekday, to: thisWeek), date <= today else { continue }
                cells.append(Cell(week: week, weekday: weekday, messages: byDay[localDay(date, calendar: calendar)] ?? 0, date: date))
            }
        }
        return cells
    }

    /// "3 PM" for an hour of the day.
    static func hour(_ hour: Int) -> String {
        let h = hour % 12 == 0 ? 12 : hour % 12
        return "\(h) \(hour < 12 ? "AM" : "PM")"
    }
}
