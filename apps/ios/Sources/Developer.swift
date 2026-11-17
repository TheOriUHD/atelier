import SwiftUI
import Observation
import UIKit

/// The developer options: switched on by tapping the version in Settings ten times. They change how the app behaves in ways
/// an ordinary person never needs (how it checks the connection, what it records), and are kept on this device only.
@MainActor @Observable final class DeveloperOptions {
    static let shared = DeveloperOptions()

    struct Request: Identifiable {
        let id = UUID()
        let at: Date
        let method: String
        let milliseconds: Int
        let failure: String?
    }

    // MARK: switches

    var enabled: Bool
    /// The app asks the server whether it is there when it needs to know: when it comes back to the front, when pulled
    /// to refresh, and when something it sent fails. These two switches add more.
    var checkOnForeground: Bool
    var alwaysCheck: Bool
    var checkInterval: Double
    /// Seconds between the attempts to connect again after a drop, as the person typed them ("1, 2, 4, 8, 10").
    var backoff: String
    /// Seconds without a connection before the list says "Still connecting" (launch), "Can't reach" (launch) and
    /// "Reconnecting" (after it was connected once).
    var stillConnectingAfter: Double
    var cantReachAfter: Double
    var reconnectingAfter: Double
    var recordRequests: Bool
    private(set) var requests: [Request] = []

    // MARK: what the connection says about itself

    private(set) var lastCheck: Date?
    private(set) var lastLatency: Int?
    private(set) var lastProblem: String?
    private(set) var reconnectAttempts = 0

    private let defaults = UserDefaults.standard

    private init() {
        let d = UserDefaults.standard
        enabled = d.bool(forKey: "dev.enabled")
        checkOnForeground = d.object(forKey: "dev.checkOnForeground") as? Bool ?? true
        alwaysCheck = d.bool(forKey: "dev.alwaysCheck")
        checkInterval = d.object(forKey: "dev.checkInterval") as? Double ?? 20
        backoff = d.string(forKey: "dev.backoff") ?? "1, 2, 4, 8, 10"
        stillConnectingAfter = d.object(forKey: "dev.stillConnectingAfter") as? Double ?? 5
        cantReachAfter = d.object(forKey: "dev.cantReachAfter") as? Double ?? 15
        reconnectingAfter = d.object(forKey: "dev.reconnectingAfter") as? Double ?? 6
        recordRequests = d.bool(forKey: "dev.recordRequests")
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--developer") { enabled = true }
        #endif
    }

    func save() {
        defaults.set(enabled, forKey: "dev.enabled")
        defaults.set(checkOnForeground, forKey: "dev.checkOnForeground")
        defaults.set(alwaysCheck, forKey: "dev.alwaysCheck")
        defaults.set(checkInterval, forKey: "dev.checkInterval")
        defaults.set(backoff, forKey: "dev.backoff")
        defaults.set(stillConnectingAfter, forKey: "dev.stillConnectingAfter")
        defaults.set(cantReachAfter, forKey: "dev.cantReachAfter")
        defaults.set(reconnectingAfter, forKey: "dev.reconnectingAfter")
        defaults.set(recordRequests, forKey: "dev.recordRequests")
    }

    func resetConnectionSettings() {
        checkOnForeground = true; alwaysCheck = false; checkInterval = 20; backoff = "1, 2, 4, 8, 10"
        stillConnectingAfter = 5; cantReachAfter = 15; reconnectingAfter = 6
        save()
    }

    /// The waits between connection attempts: the numbers in `backoff`, each between a quarter of a second and five minutes.
    var backoffDelays: [Double] { Self.parseDelays(backoff) }

    static func parseDelays(_ text: String) -> [Double] {
        let list = text.split(whereSeparator: { ",; ".contains($0) }).compactMap { Double($0) }.filter { $0 >= 0.25 && $0 <= 300 }
        return list.isEmpty ? [1, 2, 4, 8, 10] : Array(list.prefix(20))
    }

    // MARK: recording

    func record(_ method: String, since start: ContinuousClock.Instant, error: Error?) {
        guard recordRequests else { return }
        let elapsed = start.duration(to: .now)
        let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
        requests.insert(Request(at: .now, method: method, milliseconds: ms, failure: error.map { ChatError.text($0) }), at: 0)
        if requests.count > 150 { requests.removeLast(requests.count - 150) }
    }

    func clearRequests() { requests = [] }

