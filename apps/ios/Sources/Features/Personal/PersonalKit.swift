import SwiftUI
import UIKit

// MARK: - What every personal page shares: how it reaches the server, how a failure reads, and a few small views.

/// How a personal page calls the server. The app passes `store.rpc`; a test passes a fake.
typealias PersonalCall = @MainActor (String, [String: JSON]) async throws -> JSON

extension AppStore {
    var personalCall: PersonalCall { { [rpc] method, params in try await rpc.call(method, params) } }
}

/// What a server failure says, in words for the person: no codes, no raw validation output.
enum PersonalFailure {
    static func text(_ error: Error) -> String { text(error.localizedDescription) }

    static func text(_ message: String) -> String {
        let lower = message.lowercased()
        if lower.contains("unknown method") { return "This server doesn't support this yet." }
        if lower.hasSuffix("not a preference") { return "This server doesn't support this setting yet." }
        if message == "Invalid params" { return "Check what you entered and try again." }
        if lower.hasPrefix("not connected") { return "Not connected to your server. Try again once it is back." }
        if lower.hasPrefix("connection interrupted") { return "The connection was interrupted. Check the result, then try again." }
        if lower.hasPrefix("the server did not acknowledge") { return "The server did not answer in time. Check the result before trying again." }
        return message.isEmpty ? "Something went wrong. Try again." : message
    }

    static func isUnsupported(_ error: Error) -> Bool {
        let lower = error.localizedDescription.lowercased()
        return lower.contains("unknown method") || lower.hasSuffix("not a preference")
    }

    static func isForbidden(_ error: Error) -> Bool { error.localizedDescription.lowercased().contains("only admins") }
}

#if DEBUG
enum PersonalDebug {
    /// `--state loading` keeps a page in its loading state, to look at it.
    static func holdIfLoading() async {
        guard Launch.value("--state") == "loading" else { return }
        try? await Task.sleep(for: .seconds(3600))
    }
}
#else
enum PersonalDebug { static func holdIfLoading() async {} }
#endif

extension Resource {
    /// A resource that shows what a failure says in words, and can be asked again.
    static func personal(_ fetch: @escaping () async throws -> Value) -> Resource<Value> {
        Resource {
            await PersonalDebug.holdIfLoading()
            do { return try await fetch() } catch is CancellationError { throw CancellationError() } catch { throw MobileError.message(PersonalFailure.text(error)) }
        }
    }
}

/// Shows a `Resource` inside a list: a spinner while it first loads, what failed with Try again, the empty state, or the content.
struct PersonalLoad<Value, Content: View>: View {
    let resource: Resource<Value>
    var isEmpty: (Value) -> Bool = { _ in false }
    var emptyTitle = "Nothing here yet"
    var emptySymbol = "tray"
    var emptyMessage: String?
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch resource.state {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240).personalPlainRow()
                .task { if case .idle = resource.state { await resource.reload() } }
                .accessibilityLabel("Loading")
        case .failed(let message):
            InlineError(message: message) { Task { await resource.reload() } }.personalPlainRow()
        case .loaded(let value):
            if isEmpty(value) { EmptyState(title: emptyTitle, symbol: emptySymbol, message: emptyMessage).personalPlainRow() } else { content(value) }
        }
    }
}

extension View {
    /// A row with no card behind it: a spinner, an empty or an error message in the middle of a list.
    func personalPlainRow() -> some View { listRowBackground(Color.clear).listRowSeparator(.hidden) }

    /// Runs a server call from a button, showing a failure as the shared alert.
    @MainActor func personalAction(_ store: AppStore, _ run: @escaping @MainActor () async throws -> Void) {
        Task { do { try await run() } catch is CancellationError {} catch { store.error = PersonalFailure.text(error) } }
    }
}

/// A section's footer in the muted footnote style, with an optional link after it.
struct PersonalLinkRow: View {
    let title: String
    let symbol: String
    let url: String
    var subtitle: String?
    @Environment(\.openURL) private var openURL
    var body: some View {
        Button { if let url = URL(string: url) { openURL(url) } } label: {
            HStack(spacing: 12) {
                IconTile(symbol: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Theme.ink)
                    if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens in your browser")
    }
}

/// A settings page of this area: the shared page, plus (in debug builds) `--scroll bottom|center` to look at what is below the fold.
struct PersonalPage<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        SettingsPage(title: title) { content }.personalLook()
    }
}

extension View {
    @ViewBuilder func personalLook() -> some View {
        #if DEBUG
        if let mode = Launch.value("--scroll") { background(PersonalScrollProbe(mode: mode)) } else { self }
        #else
        self
        #endif
    }
}

#if DEBUG
/// Debug builds launched with `--scroll bottom|center` scroll the page after it has loaded, to look at what is below the fold.
struct PersonalScrollProbe: UIViewRepresentable {
    let mode: String
    func makeUIView(context: Context) -> ProbeView { let view = ProbeView(); view.mode = mode; return view }
    func updateUIView(_ view: ProbeView, context: Context) {}

