import SwiftUI

/// Settings › Admin › Users: who can sign in, who is waiting for approval, and the invite codes. A person opens to their own page.
struct UsersSettings: View {
    let store: AppStore
    @State private var model: AdminUsersModel
    @State private var adding = AdminDebug.is("add") || AdminDebug.is("add-result")
    @State private var inviting = AdminDebug.is("invite") || AdminDebug.is("invite-result")
    @State private var rejecting: AdminPerson?
    @State private var revoking: AdminInvite?
    @State private var removingPast: AdminInvite?
    @State private var pushed: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AdminUsersModel(rpc: store.rpc, selfID: store.authStatus["user"]["id"].string))
    }

    var body: some View {
        AdminList(resource: model.resource) { snapshot in
            people(snapshot)
            if !snapshot.waiting.isEmpty { waiting(snapshot.waiting) }
            if snapshot.invitesProblem != AdminFailure.unsupportedText { invites(snapshot) }
        }
        .navigationTitle("Users").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Label("Add user", systemImage: "person.badge.plus") }.disabled(model.snapshot == nil)
            }
        }
        .navigationDestination(isPresented: Binding(get: { pushed != nil }, set: { if !$0 { pushed = nil } })) {
            if let pushed { AdminUserDetail(model: model, store: store, id: pushed) }
        }
        .onChange(of: model.snapshot) { old, new in
            guard old == nil, let new else { return }
            if let id = AdminDebug.parts(after: "user")?.first { pushed = id }
            if AdminDebug.is("toast") { store.notify("Password copied") }
            if AdminDebug.is("reject") { rejecting = new.waiting.first }
            if AdminDebug.is("revoke") { revoking = new.openInvites.first }
        }
        .sheet(isPresented: $adding) { AdminAddUserSheet(model: model, store: store) }
        .sheet(isPresented: $inviting) { AdminInviteSheet(model: model, store: store) }
        .adminAlert($model.failure)
        .adminToast(store)
    }

    // MARK: Sections

    @ViewBuilder private func people(_ snapshot: AdminUsersSnapshot) -> some View {
        Section {
            ForEach(snapshot.members) { person in
                NavigationLink { AdminUserDetail(model: model, store: store, id: person.id) } label: { AdminPersonRow(person: person, isSelf: person.id == model.selfID) }
            }
        } header: {
            Text("People")
        } footer: {
            if snapshot.members.count <= 1 { Text("You are the only person here. Add someone, or create an invite code.") }
        }
    }

    @ViewBuilder private func waiting(_ people: [AdminPerson]) -> some View {
        Section {
            ForEach(people) { person in
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        Avatar(name: person.name, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person.name).lineLimit(1)
                            Text("@\(person.username) · asked \(person.createdAt?.relative ?? "recently")").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
                        }
                    }
                    HStack(spacing: 10) {
                        Button("Approve") { Task { if await model.approve(person) { store.notify("\(person.name) can sign in") } } }
                            .buttonStyle(AdminPillButtonStyle(prominent: true))
                        Button("Reject") { rejecting = person }.buttonStyle(AdminPillButtonStyle())
                            .confirmationDialog("Reject \(person.name)?", isPresented: Binding(get: { rejecting?.id == person.id }, set: { if !$0 { rejecting = nil } }), titleVisibility: .visible) {
                                Button("Reject request", role: .destructive) { Task { if await model.reject(person) { store.notify("Request rejected") } } }
                            } message: { Text("The request is deleted. They can ask again while sign-up is open.") }
                        if model.isBusy(person.id) { ProgressView() }
                    }
                    .disabled(model.isBusy(person.id))
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .contain)
            }
        } header: {
            Text("Waiting for approval")
        } footer: {
            Text("These people asked for an account. Approving lets them in as users; you can make them admins afterwards. Rejecting deletes the request.")
        }
    }

    @ViewBuilder private func invites(_ snapshot: AdminUsersSnapshot) -> some View {
        Section {
            if let problem = snapshot.invitesProblem {
                Text(problem).font(.subheadline).foregroundStyle(Theme.inkMuted)
            } else if snapshot.openInvites.isEmpty {
                Text("No open invite codes.").font(.subheadline).foregroundStyle(Theme.inkMuted)
            }
            ForEach(snapshot.openInvites) { invite in
                HStack(spacing: 12) {
                    IconTile(symbol: "ticket", size: 34)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invite.maskedCode).font(.mono(.subheadline)).foregroundStyle(Theme.ink)
                        Text(invite.detail(people: snapshot.people)).font(.footnote).foregroundStyle(Theme.inkMuted)
                    }
                    Spacer(minLength: 8)
                    Button("Revoke") { revoking = invite }.font(.subheadline).foregroundStyle(Theme.danger).buttonStyle(.borderless)
                        .accessibilityLabel("Revoke \(invite.maskedCode)")
                        .confirmationDialog("Revoke this invite code?", isPresented: Binding(get: { revoking?.id == invite.id }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
                            Button("Revoke code", role: .destructive) { Task { if await model.revoke(invite) { store.notify("Invite code revoked") } } }
                        } message: { Text("\(invite.maskedCode) stops working. Anyone who has it can no longer join.") }
                }
                .swipeActions { Button("Revoke", role: .destructive) { revoking = invite } }
            }
            if snapshot.invitesProblem == nil { ActionRow(title: "Create invite code", symbol: "plus.circle") { inviting = true } }
            if !snapshot.pastInvites.isEmpty {
                DisclosureGroup("Used and expired (\(snapshot.pastInvites.count))") {
                    ForEach(snapshot.pastInvites) { invite in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invite.maskedCode).font(.mono(.subheadline)).foregroundStyle(Theme.inkSecondary)
                            Text(invite.detail(people: snapshot.people)).font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                        .swipeActions { Button("Remove", role: .destructive) { removingPast = invite } }
                        .confirmationDialog("Remove this from the list?", isPresented: Binding(get: { removingPast?.id == invite.id }, set: { if !$0 { removingPast = nil } }), titleVisibility: .visible) {
                            Button("Remove", role: .destructive) { Task { _ = await model.revoke(invite) } }
                        } message: { Text("Only the record of the code is removed. An account it created stays.") }
                    }
                }
                .tint(Theme.inkMuted)
            }
        } header: {
            Text("Invite codes")
        } footer: {
            Text("Each code creates one account and works once, for 7 days. Only the last group of a code is kept here: the full code is shown once, when you create it.")
        }
    }
}

