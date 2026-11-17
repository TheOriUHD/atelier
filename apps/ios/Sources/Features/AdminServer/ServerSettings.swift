import SwiftUI

/// Settings › Admin › Server: the version and how to update it, how people sign up, the identity providers, and where the
/// server keeps its data.
struct ServerSettings: View {
    let store: AppStore
    @State private var model: AdminServerModel
    @State private var confirmUpdate = AdminDebug.is("update-confirm")
    @State private var confirmOpen = AdminDebug.is("open-confirm")
    @State private var editing: AdminProviderTarget?
    @State private var copied = false

    static let changelog = URL(string: "https://github.com/TheOriUHD/atelier/blob/main/CHANGELOG.md")!
    static let backupDocs = URL(string: "https://docs.atelierhq.dev/data-and-files/#backing-up-and-restoring")!

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AdminServerModel(store: store))
    }

    var body: some View {
        AdminList(resource: model.resource) { snapshot in
            if snapshot.sharedComputer {
                sharedComputer(snapshot)
            } else {
                version(snapshot)
                if snapshot.signup != nil { accounts(snapshot) }
                if snapshot.redirectBase != nil { singleSignOn(snapshot) }
            }
            thisServer(snapshot)
        }
        .navigationTitle("Server").navigationBarTitleDisplayMode(.inline)
        .onChange(of: model.snapshot?.update?.isRunning) { _, running in if running == true { model.watch() } }
        .onChange(of: model.snapshot) { old, new in
            guard old == nil, let new else { return }
            if AdminDebug.is("provider/new") { editing = AdminProviderTarget(provider: nil) }
            if let id = AdminDebug.parts(after: "provider")?.first, id != "new" { editing = new.providers.first { $0.id == id }.map { AdminProviderTarget(provider: $0) } }
        }
        .onDisappear { model.stopWatching() }
        .sheet(item: $editing) { target in
            AdminProviderSheet(model: model, store: store, redirectBase: model.snapshot?.redirectBase ?? "", provider: target.provider)
        }
        .adminAlert($model.failure)
        .adminToast(store)
    }

    // MARK: Version

    @ViewBuilder private func version(_ snapshot: AdminServerSnapshot) -> some View {
        Section {
            if let update = snapshot.update {
                AdminUpdateStatus(update: update, reconnecting: model.reconnecting)
                ValueRow(title: "Version", value: update.version)
                if let image = update.image { ValueRow(title: "Image", value: image, mono: true, copyable: true) }
                updateActions(update)
                if update.install == .manual {
                    AdminCodeBlock(text: AdminServerUpdate.manualCommand).padding(.vertical, 4)
                    ActionRow(title: "Copy command", symbol: "doc.on.doc") { adminCopy(AdminServerUpdate.manualCommand, store: store, said: "Command copied") }
                }
            } else {
                ValueRow(title: "Version", value: snapshot.version)
                Text("This server cannot say whether there is a newer version.").font(.subheadline).foregroundStyle(Theme.inkMuted)
            }
            Link(destination: Self.changelog) {
                HStack(spacing: 10) {
                    Image(systemName: "doc.text").frame(width: 22)
                    Text("Release notes")
                    Spacer()
                    Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                }.foregroundStyle(Theme.clay)
            }
        } header: {
            Text("Version")
        }
        if let update = snapshot.update, update.install == .updater, update.newerVersion != nil, !update.isRunning {
            Section {
                Button { confirmUpdate = true } label: { Text("Update server") }
                    .buttonStyle(ClayButtonStyle(busy: model.starting)).disabled(model.starting)
                    .confirmationDialog("Update the server to Atelier \(update.newerVersion ?? "")?", isPresented: $confirmUpdate, titleVisibility: .visible) {
                        Button("Update server") { Task { await model.startUpdate() } }
                    } message: { Text("The server downloads the new version and restarts. Everyone is disconnected for a minute or so, and replies being written stop. The apps reconnect by themselves.") }
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            } footer: {
                Text("Back up the server's data folder first. Updates move the database forward and cannot be undone.")
            }
        }
    }

    @ViewBuilder private func updateActions(_ update: AdminServerUpdate) -> some View {
        if update.isRunning || (update.install == .updater && update.newerVersion != nil) {
            EmptyView()
        } else {
            ActionRow(title: "Check now", symbol: "arrow.clockwise", busy: model.checking) { Task { await model.check() } }
        }
    }

    // MARK: Accounts

    @ViewBuilder private func accounts(_ snapshot: AdminServerSnapshot) -> some View {
        let policy = snapshot.signup ?? .invite
        Section {
            PickRow(title: "Sign-up", selection: Binding(get: { policy }, set: { new in
                if new == .open { confirmOpen = true } else { Task { await model.setSignup(new) } }
            }), options: AdminSignup.allCases.map { ($0, $0.title) })
            .disabled(model.savingSignup)
            .confirmationDialog("Let anyone ask for an account?", isPresented: $confirmOpen, titleVisibility: .visible) {
                Button("Open sign-up") { Task { await model.setSignup(.open) } }
            } message: { Text("Anyone who can reach this server can send a request. Each one waits for you to approve it under Users. Keep it on Invite only unless you need otherwise.") }
        } header: {
            Text("Accounts")
        } footer: {
            Text(policy.explanation)
        }
    }

    // MARK: Single sign-on

    @ViewBuilder private func singleSignOn(_ snapshot: AdminServerSnapshot) -> some View {
        Section {
            if snapshot.providers.isEmpty { Text("No identity providers yet.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
            ForEach(snapshot.providers) { provider in
                Button { editing = AdminProviderTarget(provider: provider) } label: {
                    HStack(spacing: 12) {
                        IconTile(symbol: "person.badge.shield.checkmark", size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.name).foregroundStyle(Theme.ink)
                            Text("\(provider.newAccounts.short) · \(provider.people == 1 ? "1 account" : "\(provider.people) accounts")").font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted.opacity(0.6))
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            ActionRow(title: "Add provider", symbol: "plus.circle") { editing = AdminProviderTarget(provider: nil) }
        } header: {
            Text("Single sign-on")
        } footer: {
            Text("Lets people sign in with an identity provider such as Authentik, Keycloak or Google. In this app they choose “Use passkey or SSO in browser”.")
        }
    }

    // MARK: This server

    @ViewBuilder private func thisServer(_ snapshot: AdminServerSnapshot) -> some View {
        Section {
            ValueRow(title: "Address", value: URL(string: snapshot.address)?.host ?? snapshot.address, copyable: true)
            if !snapshot.platform.isEmpty { ValueRow(title: "Runs on", value: snapshot.platform) }
            if !snapshot.dataDir.isEmpty { ValueRow(title: "Data folder", value: snapshot.dataDir, subtitle: "On the computer it runs on", mono: true, copyable: true) }
            Link(destination: Self.backupDocs) {
                HStack(spacing: 10) {
                    Image(systemName: "externaldrive").frame(width: 22)
                    Text("How to back up")
                    Spacer()
                    Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                }.foregroundStyle(Theme.clay)
            }
        } header: {
            Text("This server")
        } footer: {
            Text("Everything the server keeps lives in its data folder: the database, files, settings and the key to its secrets. Back it up before you update, and keep the backup private.")
        }
    }

    @ViewBuilder private func sharedComputer(_ snapshot: AdminServerSnapshot) -> some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: "desktopcomputer", size: 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text("A shared computer").font(.system(.headline, design: .serif, weight: .medium))
                    Text("You are connected to the Atelier app on someone's computer, shared on its network. It has one person and no accounts to manage here.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.vertical, 4)
            ValueRow(title: "Version", value: snapshot.version)
        } header: {
            Text("Shared computer")
        } footer: {
            Text("Updates, sharing, its password and the screen lock are changed in Atelier on that computer.")
        }
    }
}

/// Which provider the sheet edits: none for a new one.
struct AdminProviderTarget: Identifiable {
    let provider: AdminProvider?
    var id: String { provider?.id ?? "new" }
}

// MARK: - The version's status

/// The state of the server's version in one row: up to date, an update to install, one running, or why nothing can be done.
struct AdminUpdateStatus: View {
    let update: AdminServerUpdate
    let reconnecting: Bool

    private struct Look { let symbol: String; let tint: Color; let title: String }

    private var look: Look {
        if update.isRunning { return Look(symbol: "arrow.triangle.2.circlepath", tint: Theme.clay, title: update.job?.state == .restarting ? "Restarting the server" : "Updating the server") }
        if update.failure != nil { return Look(symbol: "exclamationmark.triangle", tint: Theme.danger, title: "The last update failed") }
        if let newer = update.newerVersion { return Look(symbol: "arrow.down.circle", tint: Theme.clay, title: "Atelier \(newer) is available") }
        if update.latestVersion != nil { return Look(symbol: "checkmark.circle", tint: Theme.success, title: update.install == .source ? "Up to date, built from source" : "Up to date") }
        if update.latestError != nil { return Look(symbol: "wifi.exclamationmark", tint: Color(hex: 0xB77800), title: "Cannot check for updates") }
        return Look(symbol: "clock", tint: Theme.inkMuted, title: "Checking for a newer version…")
    }

    private var detail: String? {
        if reconnecting && update.isRunning { return "Waiting for the server to come back. This takes a minute or so." }
        if let reason = update.failureReason { return reason }
        if update.latestVersion == nil, let error = update.latestError { return error }
        let versionLine = update.newerVersion == nil && update.latestVersion != nil ? update.checkedAt.map { "Checked \($0.relative)." } : nil
        return [update.updateDetail, versionLine].compactMap { $0 }.joined(separator: " ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: look.symbol, tint: look.tint, size: 36)
            VStack(alignment: .leading, spacing: 6) {
                Text(look.title).font(.system(.headline, design: .serif, weight: .medium)).foregroundStyle(Theme.ink)
                if let detail, !detail.isEmpty { Text(detail).font(.subheadline).foregroundStyle(update.failure != nil ? Theme.danger : Theme.inkSecondary).fixedSize(horizontal: false, vertical: true).monospacedDigit() }
                if update.isRunning {
                    if let fraction = update.progressFraction { ProgressView(value: fraction).tint(Theme.clay).accessibilityLabel("Server update") } else { ProgressView().controlSize(.small) }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - An identity provider

struct AdminProviderSheet: View {
    let model: AdminServerModel
    let store: AppStore
    let redirectBase: String
    let provider: AdminProvider?
    @Environment(\.dismiss) private var dismiss
    @State private var draft = AdminProviderDraft()
    @State private var touched: Set<String> = []
    @State private var replacingSecret = false
    @State private var saving = false
    @State private var problem: String?
    @State private var confirmRemove = false
    @State private var removing = false
    @State private var copied = false

    private var redirectURI: String { AdminSSO.redirectURI(base: redirectBase, id: provider?.id ?? AdminSSO.providerID(for: draft.name)) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FieldRow(title: "Name", placeholder: "Authentik", text: $draft.name, autocapitalize: true).onChange(of: draft.name) { _, _ in touched.insert("name") }
                    if touched.contains("name"), let text = draft.nameProblem { Text(text).font(.footnote).foregroundStyle(Theme.danger) }
                } footer: { Text("The sign-in page says “Continue with” this name.") }

                Section {
                    Text(redirectURI).font(.mono(.footnote)).foregroundStyle(Theme.ink).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    ActionRow(title: copied ? "Copied" : "Copy redirect address", symbol: copied ? "checkmark" : "doc.on.doc") { adminCopy(redirectURI, store: store, said: "Redirect address copied"); copied = true }
                } header: { Text("Register this at your provider") } footer: {
                    Text("Create an OpenID Connect application at your provider with this redirect address, the authorization code flow and the scopes openid, profile and email. \(provider == nil ? "It follows the name until you add the provider, then it stays. " : "")Anyone who reaches this server at another address needs that address listed at your provider too.")
                }

                Section {
                    FieldRow(title: "Issuer", placeholder: "https://auth.example.com/application/o/atelier/", text: $draft.issuer, keyboard: .URL).onChange(of: draft.issuer) { _, _ in touched.insert("issuer") }
                    if touched.contains("issuer"), let text = draft.issuerProblem { Text(text).font(.footnote).foregroundStyle(Theme.danger) }
                    FieldRow(title: "Client ID", placeholder: "Client ID from your provider", text: $draft.clientId, mono: true).onChange(of: draft.clientId) { _, _ in touched.insert("clientId") }
                    if touched.contains("clientId"), let text = draft.clientIdProblem { Text(text).font(.footnote).foregroundStyle(Theme.danger) }
                    secretRow
                } header: { Text("From your provider") } footer: { Text("Authentik calls the issuer “OpenID Configuration Issuer”. Leave the secret empty for a public client.") }

                Section {
                    Picker("New people", selection: $draft.newAccounts) { ForEach(AdminNewAccounts.allCases) { Text($0.title).tag($0) } }.pickerStyle(.inline).labelsHidden()
                } header: { Text("Someone without an account here") } footer: {
                    Text("Your provider decides who gets this far. Only an account you connected yourself is matched to an existing one.")
                }

                if let problem { Section { Text(problem).font(.footnote).foregroundStyle(Theme.danger) } }

                if provider != nil {
                    Section {
                        ActionRow(title: "Remove provider…", symbol: "trash", destructive: true, busy: removing) { confirmRemove = true }
                    } footer: { Text("It no longer signs anyone in. Their accounts stay; people who have no password or passkey need a password from an admin.") }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(provider == nil ? "Add provider" : "Edit \(provider?.name ?? "provider")").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button(provider == nil ? "Add" : "Save") { save() }.disabled(!draft.isValid) }
                }
            }
            .confirmationDialog("Remove \(provider?.name ?? "this provider")?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove provider", role: .destructive) { remove() }
            } message: { Text("It no longer signs anyone in. Their accounts stay.") }
        }
        .tint(Theme.clay)
        .interactiveDismissDisabled(saving || removing)
        .adminToast(store)
        .onAppear { if let provider { draft = AdminProviderDraft(provider) } }
    }

    @ViewBuilder private var secretRow: some View {
        if let stored = provider?.secret, !replacingSecret {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Client secret").font(.footnote).foregroundStyle(Theme.inkMuted)
                    Text(stored).font(.mono(.body)).foregroundStyle(Theme.inkSecondary)
                }
                Spacer()
                Button("Replace") { replacingSecret = true }.foregroundStyle(Theme.clay).buttonStyle(.borderless)
            }
        } else {
            FieldRow(title: "Client secret", placeholder: provider?.secret == nil ? "Paste it here" : "New secret", text: $draft.secret, secure: true, mono: true)
        }
    }

    private func save() {
        guard draft.isValid, !saving else { return }
        saving = true; problem = nil
        Task {
            defer { saving = false }
            do {
                let saved = try await model.saveProvider(draft, id: provider?.id)
                store.notify(provider == nil ? "\(saved.name) added" : "\(saved.name) saved")
                dismiss()
            } catch is CancellationError { return } catch { problem = AdminFailure.message(for: error) }
        }
    }

    private func remove() {
        guard let provider, !removing else { return }
        removing = true
        Task {
            defer { removing = false }
            do { try await model.removeProvider(provider); store.notify("\(provider.name) removed"); dismiss() }
            catch is CancellationError { return } catch { problem = AdminFailure.message(for: error) }
        }
    }
}
