import SwiftUI

/// The signed-out app: connect to a server and sign in. Besides the password form it handles what a server can ask
/// for: its first account, an invite code, open sign-up with approval, passkeys and identity providers through the
/// browser, and a temporary password that has to be replaced. Every failure says what it is in words.
struct SignInView: View {
    @Bindable var store: AppStore
    @State private var model = ChatSignIn()
    @State private var username = ""
    @State private var password = ""
    @State private var name = ""
    @State private var setupToken = ""
    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var touched: Set<Field> = []
    @State private var discovery = NetworkDiscovery()
    @State private var scanning = false
    @FocusState private var field: Field?
    private enum Field: Hashable { case server, name, username, password, token, invite, current, next, confirm }

    private var hub: ChatHub { ChatHub.of(store) }
    private var typing: Bool { field != nil && model.screen != .approval }
    private var mustChangePassword: Bool { store.signedIn && store.authStatus["user"]["mustChangePassword"].bool }

    /// The server says it has no account yet: the first one is made here, whichever screen was showing.
    private var screen: ChatSignIn.Screen {
        if mustChangePassword { return .password }
        if model.screen == .signIn, model.probe == .ready, model.setupRequired { return .setup }
        return model.screen
    }

    private var addressReady: Bool { !ChatSignIn.normalized(store.address).isEmpty && ChatSignIn.addressProblem(store.address) == nil }
    private var loginReady: Bool { addressReady && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header
                if let message = hub.signedOutMessage, screen == .signIn { notice(message, symbol: "person.crop.circle.badge.exclamationmark") }
                content
                Text("No account with us: you sign in to your server. Files and prompts go to it and to the model providers it uses.")
                    .font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center).padding(.horizontal, 12)
            }
            .frame(maxWidth: 460).padding(.horizontal, 24).padding(.bottom, 32).frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
        .tint(Theme.clay)
        .fullScreenCover(isPresented: $scanning) { QRScanSheet { link in pair(link) } }
        .task { if store.address.isEmpty, discovery.state == .idle { await discovery.scan() } }
        .onAppear {
            if store.address.isEmpty == false, model.probe == .idle { model.schedule(store.address) }
            #if DEBUG
            ChatDemo.prepareSignIn(model, store: store)
            #endif
        }
        .onChange(of: store.address) { _, value in model.schedule(value) }
        .onChange(of: store.error) { _, value in if mustChangePassword, value?.hasPrefix("Choose a new password") == true { store.error = nil } }
        .onDisappear { if !store.signedIn { model.reset() } }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 16) {
            AtelierMark(size: typing ? 44 : 72)
            Text(title).font(.system(typing ? .title : .largeTitle, design: .serif, weight: .medium)).multilineTextAlignment(.center)
            if !typing || screen != .signIn {
                Text(subtitle).font(.body).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, typing ? 12 : 56).animation(.snappy, value: typing)
    }

    private var title: String {
        switch screen {
        case .signIn: "Welcome to Atelier"
        case .setup: "Set up Atelier"
        case .invite: "Join with a code"
        case .newAccount: "You're invited"
        case .signup: "Create an account"
        case .pending: "Waiting for approval"
        case .approval: "Approve this device"
        case .password: "Choose a new password"
        }
    }

    private var subtitle: String {
        switch screen {
        case .signIn: "Your conversations and tools stay on your own server. This app connects to it."
        case .setup: "Create the first account. It becomes the admin, who can add everyone else."
        case .invite: "Enter the invite code an admin of this server gave you."
        case .newAccount: "Create your account to join this Atelier."
        case .signup: "An admin approves new accounts before they can sign in."
        case .pending: "Your account is waiting for an admin to approve it. Once they do, sign in with your username and password."
        case .approval: "Finish signing in with the browser, then come back here."
        case .password: "\(store.userName.isEmpty ? "An admin" : store.userName.components(separatedBy: " ").first ?? "An admin") gave you a temporary password. Replace it with one only you know."
        }
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case .signIn: loginForm
        case .setup: accountForm(.setup)
        case .invite: inviteForm
        case .newAccount: accountForm(.invite)
        case .signup: accountForm(.signup)
        case .pending: pending
        case .approval: approval
        case .password: passwordForm
        }
    }

    // MARK: sign in

    private var loginForm: some View {
        VStack(spacing: 14) {
            foundServers
            VStack(spacing: 0) {
                serverRow
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("person") {
                    TextField("Username", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled().focused($field, equals: .username).submitLabel(.next).onSubmit { field = .password }
                }
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("lock") {
                    SecureField("Password", text: $password).textContentType(.password).focused($field, equals: .password).submitLabel(.go).onSubmit { connect() }
                }
            }
            .card(radius: 18)

            serverStatus

            if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4).accessibilityIdentifier("sign-in-error") }

            Button("Connect") { connect() }.buttonStyle(ClayButtonStyle(busy: model.busy)).disabled(model.busy || !loginReady)

            HStack(spacing: 12) {
                Rectangle().fill(Theme.hairline).frame(height: 1)
                Text("or").font(.footnote).foregroundStyle(Theme.inkMuted)
                Rectangle().fill(Theme.hairline).frame(height: 1)
            }.padding(.vertical, 2)

            VStack(spacing: 8) {
                Button { scanning = true } label: { Label("Scan QR code from your computer", systemImage: "qrcode.viewfinder") }.buttonStyle(QuietButtonStyle()).disabled(model.busy)
                Button("Use passkey or SSO in browser") { startBrowser() }.buttonStyle(QuietButtonStyle()).disabled(model.busy || !addressReady || !model.browserSignIn)
                if !model.providers.isEmpty {
                    Text("Sign in with \(model.providers.map { $0["name"].string }.joined(separator: ", ")) or a passkey in the browser.").font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
                } else if model.probe == .ready, !model.browserSignIn, !model.passwordOnly {
                    Text("This server can't sign in through the browser yet. Use your username and password.").font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
                }
            }

            if model.invitesOffered {
                HStack(spacing: 22) {
                    Button("I have an invite code") { model.error = nil; model.screen = .invite }
                    if model.signupOpen { Button("Create an account") { model.error = nil; model.screen = .signup } }
                }.font(.subheadline.weight(.medium)).foregroundStyle(Theme.clay).padding(.top, 4)
            }
        }
    }

    /// Servers that answered on this Wi-Fi: tap one to fill the address.
    @ViewBuilder private var foundServers: some View {
        if discovery.state == .scanning || !discovery.found.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Found on your network").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                    if discovery.state == .scanning { ProgressView().controlSize(.mini) }
                    Spacer()
                    if discovery.state == .finished { Button("Look again") { Task { await discovery.scan() } }.font(.footnote.weight(.medium)) }
                }.padding(.horizontal, 4)
                if !discovery.found.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(discovery.found.enumerated()), id: \.element.id) { index, server in
                            if index > 0 { Divider().overlay(Theme.hairline).padding(.leading, 48) }
                            Button { choose(server) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer").foregroundStyle(Theme.clay).frame(width: 24)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(server.name).foregroundStyle(Theme.ink).lineLimit(1)
                                        Text(server.compatible ? foundLine(server) : "Too old for the app. Update it first.").font(.footnote).foregroundStyle(server.compatible ? Theme.inkMuted : Theme.waiting).lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    if !server.secure { Image(systemName: "lock.open").font(.footnote).foregroundStyle(Theme.inkMuted).accessibilityLabel("Not encrypted") }
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                                }.padding(.horizontal, 16).padding(.vertical, 12).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(!server.compatible)
                        }
                    }.card(radius: 18)
                }
            }
        } else if discovery.state == .finished, store.address.isEmpty {
            Button { Task { await discovery.scan() } } label: { Label("Look for servers on this network", systemImage: "dot.radiowaves.left.and.right").font(.subheadline) }
                .foregroundStyle(Theme.clay).frame(maxWidth: .infinity)
        }
    }

    private func foundLine(_ server: FoundServer) -> String {
        let place: String? = server.name == server.host ? nil : (server.secure ? (server.url.host ?? server.host) : server.host)
        return [place, server.version.isEmpty ? "Atelier" : "Atelier \(server.version)"].compactMap { $0 }.joined(separator: " · ")
    }

    private func choose(_ server: FoundServer) {
        store.address = server.url.absoluteString
        field = .username
    }

    /// A QR code from the computer: the server and a one-time sign-in in one.
    private func pair(_ link: PairingLink) {
        model.error = nil
        model.busy = true
        Task {
            defer { model.busy = false }
            do { try await store.signIn(pairing: link) } catch is CancellationError { return } catch { model.error = ChatError.text(error) }
        }
    }

    private var serverRow: some View {
        row("server.rack") {
            TextField("Server address", text: $store.address, prompt: Text(verbatim: "https://atelier.example.com").foregroundStyle(Theme.inkMuted))
                .keyboardType(.URL).textContentType(.none).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Theme.ink).focused($field, equals: .server).submitLabel(.next).onSubmit { field = .username }
        }
    }

    /// One line under the address: what the server turned out to be.
    @ViewBuilder private var serverStatus: some View {
        if let problem = ChatSignIn.addressProblem(store.address) {
            statusLine(problem, symbol: "exclamationmark.triangle", tone: Theme.danger)
        } else {
            switch model.probe {
            case .idle: EmptyView()
            case .checking: HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking the server").font(.footnote).foregroundStyle(Theme.inkMuted) }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
            case .ready:
                VStack(alignment: .leading, spacing: 6) {
                    statusLine("Atelier server at \(URL(string: ChatSignIn.normalized(store.address))?.host ?? store.address)", symbol: "checkmark.circle", tone: Theme.success)
                    if ChatSignIn.normalized(store.address).lowercased().hasPrefix("http://") {
                        statusLine("Not encrypted. Only sign in like this on your own network.", symbol: "exclamationmark.shield", tone: Theme.waiting)
                    }
                }
            case .unreachable(let text):
                VStack(alignment: .leading, spacing: 8) {
                    statusLine(text, symbol: "wifi.exclamationmark", tone: Theme.danger)
                    Button("Try again") { Task { await model.check(store.address) } }.font(.footnote.weight(.semibold))
                }.frame(maxWidth: .infinity, alignment: .leading)
            case .certificate(let text): statusLine(text, symbol: "lock.trianglebadge.exclamationmark", tone: Theme.danger)
            case .tooOld(let text): statusLine(text, symbol: "arrow.down.circle", tone: Theme.waiting)
            case .notAtelier(let text): statusLine(text, symbol: "questionmark.circle", tone: Theme.danger)
            }
        }
    }

    private func statusLine(_ text: String, symbol: String, tone: Color) -> some View {
        Label { Text(text).font(.footnote).foregroundStyle(tone == Theme.success ? Theme.inkSecondary : tone).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: symbol).foregroundStyle(tone) }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
    }

    private func notice(_ text: String, symbol: String) -> some View {
        Label { Text(text).font(.subheadline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: symbol).foregroundStyle(Theme.waiting) }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.waiting.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // MARK: new accounts

    private enum AccountKind { case setup, invite, signup }

    private func accountForm(_ kind: AccountKind) -> some View {
        let nameOK = !name.trimmingCharacters(in: .whitespaces).isEmpty
        let usernameOK = Self.validUsername(username)
        let passwordOK = password.count >= 8
        let ready = nameOK && usernameOK && passwordOK && !model.busy
        return VStack(spacing: 14) {
            VStack(spacing: 0) {
                if kind == .setup {
                    row("key") { TextField("Setup token", text: $setupToken).textInputAutocapitalization(.never).autocorrectionDisabled().focused($field, equals: .token).submitLabel(.next).onSubmit { field = .name } }
                    Divider().overlay(Theme.hairline).padding(.leading, 48)
                }
                row("person.text.rectangle") { TextField("Full name", text: $name).textContentType(.name).focused($field, equals: .name).submitLabel(.next).onSubmit { field = .username } }
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("at") { TextField("Username", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled().focused($field, equals: .username).submitLabel(.next).onSubmit { field = .password } }
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("lock") { SecureField("Password", text: $password).textContentType(.newPassword).focused($field, equals: .password).submitLabel(.go).onSubmit { if ready { createAccount(kind) } } }
            }.card(radius: 18)
            VStack(alignment: .leading, spacing: 4) {
                if kind == .setup { hint("The setup token is printed in the server's log when it starts without any accounts.", bad: false) }
                if !username.isEmpty, !usernameOK { hint("Use 2 to 32 characters: letters, digits, dots, dashes or underscores.", bad: true) }
                if !password.isEmpty, !passwordOK { hint("The password needs at least 8 characters.", bad: true) }
                if username.isEmpty || password.isEmpty { hint("Use letters, digits, dots, dashes or underscores for the username, and at least 8 characters for the password.", bad: false) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4) }
            Button(kind == .signup ? "Request account" : "Create account") { createAccount(kind) }.buttonStyle(ClayButtonStyle(busy: model.busy)).disabled(!ready)
            Button(kind == .setup ? "Use a different server" : "Back to sign in") { model.error = nil; model.screen = .signIn; if kind == .setup { store.address = ""; model.reset() } }.font(.subheadline).foregroundStyle(Theme.inkMuted)
        }
    }

    private func hint(_ text: String, bad: Bool) -> some View {
        Text(text).font(.footnote).foregroundStyle(bad ? Theme.danger : Theme.inkMuted).fixedSize(horizontal: false, vertical: true)
    }

    static func validUsername(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard (2...32).contains(value.count), let first = value.first, first.isLetter && first.isASCII || first.isNumber && first.isASCII else { return false }
        return value.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || ".-_".contains($0) }
    }

    private func createAccount(_ kind: AccountKind) {
        let cleanName = name.trimmingCharacters(in: .whitespaces)
        Task {
            switch kind {
            case .setup: await model.setup(address: store.address, name: cleanName, username: username, password: password, setupToken: setupToken, store: store)
            case .invite: await model.acceptInvite(address: store.address, name: cleanName, username: username, password: password, store: store)
            case .signup: await model.signup(address: store.address, name: cleanName, username: username, password: password)
            }
            if model.error == nil { password = "" }
        }
    }

    // MARK: invite code

    private var inviteForm: some View {
        VStack(spacing: 14) {
            VStack(spacing: 0) {
                row("ticket") {
                    TextField("A1B2-C3D4-E5F6-G7H8", text: $model.inviteCode).textInputAutocapitalization(.characters).autocorrectionDisabled().font(.mono(.body)).focused($field, equals: .invite).submitLabel(.go)
                        .onSubmit { Task { await model.checkInvite(address: store.address, code: model.inviteCode) } }
                }
            }.card(radius: 18)
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4) }
            Button("Continue") { Task { await model.checkInvite(address: store.address, code: model.inviteCode) } }
                .buttonStyle(ClayButtonStyle(busy: model.busy)).disabled(model.busy || model.inviteCode.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Back to sign in") { model.error = nil; model.screen = .signIn }.font(.subheadline).foregroundStyle(Theme.inkMuted)
        }
    }

    private var pending: some View {
        VStack(spacing: 16) {
            Image(systemName: "hourglass").font(.system(size: 34, weight: .light)).foregroundStyle(Theme.inkMuted)
            Button("Back to sign in") { model.screen = .signIn }.buttonStyle(QuietButtonStyle())
        }
    }

    // MARK: the browser

    private var approval: some View {
        let flow = model.flow ?? .null
        return VStack(spacing: 18) {
            VStack(spacing: 10) {
                Text("Check this code in your browser").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                Text(flow["code"].string).font(.system(size: 34, weight: .semibold, design: .monospaced)).tracking(4).foregroundStyle(Theme.ink)
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.flowNote ?? "Waiting for you to approve this device").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 26).card(radius: 18)
            Text("Sign in on the page that opened with your password, a passkey or your identity provider, compare the code, then approve this device.").font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
            Button("Open the approval page") { model.reopenBrowser(address: store.address) }.buttonStyle(ClayButtonStyle())
            Button("Start over") { model.cancelBrowser() }.font(.subheadline).foregroundStyle(Theme.inkMuted)
        }
    }

    // MARK: temporary password

    private var passwordForm: some View {
        let long = next.count >= 8
        let same = next == confirm
        return VStack(spacing: 14) {
            VStack(spacing: 0) {
                row("key") { SecureField("Temporary password", text: $current).textContentType(.password).focused($field, equals: .current).submitLabel(.next).onSubmit { field = .next } }
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("lock") { SecureField("New password", text: $next).textContentType(.newPassword).focused($field, equals: .next).submitLabel(.next).onSubmit { field = .confirm } }
                Divider().overlay(Theme.hairline).padding(.leading, 48)
                row("lock.rotation") { SecureField("Confirm new password", text: $confirm).textContentType(.newPassword).focused($field, equals: .confirm).submitLabel(.go) }
            }.card(radius: 18)
            VStack(alignment: .leading, spacing: 4) {
                if !next.isEmpty, !long { hint("The new password needs at least 8 characters.", bad: true) }
                if !confirm.isEmpty, !same { hint("The two passwords don't match.", bad: true) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4) }
            Button("Save and continue") { Task { await model.changePassword(current: current, next: next, store: store); if model.error == nil { current = ""; next = ""; confirm = "" } } }
                .buttonStyle(ClayButtonStyle(busy: model.busy)).disabled(model.busy || current.isEmpty || !long || !same)
        }
    }

    // MARK: pieces

    private func row<Content: View>(_ icon: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Theme.inkMuted).frame(width: 24)
            content().font(.body)
        }.padding(.horizontal, 16).frame(minHeight: 52)
    }

    private func connect() {
        guard loginReady, !model.busy else { return }
        Task {
            await model.login(address: store.address, username: username, password: password, store: store)
            if model.error != nil { password = ""; field = .password } else { password = "" }
        }
    }

    private func startBrowser() {
        guard addressReady else { return }
        Task { await model.startBrowser(address: store.address, store: store) }
    }
}