// MARK: - A person in the list

struct AdminPersonRow: View {
    let person: AdminPerson
    let isSelf: Bool

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: person.name, size: 38).opacity(person.disabled ? 0.45 : 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(person.name).lineLimit(2).foregroundStyle(Theme.ink)
                    if isSelf { StatusBadge(text: "You") }
                }
                Text("@\(person.username) · \(person.activity)").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                switch person.status {
                case .active: EmptyView()
                case .disabled: StatusBadge(text: "Disabled", tone: .bad)
                case .temporaryPassword: StatusBadge(text: "Temporary password", tone: .warn)
                }
            }
            Spacer(minLength: 8)
            if person.role == .admin { StatusBadge(text: "Admin", tone: .clay) }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One person

struct AdminUserDetail: View {
    let model: AdminUsersModel
    let store: AppStore
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var seeded = false
    @State private var pendingRole: AdminRole?
    @State private var confirmReset = false
    @State private var deleting = AdminDebug.parts(after: "user")?.dropFirst().first == "delete"
    @State private var issued: AdminIssuedPassword?

    private var isSelf: Bool { id == model.selfID }

    var body: some View {
        Group {
            if let person = model.person(id) { content(person) } else { Color.clear.onAppear { dismiss() } }
        }
        .navigationTitle(model.person(id)?.name ?? "Person").navigationBarTitleDisplayMode(.inline)
        .background(Theme.sunken)
        .adminAlert(Binding(get: { model.failure }, set: { model.failure = $0 }))
        .adminToast(store)
    }

