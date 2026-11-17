import SwiftUI
import Observation
import UniformTypeIdentifiers

/// What the chat screens share beyond `AppStore`: the person's groups, settings and connectors, the live extras of the
/// open conversation (co-op presence, reactions, partial tool input) and the images the app has already fetched. One per
/// store. It listens to the server's events by wrapping the connection's handler, so `AppStore` keeps working as it is.
@MainActor @Observable final class ChatHub {
    private static var hubs: [ObjectIdentifier: ChatHub] = [:]

    static func of(_ store: AppStore) -> ChatHub {
        if let hub = hubs[ObjectIdentifier(store)], hub.store === store { return hub }
        let hub = ChatHub(store: store)
        hubs[ObjectIdentifier(store)] = hub
        return hub
    }

    @ObservationIgnored private weak var store: AppStore?

    // MARK: the list's own state

    var listLoaded = false
    /// Why the conversation the person tried to open did not open.
    var openError: String?
    var listError: String?
    var refreshing = false

    // MARK: shell data

    var groups: [JSON] = []
    var settings: JSON = .null
    var prefs: JSON = .null
    var mcp: [JSON] = []
    var imageModels: [JSON] = []
    var workspaces: [JSON] = []
    var slash: [JSON] = []
    var shellLoaded = false

    /// Why the person is looking at the sign-in screen again, when the server ended their sign-in.
    var signedOutMessage: String?

    // MARK: the open conversation's extras

    var presence: [String: [JSON]] = [:]
    var typing: [String: [String: Date]] = [:]
    var reactions: [String: [String: [JSON]]] = [:]
    var suggestion: [String: String] = [:]
    var limitWarning: [String: JSON] = [:]
    var hostAway: [String: Bool] = [:]
    /// Tool input as it streams in, by `messageId:index`.
    var toolInputs: [String: String] = [:]
    /// How a reply ended, for the replies that finished while this screen watched (the snapshot's copy lacks it).
    var stopReasons: [String: String] = [:]
    /// Bumped when a conversation's side chats change, so open lists read again.
    var sideChatTick: [String: Int] = [:]
    /// `coop.state` of the shared conversations that were opened, by session id.
    var coop: [String: JSON] = [:]
    /// A side chat's own conversation, and the one it was started beside.
    var sideChatParent: [String: String] = [:]

    private init(store: AppStore) {
        self.store = store
        let previous = store.rpc.event
        store.rpc.event = { [weak self] method, value in
            let passed = self?.intercept(method, value) ?? value
            previous?(method, passed)
        }
    }

    // MARK: events

    private func intercept(_ method: String, _ value: JSON) -> JSON {
        switch method {
        case "auth.signedOut": signedOutMessage = "Your sign-in ended. Sign in again to carry on."
        case "groups.changed": groups = value.array
        case "prefs.changed": prefs = value
        case "settings.changed": settings = value["effective"]
        case "mcp.changed": mcp = value.array
        case "imageModels.changed": imageModels = value.array
        case "workspaces.changed": workspaces = value.array
        case "models.changed": store?.models = value.array
        case "projects.changed": Task { await reloadProjects() }
        case "sideChats.changed": sideChatTick[value["sessionId"].string, default: 0] += 1
        case "session.event": return sessionEvent(value)
        case "dictation.update": dictationListener?(value)
        default: break
        }
        return value
    }

