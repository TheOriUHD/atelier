import SwiftUI

// MARK: - Starting a Code session

/// The sheet that starts a Code session: where it works (a folder, or none), how much it may do, which model and how
/// hard it thinks, and optionally a new branch to start on. Calls `sessions.create`, then `onCreated` with the new session's id.
/// Starting a Code session: a page in the app (not a sheet), where it works and what it is for.
struct NewCodeSessionPage: View {
    let store: AppStore
    var onCreated: (String) -> Void
    @State private var folders: CodeFolders
    @State private var system: CodeSystemSettings
    @State private var chosen: String?
    @State private var scratch = false
    /// Where the session works (`CodeTarget.id`): the place comes first, the folder is one there.
    @State private var targetID: String?
    @AppStorage("atelier.code.target") private var rememberedTarget = ""
    @State private var mode: String = ""
    @State private var model = ""
    @State private var effort = ""
    @State private var branch = ""
    @State private var currentBranch: String?
    @State private var branchKnown = false
    @State private var trust: CodeTrustRequest?
    @State private var busy = false
    @State private var problem: String?
    @State private var openRepo = false
    @State private var addSsh = false
    @State private var preferredModel: String?
    /// What the person wants done first; the session starts with it.
    @State private var prompt = ""
    @State private var options = false
    /// The effort panel is open: it covers the box until the person taps elsewhere.
    @State private var effortOpen = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(store: AppStore, onCreated: @escaping (String) -> Void) {
        self.store = store
        self.onCreated = onCreated
        _folders = State(initialValue: CodeFolders(store: store))
        _system = State(initialValue: CodeSystemSettings(store: store))
    }

    private static var isDemoScreen: Bool {
        #if DEBUG
        Demo.requested != nil
        #else
        false
        #endif
    }

    private var caps: CodeCapabilities { CodeCapabilities(store: store) }
    private var selectedFolder: CodeWorkspace? { chosen.flatMap { id in folders.folders.first { $0.id == id } } }
    private var targets: [CodeTarget] { CodeTarget.targets(folders: folders.all, devices: folders.devices) }
    private var target: CodeTarget? { targets.first { $0.id == targetID } }
    private var chosenModel: JSON? { store.models.first { $0["ref"].string == model } }
    private var modes: [CodeMode] { CodeMode.offered(code: true, planAuto: caps.planAuto) }
    private var effectiveMode: CodeMode { CodeMode(rawValue: mode) ?? system.defaultMode }
    private var ready: Bool { (selectedFolder != nil || scratch) && !model.isEmpty && !busy }

    private var optionsSheet: some View {
        NavigationStack {
            List {
                if selectedFolder != nil, branchKnown { branchSection }
                Section {
                    Picker("Permission mode", selection: $mode) {
                        Text("Default · \(system.defaultMode.short)").tag("")
                        ForEach(modes) { Label($0.title, systemImage: $0.symbol).tag($0.rawValue) }
                    }
                } header: { Text("How much it may do") } footer: { Text(effectiveMode.detail + ".") }
                Section {
                    PickRow(title: "Model", selection: $model, options: store.models.map { ($0["ref"].string, $0["displayName"].string) })
                } header: { Text("Model") }
                if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger).textSelection(.enabled) } }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Session options").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { options = false } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }

    // MARK: The page