    final class ProbeView: UIView {
        var mode = "bottom"
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            for delay in [2.5, 4.0] {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    self?.scroll()
                }
            }
        }
        private func scroll() {
            guard let window, let scroller = Self.largest(in: window) else { return }
            let inset = scroller.adjustedContentInset
            let maxY = scroller.contentSize.height - scroller.bounds.height + inset.bottom
            let y = mode == "bottom" ? maxY : maxY / 2
            scroller.setContentOffset(CGPoint(x: 0, y: max(-inset.top, y)), animated: false)
        }
        private static func largest(in view: UIView) -> UIScrollView? {
            var best: UIScrollView?
            func walk(_ v: UIView) {
                if let s = v as? UIScrollView, s.bounds.height > 300, s.bounds.height * s.bounds.width > (best.map { $0.bounds.height * $0.bounds.width } ?? 0) { best = s }
                v.subviews.forEach(walk)
            }
            walk(view)
            return best
        }
    }
}
#endif

/// A button row with an icon tile, in step with the navigation rows around it.
struct PersonalIconAction: View {
    let title: String
    let symbol: String
    var destructive = false
    var busy = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                IconTile(symbol: symbol, tint: destructive ? Theme.danger : Theme.clay)
                Text(title).foregroundStyle(destructive ? Theme.danger : Theme.clay)
                Spacer(minLength: 8)
                if busy { ProgressView() }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

// MARK: - Files from the server

enum PersonalBlob {
    /// Downloads one of the person's files from the server into a temporary file (protected, removed by the caller).
    @MainActor static func download(store: AppStore, sha: String, fileName: String) async throws -> URL {
        let data = try await load(store: store, sha: sha)
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: fileName.replacingOccurrences(of: "/", with: "-"))
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    @MainActor static func load(store: AppStore, sha: String) async throws -> Data {
        guard sha.count == 64, sha.allSatisfy({ $0.isHexDigit }) else { throw MobileError.message("That file is not available.") }
        let server = try serverURL(store.address)
        guard let token = CredentialStore.read(store.address) else { throw MobileError.message("Sign in to download this file.") }
        var request = URLRequest(url: server.appending(path: "api/blobs/\(sha)"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw MobileError.message("That file is no longer available on your server.") }
        return data
    }
}

/// The person's profile photo, or their initial on clay when there is none.
struct PersonalAvatar: View {
    let store: AppStore
    let sha: String?
    let name: String
    var size: CGFloat = 64
    @State private var image: UIImage?
    @MainActor private static var cache: [String: UIImage] = [:]
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle()) } else { Avatar(name: name, size: size) }
        }
        .task(id: sha) {
            guard let sha, !sha.isEmpty else { image = nil; return }
            if let cached = Self.cache[sha] { image = cached; return }
            guard let data = try? await PersonalBlob.load(store: store, sha: sha), let loaded = UIImage(data: data) else { return }
            Self.cache[sha] = loaded; image = loaded
        }
        .accessibilityHidden(true)
    }
}

/// The system share sheet for a file.
struct PersonalShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct PersonalSharedFile: Identifiable { let url: URL; var id: URL { url } }

// MARK: - Small facts about the app and the device

@MainActor enum PersonalApp {
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1" }
    /// "iPhone17,1": the hardware model, which says what the screen and the chip are without naming the person's device.
    static var machine: String {
        var info = utsname(); uname(&info)
        let identifier = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        if identifier == "arm64" || identifier == "x86_64" { return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? identifier }
        return identifier
    }
    static var family: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
    static var system: String { "iOS \(UIDevice.current.systemVersion)" }
    /// The size and scale of the screen the app is on.
    static var screen: (CGSize, CGFloat) {
        let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
        return (screen?.bounds.size ?? .zero, screen?.scale ?? 1)
    }
}

extension Date {
    var personalShort: String { formatted(date: .abbreviated, time: .omitted) }
}

/// A key as it is printed on a keyboard.
struct PersonalKeyCap: View {
    let text: String
    var body: some View {
        Text(text).font(.system(.footnote, design: .rounded, weight: .medium)).foregroundStyle(Theme.ink)
            .frame(minWidth: 26, minHeight: 26).padding(.horizontal, text.count > 1 ? 6 : 0)
            .background(Theme.fill, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
    }
}

/// A multi-line text box that sits in a list row.
struct PersonalTextBox: View {
    let title: String
    @Binding var text: String
    var placeholder = ""
    var minHeight: CGFloat = 140
    var mono = false
    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(mono ? .mono(.callout) : .body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: minHeight)
                .padding(.horizontal, -5)
                .accessibilityLabel(title)
            if text.isEmpty && !placeholder.isEmpty {
                Text(placeholder).font(mono ? .mono(.callout) : .body).foregroundStyle(Theme.inkMuted.opacity(0.8)).allowsHitTesting(false).padding(.top, 8)
            }
        }
    }
}
