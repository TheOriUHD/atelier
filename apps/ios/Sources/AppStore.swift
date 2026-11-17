import Foundation
import Observation
import UniformTypeIdentifiers

@MainActor @Observable final class AppStore {
    var address = UserDefaults.standard.string(forKey: "server") ?? ""
    var signedIn = false
    /// Why the server could not be reached, when it answered but refused (an old server); nil while it is just not there.
    var connectionNote: String?
    var connected = false
    var busy = false
    var error: String?
    var sessions: [Conversation] = []
    var models: [JSON] = []
    var projects: [JSON] = []
    var artifacts: [JSON] = []
    var selected: String?
    var transcript = Transcript()
    var draft = ""
    var attachments: [JSON] = []
    var selectedModel = ""
    var selectedEffort = ""
    var project: String?
    var search = ""
    var userName = ""
    /// `auth.status` and `app.info` of the server this device is signed in to: who the person is, and what the server offers.
    var authStatus: JSON = .null
    var info: JSON = .null
    var uncertainDelivery = false
    /// A short confirmation shown over the app for a moment ("Copied", "Saved").
    var toast: String?
    private var toastTask: Task<Void, Never>?
    func notify(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { try? await Task.sleep(for: .seconds(2.2)); if !Task.isCancelled { toast = nil } }
    }
    let rpc = Connection()
    private var loading = false
    private var buffered: [JSON] = []
    private var reconnectTask: Task<Void, Never>?
    private var active = true
    private var restoring = false
    /// A QR sign-in is in progress: nothing else may take the connection (or try to restore an old sign-in) meanwhile.
    private var pairing = false
    /// The socket may have been closed while the app was in the background: look once when it comes back.
    private var needsCheck = false
    private var pollTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?
    private var pendingSend: (session: String, parts: [JSON], mutation: String)?
    private var userID = ""

