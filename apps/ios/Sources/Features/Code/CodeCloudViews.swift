import SwiftUI
import UIKit

// MARK: - GitHub and codespaces

/// The person's GitHub connection: a sign-in with a code (where an admin set up the OAuth app) or a personal access token.
@MainActor @Observable final class CodeGitHub {
    struct Flow: Equatable { let id: String; let code: String; let uri: String; let interval: Int }

    private(set) var connected: Bool?
    private(set) var login: String?
    private(set) var deviceFlowOffered = false
    var failure: String?
    private(set) var flow: Flow?
    private(set) var starting = false
    var flowError: String?
    let store: AppStore
    private var polling: Task<Void, Never>?
    /// Told when a connection is made, so lists that failed for want of one load again.
    var onConnected: () -> Void = {}

    init(store: AppStore) { self.store = store }
    isolated deinit { polling?.cancel() }

    func load() async {
        do {
            let status = try await codeCall(store, "github.status")
            connected = status["connected"].bool
            login = status["login"].stringOrNil
            failure = nil
            if let settings = try? await codeCall(store, "settings.get") { deviceFlowOffered = !settings["effective"]["cloud"]["github"]["clientId"].string.isEmpty }
        } catch is CancellationError { return }
        catch { failure = error.localizedDescription }
    }

    func startDevice() async {
        starting = true; flowError = nil
        defer { starting = false }
        do {
            let started = try await codeCall(store, "github.deviceStart")
            let next = Flow(id: started["flowId"].string, code: started["userCode"].string, uri: started["verificationUri"].string, interval: max(2, started["interval"].int))
            flow = next
            poll(next)
        } catch is CancellationError { return }
        catch { flowError = error.localizedDescription }
    }

    func cancelDevice() { polling?.cancel(); polling = nil; flow = nil }

    /// Waits for the person to approve on github.com, no faster than GitHub asks.
    private func poll(_ flow: Flow) {
        polling?.cancel()
        polling = Task { [weak self] in
            var seconds = flow.interval
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled, let self else { return }
                do {
                    let result = try await codeCall(self.store, "github.devicePoll", ["flowId": .string(flow.id)])
                    switch result["status"].string {
                    case "pending": seconds = max(2, result["interval"].int > 0 ? result["interval"].int : seconds)
                    case "connected":
                        self.flow = nil; self.connected = true; self.login = result["login"].stringOrNil
                        self.store.notify("Connected to GitHub as @\(self.login ?? "")")
                        self.onConnected(); return
                    case "denied": self.flow = nil; self.flowError = "GitHub sign-in was denied."; return
                    default: self.flow = nil; self.flowError = "The code expired. Start again for a new one."; return
                    }
                } catch is CancellationError { return }
                catch { self.flow = nil; self.flowError = error.localizedDescription; return }
            }
        }
    }

    /// Connects with a personal access token, checked with GitHub before the server keeps it. Returns the problem in words, or nil.
    func connect(token: String) async -> String? {
        do {
            let result = try await codeCall(store, "github.connectToken", ["token": .string(token)])
            connected = result["connected"].bool; login = result["login"].stringOrNil
            store.notify("Connected to GitHub as @\(login ?? "")")
            onConnected()
            return nil
        } catch is CancellationError { return nil }
        catch { return error.localizedDescription }
    }

    func disconnect() async {
        await store.attempt { _ = try await codeCall(self.store, "github.disconnect"); self.connected = false; self.login = nil }
    }
}

