import SwiftUI

// What the four admin server pages (Users, Limits, Server, Activity) share: how a failed call reads, the container that
// shows a page's loading and failed states, the alert for a change that did not go through, and the card a secret
// (a temporary password, an invite code) is shown in.

/// How a failed call reads to an admin: calm words, never a raw error or a code.
enum AdminFailure {
    enum Kind: Equatable { case unsupported, forbidden, elsewhere, offline, other }

    static let unsupportedText = "This server doesn't support this yet."
    static let forbiddenText = "Only admins of this server can do this."
    static let elsewhereText = "This is done in Atelier on the computer you are connected to."
    static let offlineText = "Can't reach the server right now. Check your connection and try again."
    static let rejectedText = "The server did not accept that. Check what you entered and try again."

    static func kind(of error: Error) -> Kind { kind(ofMessage: error.localizedDescription) }

    static func kind(ofMessage text: String) -> Kind {
        if text.hasPrefix("Unknown method") || text == unsupportedText { return .unsupported }
        if text.hasPrefix("Only admins") || text == forbiddenText { return .forbidden }
        if text.hasPrefix("Only Atelier on the computer") || text.hasPrefix("Only the desktop app") || text == elsewhereText { return .elsewhere }
        if text.hasPrefix("Not connected") || text.hasPrefix("Connection interrupted") || text == offlineText { return .offline }
        return .other
    }

    static func message(for error: Error) -> String {
        let text = error.localizedDescription
        switch kind(ofMessage: text) {
        case .unsupported: return unsupportedText
        case .forbidden: return forbiddenText
        case .elsewhere: return elsewhereText
        case .offline: return offlineText
        case .other: return text == "Invalid params" ? rejectedText : text
        }
    }
}

extension Connection {
    /// A call whose failure reads calmly (see `AdminFailure`). Cancellation passes through untouched.
    func adminCall(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        do { return try await call(method, params) }
        catch is CancellationError { throw CancellationError() }
        catch { throw MobileError.message(AdminFailure.message(for: error)) }
    }
}

// MARK: - Formatting

enum AdminFormat {
    /// "Nov 17, 2026 at 3:41 PM".
    static func dateTime(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .shortened) }
    static func date(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .omitted) }
    /// "in 6 days", "3 hours ago".
    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }
    /// "1 person", "3 people".
    static func people(_ count: Int) -> String { count == 1 ? "1 person" : "\(count) people" }
}

// MARK: - Page containers

/// A page over a `Resource`: the first load, the failure with a way to try again (or a calm note when this server can't do it
/// or this person may not), the content once it is there, and pull to refresh.
struct AdminList<Value, Content: View>: View {
    let resource: Resource<Value>
    @ViewBuilder var content: (Value) -> Content
    var body: some View {
        Group {
            switch resource.state {
            case .idle, .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ScrollView { AdminFailureView(message: message) { Task { await resource.reload() } }.padding(.top, 60) }
            case .loaded(let value):
                List { content(value) }.listStyle(.insetGrouped)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.sunken)
        .refreshable { await resource.reload() }
        .task { if case .idle = resource.state { await resource.reload() } }
        .tint(Theme.clay)
    }
}

/// A failure in words: "not on this server yet" and "admins only" are states, not errors; the rest can be tried again.
struct AdminFailureView: View {
    let message: String
    var retry: (() -> Void)?
    var body: some View {
        switch AdminFailure.kind(ofMessage: message) {
        case .unsupported:
            EmptyState(title: "Not on this server yet", symbol: "arrow.triangle.2.circlepath", message: "\(AdminFailure.unsupportedText) Update the server to get it.")
        case .forbidden:
            EmptyState(title: "Admins only", symbol: "lock", message: "Only admins of this server can open this page.")
        case .elsewhere:
            EmptyState(title: "Not from here", symbol: "desktopcomputer", message: AdminFailure.elsewhereText)
        case .offline, .other:
            InlineError(message: message, retry: retry)
        }
    }
}

extension View {
    /// The alert for a change that did not go through; clears itself when dismissed. Attached inside the page so it shows over the Settings sheet.
    func adminAlert(_ message: Binding<String?>) -> some View {
        alert("That did not work", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(message.wrappedValue ?? "") }
    }
}

// MARK: - Secrets and sharing

/// A value shown once, large and selectable: a temporary password, an invite code.
struct AdminSecretCard: View {
    let label: String
    let value: String
    var body: some View {
        Text(value)
            .font(.system(.title2, design: .monospaced, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .textSelection(.enabled)
            .multilineTextAlignment(.center)
            .lineLimit(2).minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24).padding(.horizontal, 14)
            .card(radius: 18)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityValue(value)
    }
}

/// A short confirmation over a page. The app's own toast sits under the Settings sheet, so every page and sheet here shows it itself.
struct AdminToastModifier: ViewModifier {
    let store: AppStore
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast = store.toast {
                    Text(toast).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.bottom, 28).transition(.move(edge: .bottom).combined(with: .opacity))
                        .allowsHitTesting(false)
                }
            }
            .animation(.snappy, value: store.toast)
    }
}

extension View {
    func adminToast(_ store: AppStore) -> some View { modifier(AdminToastModifier(store: store)) }
}

/// The system share sheet for a file (an export).
struct AdminShareSheet: UIViewControllerRepresentable {
    let files: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: files, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// A small capsule button for a row that has two answers (Approve, Reject).
struct AdminPillButtonStyle: ButtonStyle {
    var prominent = false
    var destructive = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(prominent ? Color.white : (destructive ? Theme.danger : Theme.ink))
            .padding(.horizontal, 16).frame(minHeight: 36)
            .background(prominent ? Theme.clay : Theme.fill, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A line of explanation under a form, in the muted footnote style.
struct AdminNote: View {
    let text: String
    var symbol: String?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let symbol { Image(systemName: symbol).foregroundStyle(Theme.inkMuted).accessibilityHidden(true) }
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote).foregroundStyle(Theme.inkMuted)
    }
}

/// Text in a monospaced block that can be copied (a command, an address).
struct AdminCodeBlock: View {
    let text: String
    var body: some View {
        Text(text).font(.mono(.footnote)).foregroundStyle(Theme.ink).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Puts text on the clipboard and says so. A secret (a password, an invite code) stays on this device and is gone after three minutes.
@MainActor func adminCopy(_ text: String, store: AppStore, said: String = "Copied", secret: Bool = false) {
    if secret {
        UIPasteboard.general.setItems([["public.utf8-plain-text": text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(180)])
    } else {
        UIPasteboard.general.string = text
    }
    store.notify(said)
}

/// Debug builds can open a page straight onto one of its sheets or pushed screens, to look at it: `--admin add`, `--admin user/u3`.
/// In a release build `Launch.value` is nil, so none of this does anything.
enum AdminDebug {
    static var route: String? { Launch.value("--admin") }
    static func `is`(_ name: String) -> Bool { route == name }
    /// The parts of a route after a prefix: `user/u3/delete` after "user" is ["u3", "delete"].
    static func parts(after prefix: String) -> [String]? {
        guard let route, route.hasPrefix(prefix + "/") else { return nil }
        return route.dropFirst(prefix.count + 1).split(separator: "/").map(String.init)
    }
}