    private func content(_ person: AdminPerson) -> some View {
        let renamed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return List {
            Section {
                HStack(spacing: 14) {
                    Avatar(name: person.name, size: 58).opacity(person.disabled ? 0.45 : 1)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(person.name).font(.system(.title3, design: .serif, weight: .medium)).lineLimit(2)
                        Text("@\(person.username)").font(.subheadline).foregroundStyle(Theme.inkMuted)
                        HStack(spacing: 6) {
                            if isSelf { StatusBadge(text: "You") }
                            if person.role == .admin { StatusBadge(text: "Admin", tone: .clay) }
                            if person.status == .disabled { StatusBadge(text: "Disabled", tone: .bad) }
                            if person.status == .temporaryPassword { StatusBadge(text: "Temporary password", tone: .warn) }
                        }
                    }
                }.padding(.vertical, 4)
            }

            Section {
                FieldRow(title: "Name", placeholder: "Full name", text: $name, autocapitalize: true)
                    .submitLabel(.done).onSubmit { saveName(person) }
                if !renamed.isEmpty, renamed != person.name {
                    ActionRow(title: "Save name", symbol: "checkmark", busy: model.isBusy(id)) { saveName(person) }
                }
            } header: { Text("Profile") } footer: { Text("The name other people see. Their username, @\(person.username), cannot be changed.") }

            Section {
                PickRow(title: "Role", selection: Binding(get: { person.role == .admin ? AdminRole.admin : .user }, set: { if $0 != person.role { pendingRole = $0 } }), options: [(.user, "User"), (.admin, "Admin")])
                    .disabled(isSelf || model.isBusy(id))
                    .confirmationDialog(pendingRole == .admin ? "Make \(person.name) an admin?" : "Make \(person.name) a user?", isPresented: Binding(get: { pendingRole != nil }, set: { if !$0 { pendingRole = nil } }), titleVisibility: .visible, presenting: pendingRole) { role in
                        Button(role == .admin ? "Make admin" : "Make user", role: role == .admin ? nil : .destructive) { Task { if await model.update(id, role: role) { store.notify("\(person.name) is now \(role == .admin ? "an admin" : "a user")") } } }
                    } message: { role in Text(role == .admin ? AdminRole.admin.explanation : "They lose the Admin pages. Their own conversations and settings stay.") }
            } footer: { Text(isSelf ? "You cannot change your own role. Make someone else an admin first if you want to step down." : (person.role == .admin ? AdminRole.admin.explanation : AdminRole.user.explanation)) }

            Section {
                ToggleRow(title: "Can sign in", isOn: Binding(get: { !person.disabled }, set: { setEnabled($0, person) }))
                    .disabled(isSelf || model.isBusy(id))
            } footer: { Text(isSelf ? "You cannot turn off your own account." : "Turning this off signs them out at once and stops them signing in. Nothing is deleted.") }

            Section {
                PickRow(title: "Content safeguards", selection: Binding(get: { person.safeguards }, set: { setSafeguards($0) }),
                        options: AdminSafeguards.allCases.map { ($0, $0.title(serverOn: model.snapshot?.safeguardsOn)) })
                    .disabled(model.isBusy(id))
            } footer: { Text("Extra instructions that keep the model away from the kinds of content you chose in Admin › Capabilities. “Default” follows that switch.") }

            if store.offers("usageLimits") {
                Section {
                    NavigationLink {
                        AdminPersonLimitsEditor(store: store, personID: id, name: person.name) { Task { await model.reload() } }
                    } label: {
                        NavRow(symbol: "gauge.with.dots.needle.50percent", title: "Limits", value: person.isExempt ? "No limits" : (person.hasOwnLimits ? "Own limits" : "Like everyone"))
                    }
                } footer: { Text("How much of the models this person may use. Everything else follows the limits for everyone.") }
            }

            Section {
                ValueRow(title: "Password", value: person.hasPassword ? (person.mustChangePassword ? "Temporary" : "Chosen by them") : "None", subtitle: person.hasPassword ? (person.mustChangePassword ? "They choose their own at the next sign-in." : nil) : "They sign in through single sign-on.")
                ValueRow(title: "Last active", value: person.lastActiveAt.map(AdminFormat.dateTime) ?? "Never")
                ValueRow(title: "Account created", value: person.createdAt.map(AdminFormat.dateTime) ?? "")
                if !isSelf {
                    ActionRow(title: "Reset password…", symbol: "key", busy: model.isBusy(id)) { confirmReset = true }
                        .confirmationDialog("Reset \(person.name)'s password?", isPresented: $confirmReset, titleVisibility: .visible) {
                            Button("Reset password", role: .destructive) { Task { issued = await model.resetPassword(person) } }
                        } message: { Text("They are signed out everywhere. You get a temporary password to give them, and they choose a new one when they sign in with it.") }
                }
            } header: { Text("Sign-in") } footer: {
                Text(isSelf ? "To change your own password, use Settings › Account." : "Resetting signs them out everywhere. You get a temporary password to give them, and they choose a new one when they sign in with it.")
            }

            if !isSelf {
                Section {
                    ActionRow(title: "Delete account…", symbol: "trash", destructive: true) { deleting = true }
                } footer: { Text("Deletes the account with its conversations, projects, files and memory. This cannot be undone.") }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).tint(Theme.clay)
        .onAppear { if !seeded { name = person.name; seeded = true } }
        .task {
            let step = AdminDebug.parts(after: "user")?.dropFirst().first
            if step == "password" { issued = await model.resetPassword(person) }
            if step == "reset" { confirmReset = true }
            if step == "role" { pendingRole = person.role == .admin ? .user : .admin }
        }
        .onChange(of: person.name) { _, new in if !seeded || name.trimmingCharacters(in: .whitespaces).isEmpty { name = new } }
        .sheet(item: $issued) { issue in AdminPasswordSheet(issued: issue, store: store, title: "New password for \(issue.name)") }
        .sheet(isPresented: $deleting) { AdminDeleteUserSheet(person: person, model: model) }
    }