/// Not connected: how to connect. While a sign-in runs: the code to enter on github.com, large, with Copy and Open.
struct CodeGitHubConnect: View {
    let github: CodeGitHub
    let isAdmin: Bool
    @State private var tokenSheet = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let flow = github.flow {
            VStack(alignment: .leading, spacing: 16) {
                Text("Enter this code on GitHub to connect your account:").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                Text(flow.code).font(.system(size: 34, weight: .medium, design: .monospaced)).tracking(5).textSelection(.enabled)
                    .frame(maxWidth: .infinity).padding(.vertical, 18)
                    .background(Theme.fill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityLabel("Your code: \(flow.code.map(String.init).joined(separator: " "))")
                HStack(spacing: 10) {
                    Button { UIPasteboard.general.string = flow.code; github.store.notify("Code copied") } label: { Label("Copy code", systemImage: "doc.on.doc") }.buttonStyle(QuietButtonStyle())
                    Button { if let url = URL(string: flow.uri) { openURL(url) } } label: { Label("Open GitHub", systemImage: "arrow.up.right.square") }.buttonStyle(ClayButtonStyle())
                }
                HStack(spacing: 8) { ProgressView(); Text("Waiting for you to approve on GitHub…").font(.footnote).foregroundStyle(Theme.inkMuted) }
                Button("Cancel", role: .cancel) { github.cancelDevice() }.font(.subheadline).foregroundStyle(Theme.inkSecondary)
            }
            .padding(.vertical, 6)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Not connected").font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink)
                    Text(github.deviceFlowOffered ? "Sign in with GitHub, or connect with a personal access token." : "Connect with a personal access token. Signing in with GitHub needs an OAuth app\(isAdmin ? ": add its client id below." : ", which an admin adds in Settings.")")
                        .font(.footnote).foregroundStyle(Theme.inkMuted)
                    if let message = github.flowError { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
                }
                if github.deviceFlowOffered {
                    Button("Sign in with GitHub") { Task { await github.startDevice() } }.buttonStyle(ClayButtonStyle(busy: github.starting)).disabled(github.starting)
                }
                Button("Use a token…") { tokenSheet = true }.buttonStyle(QuietButtonStyle())
            }
            .padding(.vertical, 4)
            .sheet(isPresented: $tokenSheet) { CodeGitHubTokenSheet(github: github) }
            .onAppear {
                #if DEBUG
                if Launch.value("--code-open") == "token" { tokenSheet = true }
                #endif
            }
        }
    }
}

/// Paste a personal access token.
struct CodeGitHubTokenSheet: View {
    let github: CodeGitHub
    @State private var token = ""
    @State private var problem: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FieldRow(title: "Personal access token", placeholder: "ghp_…", text: $token, secure: true, mono: true)
                    if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
                } footer: { Text("A classic personal access token with the codespace and repo scopes. Fine-grained tokens may not work for terminal access.") }
                Section {
                    Button { if let url = URL(string: "https://github.com/settings/tokens/new?scopes=codespace,repo&description=Atelier") { openURL(url) } } label: {
                        Label("Create one on GitHub", systemImage: "arrow.up.right.square")
                    }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Connect with a token").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await connect() } } label: { if busy { ProgressView() } else { Text("Connect").fontWeight(.semibold) } }
                        .disabled(token.trimmingCharacters(in: .whitespaces).count < 10 || busy)
                }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }

    private func connect() async {
        busy = true; problem = nil
        defer { busy = false }
        if let message = await github.connect(token: token.trimmingCharacters(in: .whitespaces)) { problem = message } else { dismiss() }
    }
}

// MARK: Settings › Cloud

struct CloudSettings: View {
    let store: AppStore
    @State private var github: CodeGitHub
    @State private var codespaces: Resource<[JSON]>
    @State private var folders: CodeFolders
    @State private var system: CodeSystemSettings
    @State private var confirmDisconnect = false
    @State private var creating = false
    @State private var busy: [String: String] = [:]
    @State private var deleting: JSON?
    @State private var trust: CodeTrustRequest?
    @State private var settled = true

    init(store: AppStore) {
        self.store = store
        _github = State(initialValue: CodeGitHub(store: store))
        _codespaces = State(initialValue: Resource { try await codeCall(store, "codespaces.list").array })
        _folders = State(initialValue: CodeFolders(store: store))
        _system = State(initialValue: CodeSystemSettings(store: store))
    }

