import Charts
import SwiftUI

// MARK: - Usage: requests, tokens, images and cost over a period; the person's limits and plan; their activity

enum PersonalSeries {
    static let chat = Color.adaptive(light: 0x2A78D6, dark: 0x3987E5)
    static let code = Color.adaptive(light: 0x1BAF7A, dark: 0x199E70)
    static let other = Color.adaptive(light: 0x898781, dark: 0x8F8D86)
    static let amber = Color.adaptive(light: 0xC98A1A, dark: 0xD9A03A)
    static let violet = Color.adaptive(light: 0x7B5CC9, dark: 0x9A80E0)
    static let pink = Color.adaptive(light: 0xC9507F, dark: 0xDE6E9A)
    /// For things with no fixed meaning (providers): the same colours in a steady order.
    static let palette: [Color] = [chat, code, amber, violet, pink, other]

    static func color(_ mode: PersonalUsage.Mode) -> Color { switch mode { case .chat: chat; case .code: code; case .other: other } }
}

struct PersonalPlanWindow: Identifiable, Equatable {
    let service: String
    let name: String
    let usedPercent: Double
    let resetsAt: Date?
    var note: String?
    var id: String { "\(service)|\(name)" }
}

@MainActor @Observable final class PersonalUsageModel {
    enum Phase: Equatable { case loading, loaded, failed(String) }
    var days = 30
    var everyone = false
    var statsMode = "chat"
    /// 7, 30 or nil for all time.
    var statsDays: Int? = 30
    private(set) var phase: Phase = .loading
    private(set) var rows: [PersonalUsageRow] = []
    private(set) var limits: JSON?
    private(set) var stats: JSON?
    private(set) var statsFailed = false
    private(set) var plans: [PersonalPlanWindow] = []
    private(set) var providerNames: [String: String] = [:]
    private(set) var modelNames: [String: String] = [:]
    private let call: PersonalCall

    init(call: @escaping PersonalCall) { self.call = call }

    var timezoneOffset: Int { -TimeZone.current.secondsFromGMT() / 60 }

    func loadUsage() async {
        if rows.isEmpty { phase = .loading }
        await PersonalDebug.holdIfLoading()
        var params: [String: JSON] = ["days": .number(Double(days)), "timezoneOffset": .number(Double(timezoneOffset))]
        if everyone { params["everyone"] = true }
        do {
            let result = try await call("usage.summary", params)
            rows = result.array.map(PersonalUsageRow.init); phase = .loaded
        } catch is CancellationError { return } catch {
            if case .loaded = phase { return }
            phase = .failed(PersonalFailure.text(error))
        }
    }

    func loadLimits() async { limits = try? await call("limits.mine", [:]) }

    func loadStats() async {
        var params: [String: JSON] = ["mode": .string(statsMode), "timezoneOffset": .number(Double(timezoneOffset))]
        if let statsDays { params["days"] = .number(Double(statsDays)) } else { params["days"] = .null }
        do { stats = try await call("stats.summary", params); statsFailed = false } catch is CancellationError { return } catch { statsFailed = true }
    }

    /// Display names for providers and models, best effort.
    func loadNames(models: [JSON], admin: Bool) async {
        let settings = (try? await call("settings.get", [:]))?["effective"] ?? .null
        var providers: [String: String] = [:]
        for p in settings["providers"].array + settings["imageProviders"].array { providers[p["id"].string] = p["name"].string }
        providerNames = providers
        var names: [String: String] = [:]
        for m in models + ((try? await call("imageModels.list", [:]))?.array ?? []) { names[m["ref"].string] = m["displayName"].string }
        modelNames = names
        // Plans are an admin's to read: a ChatGPT sign-in's windows and Mistral Vibe's monthly allowance.
        var windows: [PersonalPlanWindow] = []
        for p in settings["providers"].array where admin && p["enabled"].boolOrNil != false {
            if p["type"].string == "chatgpt", let status = try? await call("chatgpt.status", [:]), status["signedIn"].bool {
                let pro = status["plan"].string.lowercased().hasPrefix("pro")
                for window in [status["limits"]["primary"], status["limits"]["secondary"]] where window != .null {
                    let minutes = window["windowMinutes"].intOrNil
                    guard minutes == nil || (minutes ?? 0) > 0, !pro || minutes == 10080 else { continue }
                    let name = minutes == 10080 ? "Weekly" : minutes == 300 ? "Five-hour" : "Plan window"
                    if case .number(let used) = window["usedPercent"] { windows.append(.init(service: "ChatGPT", name: name, usedPercent: used, resetsAt: window["resetsAt"].date)) }
                }
            } else if p["type"].string == "mistral-vibe", let usage = try? await call("providers.planUsage", ["id": p["id"]]), case .number(let used) = usage["usedPercent"] {
                windows.append(.init(service: "Mistral Vibe", name: "Monthly allowance", usedPercent: used, resetsAt: usage["resetsAt"].date, note: usage["overage"].bool ? "Pay-as-you-go is on: use past the allowance is charged." : nil))
            }
        }
        plans = windows
    }

