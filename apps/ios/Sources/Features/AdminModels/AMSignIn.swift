import SwiftUI

// The sign-in flows that add a provider without a key: ChatGPT Plan and GitHub Copilot (a code entered on the service's
// own page) and OpenRouter (its page makes a key for Atelier). Each runs on the server; the app shows the code, opens
// the page, and watches the server's status until it says the person is in.

/// A device sign-in: what to show, and the polling that ends it.
@MainActor @Observable final class AMSignInFlow {
    enum Kind: String { case chatgpt, copilot
        var service: String { self == .chatgpt ? "ChatGPT" : "GitHub" }
        /// Whose page the code is entered on.
        var page: String { self == .chatgpt ? "OpenAI" : "GitHub" }
        var type: AMProviderType { self == .chatgpt ? .chatgpt : .copilot }
        var statusMethod: String { "\(rawValue).status" }
    }
    enum Phase: Equatable { case idle, starting, waiting, adding, done, failed(String) }

    let kind: Kind
    private let api: AMAPI
    var phase: Phase = .idle
    /// The one-time code to enter, and the page to enter it on.
    var code: String?
    var link: URL?
    var expiresAt: Date?
    /// The account that signed in, once it has.
    var account: String?
    /// A page to open in the browser straight away (a sign-in with no code opens its own page).
    var openNow: URL?
    var interval: Duration = .milliseconds(1500)

    init(kind: Kind, store: AppStore) { self.kind = kind; api = AMAPI(store: store) }

    var waiting: Bool { phase == .waiting }

    func start() async {
        phase = .starting
        code = nil; link = nil; expiresAt = nil; openNow = nil
        do {
            let result = try await api.call("\(kind.rawValue).signIn")
            switch kind {
            case .chatgpt:
                code = result["userCode"].stringOrNil
                link = URL(string: result["url"].string)
                if code == nil { openNow = link }
            case .copilot:
                code = result["userCode"].stringOrNil
                link = URL(string: result["verificationUri"].string)
                expiresAt = result["expiresAt"].doubleOrNil.map { Date(timeIntervalSince1970: $0 / 1000) }
            }
            phase = .waiting
        } catch { phase = .failed(AMFailure.from(error).localizedDescription) }
    }

    /// Watches the server until the sign-in finishes, then adds the provider. Ends quietly when the task is cancelled.
    func watch() async {
        while phase == .waiting {
            do { try await Task.sleep(for: interval) } catch { return }
            guard phase == .waiting else { return }
            do {
                let status = try await api.call(kind.statusMethod)
                if status["signedIn"].bool {
                    account = status["email"].stringOrNil ?? status["login"].stringOrNil
                    await add()
                    return
                }
                if !status["signingIn"].bool {
                    phase = .failed(status["error"].stringOrNil ?? "The sign-in ended before it finished. Start again.")
                    return
                }
                // The server may have a newer code than the one first shown.
                if let fresh = status["device"]["userCode"].stringOrNil ?? status["userCode"].stringOrNil, fresh != code { code = fresh }
            } catch is CancellationError { return } catch {
                // A dropped connection while waiting is not the end of the sign-in: look again.
                if AMFailure.from(error) == .unsupported { phase = .failed(AMFailure.unsupported.localizedDescription); return }
            }
        }
    }

    private func add() async {
        phase = .adding
        do {
            _ = try await api.call("providers.save", [
                "id": .string(kind.rawValue), "type": .string(kind.type.rawValue), "name": .string(kind.type.label),
                "baseUrl": .string(kind.type.defaultURL), "headers": [:], "enabled": true,
            ])
            phase = .done
        } catch { phase = .failed(AMFailure.from(error).localizedDescription) }
    }

    func cancel() async {
        guard waiting || phase == .starting else { return }
        phase = .idle
        _ = try? await api.call("\(kind.rawValue).cancel")
    }
}