    init() {
        // A server that was added stays the app's home: with a saved sign-in the app opens straight into it, and while the
        // connection is made (or fails) it shows the reconnecting banner, never the sign-in screen.
        if !address.isEmpty, let url = try? serverURL(address), CredentialStore.read(url.absoluteString) != nil {
            signedIn = true
            userName = UserDefaults.standard.string(forKey: "userName") ?? ""
            // Drafts are kept per person and server: written before the connection is made, they must land where they will be read.
            userID = UserDefaults.standard.string(forKey: "userID") ?? ""
        }
        rpc.event = { [weak self] method, value in self?.receive(method, value) }
        rpc.disconnected = { [weak self] in
            guard let self else { return }
            // A socket the system closed while the app was away is not news: the app looks when it comes back.
            guard self.active else { self.needsCheck = true; return }
            self.connected = false
            self.scheduleReconnect()
        }
    }
    /// Admins have the Admin pages and everything they open; everyone else has their own settings.
    var isAdmin: Bool { authStatus["user"]["role"].string == "admin" }
    var role: String { authStatus["user"]["role"].string }
    /// Whether the server offers a feature (`app.info`: imageGeneration, auditLog, usageLimits, sharedComputer …).
    func offers(_ feature: String) -> Bool { info[feature].bool }
    func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        Task { do { try await operation() } catch { self.error = error.localizedDescription } }
    }
    func login(username: String, password: String) async throws {
        let url = try serverURL(address)
        busy = true; defer { busy = false }
        try await checkServer(url)
        rpc.connect(url, token: nil)
        let result = try await rpc.call("auth.login", ["username": .string(username), "password": .string(password), "clientKind": .string("mobile")])
        guard !result["token"].string.isEmpty else { throw MobileError.message("The server did not return a sign-in token.") }
        try CredentialStore.save(result["token"].string, server: url.absoluteString)
        address = url.absoluteString; UserDefaults.standard.set(address, forKey: "server")
        try await restore()
    }
    /// Signs in with what a QR code on the person's computer holds: a one-time sign-in they approved there. The addresses are
    /// tried in order; the first server that answers is the one. An account already signed in here is left for the new one.
    func signIn(pairing link: PairingLink) async throws {
        busy = true; defer { busy = false }
        pairing = true
        defer { pairing = false }
        reconnectTask?.cancel()
        var failure: Error = MobileError.message("Can't reach the server in this code. Is this phone on the same network as the computer?")
        for candidate in link.addresses {
            guard let url = try? serverURL(candidate) else { continue }
            do {
                try await checkServer(url)
                if signedIn { leaveAccount() }
                rpc.connect(url, token: nil)
                let result = try await rpc.call("auth.terminalPoll", ["pollToken": .string(link.token)])
                guard result["state"].string == "approved", !result["token"].string.isEmpty else {
                    rpc.close()
                    throw PairingExpired()
                }
                try CredentialStore.save(result["token"].string, server: url.absoluteString)
                address = url.absoluteString; UserDefaults.standard.set(address, forKey: "server")
                pairing = false
                try await restore()
                return
            } catch is PairingExpired {
                throw MobileError.message("This code ran out or was already used. Show a new one on your computer and scan it again.")
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failure = error
            }
        }
        throw failure
    }
    private struct PairingExpired: Error {}
    /// This phone stops being signed in here, without telling the server (the sign-in stays valid where it was made).
    private func leaveAccount() {
        rpc.close()
        signedIn = false; connected = false
        sessions = []; transcript = Transcript(); draft = ""; attachments = []; selected = nil
        userName = ""; authStatus = .null; info = .null
    }
    func restore() async throws {
        guard !address.isEmpty, !restoring, !pairing, !connected else { return }
        restoring = true; defer { restoring = false }
        let url = try serverURL(address)
        guard let token = CredentialStore.read(url.absoluteString) else { return }
        try await checkServer(url)
        rpc.connect(url, token: token)
        let status = try await rpc.call("auth.status")
        guard status["user"] != .null else { signedIn = false; connected = false; rpc.close(); throw MobileError.message("Sign in again to this server.") }
        userID = status["user"]["id"].string
        UserDefaults.standard.set(userID, forKey: "userID")
        userName = status["user"]["name"].string
        UserDefaults.standard.set(userName, forKey: "userName")
        connectionNote = nil
        authStatus = status
        info = (try? await rpc.call("app.info")) ?? .null
        signedIn = true; connected = true
        needsCheck = false
        DeveloperOptions.shared.noteAttempt(reset: true)
        startPolling()
        try await refresh()
        if let selected { try await open(selected) }
    }
    private func checkServer(_ url: URL) async throws {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(from: url.appending(path: "api/health"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw MobileError.message("This server is unavailable.") }
        let health = try JSONDecoder().decode(JSON.self, from: data)
        guard health["app"].string == "atelier", health["mobileProtocol"].int == 1 else { throw MobileError.message("Update this Atelier server to a release that supports the native mobile app.") }
    }
    func startBrowserSignIn() async throws -> JSON {
        let url = try serverURL(address)
        try await checkServer(url)
        rpc.connect(url, token: nil)
        return try await rpc.call("auth.terminalStart", ["deviceName": .string("Atelier on iPhone / iPad"), "platform": .string("iOS")])
    }
    func finishBrowserSignIn(_ flow: JSON) async throws -> Bool {
        let result = try await rpc.call("auth.terminalPoll", ["pollToken": flow["pollToken"]])
        switch result["state"].string {
        case "approved":
            let url = try serverURL(address)
            try CredentialStore.save(result["token"].string, server: url.absoluteString)
            address = url.absoluteString; UserDefaults.standard.set(address, forKey: "server")
            try await restore(); return true
        case "pending": return false
        default: throw MobileError.message("This sign-in expired or was denied. Start again.")
        }
    }
    func refresh() async throws {
        sessions = try await rpc.call("sessions.list", ["limit": .number(200), "archived": .string("active")]).array.map(Conversation.init)
        models = try await rpc.call("models.list").array
        projects = try await rpc.call("projects.list").array
        if selectedModel.isEmpty { selectedModel = models.first?["ref"].string ?? "" }
    }
    func open(_ id: String) async throws {
        saveDraft()
        if let previous = selected, previous != id { _ = try await rpc.call("sessions.unsubscribe", ["id": .string(previous)]) }
        let previousDraft = draft
        let sameSession = selected == id
        selected = id; loading = true; buffered = []
        defer { loading = false }
        let snapshot = try await rpc.call("sessions.subscribe", ["id": .string(id)])
        guard selected == id else { return }
        transcript = Transcript(snapshot: snapshot)
        selectedModel = snapshot["session"]["model"].string
        selectedEffort = snapshot["session"]["effort"].string
        for event in buffered where event["seq"].int > transcript.seq {
            if !transcript.apply(event) { buffered = []; loading = false; try await open(id); return }
        }
        buffered = []; loading = false
        artifacts = try await rpc.call("artifacts.list", ["sessionId": .string(id)]).array
        draft = sameSession ? previousDraft : loadDraft()
        _ = try await rpc.call("sessions.markSeen", ["id": .string(id)])
    }
    func newConversation() {
        saveDraft()
        if let selected { perform { _ = try await self.rpc.call("sessions.unsubscribe", ["id": .string(selected)]) } }
        selected = nil; project = nil; transcript = Transcript(); artifacts = []; attachments = []; draft = loadDraft()
    }
    func send() async throws {
        guard connected, !uncertainDelivery else { throw MobileError.message("Reconnect and check the conversation before sending again.") }
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return }
        busy = true; defer { busy = false }
        if selected == nil {
            var params: [String: JSON] = ["mode": .string("chat")]
            if !selectedModel.isEmpty { params["model"] = .string(selectedModel) }
            if let project { params["projectId"] = .string(project) }
            if !selectedEffort.isEmpty { params["effort"] = .string(selectedEffort) }
            let session = try await rpc.call("sessions.create", params)
            let text = draft
            let files = attachments
            try await open(session["id"].string)
            draft = text; attachments = files
        }
        guard let selected else { return }
        let parts = attachments + (draft.isEmpty ? [] : [.text(draft)])
        do {
            var params: [String: JSON] = ["sessionId": .string(selected), "parts": .array(parts)]
            if transcript.status != "running" {
                let mutation = UUID().uuidString
                pendingSend = (selected, parts, mutation)
                params["clientMutationId"] = .string(mutation)
            }
            saveDraft()
            _ = try await rpc.call(transcript.status == "running" ? "chat.queue" : "chat.send", params)
            pendingSend = nil; draft = ""; attachments = []; saveDraft()
        } catch { uncertainDelivery = true; saveDraft(); throw error }
    }
    func reconcileSend() async throws {
        guard let selected else { return }
        if let pendingSend, pendingSend.session == selected {
            _ = try await rpc.call("chat.send", ["sessionId": .string(selected), "parts": .array(pendingSend.parts), "clientMutationId": .string(pendingSend.mutation)])
            self.pendingSend = nil; draft = ""; attachments = []; saveDraft()
        }
        try await open(selected)
        uncertainDelivery = false
    }
    func respond(_ answer: JSON) async throws {
        guard let selected, transcript.pending != .null, connected else { return }
        _ = try await rpc.call("chat.respond", ["sessionId": .string(selected), "interactionId": transcript.pending["id"], "answer": answer])
        try await open(selected)
    }
    func action(_ method: String, extra: [String: JSON] = [:]) async throws {
        guard let selected else { return }
        var params = extra; params["sessionId"] = .string(selected)
        _ = try await rpc.call(method, params)
    }
    func updateModel() async throws {
        guard let selected else { return }
        var params: [String: JSON] = ["id": .string(selected), "model": .string(selectedModel)]
        params["effort"] = selectedEffort.isEmpty ? .null : .string(selectedEffort)
        _ = try await rpc.call("sessions.update", params)
    }
    func upload(_ data: Data, name: String, mime: String) async throws {
        guard data.count <= 32 * 1024 * 1024 else { throw MobileError.message("Attachments are limited to 32 MB each.") }
        busy = true; defer { busy = false }
        let file = try await rpc.call("files.upload", ["name": .string(name), "mime": .string(mime), "dataBase64": .string(data.base64EncodedString())])
        attachments.append(.object(["type": .string(mime.hasPrefix("image/") ? "image" : "document"), "blob": file["blob"], "mime": .string(mime), "name": .string(name)]))
    }
    func upload(_ url: URL) async throws {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 32 * 1024 * 1024 else { throw MobileError.message("Attachments are limited to 32 MB each.") }
        try await upload(Data(contentsOf: url), name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
    }
    func lifecycle(active: Bool) {
        self.active = active
        saveDraft()
        if active {
            Task { await resumed() }
            startPolling()
        } else {
            // Nothing runs in the background. The socket is left as it is: the system keeps it or closes it, and the app
            // finds out when it comes back, so a short trip to another app never shows a "reconnecting" banner.
            reconnectTask?.cancel(); reloadTask?.cancel(); pollTask?.cancel(); pollTask = nil
        }
    }

    private func resumed() async {
        guard signedIn else { return }
        if connected, !needsCheck, !DeveloperOptions.shared.checkOnForeground { return }
        await checkConnection(reason: "foreground")
    }

    /// Asks the server whether it is there, with a short wait. A server that answers changes nothing on screen; one that
    /// does not starts connecting again (the list says so only if that takes a while).
    func checkConnection(reason: String) async {
        guard signedIn, !pairing, !restoring else { return }
        let started = ContinuousClock.now
        do {
            _ = try await rpc.call("app.info", timeout: 4)
            let elapsed = started.duration(to: .now)
            DeveloperOptions.shared.noteCheck(latency: Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000), problem: nil)
            needsCheck = false
            if !connected { connected = true }
        } catch {
            DeveloperOptions.shared.noteCheck(latency: nil, problem: ChatError.text(error))
            rpc.close()
            connected = false
            await reconnectQuietly()
        }
    }

    /// The timer some developers switch on: look at the connection every so many seconds while the app is open.
    func startPolling() {
        pollTask?.cancel(); pollTask = nil
        let options = DeveloperOptions.shared
        guard active, signedIn, options.alwaysCheck else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(max(2, options.checkInterval)))
                guard !Task.isCancelled, let self, self.active else { return }
                await self.checkConnection(reason: "timer")
            }
        }
    }

    func developerOptionsChanged() { startPolling() }

    func reconnectNow() async {
        rpc.close()
        connected = false
        await reconnectQuietly()
    }

    /// For trying the banners: closes the socket as a bad network would.
    func dropConnectionForTesting() {
        rpc.close()
        connected = false
        scheduleReconnect()
    }
    func logout() async throws {
        _ = try await rpc.call("auth.logout")
        CredentialStore.remove(address); clearDrafts(); rpc.close(); signedIn = false; connected = false
        sessions = []; transcript = Transcript(); draft = ""; attachments = []; selected = nil
    }
    private func receive(_ method: String, _ value: JSON) {
        if method == "auth.signedOut" { signedIn = false; connected = false; return }
        if method == "session.event", value["sessionId"].string == selected {
            if loading { buffered.append(value) }
            else if !transcript.apply(value), let selected, reloadTask == nil {
                reloadTask = Task {
                    defer { reloadTask = nil }
                    do { try await Task.sleep(for: .milliseconds(100)); try await open(selected) }
                    catch { self.error = error.localizedDescription }
                }
            }
        } else if method == "sessions.changed" {
            let session = Conversation(raw: value)
            if let i = sessions.firstIndex(where: { $0.id == session.id }) { sessions[i] = session } else { sessions.insert(session, at: 0) }
        } else if method == "sessions.removed" {
            sessions.removeAll { $0.id == value["id"].string }
            if selected == value["id"].string { newConversation() }
        }
    }
    /// Connects again without an alert: the banner says it is reconnecting, and this keeps trying.
    func reconnectQuietly() async {
        do { try await restore() } catch is CancellationError { return } catch {
            connectionNote = error is MobileError ? error.localizedDescription : nil
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard active, signedIn else { return }
        reconnectTask?.cancel()
        reconnectTask = Task {
            for delay in DeveloperOptions.shared.backoffDelays {
                do { try await Task.sleep(for: .seconds(delay)); try Task.checkCancellation(); DeveloperOptions.shared.noteAttempt(); try await restore(); return }
                catch is CancellationError { return } catch { self.connectionNote = error is MobileError ? error.localizedDescription : nil }
            }
        }
    }
    private var draftURL: URL? {
        guard transcript.snapshot["session"]["temporary"] == .null else { return nil }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let identity = Data((address + "|" + userID + "|" + (selected ?? "new")).utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
        return root.appending(path: "Drafts").appending(path: identity)
    }
    func saveDraft() {
        guard signedIn, let url = draftURL else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            var record: [String: JSON] = ["text": .string(draft), "attachments": .array(attachments), "uncertain": .bool(uncertainDelivery)]
            if let pendingSend, pendingSend.session == selected {
                record["pending"] = .object(["session": .string(pendingSend.session), "parts": .array(pendingSend.parts), "mutation": .string(pendingSend.mutation)])
            }
            try JSONEncoder().encode(JSON.object(record)).write(to: url, options: [.atomic, .completeFileProtection])
            var resource = URLResourceValues(); resource.isExcludedFromBackup = true
            var directory = url.deletingLastPathComponent(); try directory.setResourceValues(resource)
        } catch { self.error = "Could not save the local draft: \(error.localizedDescription)" }
    }
    private func loadDraft() -> String {
        attachments = []; pendingSend = nil; uncertainDelivery = false
        guard let url = draftURL, let data = try? Data(contentsOf: url) else { return "" }
        guard let record = try? JSONDecoder().decode(JSON.self, from: data) else { return String(data: data, encoding: .utf8) ?? "" }
        attachments = record["attachments"].array; uncertainDelivery = record["uncertain"].bool
        let pending = record["pending"]
        if pending["session"].string == selected, UUID(uuidString: pending["mutation"].string) != nil {
            pendingSend = (pending["session"].string, pending["parts"].array, pending["mutation"].string)
            uncertainDelivery = true
        }
        return record["text"].string
    }
    func clearDrafts() {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appending(path: "Drafts")
        do { if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) } }
        catch { self.error = error.localizedDescription }
    }
}
