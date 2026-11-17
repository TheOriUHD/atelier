import SwiftUI
import Observation
import AuthenticationServices

/// What signing in needs beyond a form: asking the server what it offers (first account, invites, sign-up, identity
/// providers), every way of getting a token, and saying what went wrong in words. It talks to the server over a
/// connection of its own, so the app's connection stays untouched until a token has been saved.
@MainActor @Observable final class ChatSignIn {
    enum Screen: Equatable { case signIn, setup, invite, newAccount, signup, pending, approval, password }

    enum Probe: Equatable {
        case idle, checking, ready
        case unreachable(String)
        case certificate(String)
        case tooOld(String)
        case notAtelier(String)
        var failure: String? {
            switch self {
            case .unreachable(let text), .certificate(let text), .tooOld(let text), .notAtelier(let text): text
            default: nil
            }
        }
    }

    var screen: Screen = .signIn
    var probe: Probe = .idle
    var status: JSON = .null
    var info: JSON = .null
    var busy = false
    var error: String?
    var flow: JSON?
    var flowNote: String?
    var inviteCode = ""
    @ObservationIgnored private var connection: Connection?
    @ObservationIgnored private var probeTask: Task<Void, Never>?
    @ObservationIgnored private let web = ChatWebSession()

    // MARK: what the server says it offers

    var setupRequired: Bool { status["setupRequired"].bool }
    var signupOpen: Bool { status["signup"].string == "open" && !passwordOnly }
    var passwordOnly: Bool { status["passwordOnly"].bool }
    var providers: [JSON] { passwordOnly ? [] : status["oidc"].array }
    var browserSignIn: Bool { !passwordOnly && (info == .null || info["terminalSignIn"].bool) }
    var invitesOffered: Bool { !passwordOnly && probe == .ready }

    // MARK: asking the server

    /// Adds `https://` when the person typed a bare host, and says why an address cannot work.
    static func normalized(_ input: String) -> String {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.isEmpty, !text.contains("://") { text = "https://" + text }
        return text
    }

    static func addressProblem(_ input: String) -> String? {
        let text = normalized(input)
        guard !text.isEmpty else { return nil }
        if text.lowercased().hasPrefix("http://") { return "Atelier connects over HTTPS only. Use an address that starts with https://." }
        if (try? serverURL(text)) == nil { return "Enter the address without a path, password or query, like https://atelier.example.com." }
        return nil
    }

