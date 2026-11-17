import SwiftUI

// MARK: - Settings › Folders

/// The person's folders on all their computers, and the SSH connections they reach some of them through. Folders on a
/// computer are opened in its desktop app; this page lists them, trusts them, forgets them, and opens codespaces and
/// (where the server reaches SSH hosts itself) folders on SSH hosts.
struct FoldersSettings: View {
    let store: AppStore
    @State private var folders: CodeFolders
    @State private var connections: Resource<[JSON]>
    @State private var openRepo = false
    @State private var addSsh = false
    @State private var editing: JSON?
    @State private var addingConnection = false
    @State private var removing: JSON?
    @State private var trust: CodeTrustRequest?
    @State private var forgetting: JSON?

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
        _connections = State(initialValue: Resource { try await codeCall(store, "ssh.list").array })
    }

    private var caps: CodeCapabilities { CodeCapabilities(store: store) }

    var body: some View {
        CodeDebugScroll { SettingsPage(title: "Folders") {
            if !folders.didLoad {
                CodeLoadingRows(failure: folders.error) { Task { await folders.load(devices: true) } }
            } else {
                foldersSection
                addSection
                sshSection
            }
        } }
        .task {
            CodeSshPromptCenter.shared.start(store: store)
            await folders.load(devices: true)
            await connections.reload()
        }
        .refreshable { await folders.load(devices: true); await connections.reload() }
        .sheet(isPresented: $openRepo) {
            NavigationStack { CodeRepositoriesView(store: store) { _ in Task { await folders.load(devices: true) } }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { openRepo = false } } } }.tint(Theme.clay)
        }
        .sheet(isPresented: $addSsh) {
            CodeAddSshFolderSheet(store: store, connections: connections.value ?? []) { _ in Task { await folders.load(devices: true) } }
        }
        .sheet(isPresented: $addingConnection) { CodeSshConnectionSheet(store: store) { _ in Task { await connections.reload() } } }
        .sheet(item: Binding(get: { editing.map(CodeJSONItem.init) }, set: { editing = $0?.json })) { item in
            CodeSshConnectionSheet(store: store, connection: item.json) { _ in Task { await connections.reload() } }
        }
        .confirmationDialog(removing.map { "Remove \($0["name"].string)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { item in
            Button("Remove", role: .destructive) { Task { await store.attempt { _ = try await codeCall(store, "ssh.remove", ["id": item["id"]]) }; await connections.reload() } }
        } message: { _ in Text("Atelier forgets this connection and its saved password. Folders you opened there stay in your list, and the machine itself is untouched.") }
        .confirmationDialog(forgetting.map { "Forget the saved password of \($0["name"].string)?" } ?? "", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible, presenting: forgetting) { item in
            Button("Forget password", role: .destructive) { Task { await store.attempt { _ = try await codeCall(store, "ssh.forgetPassword", ["id": item["id"]]) }; await connections.reload() } }
        } message: { _ in Text("You will be asked for it again the next time this connection needs it.") }
        .codeTrustDialog($trust)
        .codeToast(store)
    }

    // MARK: Folders

    @ViewBuilder private var foldersSection: some View {
        SettingsSection(title: "Folders", footer: "Folders you opened for Code sessions. Their tools run on the computer the folder is on, and can run any command there as you.") {
            if folders.folders.isEmpty {
                Text(caps.addsFoldersOnServer ? "No folders yet. Open a folder in the Atelier desktop app, connected to this server, and it shows up here. Or open a repository in a codespace." : "No folders yet.")
                    .font(.subheadline).foregroundStyle(Theme.inkMuted)
            }
            ForEach(folders.folders) { workspace in
                NavigationLink {
                    CodeFolderDetail(store: store, workspace: workspace, computer: workspace.computer(devices: folders.devices)) { Task { await folders.load(devices: true) } }
                } label: { folderRow(workspace) }
                .swipeActions(edge: .trailing) { Button("Remove", role: .destructive) { remove(workspace) } }
                .swipeActions(edge: .leading) { if !workspace.trusted { Button("Trust") { askTrust(workspace) }.tint(Theme.clay) } }
            }
        }
    }

    private func folderRow(_ workspace: CodeWorkspace) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: workspace.kind == .codespace ? "cloud" : workspace.kind == .ssh ? "server.rack" : "folder")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(workspace.name).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let badge = workspace.kindBadge { StatusBadge(text: badge, tone: .neutral) }
                    if !workspace.trusted { StatusBadge(text: "Not trusted", tone: .warn) }
                    if !workspace.available { StatusBadge(text: "Offline", tone: .neutral) }
                }
                Text(workspace.location).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle)
                Text("\(workspace.computer(devices: folders.devices)) · \(Date(timeIntervalSince1970: Double(workspace.lastUsedAt) / 1000).relative)").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func remove(_ workspace: CodeWorkspace) {
        Task { await store.attempt { _ = try await codeCall(store, "workspaces.remove", ["id": .string(workspace.id)]) }; await folders.load(devices: true) }
    }
    private func askTrust(_ workspace: CodeWorkspace) {
        trust = CodeTrustRequest(path: workspace.root, host: workspace.kind == .codespace ? "GitHub codespace \(workspace.host ?? "")" : workspace.host) {
            Task { await store.attempt { _ = try await codeCall(store, "workspaces.trust", ["id": .string(workspace.id)]) }; await folders.load(devices: true) }
        }
    }

    // MARK: Adding

    @ViewBuilder private var addSection: some View {
        SettingsSection(title: "Add a folder", footer: caps.isDesktopBackend ? "Folders on this computer are added in the desktop app itself." : "A folder on one of your computers is opened in the Atelier desktop app connected to this server; it shows up here once it is.") {
            ActionRow(title: "Open a repository…", symbol: "shippingbox") { openRepo = true }.id("add")
            if caps.isDesktopBackend { ActionRow(title: "Add SSH folder…", symbol: "server.rack") { addSsh = true } }
        }
    }

    // MARK: SSH

    @ViewBuilder private var sshSection: some View {
        let list = connections.value ?? []
        if caps.isDesktopBackend || !list.isEmpty {
            SettingsSection(title: "SSH connections", footer: caps.isDesktopBackend ? "Remote machines you work on over SSH: their host, port and key, and whether Atelier keeps a password for them." : "SSH connections are managed in the Atelier desktop app.") {
                if case .failed(let message) = connections.state { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
                if list.isEmpty, caps.isDesktopBackend, connections.value != nil { Text("No SSH connections yet. Add one to work in a remote machine's folders.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                ForEach(list, id: \.self) { connection in
                    let row = HStack(spacing: 12) {
                        IconTile(symbol: "server.rack")
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(connection["name"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                                if connection["passwordSaved"].bool { StatusBadge(text: "Password saved", tone: .neutral) }
                            }
                            Text(connection["port"].intOrNil.map { "\(connection["host"].string):\($0)" } ?? connection["host"].string).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1)
                            if let folder = connection["folder"].stringOrNil, !folder.isEmpty { Text(folder).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1) }
                        }
                        Spacer(minLength: 4)
                        if caps.isDesktopBackend { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted) }
                    }.contentShape(Rectangle())
                    if caps.isDesktopBackend {
                        Button { editing = connection } label: { row }.buttonStyle(.plain)
                            .swipeActions(edge: .trailing) { Button("Remove", role: .destructive) { removing = connection } }
                            .contextMenu {
                                Button("Edit", systemImage: "pencil") { editing = connection }
                                if connection["passwordSaved"].bool { Button("Forget saved password", systemImage: "key.slash") { forgetting = connection } }
                                Button("Remove", systemImage: "trash", role: .destructive) { removing = connection }
                            }
                    } else { row }
                }
                if caps.isDesktopBackend { ActionRow(title: "Add SSH connection…", symbol: "plus") { addingConnection = true } }
            }
        }
    }
}