/// OpenRouter's connect: its page makes a key for Atelier, and the server saves the provider with it.
@MainActor @Observable final class AMOpenRouterFlow {
    enum Phase: Equatable { case idle, starting, waiting, done(String), failed(String) }
    private let api: AMAPI
    var phase: Phase = .idle
    var openNow: URL?
    var interval: Duration = .milliseconds(1500)
    init(store: AppStore) { api = AMAPI(store: store) }

    func connect(draft: [String: JSON]) async {
        phase = .starting
        openNow = nil
        do {
            let result = try await api.call("openrouter.connect", draft)
            openNow = URL(string: result["url"].string)
            phase = .waiting
        } catch { phase = .failed(AMFailure.from(error).localizedDescription) }
    }

    func watch() async {
        while phase == .waiting {
            do { try await Task.sleep(for: interval) } catch { return }
            guard phase == .waiting else { return }
            do {
                let status = try await api.call("openrouter.status")
                if status["connecting"].bool { continue }
                if status["provider"] != .null { phase = .done(status["provider"]["name"].string) }
                else { phase = .failed(status["error"].stringOrNil ?? "The connection ended before it finished. Try again.") }
                return
            } catch is CancellationError { return } catch { continue }
        }
    }

    func cancel() async {
        guard phase == .waiting || phase == .starting else { return }
        phase = .idle
        _ = try? await api.call("openrouter.cancel")
    }
}

// MARK: - Views

/// A row that holds a main button on the page's background.
struct AMButtonRow<Label: View>: View {
    @ViewBuilder var label: Label
    var body: some View {
        label
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// The one-time code, large, with Copy and Open.
struct AMCodeCard: View {
    let store: AppStore
    let code: String
    let service: String
    let link: URL?
    var expires: Date?
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 14) {
            Text("Your code").font(.footnote).foregroundStyle(Theme.inkMuted)
            Text(code)
                .font(.system(size: 38, weight: .semibold, design: .monospaced))
                .tracking(3)
                .minimumScaleFactor(0.5).lineLimit(1)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .accessibilityLabel("Your code is \(code.map(String.init).joined(separator: " "))")
            if let expires {
                Text("Expires \(expires.formatted(.relative(presentation: .named)))").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            HStack(spacing: 10) {
                Button { UIPasteboard.general.string = code; store.notify("Code copied") } label: { Label("Copy", systemImage: "doc.on.doc") }
                    .buttonStyle(QuietButtonStyle())
                if let link {
                    Button { openURL(link) } label: { Label("Open \(service)", systemImage: "arrow.up.right.square") }
                        .buttonStyle(ClayButtonStyle())
                }
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
    }
}

/// ChatGPT Plan or GitHub Copilot: say what it is, show the code, wait, add the provider.
struct AMSignInView: View {
    let store: AppStore
    @State private var flow: AMSignInFlow
    let onAdded: () -> Void
    @Environment(\.openURL) private var openURL

    init(store: AppStore, kind: AMSignInFlow.Kind, onAdded: @escaping () -> Void) {
        self.store = store
        self.onAdded = onAdded
        _flow = State(initialValue: AMSignInFlow(kind: kind, store: store))
    }

    private var intro: String {
        flow.kind == .chatgpt
            ? "Use the models in your ChatGPT plan, signed in the way OpenAI's Codex does. Your plan's own limits apply instead of per-token billing."
            : "Use the models in your GitHub Copilot plan, signed in with your GitHub account. Your plan's own limits apply instead of per-token billing."
    }
    private var caution: String {
        flow.kind == .chatgpt
            ? "Unofficial: it isn't a documented API, so it can change or stop working. Everyone who can use this provider uses your plan."
            : "Unofficial: Copilot's API is documented for GitHub's own editors, so it can change or stop working. Everyone who can use this provider uses your plan."
    }

    var body: some View {
        SettingsPage(title: flow.kind.type.label) {
            SettingsSection(footer: caution) { AMNote(text: intro).foregroundStyle(Theme.ink) }
            switch flow.phase {
            case .waiting, .starting:
                if let code = flow.code {
                    Section { AMCodeCard(store: store, code: code, service: flow.kind.page, link: flow.link, expires: flow.expiresAt) }
                        footer: { Text(flow.kind == .chatgpt ? "Enter this code on OpenAI's page. It expires in about 15 minutes. If OpenAI asks, turn on device code login in your ChatGPT security settings, or ask your workspace admin." : "Enter this code on GitHub's page, then approve Atelier.") }
                }
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(flow.code == nil && flow.phase == .waiting ? "Finish signing in in the browser…" : flow.phase == .starting ? "Starting…" : "Waiting for you to enter the code on \(flow.kind.page)…")
                            .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    }
                }
            case .adding:
                Section { HStack(spacing: 10) { ProgressView(); Text("Signed in\(flow.account.map { " as \($0)" } ?? ""). Adding it…").font(.subheadline).foregroundStyle(Theme.inkSecondary) } }
            case .failed(let message):
                Section { AMOutcome(kind: .bad, text: message) }
            case .idle, .done: EmptyView()
            }
            AMButtonRow {
                switch flow.phase {
                case .idle, .failed:
                    Button(flow.phase == .idle ? "Sign in with \(flow.kind.service)" : "Try again") { Task { await flow.start() } }.buttonStyle(ClayButtonStyle())
                case .starting, .waiting:
                    Button("Cancel sign-in") { Task { await flow.cancel() } }.buttonStyle(QuietButtonStyle())
                case .adding, .done:
                    EmptyView()
                }
            }
        }
        .task(id: flow.phase) { if flow.phase == .waiting { await flow.watch() } }
        .task { if AMLaunch.has("start") { await flow.start() } }
        .onChange(of: flow.openNow) { _, url in if let url { openURL(url) } }
        .onChange(of: flow.phase) { _, phase in
            if phase == .done { store.notify("Added \(flow.kind.type.label)"); onAdded() }
        }
        .onDisappear { if flow.waiting { Task { await flow.cancel() } } }
    }
}

/// "Connect with OpenRouter" inside the form: a button, and the waiting line while the page is open.
struct AMOpenRouterConnect: View {
    let store: AppStore
    /// Nil while the rest of the form isn't valid.
    let draft: [String: JSON]?
    let onInvalid: () -> Void
    let onConnected: () -> Void
    @State private var flow: AMOpenRouterFlow
    @Environment(\.openURL) private var openURL

