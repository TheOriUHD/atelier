import SwiftUI

// MARK: - SSH: questions from a connection, connections, and the remote folder browser

/// Shows what an SSH connection asks while it connects (an unknown host's key, a password) over whatever is on screen,
/// and sends the answer. A question answered on another device closes here.
@MainActor final class CodeSshPromptCenter {
    static let shared = CodeSshPromptCenter()
    private var started: ObjectIdentifier?
    private var showing: [String: UIViewController] = [:]

    /// Starts listening on this store's connection (once). Screens that can begin a connection call it.
    func start(store: AppStore) {
        CodeEvents.shared.install(on: store)
        guard started != ObjectIdentifier(store.rpc) else { return }
        started = ObjectIdentifier(store.rpc)
        CodeEvents.shared.observe { [weak self, weak store] method, value in
            guard let self, let store else { return }
            if method == "ssh.prompt" { self.show(value, store: store) }
            else if method == "ssh.promptClosed" { self.close(value["id"].string) }
        }
    }

    private func show(_ prompt: JSON, store: AppStore) {
        let id = prompt["id"].string
        guard showing[id] == nil else { return }
        let view = CodeSshPromptView(store: store, prompt: prompt) { [weak self] in self?.showing[id] = nil }
        showing[id] = CodePresenter.present(view, detents: [.medium()], modal: true)
    }
    private func close(_ id: String) {
        showing.removeValue(forKey: id)?.dismiss(animated: true)
    }
}

/// "Trust this host?" or "Sign in to this host": one question a connection asks.
struct CodeSshPromptView: View {
    let store: AppStore
    let prompt: JSON
    let done: () -> Void
    @State private var password = ""
    @State private var save = false
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    private var isHostKey: Bool { prompt["kind"].string == "hostkey" }
    private var connection: String { prompt["connection"].string.isEmpty ? prompt["host"].string : prompt["connection"].string }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    IconTile(symbol: isHostKey ? "lock.shield" : "key", size: 48)
                    if isHostKey {
                        Text("Trust \(connection)?").font(.reading(.title2, weight: .semibold))
                        Text("\(prompt["host"].string) is not in your known hosts yet. Check that this is the key you expect before you go on. Trusting it records it for next time.")
                            .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(prompt["keyType"].string).font(.footnote).foregroundStyle(Theme.inkMuted)
                            Text(prompt["fingerprint"].string).font(.mono(.callout)).textSelection(.enabled)
                        }
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else {
                        Text("Sign in to \(connection)").font(.reading(.title2, weight: .semibold))
                        Text(prompt["prompt"].string.isEmpty ? "This connection asks for a password." : prompt["prompt"].string)
                            .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                        if prompt["retry"].bool { Text("That was not accepted. Try again.").font(.footnote).foregroundStyle(Theme.danger) }
                        SecureField("Password", text: $password).textContentType(.password)
                            .padding(14).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        if prompt["canSave"].bool { ToggleRow(title: "Save password", subtitle: "Kept encrypted for this connection.", isOn: $save) }
                    }
                    VStack(spacing: 10) {
                        Button(isHostKey ? "Trust and connect" : "Sign in") { answer(accept: true) }
                            .buttonStyle(ClayButtonStyle(busy: busy)).disabled(busy || (!isHostKey && password.isEmpty))
                        Button("Cancel") { answer(accept: false) }.buttonStyle(QuietButtonStyle()).disabled(busy)
                    }
                }
                .padding(24)
            }
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(Theme.clay)
    }

    private func answer(accept: Bool) {
        busy = true
        var params: [String: JSON] = ["id": prompt["id"]]
        if accept {
            if isHostKey { params["accept"] = .bool(true) } else { params["password"] = .string(password); if save { params["save"] = .bool(true) } }
        } else { params["accept"] = .bool(false) }
        Task {
            // A question already closed elsewhere is not a problem here.
            _ = try? await store.rpc.call("ssh.answer", params)
            done(); dismiss()
        }
    }
}

// MARK: Connections

/// Adds an SSH connection or edits one: its name, host, port, key and starting folder, with a test.
struct CodeSshConnectionSheet: View {
    let store: AppStore
    var connection: JSON?
    var onSaved: (JSON) -> Void = { _ in }
    @State private var name = ""
    @State private var host = ""
    @State private var port = ""
    @State private var key = ""
    @State private var folder = ""
    @State private var testing = false
    @State private var saving = false
    @State private var result: (ok: Bool, message: String)?
    @Environment(\.dismiss) private var dismiss