    /// Looks at the server after a short pause in typing. Calling it again replaces the look in progress.
    func schedule(_ address: String) {
        probeTask?.cancel()
        probe = .idle
        status = .null
        info = .null
        guard Self.addressProblem(address) == nil, !Self.normalized(address).isEmpty else { return }
        probeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(650))
            guard !Task.isCancelled else { return }
            await self?.check(address)
        }
    }

    func check(_ address: String) async {
        let text = Self.normalized(address)
        guard let url = try? serverURL(text) else { return }
        probe = .checking
        do {
            try await Self.health(url)
            let link = Connection()
            link.connect(url, token: nil)
            connection?.close()
            connection = link
            status = try await link.call("auth.status")
            info = (try? await link.call("app.info")) ?? .null
            if Task.isCancelled { return }
            probe = .ready
        } catch is CancellationError {
            return
        } catch let failure as ChatSignIn.Failure {
            probe = failure.probe
        } catch {
            probe = Self.probe(for: error)
        }
    }

    struct Failure: Error { let probe: Probe }

    /// `GET /api/health`: is this an Atelier server, and is it new enough for the app?
    static func health(_ url: URL) async throws {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url.appending(path: "api/health"))
        request.timeoutInterval = 12
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let health = try? JSONDecoder().decode(JSON.self, from: data), health["app"].string == "atelier" else {
            throw Failure(probe: .notAtelier("That address answered, but it isn't an Atelier server."))
        }
        guard health["mobileProtocol"].int == 1 else {
            throw Failure(probe: .tooOld("This server is too old for the app. Ask an admin to update it to the latest Atelier release."))
        }
    }

    static func probe(for error: Error) -> Probe {
        guard let failure = error as? URLError else { return .unreachable(ChatError.text(error)) }
        switch failure.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected, .clientCertificateRequired:
            return .certificate("This server's certificate isn't trusted, so the app won't connect. If it uses your own certificate authority, install that certificate on this device and trust it in Settings, General, About, Certificate Trust Settings.")
        case .cannotFindHost, .dnsLookupFailed:
            return .unreachable("Can't find that server. Check the address.")
        case .notConnectedToInternet, .dataNotAllowed:
            return .unreachable("This device is offline.")
        case .timedOut:
            return .unreachable("The server didn't answer in time. Check the address and your connection.")
        case .cannotConnectToHost, .networkConnectionLost:
            return .unreachable("Can't reach the server. Check the address and that it is running.")
        default:
            return .unreachable("Can't reach the server. \(failure.localizedDescription)")
        }
    }

    // MARK: getting a token

    private func link(_ address: String) async throws -> (Connection, URL) {
        let url = try serverURL(Self.normalized(address))
        if probe != .ready || connection == nil {
            await check(address)
            if let text = probe.failure { throw MobileError.message(text) }
        }
        guard let connection else { throw MobileError.message("Can't reach the server.") }
        return (connection, url)
    }

    /// Saves the token and lets the app take over: it connects with it, as it does at every launch.
    private func finish(token: String, url: URL, store: AppStore) async throws {
        try CredentialStore.save(token, server: url.absoluteString)
        store.address = url.absoluteString
        UserDefaults.standard.set(store.address, forKey: "server")
        connection?.close()
        connection = nil
        ChatHub.of(store).signedOutMessage = nil
        do { try await store.restore() } catch {
            // A temporary password: the app is connected and must ask for a new one before it shows anything.
            if store.authStatus["user"]["mustChangePassword"].bool { screen = .password; return }
            throw error
        }
        if store.authStatus["user"]["mustChangePassword"].bool { screen = .password }
    }

    private func run(_ operation: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do { try await operation() } catch is CancellationError { return } catch { self.error = ChatError.text(error) }
    }

    func login(address: String, username: String, password: String, store: AppStore) async {
        await run {
            let (connection, url) = try await link(address)
            let result = try await connection.call("auth.login", ["username": .string(username.trimmingCharacters(in: .whitespaces).lowercased()), "password": .string(password), "clientKind": .string("mobile")])
            guard !result["token"].string.isEmpty else { throw MobileError.message("The server did not return a sign-in token.") }
            try await finish(token: result["token"].string, url: url, store: store)
        }
        if error?.contains("waiting for an admin") == true { screen = .pending; error = nil }
    }

    func setup(address: String, name: String, username: String, password: String, setupToken: String, store: AppStore) async {
        await run {
            let (connection, url) = try await link(address)
            var params: [String: JSON] = ["username": .string(username.lowercased()), "name": .string(name), "password": .string(password), "clientKind": .string("mobile")]
            if !setupToken.trimmingCharacters(in: .whitespaces).isEmpty { params["setupToken"] = .string(setupToken.trimmingCharacters(in: .whitespaces)) }
            let result = try await connection.call("auth.setup", params)
            try await finish(token: result["token"].string, url: url, store: store)
        }
    }

    /// Whether an invite code is open; on yes the account form follows.
    func checkInvite(address: String, code: String) async {
        await run {
            guard let normalized = Self.normalizedInvite(code) else { throw MobileError.message("An invite code has 16 letters and digits, like A1B2-C3D4-E5F6-G7H8.") }
            let (connection, _) = try await link(address)
            _ = try await connection.call("auth.checkInvite", ["invite": .string(normalized)])
            inviteCode = normalized
            screen = .newAccount
        }
    }

    func acceptInvite(address: String, name: String, username: String, password: String, store: AppStore) async {
        await run {
            let (connection, url) = try await link(address)
            let result = try await connection.call("auth.acceptInvite", ["username": .string(username.lowercased()), "name": .string(name), "password": .string(password), "invite": .string(inviteCode), "clientKind": .string("mobile")])
            try await finish(token: result["token"].string, url: url, store: store)
        }
    }

    func signup(address: String, name: String, username: String, password: String) async {
        await run {
            let (connection, _) = try await link(address)
            _ = try await connection.call("auth.signup", ["username": .string(username.lowercased()), "name": .string(name), "password": .string(password)])
            screen = .pending
        }
    }

    /// Crockford's base32 has no I, L, O or U: a typed I or L means 1, an O means 0.
    static func normalizedInvite(_ input: String) -> String? {
        let code = input.uppercased().filter { !$0.isWhitespace && !"-\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}".contains($0) }
            .map { $0 == "O" ? "0" : ($0 == "I" || $0 == "L" ? "1" : $0) }
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        return code.count == 16 && code.allSatisfy({ alphabet.contains($0) }) ? String(code) : nil
    }

    // MARK: the browser (passkeys, identity providers)

    func startBrowser(address: String, store: AppStore) async {
        await run {
            let (connection, url) = try await link(address)
            let started = try await connection.call("auth.terminalStart", ["deviceName": .string(UIDevice.current.userInterfaceIdiom == .pad ? "Atelier on iPad" : "Atelier on iPhone"), "platform": .string("iOS")])
            flow = started
            flowNote = nil
            screen = .approval
            if let page = URL(string: started["verifyUrlComplete"].string), page.scheme == "https", page.host == url.host, page.port == url.port { web.open(page) }
            pollTask?.cancel()
            pollTask = Task { [weak self] in await self?.poll(url: url, store: store) }
        }
    }

    @ObservationIgnored private var pollTask: Task<Void, Never>?

    private func poll(url: URL, store: AppStore) async {
        guard let flow else { return }
        let interval = max(2, flow["interval"].int)
        while !Task.isCancelled, self.flow != nil {
            do {
                try await Task.sleep(for: .seconds(interval))
                guard let connection else { return }
                let result = try await connection.call("auth.terminalPoll", ["pollToken": flow["pollToken"]])
                switch result["state"].string {
                case "approved":
                    web.close()
                    await run { try await finish(token: result["token"].string, url: url, store: store) }
                    self.flow = nil
                    return
                case "denied": flowNote = "This sign-in was denied. Start again."; self.flow = nil; web.close(); screen = .signIn; error = flowNote; return
                case "expired": flowNote = "This sign-in expired. Start again."; self.flow = nil; web.close(); screen = .signIn; error = flowNote; return
                default: continue
                }
            } catch is CancellationError {
                return
            } catch {
                flowNote = "Can't reach the server. Trying again."
            }
        }
    }

    func reopenBrowser(address: String) {
        guard let flow, let url = try? serverURL(Self.normalized(address)), let page = URL(string: flow["verifyUrlComplete"].string), page.host == url.host, page.port == url.port, page.scheme == "https" else { return }
        web.open(page)
    }

    func cancelBrowser() {
        pollTask?.cancel()
        web.close()
        flow = nil
        flowNote = nil
        screen = .signIn
    }

    // MARK: a temporary password

    func changePassword(current: String, next: String, store: AppStore) async {
        await run {
            _ = try await store.rpc.call("account.changePassword", ["current": .string(current), "next": .string(next)])
            store.authStatus = try await store.rpc.call("auth.status")
            store.error = nil
            await ChatHub.of(store).reloadAll()
            screen = .signIn
        }
    }

    func reset() {
        pollTask?.cancel()
        probeTask?.cancel()
        web.close()
        connection?.close()
        connection = nil
        flow = nil
        error = nil
        screen = .signIn
    }
}

/// The in-app browser the approval page opens in: it shares Safari's cookies and passkeys, so signing in there works
/// the way it does everywhere else. The page never returns to the app, so the app closes the sheet itself once the
/// server says the sign-in was approved.
@MainActor final class ChatWebSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL) {
        close()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "atelier-signin") { _, _ in }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    func close() {
        session?.cancel()
        session = nil
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { preconditionFailure("A sheet can only be presented while the app has a window") }
            return scene.keyWindow ?? ASPresentationAnchor(windowScene: scene)
        }
    }
}