    var body: some View {
        Group {
            startPage
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if sizeClass == .regular { ToolbarItem(placement: .principal) { HomeModePicker() } } }
            .task {
                // The box takes the keyboard when the page opens; the canned demo screens (screenshots) stay without it.
                Task { try? await Task.sleep(for: .milliseconds(450)); focused = !Self.isDemoScreen }
                CodeSshPromptCenter.shared.start(store: store)
                await folders.load(devices: true)
                await system.load()
                if model.isEmpty {
                    if let prefs = try? await store.rpc.call("prefs.get"), let ref = prefs["models"]["code"].stringOrNil, store.models.contains(where: { $0["ref"].string == ref }) { preferredModel = ref }
                    model = preferredModel ?? (store.models.contains { $0["ref"].string == store.selectedModel } ? store.selectedModel : store.models.first?["ref"].string ?? "")
                }
                if targetID == nil, let first = CodeTarget.initial(targets, remembered: rememberedTarget.isEmpty ? nil : rememberedTarget) { choose(target: first.id) }
                #if DEBUG
                // `--effort <level>` opens the effort panel on that level, for looking at it.
                if let level = Launch.value("--effort") { effort = level; try? await Task.sleep(for: .milliseconds(500)); effortOpen = true }
                #endif
            }
            .onChange(of: chosen) { _, _ in Task { await loadBranch() } }
            .onChange(of: model) { _, _ in if !effortLevels.contains(effort) { effort = "" } }
            .codeTrustDialog($trust)
            .sheet(isPresented: $options) { optionsSheet }
            .sheet(isPresented: $openRepo) {
                NavigationStack {
                    CodeRepositoriesView(store: store) { workspace in Task { await folders.load(devices: true); select(workspace) } }
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { openRepo = false } } }
                }.tint(Theme.clay)
            }
            .sheet(isPresented: $addSsh) {
                CodeAddSshFolderSheet(store: store, connections: []) { workspace in Task { await folders.load(devices: true); select(workspace) } }
            }
        }
        .tint(Theme.clay)
    }

    private var effortLevels: [String] { ChatEffort.choices(chosenModel, mode: "code", ultracode: ChatHub.of(store).ultracodeOn) }
    private var effortLabel: String? {
        guard effortLevels.count > 1, let shown = ChatEffort.shown(effort.isEmpty ? nil : effort, model: chosenModel, mode: "code", ultracode: ChatHub.of(store).ultracodeOn) else { return nil }
        return ChatEffort.name(shown, model: chosenModel)
    }

    private var firstName: String { store.userName.split(separator: " ").first.map(String.init) ?? "" }

    /// The greeting, where the session will work, and the box to say what it is for.
    private var startPage: some View {
        // On an iPad the greeting and the box are one group in the middle, as on a new conversation's page; on a phone the box
        // sits at the bottom, above the keyboard.
        let wide = sizeClass == .regular
        return VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 18) {
                AtelierMark(size: 46)
                Text(firstName.isEmpty ? "What shall we build?" : "Hello, \(firstName)")
                    .font(.system(size: 32, weight: .regular, design: .serif)).foregroundStyle(Theme.ink)
            }
            if wide { Spacer().frame(height: 34) } else { Spacer(minLength: 0) }
            VStack(alignment: .leading, spacing: 12) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        targetMenu
                        folderMenu
                        if let currentBranch, branchKnown { pill(currentBranch, symbol: "arrow.triangle.branch") { options = true } }
                    }.padding(.horizontal, 2)
                }
                box.coveredBy($effortOpen) {
                    if let model = chosenModel { EffortPanel(store: store, model: model, mode: "code", local: $effort) }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, wide ? 0 : 10)
            if wide { Spacer(minLength: 0); Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .paperBehind()
        .overlay(alignment: .top) {
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger).padding(12).background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).padding(.horizontal, 16).padding(.top, 8) }
        }
    }

    private func pillLabel(_ title: String, symbol: String, menu: Bool = false) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 15))
            Text(title).font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle)
            if menu { Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.inkMuted) }
        }
        .foregroundStyle(Theme.ink).padding(.horizontal, 14).frame(height: 44)
        .background(Theme.surface, in: Capsule()).overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
    }

    private func pill(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { pillLabel(title, symbol: symbol) }.buttonStyle(.plain)
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Describe a task or ask a question…", text: $prompt, axis: .vertical)
                .lineLimit(1...8).focused($focused).font(.body)
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 4)
            HStack(spacing: 8) {
                Button { options = true } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.inkSecondary).frame(width: 36, height: 36).background(Theme.fill, in: Circle())
                }.buttonStyle(.plain).accessibilityLabel("Session options")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Menu {
                            Picker("Model", selection: $model) { ForEach(store.models.filter { !$0["hidden"].bool }, id: \.self) { Text($0["displayName"].string).tag($0["ref"].string) } }
                        } label: { chip(chosenModel?["displayName"].string ?? "Choose a model") }
                        if let label = effortLabel { EffortChip(label: label) { focused = false; effortOpen = true } }
                        Menu {
                            Picker("Permission mode", selection: $mode) {
                                Text("Default · \(system.defaultMode.short)").tag("")
                                ForEach(modes) { Label($0.title, systemImage: $0.symbol).tag($0.rawValue) }
                            }
                        } label: { chip(effectiveMode.short, symbol: effectiveMode.symbol) }
                    }
                }.scrollBounceBehavior(.basedOnSize)
                Spacer(minLength: 0)
                Button { focused = false; Task { await create() } } label: {
                    ZStack {
                        Circle().fill(Theme.clay.opacity(ready ? 1 : 0.35))
                        if busy { ProgressView().tint(.white) } else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(.white) }
                    }.frame(width: 36, height: 36)
                }.buttonStyle(.plain).disabled(!ready).accessibilityLabel("Start session")
            }.padding(.horizontal, 10).padding(.bottom, 10).padding(.top, 2)
        }
        .raisedBox()
    }

    private func chip(_ title: String, symbol: String? = nil) -> some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .medium)) }
            Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.fill, in: Capsule())
    }

    // MARK: Where: the place first, then a folder there

    /// The place, as the web's first chip: this server, each computer of the person's, the cloud, an SSH host.
    private var targetMenu: some View {
        Menu {
            Picker("Where", selection: Binding(get: { targetID ?? "" }, set: { choose(target: $0) })) {
                ForEach(targets) { place in
                    Label(place.online ? place.name : "\(place.name) · offline", systemImage: place.symbol).tag(place.id).disabled(!place.online)
                }
            }
            if caps.isDesktopBackend {
                Divider()
                Button("Add SSH folder…", systemImage: "plus") { addSsh = true }
            }
        } label: { pillLabel(target?.name ?? "Choose where", symbol: target?.symbol ?? "laptopcomputer", menu: true) }
            .menuStyle(.button).buttonStyle(.plain).accessibilityLabel("Where it works")
    }

    /// The folder, as the web's second chip: those of the chosen place, the latest first, and what adds one there.
    private var folderMenu: some View {
        Menu {
            if let target {
                Picker("Folder", selection: Binding(get: { scratch ? "none" : (chosen ?? "") }, set: { choose(folder: $0) })) {
                    if target.kind == .server { Label("No folder", systemImage: "folder.badge.questionmark").tag("none") }
                    ForEach(target.folders) { workspace in
                        Label(menuTitle(workspace), systemImage: "folder").tag(workspace.id).disabled(!workspace.available)
                    }
                }
                switch target.kind {
                case .cloud:
                    Divider()
                    Button("Open a repository…", systemImage: "shippingbox") { openRepo = true }
                case .computer:
                    Divider()
                    Button("Open more folders in its desktop app", systemImage: "laptopcomputer") {}.disabled(true)
                case .server, .ssh:
                    if target.folders.isEmpty && target.kind == .ssh { Button("No folders here yet") {}.disabled(true) }
                    if caps.isDesktopBackend { Divider(); Button("Add SSH folder…", systemImage: "plus") { addSsh = true } }
                }
            }
        } label: {
            pillLabel(scratch ? "No folder" : (selectedFolder?.label ?? "Select folder…"), symbol: scratch ? "folder.badge.questionmark" : "folder", menu: true)
        }
        .menuStyle(.button).buttonStyle(.plain).accessibilityLabel("Folder")
    }

    private func menuTitle(_ workspace: CodeWorkspace) -> String {
        var title = workspace.label
        if !workspace.available { title += " · offline" } else if !workspace.trusted { title += " · not trusted" }
        return title
    }

    /// Picks a place: it starts in the latest folder there that can be reached (the server with none starts with no folder).
    private func choose(target id: String) {
        guard let place = targets.first(where: { $0.id == id }) else { return }
        targetID = id
        rememberedTarget = id
        if let folder = place.firstUsable { chosen = folder.id; scratch = false }
        else { chosen = nil; scratch = place.kind == .server }
    }

    private func choose(folder id: String) {
        if id == "none" { chosen = nil; scratch = true } else { chosen = id; scratch = false }
    }

    /// A folder that was just added: its place and it.
    private func select(_ workspace: CodeWorkspace) {
        let place = CodeTarget.id(of: workspace)
        targetID = place
        rememberedTarget = place
        chosen = workspace.id
        scratch = false
    }

    // MARK: Branch

    private var branchSection: some View {
        Section {
            if let currentBranch { ValueRow(title: "Now on", value: currentBranch, mono: true) }
            FieldRow(title: "Start on a new branch (optional)", placeholder: "feature/my-change", text: $branch, mono: true)
        } header: { Text("Branch") } footer: { Text("Atelier makes the branch from what is checked out now, keeping your changes, before the session starts.") }
    }

    private func loadBranch() async {
        branchKnown = false; currentBranch = nil
        guard let workspace = selectedFolder, workspace.available, workspace.trusted else { return }
        if let status = try? await store.rpc.call("workspaces.gitStatus", ["workspaceId": .string(workspace.id)]), status != .null {
            currentBranch = status["branch"].stringOrNil
            branchKnown = true
        }
    }

    // MARK: Start

    private func create() async {
        problem = nil
        if let workspace = selectedFolder, !workspace.trusted {
            trust = CodeTrustRequest(path: workspace.root, host: workspace.kind == .codespace ? "GitHub codespace \(workspace.host ?? "")" : workspace.host) {
                Task { await start(trusting: workspace) }
            }
            return
        }
        await start(trusting: nil)
    }

    private func start(trusting: CodeWorkspace?) async {
        busy = true
        defer { busy = false }
        do {
            if let trusting { _ = try await codeCall(store, "workspaces.trust", ["id": .string(trusting.id)]) }
            let name = branch.trimmingCharacters(in: .whitespaces)
            if let workspace = selectedFolder, branchKnown, !name.isEmpty {
                _ = try await codeCall(store, "git.checkout", ["workspaceId": .string(workspace.id), "branch": .string(name), "create": .bool(true)])
            }
            var params: [String: JSON] = ["mode": "code", "model": .string(model)]
            if let workspace = selectedFolder { params["workspaceId"] = .string(workspace.id) } else { params["scratch"] = .object([:]) }
            if !mode.isEmpty { params["permissionMode"] = .string(mode) }
            if !effort.isEmpty { params["effort"] = .string(effort) }
            let session = try await codeCall(store, "sessions.create", params)
            try? await store.refresh()
            let id = session["id"].string
            let first = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !first.isEmpty {
                try await store.open(id)
                store.draft = first
                try await store.send()
            }
            onCreated(id)
        } catch is CancellationError { return } catch { problem = error.localizedDescription }
    }
}