    static let hostPattern = #"^[\w.@:+-]+$"#
    private var hostProblem: String? {
        let text = host.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return nil }
        if text.hasPrefix("-") || text.range(of: Self.hostPattern, options: .regularExpression) == nil { return "Use user@hostname or a host from ~/.ssh/config." }
        return nil
    }
    private var portProblem: String? {
        guard !port.isEmpty else { return nil }
        guard let value = Int(port), (1...65535).contains(value) else { return "Use a port from 1 to 65535, or leave it empty." }
        return nil
    }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !host.trimmingCharacters(in: .whitespaces).isEmpty && hostProblem == nil && portProblem == nil }

    private var input: [String: JSON] {
        func text(_ value: String) -> JSON { value.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(value.trimmingCharacters(in: .whitespaces)) }
        var params: [String: JSON] = ["name": .string(name.trimmingCharacters(in: .whitespaces)), "host": .string(host.trimmingCharacters(in: .whitespaces)), "port": Int(port).map { .number(Double($0)) } ?? .null, "keyPath": text(key), "folder": text(folder)]
        if let id = connection?["id"].stringOrNil { params["id"] = .string(id) }
        return params
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FieldRow(title: "Name", placeholder: "Work laptop", text: $name, autocapitalize: true)
                    VStack(alignment: .leading, spacing: 4) {
                        FieldRow(title: "SSH host", placeholder: "user@hostname", text: $host, keyboard: .URL, mono: true)
                        if let hostProblem { Text(hostProblem).font(.footnote).foregroundStyle(Theme.danger) }
                    }
                } footer: { Text("A host from ~/.ssh/config, or user@host. The first time, you are asked to trust its key.") }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        FieldRow(title: "SSH port", placeholder: "22", text: $port, keyboard: .numberPad)
                        if let portProblem { Text(portProblem).font(.footnote).foregroundStyle(Theme.danger) }
                    }
                    FieldRow(title: "SSH key (optional)", placeholder: "~/.ssh/id_ed25519", text: $key, mono: true)
                    FieldRow(title: "Starting folder (optional)", placeholder: "~/projects", text: $folder, mono: true)
                } footer: { Text("Empty uses your ssh configuration or agent, and the host's home folder.") }
                Section {
                    ActionRow(title: "Test connection", symbol: "bolt.horizontal", busy: testing) { Task { await test() } }.disabled(!valid)
                    if let result {
                        Label(result.message, systemImage: result.ok ? "checkmark.circle" : "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(result.ok ? Theme.success : Theme.danger)
                    }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle(connection == nil ? "Add SSH connection" : "Edit connection").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { if saving { ProgressView() } else { Text("Save").fontWeight(.semibold) } }.disabled(!valid || saving)
                }
            }
            .onAppear {
                CodeSshPromptCenter.shared.start(store: store)
                guard let connection, name.isEmpty else { return }
                name = connection["name"].string; host = connection["host"].string
                port = connection["port"].intOrNil.map(String.init) ?? ""; key = connection["keyPath"].string; folder = connection["folder"].string
            }
        }
        .tint(Theme.clay)
    }

    private func test() async {
        testing = true; result = nil
        defer { testing = false }
        do {
            let answer = try await codeCall(store, "ssh.test", input)
            result = (answer["ok"].bool, answer["message"].string.isEmpty ? (answer["ok"].bool ? "Connected." : "Could not connect.") : answer["message"].string)
        } catch is CancellationError { return } catch { result = (false, error.localizedDescription) }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        if await store.attempt({ let saved = try await codeCall(store, "ssh.save", input); store.notify("Saved"); onSaved(saved); dismiss() }) { return }
    }
}

// MARK: The remote folder browser

/// "Select remote folder": a host's folders one level at a time, with a path to type and a place to make a new folder.
struct CodeRemoteFolderBrowser: View {
    let store: AppStore
    let host: String
    var start: String?
    let onPick: (String) -> Void
    @State private var listing: (path: String, home: String, dirs: [String])?
    @State private var typed = ""
    @State private var error: String?
    @State private var loading = false
    @State private var naming = false
    @State private var folderName = ""
    @State private var latest = 0
    @Environment(\.dismiss) private var dismiss

