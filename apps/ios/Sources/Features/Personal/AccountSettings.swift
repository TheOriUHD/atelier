import PhotosUI
import SwiftUI

// MARK: - Account: profile, personalization, sign-in and security, where it is signed in

/// How a browser or an app that signed in is named: "Safari on iPhone", "Atelier CLI on macOS".
enum PersonalClientName {
    private static let systems: [(String, String)] = [("iPhone|iPad|iOS", "iOS"), ("Android", "Android"), ("Mac OS X|Macintosh|darwin", "macOS"), ("Windows|win32", "Windows"), ("Linux|linux", "Linux")]
    private static let browsers: [(String, String)] = [("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]

    private static func first(_ userAgent: String, _ list: [(String, String)]) -> String? {
        list.first { userAgent.range(of: $0.0, options: .regularExpression) != nil }?.1
    }

    static func name(kind: String, userAgent: String) -> String {
        let app: String
        switch kind {
        case "desktop": app = "Atelier Desktop"
        case "cli": app = "Atelier CLI"
        case "mobile": return "Atelier for iPhone and iPad"
        default: app = first(userAgent, browsers) ?? "Browser"
        }
        return first(userAgent, systems).map { "\(app) on \($0)" } ?? app
    }

    static func symbol(kind: String, userAgent: String) -> String {
        switch kind {
        case "desktop": "desktopcomputer"
        case "cli": "terminal"
        case "mobile": "iphone"
        default: userAgent.contains("iPhone") ? "iphone" : userAgent.contains("iPad") ? "ipad" : "globe"
        }
    }

    static func platform(_ id: String) -> String { ["darwin": "macOS", "win32": "Windows", "linux": "Linux"][id] ?? id }
}

@MainActor @Observable final class PersonalAccountModel {
    let account: Resource<JSON>
    let sessions: Resource<[JSON]>
    let devices: Resource<[JSON]>
    let passkeys: Resource<[JSON]>
    let identities: Resource<JSON>
    let safeguards: Resource<JSON>
    private let call: PersonalCall

    init(call: @escaping PersonalCall) {
        self.call = call
        account = .personal { try await call("account.get", [:]) }
        sessions = .personal { try await call("account.sessions", [:]).array }
        devices = .personal { try await call("account.devices", [:]).array }
        passkeys = .personal { try await call("account.passkeys", [:]).array }
        identities = .personal { try await call("account.identities", [:]) }
        safeguards = .personal { try await call("settings.get", [:])["effective"]["safeguards"] }
    }

    func reloadAll() async {
        await account.reload()
        async let a: Void = sessions.reload()
        async let b: Void = devices.reload()
        async let c: Void = passkeys.reload()
        async let d: Void = identities.reload()
        async let e: Void = safeguards.reload()
        _ = await (a, b, c, d, e)
    }

    func revokeSession(_ id: String) async throws {
        _ = try await call("account.revokeSession", ["id": .string(id)])
        await sessions.reload()
    }
    func removeDevice(_ id: String) async throws {
        _ = try await call("account.removeDevice", ["id": .string(id)])
        await devices.reload()
    }
    func removePasskey(_ id: String) async throws {
        _ = try await call("account.removePasskey", ["id": .string(id)])
        await passkeys.reload()
    }
    func removeIdentity(_ id: String) async throws {
        _ = try await call("account.removeIdentity", ["id": .string(id)])
        await identities.reload()
    }
    func update(name: String? = nil, avatar: JSON? = nil) async throws {
        var params: [String: JSON] = [:]
        if let name { params["name"] = .string(name) }
        if let avatar { params["avatar"] = avatar }
        account.set(try await call("account.update", params))
    }
    func uploadAvatar(_ picture: PersonalImages.Picture) async throws {
        let file = try await call("files.upload", ["name": "profile.jpg", "mime": "image/jpeg", "dataBase64": .string(picture.data.base64EncodedString())])
        try await update(avatar: file["blob"])
    }

    /// What the administrator's safeguards cover for this person, in words, or nil when none apply.
    static func safeguardsText(settings: JSON, override: String) -> String? {
        let on = override == "inherit" ? settings["enabled"].bool : override == "on"
        let labels = [("sexual", "explicit sexual content"), ("hate", "hate and violent extremism"), ("harassment", "harassment of private people"), ("selfHarm", "self-harm")]
        var covers = labels.filter { settings["categories"][$0.0].bool }.map(\.1)
        if settings["profile"].string == "younger" { covers.append("rules for younger people") }
        guard on, !covers.isEmpty else { return nil }
        return "Covers \(covers.joined(separator: ", "))."
    }
}

private enum AccountRoute: String, Hashable { case password, approve, personality }
private enum AccountSheet: String, Identifiable { case instructions, atelierMd; var id: String { rawValue } }

struct AccountSettings: View {
    let store: AppStore
    @State private var model: PersonalAccountModel
    @State private var prefs: PersonalPrefs
    @State private var route: AccountRoute?
    @State private var sheet: AccountSheet?
    @State private var photo: PhotosPickerItem?
    @State private var uploading = false
    @State private var confirmLogout = false
    @State private var confirmEverywhere = false
    @State private var sessionToRevoke: JSON?
    @State private var deviceToRemove: JSON?
    @State private var passkeyToRemove: JSON?
    @State private var identityToRemove: JSON?
    @Environment(\.openURL) private var openURL

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: PersonalAccountModel(call: store.personalCall))
        _prefs = State(initialValue: PersonalPrefs(store: store))
        #if DEBUG
        _route = State(initialValue: Launch.value("--sub").flatMap(AccountRoute.init(rawValue:)))
        _sheet = State(initialValue: Launch.value("--sub").flatMap(AccountSheet.init(rawValue:)))
        #endif
    }