    private func setEnabled(_ enabled: Bool, _ person: AdminPerson) {
        Task { if await model.update(id, disabled: !enabled) { store.notify(enabled ? "\(person.name) can sign in again" : "\(person.name) is signed out") } }
    }

    private func setSafeguards(_ value: AdminSafeguards) {
        Task { if await model.update(id, safeguards: value) { store.notify("Saved") } }
    }

    private func saveName(_ person: AdminPerson) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != person.name else { return }
        Task { if await model.update(id, name: trimmed) { store.notify("Saved") } else { name = person.name } }
    }
}

// MARK: - Giving someone a temporary password

/// A temporary password, shown once with the words that go with it.
struct AdminPasswordContent: View {
    let issued: AdminIssuedPassword
    let store: AppStore
    var heading: String
    /// Set once it was copied or shared, so closing it by accident can warn.
    @Binding var handedOver: Bool
    let done: () -> Void
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    Image(systemName: "key.horizontal").font(.system(size: 30, weight: .light)).foregroundStyle(Theme.clay).accessibilityHidden(true)
                    Text(heading).font(.system(.title2, design: .serif, weight: .medium)).multilineTextAlignment(.center)
                    Text("Give this to \(issued.name) privately. They sign in as **\(issued.username)** and choose their own password straight away. It will not be shown again.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
                AdminSecretCard(label: "Temporary password", value: issued.password)
                VStack(spacing: 12) {
                    Button { adminCopy(issued.password, store: store, said: "Password copied", secret: true); copied = true; handedOver = true } label: { Label(copied ? "Copied" : "Copy password", systemImage: copied ? "checkmark" : "doc.on.doc") }
                        .buttonStyle(ClayButtonStyle())
                    ShareLink(item: AdminTemporaryPassword.message(server: store.address, username: issued.username, password: issued.password), subject: Text("Your Atelier account")) { Label("Share…", systemImage: "square.and.arrow.up") }
                        .buttonStyle(QuietButtonStyle())
                        .simultaneousGesture(TapGesture().onEnded { handedOver = true })
                    Button("Done", action: done).font(.body.weight(.medium)).foregroundStyle(Theme.inkSecondary).padding(.top, 4)
                }
            }
            .frame(maxWidth: 460).padding(.horizontal, 24).padding(.vertical, 28).frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.background)
    }
}

/// A sheet over a person's page that shows a new temporary password.
struct AdminPasswordSheet: View {
    let issued: AdminIssuedPassword
    let store: AppStore
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var handedOver = false
    @State private var warn = false

    var body: some View {
        NavigationStack {
            AdminPasswordContent(issued: issued, store: store, heading: title, handedOver: $handedOver) { close() }
                .navigationTitle("Temporary password").navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled(!handedOver)
        .adminToast(store)
        .confirmationDialog("You have not copied the password", isPresented: $warn, titleVisibility: .visible) {
            Button("Close anyway", role: .destructive) { dismiss() }
            Button("Stay", role: .cancel) {}
        } message: { Text("It will not be shown again. If you lose it, reset the password for a new one.") }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }

    private func close() { if handedOver { dismiss() } else { warn = true } }
}

// MARK: - Adding a person

struct AdminAddUserSheet: View {
    let model: AdminUsersModel
    let store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var username = ""
    @State private var usernameEdited = false
    @State private var role: AdminRole = .user
    @State private var creating = false
    @State private var problem: String?
    @State private var issued: AdminIssuedPassword?
    @State private var handedOver = false
    @State private var warn = false
    @FocusState private var focus: Field?
    private enum Field { case name, username }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var usernameProblem: String? { AdminUsername.problem(username) }
    private var valid: Bool { !trimmedName.isEmpty && trimmedName.count <= 80 && AdminUsername.isValid(AdminUsername.normalized(username)) }