    /// The breadcrumb's steps for `path`: the home folder first, then each folder below it (or from `/`).
    static func crumbs(path: String, home: String) -> [(label: String, path: String)] {
        let below = path == home || path.hasPrefix(home + "/")
        let base = below ? home : "/"
        let rest = path.dropFirst(base.count).split(separator: "/").map(String.init)
        var out: [(String, String)] = [(below ? (home.split(separator: "/").last.map(String.init) ?? "/") : "/", base)]
        var at = base == "/" ? "" : base
        for part in rest { at += "/" + part; out.append((part, at)) }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                if let error { Section { Text(error).font(.subheadline).foregroundStyle(Theme.danger) } }
                if let listing {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(Array(Self.crumbs(path: listing.path, home: listing.home).enumerated()), id: \.offset) { index, crumb in
                                    if index > 0 { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Theme.inkMuted) }
                                    Button { Task { await go(crumb.path) } } label: {
                                        HStack(spacing: 4) {
                                            if index == 0, crumb.path == listing.home { Image(systemName: "house").font(.footnote) }
                                            Text(crumb.label).font(.subheadline)
                                        }.padding(.horizontal, 8).padding(.vertical, 5)
                                    }.buttonStyle(.plain).foregroundStyle(crumb.path == listing.path ? Theme.ink : Theme.clay)
                                }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                    }
                    Section {
                        ActionRow(title: "Use this folder", symbol: "checkmark.circle", tint: Theme.clay) { dismiss(); onPick(listing.path) }
                        if listing.dirs.isEmpty { Text("No folders here.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                        ForEach(listing.dirs, id: \.self) { dir in
                            Button { Task { await go(listing.path == "/" ? "/\(dir)" : "\(listing.path)/\(dir)") } } label: {
                                HStack(spacing: 12) {
                                    IconTile(symbol: "folder", size: 28)
                                    Text(dir).foregroundStyle(Theme.ink).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    } header: { Text("Folders on \(host)") }
                } else if error == nil {
                    Section { HStack(spacing: 10) { ProgressView(); Text("Connecting to \(host)…").foregroundStyle(Theme.inkMuted) } }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Select remote folder").navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 10) {
                    TextField("Path", text: $typed).font(.mono(.callout)).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.go)
                        .onSubmit { Task { await go(typed.trimmingCharacters(in: .whitespaces)) } }
                    if loading { ProgressView() }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(.bar)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("New folder", systemImage: "folder.badge.plus") { folderName = ""; naming = true }.disabled(listing == nil) }
            }
            .alert("New folder", isPresented: $naming) {
                TextField("Name", text: $folderName).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Create") { Task { await create() } }
            } message: { Text("Made inside \(listing?.path ?? "the folder shown").") }
            .task {
                CodeSshPromptCenter.shared.start(store: store)
                await go(start)
            }
        }
        .tint(Theme.clay)
    }

    private func go(_ path: String?) async {
        latest += 1
        let mine = latest
        loading = true; error = nil
        defer { if mine == latest { loading = false } }
        do {
            var params: [String: JSON] = ["host": .string(host)]
            if let path, !path.isEmpty { params["path"] = .string(path) }
            let next = try await codeCall(store, "ssh.browse", params)
            guard mine == latest else { return }
            listing = (next["path"].string, next["home"].string, next["dirs"].array.map(\.string))
            typed = next["path"].string
        } catch is CancellationError { return } catch { if mine == latest { self.error = error.localizedDescription } }
    }

    private func create() async {
        guard let listing, !folderName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        loading = true
        defer { loading = false }
        do {
            let made = try await codeCall(store, "ssh.mkdir", ["host": .string(host), "parent": .string(listing.path), "name": .string(folderName.trimmingCharacters(in: .whitespaces))])
            await go(made["path"].string)
        } catch is CancellationError { return } catch { self.error = error.localizedDescription }
    }
}

// MARK: Trusting a folder

/// "Trust this workspace?": asked before a folder new to the person's list is used, because the agent may read, write and
/// run commands there and the folder may bring its own settings and hooks.
struct CodeTrustRequest: Identifiable {
    let id = UUID()
    let path: String
    var host: String?
    let trust: () -> Void
}

extension View {
    func codeTrustDialog(_ request: Binding<CodeTrustRequest?>) -> some View {
        confirmationDialog("Trust this workspace?", isPresented: Binding(get: { request.wrappedValue != nil }, set: { if !$0 { request.wrappedValue = nil } }), titleVisibility: .visible, presenting: request.wrappedValue) { item in
            Button("Trust workspace") { item.trust() }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text("Atelier's agent may read, write or run commands in \(item.path)\(item.host.map { " on \($0)" } ?? ""), as you. Only go on if you trust what is in it.")
        }
    }
}
