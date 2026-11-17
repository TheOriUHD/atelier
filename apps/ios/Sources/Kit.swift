import SwiftUI

// MARK: - The shared pieces every settings and management screen is made of
//
// A screen is a `SettingsPage` (a grouped list on the paper-grey background) of `SettingsSection`s made of the rows
// below. Data comes through a `Resource`, which gives every screen the same four states: loading, loaded, empty and
// failed (with a Retry). Nothing here knows about a particular feature.

/// A page of settings: a grouped list on the sunken background, with a title.
struct SettingsPage<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content
    var body: some View {
        List { content }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.sunken)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.clay)
    }
}

/// A section with an optional header and footer, the footer in the muted footnote style.
struct SettingsSection<Content: View>: View {
    var title: String?
    var footer: String?
    @ViewBuilder var content: Content
    var body: some View {
        Section {
            content
        } header: {
            if let title { Text(title) }
        } footer: {
            if let footer { Text(footer) }
        }
    }
}

/// The icon tile at the start of a row: a symbol on a soft rounded square.
struct IconTile: View {
    let symbol: String
    var tint: Color = Theme.clay
    var size: CGFloat = 30
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A row that opens another page: the label of a `NavigationLink`, or a plain row.
struct NavRow: View {
    var symbol: String?
    var tint: Color = Theme.clay
    let title: String
    var subtitle: String?
    var value: String?
    var badge: String?
    var body: some View {
        HStack(spacing: 12) {
            if let symbol { IconTile(symbol: symbol, tint: tint) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(.body)).foregroundStyle(Theme.ink)
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
            }
            Spacer(minLength: 8)
            if let badge, !badge.isEmpty { StatusBadge(text: badge, tone: .neutral) }
            if let value, !value.isEmpty { Text(value).font(.subheadline).foregroundStyle(Theme.inkMuted).lineLimit(1) }
        }
        .contentShape(Rectangle())
    }
}

/// A title with its value on the right: a read-only fact.
struct ValueRow: View {
    let title: String
    let value: String
    var subtitle: String?
    var mono = false
    var copyable = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
            }
            Spacer(minLength: 8)
            Text(value).font(mono ? .mono(.subheadline) : .subheadline).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .contextMenu { if copyable { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = value } } }
    }
}

/// A switch with an optional explanation under it.
struct ToggleRow: View {
    let title: String
    var subtitle: String?
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
            }
        }
        .tint(Theme.clay)
    }
}

/// A choice from a short list, shown as a menu on the right.
struct PickRow<Value: Hashable>: View {
    let title: String
    var subtitle: String?
    @Binding var selection: Value
    let options: [(Value, String)]
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
            }
            Spacer(minLength: 8)
            Picker(title, selection: $selection) { ForEach(options, id: \.0) { Text($0.1).tag($0.0) } }
                .labelsHidden().pickerStyle(.menu).tint(Theme.inkSecondary)
        }
    }
}

/// A text field in a row, with the title above it when there is one.
struct FieldRow: View {
    var title: String?
    let placeholder: String
    @Binding var text: String
    var secure = false
    var keyboard: UIKeyboardType = .default
    var mono = false
    var autocapitalize = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title { Text(title).font(.footnote).foregroundStyle(Theme.inkMuted) }
            Group {
                if secure { SecureField(placeholder, text: $text) } else { TextField(placeholder, text: $text) }
            }
            .keyboardType(keyboard)
            .textInputAutocapitalization(autocapitalize ? .sentences : .never)
            .autocorrectionDisabled(!autocapitalize)
            .font(mono ? .mono(.body) : .body)
        }
    }
}

/// A button in a list: an action, optionally destructive, with a spinner while it runs.
struct ActionRow: View {
    let title: String
    var symbol: String?
    var destructive = false
    var busy = false
    var tint: Color?
    let action: () -> Void
    var body: some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            HStack(spacing: 10) {
                if let symbol { Image(systemName: symbol).frame(width: 22) }
                Text(title)
                Spacer()
                if busy { ProgressView() }
            }
            .foregroundStyle(destructive ? Theme.danger : (tint ?? Theme.clay))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

/// A small coloured pill: a state ("Connected", "Admin", "Needs sign-in").
struct StatusBadge: View {
    enum Tone { case good, warn, bad, neutral, clay }
    let text: String
    var tone: Tone = .neutral
    private var color: Color {
        switch tone {
        case .good: Theme.success
        case .warn: Color(hex: 0xB77800)
        case .bad: Theme.danger
        case .clay: Theme.clay
        case .neutral: Theme.inkMuted
        }
    }
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.13), in: Capsule())
    }
}

// MARK: - States

/// Nothing here yet: a calm centred message, with an optional action.
struct EmptyState: View {
    let title: String
    let symbol: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 34, weight: .light)).foregroundStyle(Theme.inkMuted)
            Text(title).font(.system(.title3, design: .serif, weight: .medium)).multilineTextAlignment(.center)
            if let message { Text(message).font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center) }
            if let actionTitle, let action { Button(actionTitle, action: action).buttonStyle(ClayButtonStyle()).frame(maxWidth: 260).padding(.top, 6) }
        }
        .frame(maxWidth: 360).padding(32).frame(maxWidth: .infinity)
    }
}