/// A JSON value a sheet can be shown for.
struct CodeJSONItem: Identifiable {
    let json: JSON
    var id: String { json["id"].string.isEmpty ? json.pretty : json["id"].string }
}

/// One folder: where it is, whether it is trusted, and removing it.
struct CodeFolderDetail: View {
    let store: AppStore
    let workspace: CodeWorkspace
    let computer: String
    let changed: () -> Void
    @State private var confirmRemove = false
    @State private var trust: CodeTrustRequest?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SettingsPage(title: workspace.name) {
            SettingsSection {
                ValueRow(title: "Folder", value: workspace.location, mono: true, copyable: true)
                ValueRow(title: "Computer", value: computer)
                ValueRow(title: "Kind", value: workspace.kind == .ssh ? "SSH host" : workspace.kind == .codespace ? "Codespace" : "Computer")
                ValueRow(title: "Last used", value: Date(timeIntervalSince1970: Double(workspace.lastUsedAt) / 1000).relative)
                HStack {
                    Text("Status").foregroundStyle(Theme.ink)
                    Spacer()
                    StatusBadge(text: workspace.available ? "Available" : "Offline", tone: workspace.available ? .good : .neutral)
                }
            }
            SettingsSection(title: "Trust", footer: workspace.trusted ? "This folder's own settings, hooks and instruction files apply." : "Until you trust it, Atelier ignores what the folder brings itself: its permission rules and hooks, its instruction files, and its skills, commands and agents.") {
                HStack {
                    Text("Trusted").foregroundStyle(Theme.ink)
                    Spacer()
                    StatusBadge(text: workspace.trusted ? "Yes" : "Not yet", tone: workspace.trusted ? .good : .warn)
                }
                if !workspace.trusted {
                    ActionRow(title: "Trust this folder", symbol: "checkmark.shield", busy: busy) {
                        trust = CodeTrustRequest(path: workspace.root, host: workspace.kind == .codespace ? "GitHub codespace \(workspace.host ?? "")" : workspace.host) {
                            busy = true
                            Task {
                                if await store.attempt({ _ = try await codeCall(store, "workspaces.trust", ["id": .string(workspace.id)]) }) { store.notify("Trusted"); changed(); dismiss() }
                                busy = false
                            }
                        }
                    }
                }
            }
            SettingsSection(footer: "Atelier only forgets this folder. Nothing in it is deleted, and you can open it again any time.") {
                ActionRow(title: "Remove from my folders", symbol: "minus.circle", destructive: true) { confirmRemove = true }
            }
        }
        .confirmationDialog("Remove \(workspace.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task { if await store.attempt({ _ = try await codeCall(store, "workspaces.remove", ["id": .string(workspace.id)]) }) { changed(); dismiss() } }
            }
        } message: { Text("Atelier only forgets this folder. Nothing in it is deleted, and you can open it again any time.") }
        .codeTrustDialog($trust)
        .codeToast(store)
    }
}