// MARK: - The permission mode of the open session

/// The open session's permission mode as a chip for the message box: Auto, Ask, Accept edits, Plan (and Plan · Auto where the
/// server has it). A chat has no plan to approve, so it offers four.
struct PermissionModeChip: View {
    let store: AppStore
    @State private var system: CodeSystemSettings
    @State private var changing = false

    init(store: AppStore) {
        self.store = store
        _system = State(initialValue: CodeSystemSettings(store: store))
    }

    private var session: CodeSession { CodeSession(store: store) }
    private var isCode: Bool { session.summary?.mode == "code" }
    private var current: CodeMode {
        let own = session.permissionMode ?? system.defaultMode
        return isCode ? own : own.forChat()
    }

    var body: some View {
        if session.id != nil, session.summary != nil {
            Menu {
                Picker("Permission mode", selection: Binding(get: { current }, set: { change(to: $0) })) {
                    ForEach(CodeMode.offered(code: isCode, planAuto: CodeCapabilities(store: store).planAuto)) { mode in
                        Label { Text(mode.title); Text(mode.detail) } icon: { Image(systemName: mode.symbol) }.tag(mode)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if changing { ProgressView().controlSize(.mini) } else { Image(systemName: current.symbol).font(.system(size: 12, weight: .medium)) }
                    Text(current.short).font(.subheadline.weight(.medium)).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(current == .bypass ? Theme.danger : current.isPlan ? Theme.clay : Theme.ink)
                .padding(.horizontal, 12).frame(minHeight: 34)
                .background(Theme.fill, in: Capsule())
            }
            .accessibilityLabel("Permission mode: \(current.title)")
            .task {
                await system.load()
                CodeLaunch.openRequested(store)
            }
        }
    }

    private func change(to mode: CodeMode) {
        guard mode != current else { return }
        changing = true
        Task {
            defer { changing = false }
            await CodePermission.set(mode, store: store)
        }
    }
}

/// Changing the open session's permission mode.
@MainActor enum CodePermission {
    static func set(_ mode: CodeMode, store: AppStore) async {
        guard let id = CodeSession(store: store).id else { return }
        await store.attempt {
            let updated = try await codeCall(store, "sessions.update", ["id": .string(id), "permissionMode": .string(mode.rawValue)])
            if let index = store.sessions.firstIndex(where: { $0.id == id }) { store.sessions[index] = Conversation(raw: updated) }
        }
    }
}

/// The Permission row of the + sheet: the mode in force, opening the list of modes.
struct PermissionModeRow: View {
    let store: AppStore
    @State private var system: CodeSystemSettings

    init(store: AppStore) {
        self.store = store
        _system = State(initialValue: CodeSystemSettings(store: store))
    }

    private var session: CodeSession { CodeSession(store: store) }
    private var isCode: Bool { session.summary?.mode == "code" }
    private var current: CodeMode {
        let own = session.permissionMode ?? system.defaultMode
        return isCode ? own : own.forChat()
    }

    var body: some View {
        NavigationLink { PermissionModePage(store: store) } label: {
            HStack(spacing: 14) {
                Image(systemName: "checkmark.shield").font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 26)
                Text("Permission").foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(current.short).foregroundStyle(Theme.inkMuted).lineLimit(1)
            }
        }
        .task { await system.load() }
    }
}

/// "Select mode": every permission mode with what it means, the one in force checked.
struct PermissionModePage: View {
    let store: AppStore
    @State private var system: CodeSystemSettings
    @State private var changing: CodeMode?