    init(store: AppStore, draft: [String: JSON]?, onInvalid: @escaping () -> Void, onConnected: @escaping () -> Void) {
        self.store = store; self.draft = draft; self.onInvalid = onInvalid; self.onConnected = onConnected
        _flow = State(initialValue: AMOpenRouterFlow(store: store))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch flow.phase {
            case .waiting, .starting:
                HStack(spacing: 10) { ProgressView(); Text("Finish connecting in your browser…").font(.subheadline).foregroundStyle(Theme.inkSecondary) }
                Button("Cancel") { Task { await flow.cancel() } }.buttonStyle(QuietButtonStyle())
            default:
                Button { if let draft { Task { await flow.connect(draft: draft) } } else { onInvalid() } } label: { Text("Connect with OpenRouter") }
                    .buttonStyle(ClayButtonStyle())
                if case .failed(let message) = flow.phase { AMOutcome(kind: .bad, text: message) }
            }
        }
        .task(id: flow.phase) { if flow.phase == .waiting { await flow.watch() } }
        .onChange(of: flow.openNow) { _, url in if let url { openURL(url) } }
        .onChange(of: flow.phase) { _, phase in if case .done(let name) = phase { store.notify("Added \(name.isEmpty ? "OpenRouter" : name)"); onConnected() } }
        .onDisappear { if flow.phase == .waiting { Task { await flow.cancel() } } }
    }
}