    private var local: Bool { store.authStatus["local"].bool }

    var body: some View {
        PersonalPage(title: "Account") {
            PersonalLoad(resource: model.account) { account in
                if account["mustChangePassword"].bool { mustChangeSection }
                profileSection(account)
                personalizationSection(account)
                Section {
                    PrefToggleRow(prefs: prefs, path: ["remoteControl"], title: "Remote control", subtitle: "Access your server sessions from other browsers and devices signed in to this account. Turning this off keeps sessions on their originating device, even when that session allows it.", defaultValue: true)
                } header: { Text("Session access") }
                if !local {
                    signInSection(account)
                    passkeysSection
                    identitiesSection
                    sessionsSection
                    devicesSection
                }
            }
        }
        .task { await model.reloadAll(); await prefs.load() }
        .refreshable { await model.reloadAll(); await prefs.load() }
        .navigationDestination(item: $route) { destination($0) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .instructions:
                PersonalTextEditorSheet(title: "Instructions", text: prefs.string(["personalization", "instructions"]), max: 20_000,
                                        placeholder: "For example: I work in TypeScript and prefer short answers with code first.",
                                        footer: "Preferences the model should keep in mind. They are added to the system prompt of every new chat.") { text in
                    await prefs.set(["personalization", "instructions"], .string(text))
                }
            case .atelierMd:
                PersonalTextEditorSheet(title: "Your ATELIER.md", text: prefs.string(["personalization", "atelierMd"]), max: 60_000, mono: true,
                                        placeholder: "# How I work\n\n- Explain a plan before large changes.\n- Write commit messages in English.",
                                        footer: "Your own conventions and preferences for Code sessions and chats working in a folder, in Markdown. Every new one and its sub-agents read them; where a project's ATELIER.md disagrees, yours win.") { text in
                    await prefs.set(["personalization", "atelierMd"], .string(text))
                }
            }
        }
        .confirmationDialog("Log out of this device?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Log out", role: .destructive) { personalAction(store) { try await store.logout() } }
        } message: { Text("You can sign in again any time. Unsent drafts on this device are removed.") }
        .confirmationDialog("Log out of all devices?", isPresented: $confirmEverywhere, titleVisibility: .visible) {
            Button("Log out everywhere", role: .destructive) { logoutEverywhere() }
        } message: { Text("Every browser and app signed in to your account is signed out, including this one.") }
        .confirmationDialog(sessionToRevoke.map { "Sign out \(PersonalClientName.name(kind: $0["clientKind"].string, userAgent: $0["userAgent"].string))?" } ?? "Sign out?",
                            isPresented: Binding(get: { sessionToRevoke != nil }, set: { if !$0 { sessionToRevoke = nil } }), titleVisibility: .visible, presenting: sessionToRevoke) { session in
            Button("Sign out", role: .destructive) { personalAction(store) { try await model.revokeSession(session["id"].string); store.notify("Signed out") } }
        } message: { _ in Text("That browser or app is signed out of your account.") }
        .confirmationDialog(deviceToRemove.map { "Remove \($0["name"].string)?" } ?? "Remove device?",
                            isPresented: Binding(get: { deviceToRemove != nil }, set: { if !$0 { deviceToRemove = nil } }), titleVisibility: .visible, presenting: deviceToRemove) { device in
            Button("Remove", role: .destructive) { personalAction(store) { try await model.removeDevice(device["id"].string); store.notify("Device removed") } }
        } message: { _ in Text("It stops lending its files and tools to your sessions until you sign in there again.") }
        .confirmationDialog(passkeyToRemove.map { "Remove “\($0["name"].string)”?" } ?? "Remove passkey?",
                            isPresented: Binding(get: { passkeyToRemove != nil }, set: { if !$0 { passkeyToRemove = nil } }), titleVisibility: .visible, presenting: passkeyToRemove) { passkey in
            Button("Remove", role: .destructive) { personalAction(store) { try await model.removePasskey(passkey["id"].string); store.notify("Passkey removed") } }
        } message: { _ in Text("It no longer signs you in here. Delete it from your device or password manager too.") }
        .confirmationDialog(identityToRemove.map { "Disconnect \($0["provider"].string)?" } ?? "Disconnect?",
                            isPresented: Binding(get: { identityToRemove != nil }, set: { if !$0 { identityToRemove = nil } }), titleVisibility: .visible, presenting: identityToRemove) { identity in
            Button("Disconnect", role: .destructive) { personalAction(store) { try await model.removeIdentity(identity["id"].string); store.notify("Disconnected") } }
        } message: { _ in Text("It no longer signs you in to this account.") }
    }

    @ViewBuilder private func destination(_ route: AccountRoute) -> some View {
        switch route {
        case .password: PersonalChangePasswordPage(store: store, account: model.account.value ?? .null) { await model.account.reload() }
        case .approve: PersonalApproveSignInPage(store: store)
        case .personality: PersonalPersonalityPage(prefs: prefs)
        }
    }

    // MARK: Sections

    private var mustChangeSection: some View {
        Section {
            Button { route = .password } label: {
                HStack(spacing: 12) {
                    Image(systemName: "key").foregroundStyle(Theme.clay)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Choose a new password").font(.system(.body, weight: .semibold)).foregroundStyle(Theme.ink)
                        Text("An admin gave you a temporary password. Your server asks for a new one before most of Atelier works.").font(.footnote).foregroundStyle(Theme.inkSecondary)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
        }.listRowBackground(Theme.clay.opacity(0.10))
    }

    private func profileSection(_ account: JSON) -> some View {
        Section {
            HStack(spacing: 16) {
                PersonalAvatar(store: store, sha: account["avatar"].stringOrNil, name: account["name"].string, size: 64)
                VStack(alignment: .leading, spacing: 8) {
                    PhotosPicker(selection: $photo, matching: .images) {
                        Text(account["avatar"].stringOrNil == nil ? "Add a photo" : "Change photo").font(.subheadline.weight(.medium)).foregroundStyle(Theme.clay)
                    }
                    if account["avatar"].stringOrNil != nil {
                        Button("Remove photo", role: .destructive) { personalAction(store) { try await model.update(avatar: .null); store.notify("Photo removed") } }
                            .font(.subheadline).buttonStyle(.plain).foregroundStyle(Theme.danger)
                    }
                    if uploading { ProgressView().controlSize(.small) }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .onChange(of: photo) { _, item in if let item { uploadPhoto(item) } }
            PersonalDraftField(title: "Full name", placeholder: "Your name", value: account["name"].string, maxLength: 80,
                               validate: { $0.trimmingCharacters(in: .whitespaces).isEmpty ? "Enter your name." : nil }) { text in
                do { try await model.update(name: text.trimmingCharacters(in: .whitespaces)); return true } catch { store.notify("Couldn't save. \(PersonalFailure.text(error))"); return false }
            }
            PersonalDraftField(title: "What should Atelier call you?", placeholder: account["name"].string, value: prefs.string(["callMe"]), maxLength: 80) { text in
                await prefs.set(["callMe"], .string(text.trimmingCharacters(in: .whitespaces)))
            }
        } header: { Text("Profile") } footer: { Text("Your full name shows in the sidebar and to admins. The name below it is used in the greeting and shared with the model; your full name is used when it is empty.") }
    }

    @ViewBuilder private func personalizationSection(_ account: JSON) -> some View {
        Section {
            Button { sheet = .instructions } label: {
                PersonalChoiceLabel(title: "Instructions", subtitle: nil, value: summary(prefs.string(["personalization", "instructions"])))
            }.buttonStyle(.plain)
            NavigationLink { destination(.personality) } label: {
                PersonalChoiceLabel(title: "Personality", subtitle: nil, value: PersonalPersonality.name(of: prefs.value(["personalization", "personality"])))
            }
            PrefPickRow(prefs: prefs, path: ["personalization", "responseStyle"], title: "Response style", subtitle: "How replies are written unless a chat asks otherwise.",
                        options: [("default", "Default"), ("concise", "Concise"), ("explanatory", "Explanatory"), ("formal", "Formal")], defaultValue: "default")
            Button { sheet = .atelierMd } label: {
                PersonalChoiceLabel(title: "Your ATELIER.md", subtitle: "For Code and tasks", value: summary(prefs.string(["personalization", "atelierMd"])))
            }.buttonStyle(.plain)
            if let text = safeguardsText(account) {
                ValueRow(title: "Content safeguards", value: "On", subtitle: "Set by your administrator. \(text)")
            }
        } header: { Text("Personalization") } footer: {
            Text("Instructions are added to the system prompt of every new chat. Your ATELIER.md is read by every Code session and chat working in a folder.")
        }
    }

    private func summary(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? "Not set" : line
    }

    private func safeguardsText(_ account: JSON) -> String? {
        guard let settings = model.safeguards.value, settings != .null else { return nil }
        return PersonalAccountModel.safeguardsText(settings: settings, override: account["safeguards"].string)
    }

    private func signInSection(_ account: JSON) -> some View {
        Section {
            ValueRow(title: "Username", value: account["username"].string, subtitle: "What you sign in with.", mono: true, copyable: true)
            NavigationLink { destination(.password) } label: {
                NavRow(symbol: "key", title: account["hasPassword"].bool ? "Change password" : "Set a password", subtitle: account["hasPassword"].bool ? "Changing it signs you out on your other devices." : nil)
            }
            if store.offers("terminalSignIn") {
                NavigationLink { destination(.approve) } label: {
                    NavRow(symbol: "checkmark.shield", title: "Approve a sign-in", subtitle: "A terminal or another app asks you for a code.")
                }
            }
            PersonalIconAction(title: "Log out", symbol: "rectangle.portrait.and.arrow.right", destructive: true) { confirmLogout = true }
            PersonalIconAction(title: "Log out of all devices", symbol: "rectangle.portrait.and.arrow.right.fill", destructive: true) { confirmEverywhere = true }
        } header: { Text("Sign-in") } footer: { Text("Logging out ends your sign-in here. Logging out of all devices ends every sign-in to your account, including this one.") }
    }

    @ViewBuilder private var passkeysSection: some View {
        if !store.authStatus["passwordOnly"].bool {
            Section {
                PersonalSectionRows(resource: model.passkeys, emptyText: "No passkeys yet.") { passkeys in
                    ForEach(passkeys, id: \.self) { passkey in
                        Button { passkeyToRemove = passkey } label: {
                            HStack(spacing: 12) {
                                IconTile(symbol: "person.badge.key")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(passkey["name"].string).foregroundStyle(Theme.ink)
                                    Text("Added \(passkey["createdAt"].date?.personalShort ?? "")\(passkey["lastUsedAt"].date.map { " · Used \($0.relative)" } ?? " · Never used")").font(.footnote).foregroundStyle(Theme.inkMuted)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "trash").font(.footnote).foregroundStyle(Theme.inkMuted)
                            }.contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions { Button("Remove", role: .destructive) { passkeyToRemove = passkey } }
                        .accessibilityHint("Removes this passkey")
                    }
                }
                if let url = browserURL(row: "account.passkeys") {
                    PersonalLinkRow(title: "Add a passkey in your browser", symbol: "plus", url: url, subtitle: "Sign in with your device's screen lock instead of a password")
                }
            } header: { Text("Passkeys") } footer: {
                Text("A passkey belongs to your server's web address, so it is made in a browser: Safari on this device, or any browser you use. They show here, where you can remove them.")
            }
        }
    }

    @ViewBuilder private var identitiesSection: some View {
        if let identities = model.identities.value, !(identities["connected"].array.isEmpty && identities["available"].array.isEmpty) {
            Section {
                ForEach(identities["connected"].array, id: \.self) { identity in
                    Button { identityToRemove = identity } label: {
                        HStack(spacing: 12) {
                            IconTile(symbol: "person.2.badge.key")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(identity["provider"].string).foregroundStyle(Theme.ink)
                                Text("\(identity["label"].string) · \(identity["lastUsedAt"].date.map { "Used \($0.relative)" } ?? "Never used")").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "xmark.circle").font(.footnote).foregroundStyle(Theme.inkMuted)
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions { Button("Disconnect", role: .destructive) { identityToRemove = identity } }
                    .accessibilityHint("Disconnects this sign-in")
                }
                ForEach(identities["available"].array, id: \.self) { option in
                    if let url = browserURL(row: "account.identities") {
                        PersonalLinkRow(title: "Connect \(option["name"].string)", symbol: "plus", url: url)
                    }
                }
            } header: { Text("Connected sign-ins") } footer: {
                Text("Other sign-ins for this account in a browser, such as Authentik or Google. Connecting one happens in your browser.")
            }
        }
    }

    private var sessionsSection: some View {
        Section {
            PersonalSectionRows(resource: model.sessions, emptyText: "No sessions.") { sessions in
                ForEach(sessions, id: \.self) { session in
                    let kind = session["clientKind"].string, agent = session["userAgent"].string
                    let current = session["current"].bool
                    Button { if !current { sessionToRevoke = session } } label: {
                        HStack(spacing: 12) {
                            IconTile(symbol: PersonalClientName.symbol(kind: kind, userAgent: agent), tint: current ? Theme.clay : Theme.inkSecondary)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(PersonalClientName.name(kind: kind, userAgent: agent)).foregroundStyle(Theme.ink).lineLimit(2)
                                    if current { StatusBadge(text: "This device", tone: .clay) }
                                }
                                Text([session["ip"].string.isEmpty ? nil : session["ip"].string, "Signed in \(session["createdAt"].date?.personalShort ?? "")", "Active \(session["lastSeenAt"].date?.relative ?? "")"].compactMap { $0 }.joined(separator: " · "))
                                    .font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            if !current { Image(systemName: "xmark.circle").font(.footnote).foregroundStyle(Theme.inkMuted) }
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions { if !current { Button("Sign out", role: .destructive) { sessionToRevoke = session } } }
                    .accessibilityHint(current ? "" : "Signs this session out")
                }
            }
        } header: { Text("Active sessions") } footer: { Text("Browsers and apps signed in to your account. Tap one to sign it out.") }
    }

    private var devicesSection: some View {
        Section {
            PersonalSectionRows(resource: model.devices, emptyText: "No devices yet. The Atelier desktop app adds the computer it runs on when you sign in there.") { devices in
                ForEach(devices, id: \.self) { device in
                    Button { deviceToRemove = device } label: {
                        HStack(spacing: 12) {
                            IconTile(symbol: "desktopcomputer", tint: device["online"].bool ? Theme.success : Theme.inkSecondary)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(device["name"].string).foregroundStyle(Theme.ink).lineLimit(2)
                                    if device["online"].bool { StatusBadge(text: "Online", tone: .good) }
                                }
                                Text("\(PersonalClientName.platform(device["platform"].string)) · Added \(device["createdAt"].date?.personalShort ?? "")\(device["online"].bool ? "" : " · Seen \(device["lastSeenAt"].date?.relative ?? "")")")
                                    .font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "trash").font(.footnote).foregroundStyle(Theme.inkMuted)
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions { Button("Remove", role: .destructive) { deviceToRemove = device } }
                    .accessibilityHint("Removes this device")
                }
            }
        } header: { Text("Devices") } footer: { Text("Computers running the Atelier app for your account. They lend their files and tools to your sessions.") }
    }

    // MARK: Actions

    /// Where a setting is, on the web page of this server (passkeys and connected sign-ins are made there).
    private func browserURL(row: String) -> String? {
        guard let url = try? serverURL(store.address) else { return nil }
        if let host = url.host, host.range(of: #"^[\d.]+$|^\["#, options: .regularExpression) != nil, row == "account.passkeys" { return nil }
        return url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/#/?settings=account&row=\(row)"
    }

    private func uploadPhoto(_ item: PhotosPickerItem) {
        uploading = true
        personalAction(store) {
            defer { uploading = false; photo = nil }
            guard let data = try await item.loadTransferable(type: Data.self), let picture = PersonalImages.jpeg(from: data, maxSide: 1024, maxBytes: 5_000_000) else {
                throw MobileError.message("Choose a PNG, JPEG, GIF or WebP image.")
            }
            try await model.uploadAvatar(picture)
            store.notify("Photo updated")
        }
    }

    private func logoutEverywhere() {
        personalAction(store) {
            _ = try await store.rpc.call("account.logoutEverywhere")
            CredentialStore.remove(store.address); store.clearDrafts()
        }
    }
}

/// The rows of a list a section loads for itself: a spinner, what failed with Try again, a line when it is empty, or the rows.
struct PersonalSectionRows<Row: View>: View {
    let resource: Resource<[JSON]>
    let emptyText: String
    @ViewBuilder var rows: ([JSON]) -> Row
    var body: some View {
        switch resource.state {
        case .idle, .loading:
            HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 6).task { if case .idle = resource.state { await resource.reload() } }
        case .failed(let message):
            VStack(spacing: 8) {
                Text(message).font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                Button("Try again") { Task { await resource.reload() } }.buttonStyle(.borderless).foregroundStyle(Theme.clay)
            }.frame(maxWidth: .infinity)
        case .loaded(let list):
            if list.isEmpty { Text(emptyText).font(.subheadline).foregroundStyle(Theme.inkMuted) } else { rows(list) }
        }
    }
}

/// A text field in a row that saves when it loses focus or is submitted, with its problem under it.
struct PersonalDraftField: View {
    var title: String?
    let placeholder: String
    let value: String
    var maxLength = 80
    var validate: (String) -> String? = { _ in nil }
    let commit: (String) async -> Bool
    @State private var text = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title { Text(title).font(.footnote).foregroundStyle(Theme.inkMuted) }
            TextField(placeholder, text: $text)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { Task { await save() } }
                .onChange(of: text) { _, new in if new.count > maxLength { text = String(new.prefix(maxLength)) } }
                .accessibilityLabel(title ?? placeholder)
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
        }
        .onAppear { text = value }
        .onChange(of: value) { _, new in if !focused { text = new } }
        .onChange(of: focused) { _, now in if !now { Task { await save() } } }
    }

    private func save() async {
        guard text != value else { problem = nil; return }
        if let message = validate(text) { problem = message; return }
        problem = nil
        if await !commit(text) { text = value }
    }
}