    init(store: AppStore) {
        self.store = store
        _system = State(initialValue: CodeSystemSettings(store: store))
    }

    private var session: CodeSession { CodeSession(store: store) }
    private var isCode: Bool { session.summary?.mode == "code" }
    private var current: CodeMode {
        let own = session.permissionMode ?? system.defaultMode
        return isCode ? own : own.forChat()
    }

    private func tint(_ mode: CodeMode) -> Color {
        switch mode {
        case .ask: Theme.ink
        case .acceptEdits: Color(hex: 0x7C6AF2)
        case .plan, .planAuto: Color(hex: 0x3B82F6)
        case .auto: Theme.clay
        case .bypass: Theme.danger
        }
    }

    var body: some View {
        List {
            Section {
                ForEach(CodeMode.offered(code: isCode, planAuto: CodeCapabilities(store: store).planAuto)) { mode in
                    Button {
                        guard mode != current, changing == nil else { return }
                        UISelectionFeedbackGenerator().selectionChanged()
                        changing = mode
                        Task { await CodePermission.set(mode, store: store); changing = nil }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: mode.symbol).font(.system(size: 20)).foregroundStyle(tint(mode)).frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mode.title).foregroundStyle(Theme.ink)
                                Text(mode.detail).font(.subheadline).foregroundStyle(Theme.inkMuted).fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            if changing == mode { ProgressView() }
                            else if current == mode { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Theme.clay) }
                        }.contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(current == mode ? .isSelected : [])
                }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Select mode").navigationBarTitleDisplayMode(.inline)
        .task { await system.load() }
    }
}