    func noteCheck(latency: Int?, problem: String?) {
        lastCheck = .now
        lastLatency = latency
        lastProblem = problem
    }

    func noteAttempt(reset: Bool = false) { reconnectAttempts = reset ? 0 : reconnectAttempts + 1 }

    // MARK: switching on

    private var taps = 0
    private var lastTap = Date.distantPast

    /// One tap on the version. Returns what to tell the person, if anything.
    func tapVersion() -> String? {
        if enabled { return "Developer options are already on." }
        if Date().timeIntervalSince(lastTap) > 2.5 { taps = 0 }
        lastTap = .now
        taps += 1
        if taps >= 10 {
            taps = 0
            enabled = true
            save()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return "Developer options are on. They are under Settings."
        }
        UISelectionFeedbackGenerator().selectionChanged()
        let left = 10 - taps
        return taps >= 4 ? "\(left) more \(left == 1 ? "tap" : "taps") to turn on developer options" : nil
    }
}

/// Settings › Developer.
struct DeveloperSettings: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var options = DeveloperOptions.shared
    @State private var checking = false
    @State private var reloading = false

    private static let delays: [(Double, String)] = [(2, "2 seconds"), (3, "3 seconds"), (5, "5 seconds"), (8, "8 seconds"), (10, "10 seconds"), (15, "15 seconds"), (20, "20 seconds"), (30, "30 seconds"), (60, "1 minute")]
    private static let intervals: [(Double, String)] = [(5, "5 seconds"), (10, "10 seconds"), (20, "20 seconds"), (30, "30 seconds"), (60, "1 minute"), (120, "2 minutes")]

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }
    private var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }

    var body: some View {
        SettingsPage(title: "Developer") {
            SettingsSection(title: "Connection now", footer: "The app checks the connection when it needs to: when it comes back to the front, when you pull to refresh, and when something it sends fails. It keeps no timer running unless you switch one on below.") {
                ValueRow(title: "State", value: store.connected ? "Connected" : "Not connected")
                ValueRow(title: "Last check", value: options.lastCheck.map { $0.formatted(date: .omitted, time: .standard) } ?? "None yet", subtitle: options.lastLatency.map { "Answered in \($0) ms" } ?? options.lastProblem)
                ValueRow(title: "Reconnect attempts", value: "\(options.reconnectAttempts)")
                ActionRow(title: "Check now", symbol: "waveform.path.ecg", busy: checking) { checkNow() }
                ActionRow(title: "Reconnect now", symbol: "arrow.triangle.2.circlepath") { Task { await store.reconnectNow() } }
                ActionRow(title: "Drop the connection", symbol: "wifi.slash", destructive: true) { store.dropConnectionForTesting() }
            }

            SettingsSection(title: "How it checks", footer: "These change when the app asks the server whether it is there, and how long the list stays quiet about it.") {
                ToggleRow(title: "Check when the app comes back", subtitle: "Asks the server once when you return to the app, instead of showing a banner while it reconnects.", isOn: bind(\.checkOnForeground))
                ToggleRow(title: "Always check", subtitle: "Asks the server on a timer while the app is open. Off by default.", isOn: bind(\.alwaysCheck))
                if options.alwaysCheck { PickRow(title: "Check every", selection: bind(\.checkInterval), options: Self.intervals) }
                FieldRow(title: "Seconds between reconnect attempts", placeholder: "1, 2, 4, 8, 10", text: Binding(get: { options.backoff }, set: { options.backoff = $0; options.save() }), keyboard: .numbersAndPunctuation, mono: true)
                PickRow(title: "Say “Still connecting” after", selection: bind(\.stillConnectingAfter), options: Self.delays)
                PickRow(title: "Say “Can’t reach your server” after", selection: bind(\.cantReachAfter), options: Self.delays + [(120, "2 minutes")])
                PickRow(title: "Say “Reconnecting” after a drop of", selection: bind(\.reconnectingAfter), options: Self.delays)
                ActionRow(title: "Use the defaults", symbol: "arrow.counterclockwise") { options.resetConnectionSettings() }
            }

            SettingsSection(title: "Requests") {
                ToggleRow(title: "Record requests", subtitle: "Keeps the last 150 calls to the server, with how long each took.", isOn: bind(\.recordRequests))
                NavRow(symbol: "list.bullet.rectangle", title: "Request log", value: options.requests.isEmpty ? nil : "\(options.requests.count)")
                    .overlay { NavigationLink { RequestLogPage() } label: { Color.clear } .opacity(0) }
            }

            SettingsSection(title: "Server") {
                NavRow(symbol: "server.rack", title: "What the server says about itself")
                    .overlay { NavigationLink { ServerInfoPage(store: store) } label: { Color.clear }.opacity(0) }
                ValueRow(title: "Address", value: store.address, mono: true, copyable: true)
            }

            SettingsSection(title: "Data on this device") {
                ActionRow(title: "Reload conversations and settings", symbol: "arrow.clockwise", busy: reloading) {
                    reloading = true
                    Task { await ChatHub.of(store).reloadAll(); reloading = false; store.notify("Reloaded") }
                }
                ActionRow(title: "Clear the picture cache", symbol: "photo") { ChatHub.of(store).clearCaches(); store.notify("Cleared") }
                ActionRow(title: "Delete saved drafts", symbol: "square.and.pencil", destructive: true) { store.clearDrafts(); store.notify("Deleted") }
            }

            SettingsSection(title: "This app") {
                ValueRow(title: "Version", value: "\(version) (\(build))")
                ValueRow(title: "Device", value: "\(UIDevice.current.model), iOS \(UIDevice.current.systemVersion)")
                ActionRow(title: "Copy diagnostics", symbol: "doc.on.doc") { UIPasteboard.general.string = diagnostics(); store.notify("Copied") }
                ActionRow(title: "Hide developer options", symbol: "eye.slash", destructive: true) {
                    options.enabled = false
                    options.save()
                    dismiss()
                }
            }
        }
    }

    private func bind<Value>(_ path: ReferenceWritableKeyPath<DeveloperOptions, Value>) -> Binding<Value> {
        Binding(get: { options[keyPath: path] }, set: { options[keyPath: path] = $0; options.save(); store.developerOptionsChanged() })
    }

    private func checkNow() {
        checking = true
        Task { await store.checkConnection(reason: "manual"); checking = false }
    }

    private func diagnostics() -> String {
        [
            "Atelier \(version) (\(build)), \(UIDevice.current.model), iOS \(UIDevice.current.systemVersion)",
            "Server \(store.address), \(store.info["version"].string.isEmpty ? "version unknown" : store.info["version"].string)",
            "Connection: \(store.connected ? "connected" : "not connected"), last check \(options.lastCheck.map { $0.formatted() } ?? "none")\(options.lastLatency.map { ", \($0) ms" } ?? "")\(options.lastProblem.map { ", \($0)" } ?? "")",
            "Checks: foreground \(options.checkOnForeground), always \(options.alwaysCheck) every \(Int(options.checkInterval)) s, backoff \(options.backoff)",
        ].joined(separator: "\n")
    }
}