/// Add a folder on an SSH host: pick the host, browse its folders, trust the one you choose.
struct CodeAddSshFolderSheet: View {
    let store: AppStore
    let connections: [JSON]
    var onAdded: (CodeWorkspace) -> Void
    @State private var typed = ""
    @State private var configHosts: [String] = []
    @State private var browsing: String?
    @State private var chosen: (host: String, path: String)?
    @State private var trust: CodeTrustRequest?
    @State private var adding = false
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    private var hosts: [(host: String, name: String)] {
        var list = connections.map { ($0["host"].string, $0["name"].string) }
        for host in configHosts where !list.contains(where: { $0.0 == host }) { list.append((host, host)) }
        return list
    }
    private var typedValid: Bool { let t = typed.trimmingCharacters(in: .whitespaces); return !t.isEmpty && !t.hasPrefix("-") && t.range(of: CodeSshConnectionSheet.hostPattern, options: .regularExpression) != nil }

    var body: some View {
        NavigationStack {
            List {
                if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger) } }
                Section {
                    ForEach(hosts, id: \.host) { entry in
                        Button { browsing = entry.host } label: {
                            HStack(spacing: 12) {
                                IconTile(symbol: "server.rack", size: 28)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(entry.name).foregroundStyle(Theme.ink)
                                    if entry.name != entry.host { Text(entry.host).font(.mono(.caption)).foregroundStyle(Theme.inkMuted) }
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if hosts.isEmpty { Text("No SSH connections yet. Add one in Folders, or type a host below.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                } header: { Text("Host") }
                Section {
                    FieldRow(placeholder: "user@hostname", text: $typed, keyboard: .URL, mono: true)
                    ActionRow(title: "Browse folders…", symbol: "folder") { browsing = typed.trimmingCharacters(in: .whitespaces) }.disabled(!typedValid)
                } header: { Text("Another host") } footer: { Text("A host from ~/.ssh/config, or user@host. The first folder on a host takes a few seconds while Atelier copies its runner there.") }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Add SSH folder").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .overlay { if adding { ProgressView("Adding the folder…").padding(24).glassEffect(.regular, in: .rect(cornerRadius: 20)) } }
            .sheet(item: Binding(get: { browsing.map { CodeStringItem(value: $0) } }, set: { browsing = $0?.value })) { item in
                let start = connections.first { $0["host"].string == item.value }?["folder"].stringOrNil
                CodeRemoteFolderBrowser(store: store, host: item.value, start: start) { path in
                    chosen = (item.value, path)
                    trust = CodeTrustRequest(path: path, host: item.value) { Task { await add(host: item.value, path: path) } }
                }
            }
            .codeTrustDialog($trust)
            .task {
                CodeSshPromptCenter.shared.start(store: store)
                configHosts = (try? await codeCall(store, "workspaces.sshHosts").array.map(\.string)) ?? []
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }

    private func add(host: String, path: String) async {
        adding = true; problem = nil
        defer { adding = false }
        do {
            let added = CodeWorkspace(try await codeCall(store, "workspaces.addSsh", ["host": .string(host), "path": .string(path)]))
            store.notify("\(added.name) added")
            onAdded(added)
            dismiss()
        } catch is CancellationError { return } catch { problem = error.localizedDescription }
    }
}

struct CodeStringItem: Identifiable { let value: String; var id: String { value } }