// MARK: - Debug launch

/// Debug builds opened with `--open code/<panel>` show that panel once the conversation is on screen:
/// files, changes, git, terminal, plan, tasks, checkpoints, folder, new.
enum CodeLaunch {
    @MainActor private static var done = false

    @MainActor static func openRequested(_ store: AppStore) {
        #if DEBUG
        guard !done, let route = Launch.route("code") else { return }
        done = true
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            let path = Launch.value("--code-path") ?? "src/server.ts"
            switch route {
            case "new": CodePresenter.present(NavigationStack { NewCodeSessionPage(store: store) { _ in } })
            case "viewer": CodePresenter.present(CodeDebugViewer(store: store, path: path, line: Launch.value("--code-line").flatMap(Int.init)))
            case "task": CodePresenter.present(CodePanelFrame(title: "Background tasks", store: store) { CodeTaskDetail(store: store, taskId: Launch.value("--code-task") ?? "k1") })
            case "newloop": CodePresenter.present(CodeNewLoopSheet(store: store))
            case "mention": CodePresenter.present(VStack { Spacer(); FileMentionList(store: store, query: Launch.value("--code-query") ?? "ser") { _ in }.padding(16) }.background(Theme.background), detents: [.medium()])
            case "ssh-key": CodePresenter.present(CodeSshPromptView(store: store, prompt: .obj(["id": "p1", "kind": "hostkey", "connection": "Build box", "host": "build-box", "keyType": "ssh-ed25519", "fingerprint": "SHA256:Z0kqy3c1Dw1m2G8Qm0fT3q3vN8o5Nn1c0J7y3jF2xQ4"])) {}, detents: [.medium()], modal: true)
            case "ssh-password": CodePresenter.present(CodeSshPromptView(store: store, prompt: .obj(["id": "p2", "kind": "password", "connection": "Build box", "host": "build-box", "prompt": "philipp@build-box's password:", "retry": true, "canSave": true])) {}, detents: [.medium()], modal: true)
            case "ssh-connection": CodePresenter.present(CodeSshConnectionSheet(store: store))
            case "ssh-add-folder": CodePresenter.present(CodeAddSshFolderSheet(store: store, connections: [.obj(["host": "build-box", "name": "Build box"]), .obj(["host": "home", "name": "home"])]) { _ in })
            case "ssh-browse": CodePresenter.present(CodeRemoteFolderBrowser(store: store, host: "build-box") { _ in })
            case "repos": CodePresenter.present(NavigationStack { CodeRepositoriesView(store: store) }.tint(Theme.clay))
            case "new-codespace": CodePresenter.present(CodeNewCodespaceSheet(store: store))
            default: CodePanel(rawValue: route)?.present(store: store)
            }
        }
        #endif
    }
}

#if DEBUG
/// A file opened in its viewer, for looking at it (`--open code/viewer --code-path <file> --code-line <n>`).
struct CodeDebugViewer: View {
    let store: AppStore
    let path: String
    var line: Int?
    @State private var folders: CodeFolders
    init(store: AppStore, path: String, line: Int?) {
        self.store = store; self.path = path; self.line = line
        _folders = State(initialValue: CodeFolders(store: store))
    }
    var body: some View {
        CodePanelFrame(title: "Files", store: store) {
            CodeFolderGate(folders: folders) { workspace in CodeFileViewer(store: store, workspace: workspace, path: path, line: line) }
        }
        .task { await folders.load() }
    }
}
#endif