    /// Notes what `AppStore` ignores, and turns the events it would answer with a full reload into quiet ones.
    private func sessionEvent(_ value: JSON) -> JSON {
        let id = value["sessionId"].string
        let event = value["event"]
        let quiet = value.setting("event", .object(["type": .string("tool_progress")]))
        switch event["type"].string {
        case "delta" where event["kind"].string == "tool_input":
            toolInputs["\(event["messageId"].string):\(event["index"].int)", default: ""] += event["text"].string
            return quiet
        case "message":
            let message = event["message"]["id"].string
            toolInputs = toolInputs.filter { !$0.key.hasPrefix("\(message):") }
        case "done":
            let reason = event["stopReason"].string
            if !reason.isEmpty { stopReasons[event["messageId"].string] = reason }
        case "presence": presence[id] = event["participants"].array; Task { await loadCoop(id) }
        case "typing": typing[id, default: [:]][event["participantId"].string] = .now
        case "suggestion": suggestion[id] = event["text"].stringOrNil
        case "limit_warning": limitWarning[id] = event["warning"] == .null ? nil : event["warning"]
        case "host_away": hostAway[id] = event["away"].bool; return quiet
        case "reaction":
            var byMessage = reactions[id] ?? [:]
            byMessage[event["messageId"].string] = ChatReactions.applying(byMessage[event["messageId"].string] ?? [], participant: event["participantId"].string, emoji: event["emoji"].string, on: event["on"].bool)
            reactions[id] = byMessage
        default: break
        }
        return value
    }

    // MARK: loading

    /// Everything the lists and the message box need besides the conversation itself. Each part is optional: an older
    /// server that lacks one just leaves it empty.
    func loadShell() async {
        guard let store else { return }
        if let value = try? await store.rpc.call("groups.list") { groups = value.array }
        if let value = try? await store.rpc.call("settings.get") { settings = value["effective"] }
        if let value = try? await store.rpc.call("prefs.get") { prefs = value }
        if let value = try? await store.rpc.call("mcp.status") { mcp = value.array }
        if let value = try? await store.rpc.call("imageModels.list") { imageModels = value.array }
        if let value = try? await store.rpc.call("workspaces.list") { workspaces = value.array }
        if let value = try? await store.rpc.call("slash.list", [:]) { slash = value.array }
        if let value = try? await store.rpc.call("dictation.status"), value != .null { dictationOn = value["enabled"].bool }
        shellLoaded = true
    }

    /// The conversation list again: the one pull to refresh, a retry and the first load use.
    func reloadAll() async {
        guard let store else { return }
        #if DEBUG
        if Launch.value("--state") == "loading" { if Demo.requested == "home" { store.sessions = [] }; return }
        #endif
        refreshing = true
        defer { refreshing = false }
        do {
            try await store.refresh()
            listLoaded = true
            listError = nil
        } catch is CancellationError {
            return
        } catch {
            listError = ChatError.text(error)
        }
        await loadShell()
    }

    /// `coop.state` of a shared conversation (null for one nobody else is in).
    func loadCoop(_ id: String) async {
        guard let store, let state = try? await store.rpc.call("coop.state", ["sessionId": .string(id)]) else { return }
        coop[id] = state == .null ? nil : state
    }

    func reloadProjects() async {
        guard let store, let value = try? await store.rpc.call("projects.list") else { return }
        store.projects = value.array
    }

    // MARK: derived

    var providerNames: [String: String] {
        Dictionary(settings["providers"].array.map { ($0["id"].string, $0["name"].string) }, uniquingKeysWith: { first, _ in first })
    }
    var webSearchOn: Bool { settings["capabilities"]["webSearch"]["enabled"].bool }
    var imageGenerationOn: Bool { settings["imageGeneration"]["enabled"].bool }
    var ultracodeOn: Bool { settings["ultracode"]["enabled"] == .null ? true : settings["ultracode"]["enabled"].bool }
    var temporaryMode: String { prefs["privacy"]["temporaryChats"].stringOrNil ?? "private" }
    var callMe: String { prefs["callMe"].string }
    var thinkingDefault: Bool { prefs["thinking"] == .null ? true : prefs["thinking"].bool }
    var sidebarGrouping: ChatGrouping { ChatGrouping(rawValue: prefs["sidebar"]["groupBy"].string) ?? .folder }
    var sidebarSorting: ChatSorting { ChatSorting(rawValue: prefs["sidebar"]["sortBy"].string) ?? .activity }
    var showEmptyGroups: Bool { prefs["sidebar"]["showEmptyGroups"].bool }
    var rememberLastModel: Bool { prefs["models"]["rememberLast"] == .null ? true : prefs["models"]["rememberLast"].bool }