    var body: some View {
        NavigationStack {
            Group {
                if let issued {
                    AdminPasswordContent(issued: issued, store: store, heading: "\(issued.name) can sign in now", handedOver: $handedOver) { if handedOver { dismiss() } else { warn = true } }
                } else { form }
            }
            .navigationTitle(issued == nil ? "Add user" : "Temporary password").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if issued == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { if creating { ProgressView() } else { Button("Add") { create() }.disabled(!valid) } }
                }
            }
        }
        .interactiveDismissDisabled(issued != nil && !handedOver)
        .adminToast(store)
        .confirmationDialog("You have not copied the password", isPresented: $warn, titleVisibility: .visible) {
            Button("Close anyway", role: .destructive) { dismiss() }
            Button("Stay", role: .cancel) {}
        } message: { Text("It will not be shown again. If you lose it, reset their password for a new one.") }
        .tint(Theme.clay)
    }

    private var form: some View {
        List {
            Section {
                FieldRow(title: "Full name", placeholder: "Mia Member", text: $name, autocapitalize: true).focused($focus, equals: .name).submitLabel(.next).onSubmit { focus = .username }
                    .onChange(of: name) { _, new in if !usernameEdited { username = AdminUsername.suggest(from: new) } }
            }
            Section {
                FieldRow(title: "Username", placeholder: "mia.member", text: $username, mono: true).focused($focus, equals: .username).submitLabel(.done)
                    .onChange(of: username) { _, _ in if focus == .username { usernameEdited = true } }
                if let usernameProblem { Text(usernameProblem).font(.footnote).foregroundStyle(Theme.danger) }
            } footer: { Text("What they sign in with: 2 to 32 letters, digits, dots, dashes or underscores. It cannot be changed later.") }
            Section {
                Picker("Role", selection: $role) { Text("User").tag(AdminRole.user); Text("Admin").tag(AdminRole.admin) }.pickerStyle(.inline).labelsHidden()
            } header: { Text("Role") } footer: { Text(role.explanation) }
            Section {
                Button("Add user") { create() }.buttonStyle(ClayButtonStyle(busy: creating)).disabled(!valid || creating)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 0, trailing: 4)) }
            } footer: { Text("They get a temporary password to sign in with, and choose their own straight away.") }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            focus = .name
            if AdminDebug.is("add-result") { name = "Zoe Park"; username = "zoe.park"; create() }
        }
    }

    private func create() {
        guard valid, !creating else { return }
        creating = true; problem = nil
        Task {
            defer { creating = false }
            do { issued = try await model.create(username: username, name: name, role: role) }
            catch is CancellationError { return }
            catch { problem = AdminFailure.message(for: error) }
        }
    }
}

// MARK: - Deleting a person

/// Deleting an account is not undone, so the sheet asks for the username before it lets go.
struct AdminDeleteUserSheet: View {
    let person: AdminPerson
    let model: AdminUsersModel
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var deleting = false

    private var matches: Bool { AdminUsername.normalized(typed) == person.username }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: "trash").font(.system(size: 26, weight: .light)).foregroundStyle(Theme.danger).accessibilityHidden(true)
                        Text("Delete \(person.name)?").font(.system(.title3, design: .serif, weight: .medium))
                        Text("This permanently deletes the account and everything it owns: conversations, projects, files, memory, devices and passkeys. It cannot be undone.")
                            .font(.subheadline).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
                        Text("Usage records stay, no longer tied to a name. If you only want to stop them signing in, turn off Can sign in instead.")
                            .font(.footnote).foregroundStyle(Theme.inkMuted).fixedSize(horizontal: false, vertical: true)
                    }.padding(.vertical, 6)
                }
                Section {
                    FieldRow(title: "Type \(person.username) to confirm", placeholder: person.username, text: $typed, mono: true)
                }
                Section {
                    Button(role: .destructive) { delete() } label: { Text("Delete account") }
                        .buttonStyle(AdminDangerButtonStyle(busy: deleting)).disabled(!matches || deleting)
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Delete account").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.clay)
        .interactiveDismissDisabled(deleting)
    }

    private func delete() {
        guard matches, !deleting else { return }
        deleting = true
        Task {
            defer { deleting = false }
            if await model.delete(person) { dismiss() }
        }
    }
}