    func model(_ providerID: String, _ modelID: String) -> String { modelNames["\(providerID)/\(modelID)"] ?? modelID }
    func provider(_ id: String) -> String { providerNames[id] ?? id }
}

struct UsageSettings: View {
    let store: AppStore
    @State private var model: PersonalUsageModel
    @State private var showPrices = false

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: PersonalUsageModel(call: store.personalCall))
        #if DEBUG
        _showPrices = State(initialValue: Launch.value("--sub") == "prices")
        #endif
    }

    var body: some View {
        PersonalPage(title: "Usage") {
            Section {
                Picker("Period", selection: $model.days) {
                    Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90)
                }.pickerStyle(.segmented).accessibilityLabel("Period")
                if store.isAdmin {
                    Picker("Whose usage", selection: $model.everyone) {
                        Text("Only me").tag(false); Text("Everyone").tag(true)
                    }.pickerStyle(.segmented).accessibilityLabel("Whose usage")
                }
            }
            switch model.phase {
            case .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 220).personalPlainRow().accessibilityLabel("Loading")
            case .failed(let message): InlineError(message: message) { Task { await model.loadUsage() } }.personalPlainRow()
            case .loaded: loaded
            }
            activity
            if store.isAdmin {
                Section {
                    NavigationLink { PersonalPricesPage(store: store) } label: { NavRow(symbol: "tag", title: "Prices", subtitle: "Dollars per million tokens, per model.") }
                } header: { Text("Admin") }
            }
        }
        .navigationDestination(isPresented: $showPrices) { PersonalPricesPage(store: store) }
        .task(id: "\(model.days)-\(model.everyone)") { await model.loadUsage() }
        .task { await model.loadNames(models: store.models, admin: store.isAdmin); if store.offers("usageLimits") { await model.loadLimits() } }
        .task(id: "\(model.statsMode)-\(model.statsDays ?? 0)") { await model.loadStats() }
        .refreshable { await model.loadUsage(); await model.loadStats(); if store.offers("usageLimits") { await model.loadLimits() } }
    }

    // MARK: The period

    @ViewBuilder private var loaded: some View {
        let rows = model.rows
        let totals = PersonalUsage.totals(rows)
        Section {
            summary(totals)
        } header: { Text(model.everyone ? "Everyone's usage" : "Your usage") }
        yourLimits
        if !model.plans.isEmpty { planSection }
        if rows.contains(where: { !$0.isMedia }) {
            daysSection(rows)
            modelsSection(rows)
            providersSection(rows)
        }
        mediaSection(rows, .image, title: "Images", footer: "Images each model made and what they cost. A cost marked “estimate” comes from a price list, because the service didn't report one.")
        mediaSection(rows, .video, title: "Videos", footer: "Videos each model made, how many seconds of video that is and what it cost.")
        mediaSection(rows, .audio, title: "Sounds", footer: "Speech, music and sound effects each model made, how long they are in all, the characters read out and what it cost.")
    }

    private func summary(_ t: PersonalUsage.Totals) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(PersonalUsage.statement(t, days: model.days)).font(.system(.title3, design: .serif)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            if t.requests > 0 {
                Text(([ "\(PersonalUsage.tokens(t.input)) input" ] + (t.cacheRead > 0 ? ["\(PersonalUsage.tokens(t.cacheRead)) cache read"] : []) + (t.cacheWrite > 0 ? ["\(PersonalUsage.tokens(t.cacheWrite)) cache write"] : []) + ["\(PersonalUsage.tokens(t.output)) output"]).joined(separator: " · "))
                    .font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            if t.estimated > 0 { Text("\(PersonalUsage.usd(t.estimated)) of the cost is an estimate from a price list.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            if t.unpriced > 0 { Text("\(PersonalUsage.count(t.unpriced, "request", "requests")) without a price.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            if t.requests == 0 && t.images == 0 && t.videos == 0 && t.audios == 0 { Text("Requests, tokens and cost show here once you have chatted or run a Code session.").font(.footnote).foregroundStyle(Theme.inkMuted) }
        }.padding(.vertical, 4)
    }

    // MARK: Limits and plan

    @ViewBuilder private var yourLimits: some View {
        if let limits = model.limits, !model.everyone, limits["exempt"].bool || !limits["rows"].array.isEmpty {
            Section {
                if limits["exempt"].bool {
                    Text("An admin lifted all limits for you.").foregroundStyle(Theme.inkSecondary)
                } else {
                    ForEach(limits["rows"].array.map(PersonalUsage.Limit.init), id: \.key) { limitRow($0) }
                }
            } header: { Text("Your limits") } footer: {
                Text(limitsFooter(limits))
            }
        }
    }

    private func limitsFooter(_ limits: JSON) -> String {
        var text = "What an admin lets you use, and how much of it you have used. Tokens, cost and requests count across all of your chats and Code sessions, including deleted ones."
        let costLimited = limits["rows"].array.contains { $0["key"].string.hasPrefix("costUsd") }
        if costLimited, limits["unpriced"].int > 0 {
            text += " \(PersonalUsage.number(limits["unpriced"].int)) \(limits["unpriced"].int == 1 ? "request" : "requests") in the last 30 days had no price (models without one, such as local models). A cost limit doesn't count them; a token limit does."
        }
        return text
    }

    private func limitRow(_ limit: PersonalUsage.Limit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(limit.label).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(limit.amounts).font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit().multilineTextAlignment(.trailing)
            }
            PersonalMeter(fraction: limit.fraction, tone: limit.reached ? .bad : limit.near ? .warn : .normal)
                .accessibilityLabel("\(limit.label): \(limit.percent)% used")
            Text(PersonalUsage.limitNote(limit)).font(.footnote).foregroundStyle(limit.reached ? Theme.danger : Theme.inkMuted)
        }.padding(.vertical, 3)
    }

    private var planSection: some View {
        Section {
            ForEach(model.plans) { window in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(window.service) · \(window.name)").foregroundStyle(Theme.ink)
                        Spacer(minLength: 8)
                        Text("\(Int(min(100, window.usedPercent).rounded()))%").font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit()
                    }
                    PersonalMeter(fraction: min(1, window.usedPercent / 100), tone: window.usedPercent >= 100 ? .bad : window.usedPercent >= 90 ? .warn : .normal)
                        .accessibilityLabel("\(window.service) \(window.name): \(Int(window.usedPercent.rounded()))% used")
                    if let resets = window.resetsAt { Text("Resets \(PersonalUsage.resetText(resets)).").font(.footnote).foregroundStyle(Theme.inkMuted) }
                    if let note = window.note { Text(note).font(.footnote).foregroundStyle(Theme.inkMuted) }
                }.padding(.vertical, 3)
            }
        } header: { Text("Plan usage") } footer: { Text("How much of a subscription's allowance is used, as the provider reports it. Only admins can read this.") }
    }

    // MARK: Charts

    private func daysSection(_ rows: [PersonalUsageRow]) -> some View {
        let data = PersonalUsage.tokensByDay(rows, days: model.days)
        let shares = PersonalUsage.modeShares(rows)
        let modes = PersonalUsage.Mode.allCases.filter { mode in shares.contains { $0.mode == mode } }
        return Section {
            Chart {
                ForEach(data) { day in
                    ForEach(modes, id: \.self) { mode in
                        BarMark(x: .value("Day", day.date, unit: .day), y: .value("Tokens", day.tokens[mode] ?? 0)).foregroundStyle(by: .value("Mode", mode.label))
                    }
                }
            }
            .chartForegroundStyleScale(domain: modes.map(\.label), range: modes.map { PersonalSeries.color($0) })
            .chartLegend(.hidden)
            .chartXAxis { AxisMarks(values: .stride(by: .day, count: model.days <= 7 ? 1 : model.days <= 30 ? 7 : 14)) { _ in AxisGridLine(); AxisTick(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
            .chartYAxis { AxisMarks { value in AxisGridLine(); AxisValueLabel { if let v = value.as(Int.self) { Text(PersonalUsage.tokens(v)) } } } }
            .frame(height: 190)
            .padding(.vertical, 6)
            .accessibilityLabel("Tokens by day, last \(model.days) days")
            HStack(spacing: 16) {
                ForEach(shares, id: \.mode) { item in
                    HStack(spacing: 6) {
                        Circle().fill(PersonalSeries.color(item.mode)).frame(width: 8, height: 8)
                        Text(item.mode.label).font(.footnote).foregroundStyle(Theme.inkSecondary)
                        Text("\(Int((item.share * 100).rounded()))%").font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
                    }.accessibilityElement(children: .combine)
                }
                Spacer(minLength: 0)
            }
        } header: { Text("Tokens by day") }
    }

    private func modelsSection(_ rows: [PersonalUsageRow]) -> some View {
        let models = PersonalUsage.byModel(rows)
        let top = Array(models.prefix(6))
        return Section {
            Chart(top) { m in
                BarMark(x: .value("Tokens", m.tokens), y: .value("Model", model.model(m.providerID, m.modelID)))
                    .foregroundStyle(PersonalSeries.chat).cornerRadius(4)
                    .annotation(position: .trailing, alignment: .leading) { Text(PersonalUsage.tokens(m.tokens)).font(.caption2).foregroundStyle(Theme.inkMuted) }
            }
            .chartXAxis(.hidden)
            .chartYAxis { AxisMarks { _ in AxisValueLabel().font(.caption) } }
            .frame(height: CGFloat(top.count) * 34 + 8)
            .padding(.vertical, 6)
            .accessibilityLabel("Tokens by model")
            ForEach(models) { m in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(model.model(m.providerID, m.modelID)).foregroundStyle(Theme.ink).lineLimit(2)
                        Spacer(minLength: 8)
                        Text(m.cost.map { PersonalUsage.usd($0) } ?? "—").font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit()
                    }
                    Text([model.provider(m.providerID), PersonalUsage.count(m.requests, "request", "requests"), "\(PersonalUsage.tokens(m.tokens)) tokens", m.tokensPerSecond.map { "\(Int($0.rounded())) tokens/s" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(Theme.inkMuted)
                    if m.unpriced > 0 { Text("\(PersonalUsage.count(m.unpriced, "request", "requests")) without a price").font(.caption).foregroundStyle(Theme.inkMuted) }
                }.accessibilityElement(children: .combine)
            }
        } header: { Text("By model") } footer: { Text("Tokens, cost and average output speed of each model.") }
    }

    private func providersSection(_ rows: [PersonalUsageRow]) -> some View {
        let providers = PersonalUsage.byProvider(rows)
        let total = max(1, providers.reduce(0) { $0 + $1.tokens })
        let names = providers.map { model.provider($0.providerID) }
        return Section {
            if providers.count > 1 {
                Chart(Array(zip(providers, names)), id: \.0.providerID) { item in
                    SectorMark(angle: .value("Tokens", item.0.tokens), innerRadius: .ratio(0.62), angularInset: 1.5).cornerRadius(3).foregroundStyle(by: .value("Provider", item.1))
                }
                .chartForegroundStyleScale(domain: names, range: providers.indices.map { PersonalSeries.palette[$0 % PersonalSeries.palette.count] })
                .chartLegend(.hidden)
                .frame(height: 170).padding(.vertical, 6)
                .accessibilityLabel("Tokens by provider")
            }
            ForEach(Array(providers.enumerated()), id: \.element.providerID) { index, p in
                HStack(spacing: 10) {
                    Circle().fill(PersonalSeries.palette[index % PersonalSeries.palette.count]).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.provider(p.providerID)).foregroundStyle(Theme.ink)
                        Text("\(PersonalUsage.tokens(p.tokens)) tokens · \(Int((Double(p.tokens) / Double(total) * 100).rounded()))%").font(.footnote).foregroundStyle(Theme.inkMuted)
                    }
                    Spacer(minLength: 8)
                    Text(p.cost.map { PersonalUsage.usd($0) } ?? "—").font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit()
                }.accessibilityElement(children: .combine)
            }
        } header: { Text("By provider") }
    }

    @ViewBuilder private func mediaSection(_ rows: [PersonalUsageRow], _ kind: PersonalUsage.Media, title: String, footer: String) -> some View {
        let list = PersonalUsage.byMedia(rows, kind)
        if !list.isEmpty {
            Section {
                ForEach(list) { m in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(model.model(m.providerID, m.modelID)).foregroundStyle(Theme.ink).lineLimit(2)
                            Spacer(minLength: 8)
                            Text(m.cost.map { PersonalUsage.usd($0) } ?? "—").font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit()
                        }
                        Text([model.provider(m.providerID), mediaCount(m, kind), kind == .image ? nil : PersonalUsage.seconds(m.seconds), kind == .audio && m.chars > 0 ? "\(PersonalUsage.number(m.chars)) characters" : nil, m.estimated > 0 ? "estimate" : nil]
                            .compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.inkMuted)
                    }.accessibilityElement(children: .combine)
                }
            } header: { Text(title) } footer: { Text(footer) }
        }
    }

    private func mediaCount(_ m: PersonalUsage.MediaUsage, _ kind: PersonalUsage.Media) -> String {
        switch kind {
        case .image: PersonalUsage.count(m.count, "image", "images")
        case .video: PersonalUsage.count(m.count, "video", "videos")
        case .audio: PersonalUsage.count(m.count, "sound", "sounds")
        }
    }

    // MARK: Activity

    @ViewBuilder private var activity: some View {
        Section {
            Picker("Mode", selection: $model.statsMode) { Text("Chat").tag("chat"); Text("Code").tag("code") }.pickerStyle(.segmented).accessibilityLabel("Mode")
            Picker("Period", selection: Binding(get: { model.statsDays ?? 0 }, set: { model.statsDays = $0 == 0 ? nil : $0 })) {
                Text("7 days").tag(7); Text("30 days").tag(30); Text("All time").tag(0)
            }.pickerStyle(.segmented).accessibilityLabel("Activity period")
            if let stats = model.stats {
                if stats["sessions"].int == 0 && stats["messages"].int == 0 {
                    Text(model.statsMode == "code" ? "No Code sessions in this period yet." : "No chats in this period yet.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                } else {
                    statGrid(stats)
                }
                let cells = PersonalUsage.heatmap(stats["days"].array)
                if cells.contains(where: { $0.messages > 0 }) { heatmap(cells) }
            } else if model.statsFailed {
                Text("Your activity isn't available from this server.").font(.subheadline).foregroundStyle(Theme.inkMuted)
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        } header: { Text("Your activity") } footer: { Text("Sessions and messages in the mode you pick, over the period. The grid shows the last 26 weeks.") }
    }

    private func statGrid(_ stats: JSON) -> some View {
        let favorite = stats["favoriteModel"].stringOrNil.map { ref in model.modelNames[ref] ?? ref.split(separator: "/").last.map(String.init) ?? ref }
        let items: [(String, String)] = [
            ("Sessions", PersonalUsage.number(stats["sessions"].int)), ("Messages", PersonalUsage.number(stats["messages"].int)), ("Tokens", PersonalUsage.tokens(stats["tokens"].int)),
            ("Active days", PersonalUsage.number(stats["activeDays"].int)), ("Busiest hour", stats["peakHour"].intOrNil.map { PersonalUsage.hour($0) } ?? "—"), ("Favorite model", favorite ?? "—"),
        ]
        return LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 14) {
            ForEach(items, id: \.0) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.1).font(.system(.title3, design: .serif, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.7)
                    Text(item.0).font(.footnote).foregroundStyle(Theme.inkMuted)
                }.accessibilityElement(children: .combine)
            }
        }.padding(.vertical, 4)
    }

    private func heatmap(_ cells: [PersonalUsage.Cell]) -> some View {
        let peak = max(1, cells.map(\.messages).max() ?? 1)
        let names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        return Chart(cells) { cell in
            let row = Double(6 - cell.weekday), week = Double(cell.week)
            RectangleMark(xStart: .value("Week start", week + 0.07), xEnd: .value("Week end", week + 0.93), yStart: .value("Day start", row + 0.07), yEnd: .value("Day end", row + 0.93))
                .foregroundStyle(cell.messages == 0 ? Theme.fillStrong : Theme.clay.opacity(0.3 + 0.7 * Double(cell.messages) / Double(peak))).cornerRadius(2)
        }
        .chartXScale(domain: 0...26).chartYScale(domain: 0...7)
        .chartYAxis { AxisMarks(values: [0.5, 2.5, 4.5, 6.5]) { value in AxisValueLabel { if let v = value.as(Double.self) { Text(names[max(0, min(6, 6 - Int(v)))]).font(.caption2) } } } }
        .chartXAxis(.hidden)
        .frame(height: 124).padding(.vertical, 4)
        .accessibilityLabel("Activity over the last 26 weeks: \(cells.filter { $0.messages > 0 }.count) active days")
    }
}

/// A thin bar for how much of something is used.
struct PersonalMeter: View {
    enum Tone { case normal, warn, bad }
    let fraction: Double
    var tone: Tone = .normal
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.fillStrong)
                Capsule().fill(tone == .bad ? Theme.danger : tone == .warn ? Theme.waiting : Theme.clay).frame(width: max(8, proxy.size.width * min(1, max(0, fraction))))
            }
        }.frame(height: 8)
    }
}
