import SwiftUI

// MARK: - The person's preferences (`prefs.get`, `prefs.set`, `prefs.reset`)
//
// Every control writes its own path, so an older server that doesn't know a key refuses that one write and nothing else.
// A change shows at once; when the server refuses it the old value comes back and a toast says why.

extension JSON {
    /// The value at a path of keys (`["dictation", "language"]`), or `.null`.
    func personalValue(at path: [String]) -> JSON {
        path.reduce(self) { $0[$1] }
    }

    /// A copy with the value set at a path, making the objects on the way when they are missing.
    func personalSetting(_ value: JSON, at path: [String]) -> JSON {
        guard let first = path.first else { return value }
        let object: [String: JSON]
        if case .object(let existing) = self { object = existing } else { object = [:] }
        var copy = object
        copy[first] = (object[first] ?? .null).personalSetting(value, at: Array(path.dropFirst()))
        return .object(copy)
    }
}

@MainActor @Observable final class PersonalPrefs {
    enum Phase: Equatable { case loading, loaded, failed(String) }
    private(set) var phase: Phase = .loading
    private(set) var prefs: JSON = .null
    private let call: PersonalCall
    private let notify: @MainActor (String) -> Void
    private var writes = 0

    init(call: @escaping PersonalCall, notify: @escaping @MainActor (String) -> Void) {
        self.call = call
        self.notify = notify
    }

    convenience init(store: AppStore) {
        self.init(call: store.personalCall, notify: { [weak store] in store?.notify($0) })
    }

    func load() async {
        if case .loaded = phase {} else { phase = .loading }
        await PersonalDebug.holdIfLoading()
        do {
            let result = try await call("prefs.get", [:])
            guard writes == 0 else { return }
            prefs = result; phase = .loaded
        } catch is CancellationError { return } catch {
            if case .loaded = phase { return }
            phase = .failed(PersonalFailure.text(error))
        }
    }

    var isLoaded: Bool { if case .loaded = phase { true } else { false } }

    func value(_ path: [String]) -> JSON { prefs.personalValue(at: path) }
    func string(_ path: [String], default fallback: String = "") -> String { value(path).stringOrNil ?? fallback }
    func bool(_ path: [String], default fallback: Bool) -> Bool { value(path).boolOrNil ?? fallback }

    /// Writes one preference. Returns whether the server kept it; when it didn't the old value is back.
    @discardableResult
    func set(_ path: [String], _ value: JSON) async -> Bool {
        guard let before = apply(path, value) else { return true }
        return await send(path, value, before: before)
    }

    /// The same for a control's binding: the new value shows in this very frame (a switch must not snap back while the answer is awaited).
    func change(_ path: [String], _ value: JSON) {
        guard let before = apply(path, value) else { return }
        Task { await send(path, value, before: before) }
    }

    /// Shows the new value; returns the old one, or nil when nothing changes.
    private func apply(_ path: [String], _ value: JSON) -> JSON? {
        let before = prefs.personalValue(at: path)
        if before == value { return nil }
        prefs = prefs.personalSetting(value, at: path)
        writes += 1
        return before
    }

    private func send(_ path: [String], _ value: JSON, before: JSON) async -> Bool {
        defer { writes -= 1 }
        do {
            let result = try await call("prefs.set", ["path": .array(path.map { JSON.string($0) }), "value": value])
            prefs = prefs.personalSetting(result.personalValue(at: path), at: path)
            return true
        } catch {
            if prefs.personalValue(at: path) == value { prefs = prefs.personalSetting(before, at: path) }
            if !(error is CancellationError) { notify("Couldn't save. \(PersonalFailure.text(error))") }
            return false
        }
    }

    /// Takes a preference back to its default.
    @discardableResult
    func reset(_ path: [String]) async -> Bool {
        writes += 1
        defer { writes -= 1 }
        do {
            let result = try await call("prefs.reset", ["path": .array(path.map { JSON.string($0) })])
            prefs = prefs.personalSetting(result.personalValue(at: path), at: path)
            return true
        } catch {
            if !(error is CancellationError) { notify("Couldn't save. \(PersonalFailure.text(error))") }
            return false
        }
    }

    // MARK: Bindings for the rows

    func boolBinding(_ path: [String], default fallback: Bool) -> Binding<Bool> {
        Binding(get: { self.bool(path, default: fallback) }, set: { on in self.change(path, .bool(on)) })
    }

    func stringBinding(_ path: [String], default fallback: String) -> Binding<String> {
        Binding(get: { self.string(path, default: fallback) }, set: { text in self.change(path, .string(text)) })
    }
}

/// A switch bound to one preference.
struct PrefToggleRow: View {
    let prefs: PersonalPrefs
    let path: [String]
    let title: String
    var subtitle: String?
    var defaultValue = false
    var body: some View {
        ToggleRow(title: title, subtitle: subtitle, isOn: prefs.boolBinding(path, default: defaultValue))
    }
}

/// A choice from a short list, bound to one preference.
struct PrefPickRow: View {
    let prefs: PersonalPrefs
    let path: [String]
    let title: String
    var subtitle: String?
    let options: [(String, String)]
    var defaultValue: String
    var body: some View {
        PickRow(title: title, subtitle: subtitle, selection: prefs.stringBinding(path, default: defaultValue), options: options)
    }
}

/// What a page shows while its preferences load, or when they could not.
struct PersonalPrefsGate<Content: View>: View {
    let prefs: PersonalPrefs
    @ViewBuilder var content: () -> Content
    var body: some View {
        switch prefs.phase {
        case .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240).personalPlainRow().accessibilityLabel("Loading")
        case .failed(let message):
            InlineError(message: message) { Task { await prefs.load() } }.personalPlainRow()
        case .loaded:
            content()
        }
    }
}