/// The main action of a destructive sheet: red, full width, with a spinner while it works.
struct AdminDangerButtonStyle: ButtonStyle {
    var busy = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.label
            if busy { ProgressView().tint(.white) }
        }
        .font(.system(.body, weight: .semibold))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(Color(hex: 0xC22F2F).opacity(enabled ? 1 : 0.38), in: Capsule())
        .scaleEffect(configuration.isPressed ? 0.985 : 1)
        .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

// MARK: - Inviting

struct AdminInviteSheet: View {
    let model: AdminUsersModel
    let store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var role: AdminRole = .user
    @State private var creating = false
    @State private var problem: String?
    @State private var issued: AdminIssuedInvite?
    @State private var copiedCode = false
    @State private var copiedLink = false

    var body: some View {
        NavigationStack {
            Group { if let issued { result(issued) } else { form } }
                .navigationTitle("Invite code").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(issued == nil ? "Cancel" : "Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .onAppear { if AdminDebug.is("invite-result") { create() } }
        .adminToast(store)
    }

    private var form: some View {
        List {
            Section {
                Picker("Role", selection: $role) { Text("User").tag(AdminRole.user); Text("Admin").tag(AdminRole.admin) }.pickerStyle(.inline).labelsHidden()
            } header: { Text("The account it creates is a") } footer: { Text(role.explanation) }
            Section {
                Button("Create code") { create() }.buttonStyle(ClayButtonStyle(busy: creating)).disabled(creating)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger).listRowBackground(Color.clear) }
            } footer: { Text("The code works once and expires in 7 days. You will see the full code only now.") }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
    }

    private func result(_ issued: AdminIssuedInvite) -> some View {
        let link = AdminInviteCode.link(server: store.address, code: issued.code)
        let message = AdminInviteCode.message(server: store.address, code: issued.code, role: issued.invite.role, expiresAt: issued.invite.expiresAt)
        return ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    Image(systemName: "ticket").font(.system(size: 30, weight: .light)).foregroundStyle(Theme.clay).accessibilityHidden(true)
                    Text("Invite code ready").font(.system(.title2, design: .serif, weight: .medium))
                    Text("Give this code to the person you invite. On the sign-in page of **\(URL(string: store.address)?.host ?? store.address)** they choose “I have a code” and create one \(issued.invite.role == .admin ? "admin " : "")account. It works once, \(issued.invite.expiresAt.map { "until \(AdminFormat.date($0))" } ?? "for 7 days"), and is shown only now.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
                AdminSecretCard(label: "Invite code", value: issued.code)
                if let link {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Or send this link").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                        AdminCodeBlock(text: link.absoluteString)
                    }
                }
                VStack(spacing: 12) {
                    ShareLink(item: message, subject: Text("Your Atelier invitation")) { Label("Share invitation…", systemImage: "square.and.arrow.up") }.buttonStyle(ClayButtonStyle())
                    Button { adminCopy(issued.code, store: store, said: "Code copied", secret: true); copiedCode = true } label: { Label(copiedCode ? "Code copied" : "Copy code", systemImage: copiedCode ? "checkmark" : "doc.on.doc") }.buttonStyle(QuietButtonStyle())
                    if let link { Button { adminCopy(link.absoluteString, store: store, said: "Link copied", secret: true); copiedLink = true } label: { Label(copiedLink ? "Link copied" : "Copy link", systemImage: copiedLink ? "checkmark" : "link") }.buttonStyle(QuietButtonStyle()) }
                }
                Text("Anyone who has the code can create an account, so share it privately.").font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
            }
            .frame(maxWidth: 460).padding(.horizontal, 24).padding(.vertical, 28).frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.background)
    }

    private func create() {
        guard !creating else { return }
        creating = true; problem = nil
        Task {
            defer { creating = false }
            do { issued = try await model.createInvite(role: role) }
            catch is CancellationError { return }
            catch { problem = AdminFailure.message(for: error) }
        }
    }
}