    /// Image models that make pictures (not clips or sound), visible ones only.
    var pictureModels: [JSON] {
        imageModels.filter { !$0["hidden"].bool && ($0["kind"].string.isEmpty || $0["kind"].string == "image" || $0["kinds"].array.map(\.string).contains("image")) }
    }

    /// The model a new conversation in `mode` starts with: the person's own pick, the server's default, else the first.
    func defaultModel(mode: String, models: [JSON]) -> String {
        let usable = models.filter { !$0["hidden"].bool && $0["available"] != .bool(false) }
        let preferred = prefs["models"][mode == "code" ? "code" : "chat"].string
        if usable.contains(where: { $0["ref"].string == preferred }) { return preferred }
        let fallback = settings["models"]["defaults"][mode == "code" ? "code" : "chat"].string
        if usable.contains(where: { $0["ref"].string == fallback }) { return fallback }
        return (usable.first { $0["personal"] == .null } ?? usable.first)?["ref"].string ?? ""
    }

    // MARK: preferences

    /// Saves one preference, as the desktop does (`prefs.set`), and keeps the local copy.
    func setPref(_ path: [String], _ value: JSON) async {
        guard let store else { return }
        do {
            prefs = try await store.rpc.call("prefs.set", ["path": .array(path.map(JSON.string)), "value": value])
        } catch { /* A preference that did not save is not worth an alert: the choice still holds on this screen. */ }
    }

    // MARK: attachments

    var thumbnails: [String: UIImage] = [:]
    /// Files being uploaded right now, by name.
    var uploading: [String] = []
    /// Whether dictation has a speech service on this server (the microphone is hidden when it has none).
    var dictationOn = true

    // MARK: how long the connection has been missing

    /// 0: connecting, nothing to say yet (only the placeholder rows); 1: taking a while, a quiet line with Retry;
    /// 2: not connected, the banner that says so.
    var linkStage = 0
    /// Whether this run of the app has been connected: after that a lost connection is news sooner.
    private(set) var hasConnected = false

    /// Follows the connection: while it is missing, moves through the stages as the seconds pass. Cancelled and started
    /// again whenever the connection changes.
    func watchLink(connected: Bool) async {
        linkStage = 0
        if connected { hasConnected = true; return }
        do {
            try await Task.sleep(for: .seconds(hasConnected ? 3 : 5))
            if !hasConnected {
                linkStage = 1
                try await Task.sleep(for: .seconds(10))
            }
            linkStage = 2
        } catch { return }
    }
    /// Where the words the server hears while someone dictates are delivered (the dictation in progress sets it).
    @ObservationIgnored var dictationListener: ((JSON) -> Void)?

    func clearCaches() {
        thumbnails = [:]
        ChatBlobs.shared.clear()
        presence = [:]; typing = [:]; reactions = [:]; suggestion = [:]; limitWarning = [:]; toolInputs = [:]; stopReasons = [:]
        groups = []; listLoaded = false; listError = nil; shellLoaded = false
    }
}

// MARK: - Reactions

enum ChatReactions {
    static let all = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "🔥", "🚀"]

    static func applying(_ list: [JSON], participant: String, emoji: String, on: Bool) -> [JSON] {
        let others = (list.first { $0["emoji"].string == emoji }?["participants"].array ?? []).filter { $0.string != participant }
        let participants = on ? others + [.string(participant)] : others
        let rest = list.filter { $0["emoji"].string != emoji }
        return participants.isEmpty ? rest : rest + [.obj(["emoji": .string(emoji), "participants": .array(participants)])]
    }
}

// MARK: - Blobs (images, documents, clips and sounds the server keeps)