/// Something failed: what, in words, and a way to try again.
struct InlineError: View {
    let message: String
    var retry: (() -> Void)?
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 28, weight: .light)).foregroundStyle(Theme.waiting)
            Text(message).font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
            if let retry { Button("Try again", action: retry).buttonStyle(QuietButtonStyle()).frame(maxWidth: 200) }
        }
        .frame(maxWidth: 360).padding(28).frame(maxWidth: .infinity)
    }
}

/// Data a screen fetches: loading, loaded or failed, reloadable. A screen holds one in `@State` and shows it with `LoadView`.
@MainActor @Observable final class Resource<Value> {
    enum State { case idle, loading, loaded(Value), failed(String) }
    var state: State = .idle
    private let fetch: () async throws -> Value
    init(_ fetch: @escaping () async throws -> Value) { self.fetch = fetch }
    var value: Value? { if case .loaded(let value) = state { value } else { nil } }
    var isLoading: Bool { if case .loading = state { true } else { false } }
    /// Fetches. Keeps what is on screen while it reloads, so a refresh never blanks the page.
    func reload() async {
        if value == nil { state = .loading }
        do { state = .loaded(try await fetch()) } catch is CancellationError { return } catch { state = value.map { .loaded($0) } ?? .failed(error.localizedDescription) }
    }
    /// Sets the value locally after a change the server confirmed, without another round trip.
    func set(_ value: Value) { state = .loaded(value) }
}

/// Shows a `Resource`: a spinner while it first loads, the error with Retry if it failed, the content once it is there.
/// `isEmpty` turns a loaded value into the empty state.
struct LoadView<Value, Content: View, Empty: View>: View {
    let resource: Resource<Value>
    var isEmpty: (Value) -> Bool = { _ in false }
    @ViewBuilder var empty: Empty
    @ViewBuilder var content: (Value) -> Content
    var body: some View {
        switch resource.state {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 220).task { if case .idle = resource.state { await resource.reload() } }
        case .failed(let message):
            InlineError(message: message) { Task { await resource.reload() } }
        case .loaded(let value):
            if isEmpty(value) { empty } else { content(value) }
        }
    }
}

extension LoadView where Empty == EmptyView {
    init(_ resource: Resource<Value>, @ViewBuilder content: @escaping (Value) -> Content) {
        self.init(resource: resource, empty: { EmptyView() }, content: content)
    }
}

/// A list screen over a `Resource`: pull to refresh, the loading, empty and error states in the middle of the page.
struct ResourceList<Value, Content: View, Empty: View>: View {
    let resource: Resource<Value>
    var isEmpty: (Value) -> Bool = { _ in false }
    @ViewBuilder var empty: Empty
    @ViewBuilder var content: (Value) -> Content
    var body: some View {
        Group {
            switch resource.state {
            case .idle, .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ScrollView { InlineError(message: message) { Task { await resource.reload() } }.padding(.top, 60) }
            case .loaded(let value):
                if isEmpty(value) { ScrollView { empty.padding(.top, 60) } } else { List { content(value) }.listStyle(.insetGrouped) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.sunken)
        .refreshable { await resource.reload() }
        .task { if case .idle = resource.state { await resource.reload() } }
    }
}

// MARK: - Small helpers

extension AppStore {
    /// Calls the server and shows a failure as the alert every screen shares; returns whether it worked.
    @discardableResult
    func attempt(_ operation: @escaping @MainActor () async throws -> Void) async -> Bool {
        do { try await operation(); return true } catch { self.error = error.localizedDescription; return false }
    }
}

extension JSON {
    /// A time the server writes in milliseconds, as a date.
    var date: Date? { int > 0 ? Date(timeIntervalSince1970: Double(int) / 1000) : nil }
    var intOrNil: Int? { if case .number(let n) = self { Int(n) } else { nil } }
    var boolOrNil: Bool? { if case .bool(let b) = self { b } else { nil } }
    var stringOrNil: String? { if case .string(let s) = self { s } else { nil } }
    /// The values of an object, in key order.
    var entries: [(String, JSON)] { if case .object(let o) = self { o.sorted { $0.key < $1.key }.map { ($0.key, $0.value) } } else { [] } }
    static func obj(_ pairs: KeyValuePairs<String, JSON>) -> JSON { .object(Dictionary(pairs.map { ($0.0, $0.1) }, uniquingKeysWith: { _, last in last })) }
}

extension Date {
    /// "3 min ago", "yesterday".
    var relative: String { formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) }
}

// Literals, so a canned answer or a request reads like the JSON it is: `["name": "Opus", "limit": 200000, "on": true]`.
extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last })) }
    init(nilLiteral: ()) { self = .null }
}

// MARK: - Toasts

/// The brief confirmation capsule ("Saved"). Attach it to the root of the app and to every sheet, because a sheet covers
/// whatever is behind it, including the app's own toast.
struct ToastOverlay: ViewModifier {
    let store: AppStore
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast = store.toast {
                    Text(toast).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular, in: .capsule).padding(.bottom, 90).transition(.move(edge: .bottom).combined(with: .opacity))
                        .allowsHitTesting(false)
                }
            }
            .animation(.snappy, value: store.toast)
    }
}
extension View { func toasts(_ store: AppStore) -> some View { modifier(ToastOverlay(store: store)) } }