/// The calls recorded while "Record requests" was on, newest first.
struct RequestLogPage: View {
    @State private var options = DeveloperOptions.shared

    var body: some View {
        List {
            if options.requests.isEmpty {
                EmptyState(title: "Nothing recorded", symbol: "list.bullet.rectangle", message: options.recordRequests ? "Calls to the server show here as they happen." : "Switch on Record requests first.")
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(options.requests) { request in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(request.method).font(.mono(.subheadline)).foregroundStyle(request.failure == nil ? Theme.ink : Theme.danger)
                        Spacer()
                        Text("\(request.milliseconds) ms").font(.footnote.monospacedDigit()).foregroundStyle(Theme.inkMuted)
                    }
                    Text(request.failure ?? request.at.formatted(date: .omitted, time: .standard)).font(.footnote).foregroundStyle(request.failure == nil ? Theme.inkMuted : Theme.danger).lineLimit(2)
                }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Request log").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Clear") { options.clearRequests() }.disabled(options.requests.isEmpty) } }
    }
}

/// `app.info` and `auth.status`, as the server sent them.
struct ServerInfoPage: View {
    @Bindable var store: AppStore

    private func pretty(_ value: JSON) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data),
              let formatted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return "" }
        return String(decoding: formatted, as: UTF8.self)
    }

    var body: some View {
        List {
            section("app.info", store.info)
            section("auth.status", store.authStatus)
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Server").navigationBarTitleDisplayMode(.inline)
    }

    private func section(_ title: String, _ value: JSON) -> some View {
        Section(title) {
            Text(value == .null ? "Nothing yet" : pretty(value)).font(.mono(.caption)).foregroundStyle(Theme.ink).textSelection(.enabled)
        }
    }
}