/// Fetches a file by its hash with the person's sign-in, once, and keeps it for as long as the app runs.
@MainActor final class ChatBlobs {
    static let shared = ChatBlobs()
    private let images = NSCache<NSString, UIImage>()
    private var running: [String: Task<URL, Error>] = [:]

    private var folder: URL {
        FileManager.default.temporaryDirectory.appending(path: "AtelierBlobs", directoryHint: .isDirectory)
    }

    nonisolated static func extensionFor(mime: String, name: String = "") -> String {
        let fromName = URL(fileURLWithPath: name).pathExtension
        if !fromName.isEmpty { return fromName }
        return UTType(mimeType: mime)?.preferredFilenameExtension ?? "bin"
    }

    func clear() {
        images.removeAllObjects()
        running.values.forEach { $0.cancel() }
        running = [:]
        try? FileManager.default.removeItem(at: folder)
    }

    /// The file for a blob (downloaded the first time).
    func file(sha: String, mime: String, name: String = "", server: String) async throws -> URL {
        guard sha.count == 64, sha.allSatisfy(\.isHexDigit) else { throw MobileError.message("This file's reference is not valid.") }
        let destination = folder.appending(path: sha).appendingPathExtension(Self.extensionFor(mime: mime, name: name))
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        if let task = running[sha] { return try await task.value }
        let task = Task<URL, Error> {
            let url = try serverURL(server)
            guard let token = CredentialStore.read(server) else { throw MobileError.message("Sign in to open this file.") }
            var request = URLRequest(url: url.appending(path: "api/blobs/\(sha)"))
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let (temporary, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw MobileError.message("This file is not available any more.") }
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)
            try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
            return destination
        }
        running[sha] = task
        defer { running[sha] = nil }
        return try await task.value
    }

    func image(sha: String, mime: String, server: String) async throws -> UIImage {
        if let cached = images.object(forKey: sha as NSString) { return cached }
        let url = try await file(sha: sha, mime: mime, server: server)
        guard let image = UIImage(contentsOfFile: url.path) else { throw MobileError.message("This picture could not be opened.") }
        images.setObject(image, forKey: sha as NSString)
        return image
    }

    func cachedImage(sha: String) -> UIImage? { images.object(forKey: sha as NSString) }

    #if DEBUG
    /// Demo screens show pictures without a server.
    func seed(sha: String, image: UIImage) { images.setObject(image, forKey: sha as NSString) }
    #endif
}

// MARK: - Remote actions

/// Every call the chat screens make on a conversation, in one place: each is a plain async function that throws the
/// server's own error, so a screen shows it with `store.attempt` and a test can run it against a real server.
@MainActor enum ChatActions {
    @discardableResult
    static func update(_ store: AppStore, _ id: String, _ patch: [String: JSON]) async throws -> JSON {
        var params = patch
        params["id"] = .string(id)
        return try await store.rpc.call("sessions.update", params)
    }