    var body: some View {
        CodeDebugScroll { SettingsPage(title: "Cloud") {
            if github.connected == nil {
                CodeLoadingRows(failure: github.failure) { Task { await github.load() } }
            } else {
                SettingsSection(title: "GitHub", footer: "Codespaces run on your GitHub account. Atelier keeps its token encrypted and uses it only for Codespaces.") {
                    if github.connected == true {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Connected as @\(github.login ?? "")").foregroundStyle(Theme.ink)
                            Text("Your codespaces and their folders use this account.").font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                        ActionRow(title: "Disconnect", symbol: "xmark.circle", destructive: true) { confirmDisconnect = true }
                    } else {
                        CodeGitHubConnect(github: github, isAdmin: store.isAdmin)
                    }
                    if store.isAdmin {
                        CodeCommitField(title: "GitHub OAuth app client id", placeholder: "Client id", value: system.string(["cloud", "github", "clientId"]), mono: true) { text in
                            let done = text.isEmpty ? await system.reset(["cloud", "github", "clientId"]) : await system.set(["cloud", "github", "clientId"], .string(text))
                            if done { await github.load() }
                            return done
                        }
                    }
                }
                if github.connected == true { codespaceSections }
            }
        } }
        .task {
            github.onConnected = { Task { await codespaces.reload() } }
            await github.load()
            await system.load()
            await folders.load()
            #if DEBUG
            if Launch.value("--code-open") == "device" { await github.startDevice() }
            #endif
        }
        .task(id: github.connected) { if github.connected == true { await codespaces.reload() } }
        .task(id: settled) {
            // A codespace that is starting or stopping is read again until it settles.
            while !settled, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                await codespaces.reload()
            }
        }
        .onChange(of: codespaces.value) { _, list in settled = list?.allSatisfy { CodeFormat.codespaceSettled($0["state"].string) } ?? true }
        .refreshable { await github.load(); await codespaces.reload(); await folders.load() }
        .sheet(isPresented: $creating) {
            CodeNewCodespaceSheet(store: store) { created in
                Task { await codespaces.reload() }
                store.notify("\(created["displayName"].string) is ready")
            }
        }
        .confirmationDialog("Disconnect GitHub?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await github.disconnect(); codespaces = Resource { try await codeCall(store, "codespaces.list").array } } }
        } message: { Text("Atelier forgets the token. Your codespaces keep running on GitHub until their idle timeout, and their folders can't be used until you connect again.") }
        .confirmationDialog(deleting.map { "Delete \($0["displayName"].string)?" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { item in
            Button("Delete codespace", role: .destructive) { run(item, "delete") { _ = try await codeCall(store, "codespaces.delete", ["name": item["name"]]) } }
        } message: { _ in Text("GitHub deletes the codespace and everything in it. Changes that aren't committed and pushed are lost.") }
        .codeTrustDialog($trust)
        .codeToast(store)
    }

    @ViewBuilder private var codespaceSections: some View {
        SettingsSection(title: "Codespaces", footer: "Cloud machines on GitHub for Code sessions. Each one stops after its idle timeout and runs at most 12 hours at a time.") {
            switch codespaces.state {
            case .idle, .loading:
                HStack { Spacer(); ProgressView(); Spacer() }.frame(minHeight: 60)
            case .failed(let message):
                InlineError(message: message) { Task { await codespaces.reload() } }.listRowBackground(Color.clear)
            case .loaded(let list):
                if list.isEmpty {
                    Text("No codespaces yet. Create one for a repository to run Code sessions in the cloud.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                }
                ForEach(list, id: \.self) { codespace in codespaceRow(codespace) }
            }
            ActionRow(title: "New codespace", symbol: "plus") { creating = true }.id("codespaces")
            NavigationLink {
                CodeRepositoriesView(store: store) { _ in Task { await codespaces.reload(); await folders.load() } }
            } label: { NavRow(symbol: "shippingbox", title: "Open a repository", subtitle: "Your repositories, with a codespace opened for you") }
        }
    }

    private func isFolder(_ codespace: JSON) -> Bool { folders.all.contains { $0.kind == .codespace && $0.host == codespace["name"].string } }

    private func codespaceRow(_ codespace: JSON) -> some View {
        let (state, tone) = CodeFormat.codespaceState(codespace["state"].string)
        let name = codespace["name"].string
        let place = [codespace["repo"].string, codespace["machine"].stringOrNil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let usage = [codespace["idleTimeoutMinutes"].intOrNil.map { "Stops after \($0) min idle" }, codespace["lastUsedAt"].date.map { "Used \($0.relative)" }].compactMap { $0 }.joined(separator: " · ")
        return HStack(spacing: 12) {
            IconTile(symbol: "cloud")
            VStack(alignment: .leading, spacing: 4) {
                Text(codespace["displayName"].string.isEmpty ? name : codespace["displayName"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(2)
                HStack(spacing: 6) {
                    StatusBadge(text: state, tone: tone)
                    if isFolder(codespace) { StatusBadge(text: "Folder", tone: .neutral) }
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(place).lineLimit(1).truncationMode(.middle)
                    if !usage.isEmpty { Text(usage).lineLimit(1) }
                }.font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            Spacer(minLength: 4)
            if let what = busy[name] {
                ProgressView().accessibilityLabel(what)
            } else {
                Menu {
                    if !isFolder(codespace) { Button("Use as folder", systemImage: "folder.badge.plus") { useAsFolder(codespace) } }
                    if codespace["state"].string == "Available" { Button("Stop", systemImage: "stop.circle") { run(codespace, "stop") { _ = try await codeCall(store, "codespaces.stop", ["name": codespace["name"]]) } } }
                    if codespace["state"].string == "Shutdown" { Button("Start", systemImage: "play.circle") { run(codespace, "start") { _ = try await codeCall(store, "codespaces.start", ["name": codespace["name"]]) } } }
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = codespace }
                } label: { Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(Theme.inkMuted).frame(width: 36, height: 36).contentShape(Rectangle()) }
                    .accessibilityLabel("Actions for \(codespace["displayName"].string)")
            }
        }
        .swipeActions(edge: .trailing) { Button("Delete", role: .destructive) { deleting = codespace } }
    }

    private func run(_ codespace: JSON, _ what: String, _ action: @escaping () async throws -> Void) {
        let name = codespace["name"].string
        busy[name] = what
        Task {
            await store.attempt { try await action() }
            busy[name] = nil
            await codespaces.reload()
        }
    }

    private func useAsFolder(_ codespace: JSON) {
        trust = CodeTrustRequest(path: codespace["repo"].string, host: "GitHub codespace \(codespace["name"].string)") {
            run(codespace, "folder") {
                _ = try await codeCall(store, "workspaces.addCodespace", ["name": codespace["name"], "trust": .bool(true)])
                await folders.load()
                store.notify("\(codespace["displayName"].string) is one of your folders now")
            }
        }
    }
}

// MARK: Repositories: open one in a codespace

/// "Open a repository": pick one of your repositories and everything else is done for you. Atelier finds its codespace,
/// wakes it when it went to sleep, or creates one on the largest machine the account allows.
struct CodeRepositoriesView: View {
    let store: AppStore
    var onOpened: (CodeWorkspace) -> Void = { _ in }
    @State private var github: CodeGitHub
    @State private var repos: Resource<[JSON]>
    @State private var codespaces: Resource<[JSON]>
    @State private var folders: CodeFolders
    @State private var query = ""
    @State private var opening: (repo: String, since: Date, waking: Bool)?
    @State private var problem: String?
    @State private var trust: CodeTrustRequest?
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, onOpened: @escaping (CodeWorkspace) -> Void = { _ in }) {
        self.store = store
        self.onOpened = onOpened
        _github = State(initialValue: CodeGitHub(store: store))
        _repos = State(initialValue: Resource { try await codeCall(store, "github.repos").array })
        _codespaces = State(initialValue: Resource { try await codeCall(store, "codespaces.list").array })
        _folders = State(initialValue: CodeFolders(store: store))
    }

    private var matches: [JSON] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        return (repos.value ?? []).filter { repo in words.allSatisfy { repo["fullName"].string.lowercased().contains($0) } }
    }
    private func codespace(for repo: String) -> JSON? {
        (codespaces.value ?? []).filter { $0["repo"].string.lowercased() == repo.lowercased() }.max { ($0["lastUsedAt"].int) < ($1["lastUsedAt"].int) }
    }

    var body: some View {
        Group {
            if let opening { openingView(opening) }
            else if github.connected == nil { ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if github.connected == false {
                List { Section { CodeGitHubConnect(github: github, isAdmin: store.isAdmin) } header: { Text("Connect GitHub to see your repositories") } }
                    .listStyle(.insetGrouped).scrollContentBackground(.hidden)
            } else { list }
        }
        .background(Theme.sunken)
        .navigationTitle("Open a repository").navigationBarTitleDisplayMode(.inline)
        .task {
            github.onConnected = { Task { await repos.reload(); await codespaces.reload() } }
            await github.load()
            await folders.load()
            if github.connected == true { await repos.reload(); await codespaces.reload() }
        }
        .codeTrustDialog($trust)
        .codeToast(store)
    }

    @ViewBuilder private var list: some View {
        switch repos.state {
        case .idle, .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message): ScrollView { InlineError(message: message) { Task { await repos.reload() } }.padding(.top, 60) }
        case .loaded(let all):
            List {
                if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger) } }
                Section {
                    if matches.isEmpty { Text(all.isEmpty ? "No repositories on this account." : "No repository matches.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                    ForEach(matches.prefix(100), id: \.self) { repo in
                        let existing = codespace(for: repo["fullName"].string)
                        Button { choose(repo["fullName"].string, existing: existing) } label: {
                            HStack(spacing: 12) {
                                IconTile(symbol: repo["private"].bool ? "lock" : "arrow.triangle.branch", size: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(repo["fullName"].string).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                                    if let pushed = repo["pushedAt"].date { Text("Pushed \(pushed.relative)").font(.footnote).foregroundStyle(Theme.inkMuted) }
                                }
                                Spacer(minLength: 4)
                                if let existing { let (state, tone) = CodeFormat.codespaceState(existing["state"].string); StatusBadge(text: state, tone: tone) }
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                } footer: {
                    if matches.count > 100 { Text("\(matches.count - 100) more: type to narrow the list.") }
                    else { Text("Atelier opens the repository's codespace on GitHub, waking it if it went to sleep, or creates one on the largest machine your account allows.") }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search repositories")
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .refreshable { await repos.reload(); await codespaces.reload() }
        }
    }

    private func openingView(_ opening: (repo: String, since: Date, waking: Bool)) -> some View {
        VStack(spacing: 18) {
            ProgressView().controlSize(.large)
            Text(opening.waking ? "Waking \(opening.repo)…" : "Setting up \(opening.repo)…").font(.reading(.title3, weight: .medium)).multilineTextAlignment(.center)
            TimelineView(.periodic(from: opening.since, by: 1)) { context in
                let seconds = max(0, Int(context.date.timeIntervalSince(opening.since)))
                Text("\(seconds / 60):\(String(format: "%02d", seconds % 60))").font(.system(.title3, design: .monospaced)).foregroundStyle(Theme.inkMuted)
            }
            Text(opening.waking ? "It takes up to a minute. Atelier wakes it again whenever it has gone to sleep." : "A new codespace takes one to three minutes the first time; after that it only needs waking. You can leave this screen: it keeps going.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
        }
        .padding(32).frame(maxWidth: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func choose(_ repo: String, existing: JSON?) {
        guard opening == nil else { return }
        problem = nil
        let known = existing.map { c in folders.all.contains { $0.kind == .codespace && $0.host == c["name"].string && $0.trusted } } ?? false
        if known { open(repo, existing: existing, trusted: true) }
        else {
            trust = CodeTrustRequest(path: repo, host: existing.map { "GitHub codespace \($0["name"].string)" } ?? "a GitHub codespace") { open(repo, existing: existing, trusted: false) }
        }
    }

    private func open(_ repo: String, existing: JSON?, trusted: Bool) {
        opening = (repo, .now, existing != nil)
        Task {
            do {
                var params: [String: JSON] = ["repo": .string(repo)]
                if !trusted { params["trust"] = .bool(true) }
                let workspace = CodeWorkspace(try await codeCall(store, "codespaces.open", params))
                opening = nil
                store.notify("Opened \(repo)")
                onOpened(workspace)
                dismiss()
            } catch is CancellationError { opening = nil } catch {
                opening = nil
                problem = "Opening \(repo) failed: \(error.localizedDescription)"
                store.notify("Opening \(repo) failed")
            }
        }
    }
}

// MARK: New codespace

/// Creates a codespace for a repository: its branch, machine and idle timeout.
struct CodeNewCodespaceSheet: View {
    let store: AppStore
    var onCreated: (JSON) -> Void = { _ in }
    @State private var repo = ""
    @State private var ref = ""
    @State private var machine = ""
    @State private var idle = 30
    @State private var machines: Resource<[JSON]>?
    @State private var lookup: (repo: String, ref: String)?
    @State private var started: Date?
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    static let timeouts: [(Int, String)] = [(5, "5 minutes"), (15, "15 minutes"), (30, "30 minutes"), (60, "1 hour"), (120, "2 hours"), (240, "4 hours")]
    static let pattern = #"^[\w.-]+/[\w.-]+$"#

    /// owner/repo, also from a pasted github.com URL.
    static func name(_ text: String) -> String {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("https://github.com/") { t.removeFirst("https://github.com/".count) }
        if t.hasSuffix(".git") { t.removeLast(4) }
        if t.hasSuffix("/") { t.removeLast() }
        return t
    }
    private var repoName: String { Self.name(repo) }
    private var repoValid: Bool { repoName.range(of: Self.pattern, options: .regularExpression) != nil }
    private var chosenMachine: String { machine.isEmpty ? (machines?.value?.first?["name"].string ?? "") : machine }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        FieldRow(title: "Repository", placeholder: "owner/repo", text: $repo, mono: true)
                            .onSubmit { look() }
                        if !repo.isEmpty, !repoValid { Text("Enter a repository as owner/repo.").font(.footnote).foregroundStyle(Theme.danger) }
                    }
                    FieldRow(title: "Branch", placeholder: "main", text: $ref, mono: true).onSubmit { look() }
                } footer: { Text("Empty uses the default branch.") }
                Section {
                    if let machines {
                        switch machines.state {
                        case .idle, .loading: HStack(spacing: 10) { ProgressView(); Text("Loading machines…").foregroundStyle(Theme.inkMuted) }
                        case .failed(let message): Text(message).font(.footnote).foregroundStyle(Theme.danger)
                        case .loaded(let list):
                            PickRow(title: "Machine", selection: Binding(get: { chosenMachine }, set: { machine = $0 }), options: list.map { ($0["name"].string, "\($0["displayName"].string)") })
                        }
                    } else {
                        ActionRow(title: "Look up machines", symbol: "magnifyingglass") { look() }.disabled(!repoValid)
                    }
                    PickRow(title: "Idle timeout", selection: $idle, options: Self.timeouts)
                } footer: { Text("A cloud machine on GitHub with the repository checked out. It stops after the idle timeout and runs at most 12 hours at a time.") }
                if let started {
                    Section {
                        TimelineView(.periodic(from: started, by: 1)) { context in
                            let seconds = max(0, Int(context.date.timeIntervalSince(started)))
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Creating the codespace, usually one to three minutes (\(seconds / 60):\(String(format: "%02d", seconds % 60))). You can leave this screen: it keeps going.").font(.footnote).foregroundStyle(Theme.inkMuted)
                            }
                        }
                    }
                }
                if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger) } }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("New codespace").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(started == nil ? "Cancel" : "Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await create() } } label: { if started != nil { ProgressView() } else { Text("Create").fontWeight(.semibold) } }
                        .disabled(!repoValid || chosenMachine.isEmpty || started != nil)
                }
            }
            .onChange(of: repo) { _, _ in machines = nil; machine = "" }
            .onChange(of: ref) { _, _ in machines = nil; machine = "" }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }

    private func look() {
        guard repoValid else { return }
        let name = repoName, branch = ref.trimmingCharacters(in: .whitespaces)
        let resource = Resource<[JSON]> { [store] in
            var params: [String: JSON] = ["repo": .string(name)]
            if !branch.isEmpty { params["ref"] = .string(branch) }
            return try await codeCall(store, "codespaces.machines", params).array
        }
        machines = resource
        Task { await resource.reload() }
    }

    private func create() async {
        started = .now; problem = nil
        do {
            var params: [String: JSON] = ["repo": .string(repoName), "machine": .string(chosenMachine), "idleTimeoutMinutes": .number(Double(idle))]
            if !ref.trimmingCharacters(in: .whitespaces).isEmpty { params["ref"] = .string(ref.trimmingCharacters(in: .whitespaces)) }
            let created = try await codeCall(store, "codespaces.create", params)
            started = nil
            onCreated(created)
            dismiss()
        } catch is CancellationError { started = nil } catch {
            started = nil
            problem = "Creating the codespace failed: \(error.localizedDescription)"
        }
    }
}