    static func rename(_ store: AppStore, _ id: String, to title: String) async throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await update(store, id, ["title": .string(String(trimmed.prefix(200)))])
    }

    static func setPinned(_ store: AppStore, _ id: String, _ pinned: Bool) async throws { try await update(store, id, ["pinned": .bool(pinned)]) }
    static func setArchived(_ store: AppStore, _ id: String, _ archived: Bool) async throws { try await update(store, id, ["archived": .bool(archived)]) }
    static func setUnread(_ store: AppStore, _ id: String) async throws { try await update(store, id, ["unread": .bool(true)]) }
    static func markSeen(_ store: AppStore, _ id: String) async throws { _ = try await store.rpc.call("sessions.markSeen", ["id": .string(id)]) }
    static func move(_ store: AppStore, _ id: String, toProject project: String?) async throws { try await update(store, id, ["projectId": project.map(JSON.string) ?? .null]) }
    static func move(_ store: AppStore, _ id: String, toGroup group: String?) async throws { try await update(store, id, ["groupId": group.map(JSON.string) ?? .null]) }

    static func fork(_ store: AppStore, _ id: String) async throws -> String {
        try await store.rpc.call("sessions.fork", ["id": .string(id)])["id"].string
    }

    static func delete(_ store: AppStore, _ id: String) async throws {
        _ = try await store.rpc.call("sessions.delete", ["id": .string(id)])
        store.sessions.removeAll { $0.id == id }
    }

    static func leaveCoop(_ store: AppStore, _ id: String) async throws {
        _ = try await store.rpc.call("coop.leave", ["sessionId": .string(id)])
        store.sessions.removeAll { $0.id == id }
    }

    static func createGroup(_ store: AppStore, _ hub: ChatHub, name: String) async throws -> JSON {
        let group = try await store.rpc.call("groups.create", ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))])
        if !hub.groups.contains(where: { $0["id"] == group["id"] }) { hub.groups.append(group) }
        return group
    }

    static func renameGroup(_ store: AppStore, _ hub: ChatHub, id: String, name: String) async throws {
        let group = try await store.rpc.call("groups.update", ["id": .string(id), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))])
        if let index = hub.groups.firstIndex(where: { $0["id"].string == id }) { hub.groups[index] = group }
    }

    static func collapseGroup(_ store: AppStore, _ hub: ChatHub, id: String, collapsed: Bool) async throws {
        if let index = hub.groups.firstIndex(where: { $0["id"].string == id }) { hub.groups[index] = hub.groups[index].setting("collapsed", .bool(collapsed)) }
        do {
            _ = try await store.rpc.call("groups.update", ["id": .string(id), "collapsed": .bool(collapsed)])
        } catch {
            if let index = hub.groups.firstIndex(where: { $0["id"].string == id }) { hub.groups[index] = hub.groups[index].setting("collapsed", .bool(!collapsed)) }
            throw error
        }
    }

    static func deleteGroup(_ store: AppStore, _ hub: ChatHub, id: String) async throws {
        _ = try await store.rpc.call("groups.delete", ["id": .string(id)])
        hub.groups.removeAll { $0["id"].string == id }
        try await store.refresh()
    }

    // conversation

    static func retry(_ store: AppStore, _ messageId: String) async throws { try await store.action("chat.retry", extra: ["messageId": .string(messageId)]) }
    static func stop(_ store: AppStore) async throws { try await store.action("chat.stop") }
    static func carryOn(_ store: AppStore) async throws { try await store.action("chat.continue") }

    /// The same question answered again by another model, as a new version of the reply.
    static func retry(_ store: AppStore, _ messageId: String, with model: String) async throws {
        guard let id = store.selected else { return }
        try await update(store, id, ["model": .string(model)])
        store.selectedModel = model
        try await retry(store, messageId)
    }

    static func edit(_ store: AppStore, messageId: String, parts: [JSON]) async throws {
        try await store.action("chat.edit", extra: ["messageId": .string(messageId), "parts": .array(parts)])
    }

    static func switchBranch(_ store: AppStore, to messageId: String) async throws {
        try await store.action("chat.switchBranch", extra: ["messageId": .string(messageId)])
        if let id = store.selected { try await store.open(id) }
    }

    static func react(_ store: AppStore, messageId: String, emoji: String, on: Bool) async throws {
        try await store.action("chat.react", extra: ["messageId": .string(messageId), "emoji": .string(emoji), "on": .bool(on)])
    }

    static func secondOpinion(_ store: AppStore, messageId: String, model: String) async throws {
        try await store.action("chat.secondOpinion", extra: ["messageId": .string(messageId), "model": .string(model)])
    }

    static func compact(_ store: AppStore, focus: String = "") async throws {
        var extra: [String: JSON] = [:]
        if !focus.isEmpty { extra["focus"] = .string(focus) }
        do { try await store.action("chat.compact", extra: extra) }
        catch {
            // The server answers "Internal error" when there is nothing yet to summarize.
            if error.localizedDescription == "Internal error" { throw MobileError.message("There is nothing to summarize yet.") }
            throw error
        }
    }

    static func sendNow(_ store: AppStore, id: String) async throws { try await store.action("chat.sendNow", extra: ["id": .string(id)]) }

    /// Takes a waiting message back: its text goes into the message box and its files become attachments again.
    static func takeBack(_ store: AppStore, id: String) async throws {
        guard let session = store.selected else { return }
        let result = try await store.rpc.call("chat.unqueue", ["sessionId": .string(session), "id": .string(id)])
        let parts = result["parts"].array
        let text = parts.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n")
        if !text.isEmpty { store.draft += (store.draft.isEmpty ? "" : "\n") + text }
        store.attachments += parts.filter { ["image", "document"].contains($0["type"].string) || ($0["type"].string == "context" && $0["notice"]["kind"].string == "quote") }
    }

    static func contextBreakdown(_ store: AppStore) async throws -> JSON {
        try await store.rpc.call("chat.contextBreakdown", ["sessionId": .string(store.selected ?? "")])
    }

    // side chats

    static func startSideChat(_ store: AppStore, question: String?) async throws -> String {
        var params: [String: JSON] = ["sessionId": .string(store.selected ?? "")]
        if let question, !question.isEmpty { params["question"] = .string(question) }
        return try await store.rpc.call("sideChats.start", params)["id"].string
    }

    static func sideChats(_ store: AppStore, of session: String) async throws -> [JSON] {
        try await store.rpc.call("sideChats.list", ["sessionId": .string(session)]).array
    }

    // loops

    static func runLoop(_ store: AppStore, args: String) async throws -> String {
        guard let session = store.selected else { return "" }
        switch ChatLoop.parse(args) {
        case .error(let message): throw MobileError.message(message)
        case .list: return "Loops run in the background. Stop them with /loop stop."
        case .stop(let target):
            let result = try await store.rpc.call("loops.stop", ["sessionId": .string(session), "target": target.map(JSON.string) ?? .null])
            let stopped = result["stopped"].int
            if stopped == 0 { throw MobileError.message(target == nil ? "This session has no loops running." : "There is no loop \"\(target ?? "")\" in this session.") }
            return stopped == 1 ? "Stopped the loop." : "Stopped \(stopped) loops."
        case .start(let interval, let prompt):
            let result = try await store.rpc.call("loops.start", ["sessionId": .string(session), "prompt": .string(prompt), "intervalMs": .number(Double(interval))])
            let given = result["intervalMs"].int
            return "Loop started: every \(ChatLoop.format(given))\(given > interval ? " (the shortest interval)" : "")"
        }
    }

    // projects

    static func createProject(_ store: AppStore, name: String, description: String) async throws -> JSON {
        let project = try await store.rpc.call("projects.create", ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines))])
        try? await store.refresh()
        return project
    }

    static func updateProject(_ store: AppStore, id: String, patch: [String: JSON]) async throws -> JSON {
        var params = patch
        params["id"] = .string(id)
        return try await store.rpc.call("projects.update", params)
    }

    static func deleteProject(_ store: AppStore, id: String) async throws {
        _ = try await store.rpc.call("projects.delete", ["id": .string(id)])
        try await store.refresh()
    }

    /// Uploads a file and adds it to the project; returns the stored file.
    static func addProjectFile(_ store: AppStore, projectId: String, data: Data, name: String, mime: String) async throws -> JSON {
        guard data.count <= 32 * 1024 * 1024 else { throw MobileError.message("\(name) is larger than 32 MB.") }
        let file = try await store.rpc.call("files.upload", ["name": .string(name), "mime": .string(mime), "dataBase64": .string(data.base64EncodedString())])
        return try await store.rpc.call("projects.addFile", ["projectId": .string(projectId), "fileId": file["id"]])
    }

    static func removeProjectFile(_ store: AppStore, projectId: String, fileId: String) async throws {
        _ = try await store.rpc.call("projects.removeFile", ["projectId": .string(projectId), "fileId": .string(fileId)])
    }
}
