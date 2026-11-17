import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// What a conversation that does not exist yet will start with: the choices made in the + menu and the page's controls.
@MainActor @Observable final class ChatNewOptions {
    var connectorsOff: [String] = []
    var research = false
    var imageModel = ""
    var temporary = false
    @ObservationIgnored weak var owner: ChatHub?

    func reset() {
        connectorsOff = []
        research = false
        imageModel = ""
        temporary = false
    }
}

extension ChatHub {
    /// The new-conversation page's choices (one set, kept by the hub so every screen that starts a conversation shares it).
    var newOptions: ChatNewOptions { ChatNewOptionsStore.options(for: self) }
}

@MainActor enum ChatNewOptionsStore {
    private static var all: [ObjectIdentifier: ChatNewOptions] = [:]
    static func options(for hub: ChatHub) -> ChatNewOptions {
        if let existing = all[ObjectIdentifier(hub)], existing.owner === hub { return existing }
        let options = ChatNewOptions()
        options.owner = hub
        all[ObjectIdentifier(hub)] = options
        return options
    }
}

/// Everything that happens when a message is sent: a command, a new conversation, a message to a running agent.
@MainActor enum ChatSend {
    /// The built-in `/` commands for this conversation.
    static func builtIns(session: Conversation?, mode: String) -> [ChatSlashCommand] {
        var list = [
            ChatSlashCommand(name: "clear", detail: mode == "code" ? "Start a new session" : "Start a new conversation"),
            ChatSlashCommand(name: "model", detail: "Choose the model"),
        ]
        if let session, !session.isTemporary {
            list.append(ChatSlashCommand(name: "btw", detail: "Ask a side question that doesn't join this conversation", hint: "[question]"))
            list.append(ChatSlashCommand(name: "compact", detail: "Summarize the conversation so far to free up context", hint: "[focus]"))
            if session.mode == "code" { list.append(ChatSlashCommand(name: "loop", detail: "Send a prompt now and again every interval while the session is idle", hint: "[interval] <prompt>")) }
        }
        return list
    }

    /// The commands the `/` menu offers: the built-ins, then the skills and commands the server lists.
    static func commands(session: Conversation?, mode: String, hub: ChatHub, folder: [JSON]? = nil) -> [ChatSlashCommand] {
        let builtIn = builtIns(session: session, mode: mode)
        let names = Set(builtIn.map(\.name))
        let extras = (folder ?? hub.slash).filter { !names.contains($0["name"].string) }.map {
            ChatSlashCommand(name: $0["name"].string, detail: $0["description"].string, hint: $0["argumentHint"].string, kind: $0["kind"].string == "skill" ? .skill : .command)
        }
        return builtIn + extras
    }

    struct Hooks {
        var newConversation: () -> Void
        var openModelPicker: () -> Void
        var openSideChats: () -> Void
        var notify: (String) -> Void
    }

    /// Sends the draft. Returns false when it was kept (nothing to send, offline, a command that needed a second look).
    @discardableResult
    static func submit(store: AppStore, hub: ChatHub, hooks: Hooks) async -> Bool {
        let text = store.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !store.attachments.isEmpty else { return false }
        guard store.connected else { store.error = "You're offline. Your draft is kept."; return false }
        if store.attachments.isEmpty, let command = ChatSlash.parse(text), let session = ChatNav.session(store) {
            let known = builtIns(session: session, mode: session.mode).first { $0.name == command.name }
            if let known { return await run(known, args: command.args, store: store, hooks: hooks) }
        } else if store.attachments.isEmpty, let command = ChatSlash.parse(text), store.selected == nil, ["clear", "model"].contains(command.name) {
            let known = builtIns(session: nil, mode: "chat").first { $0.name == command.name }
            if let known { return await run(known, args: command.args, store: store, hooks: hooks) }
        }
        do {
            if store.selected == nil { try await start(store: store, hub: hub) }
            try await store.send()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        } catch is CancellationError {
            return false
        } catch {
            store.error = ChatError.text(error)
            return false
        }
    }

    private static func run(_ command: ChatSlashCommand, args: String, store: AppStore, hooks: Hooks) async -> Bool {
        store.draft = ""
        store.saveDraft()
        switch command.name {
        case "clear": hooks.newConversation()
        case "model": hooks.openModelPicker()
        case "btw":
            if args.isEmpty { hooks.openSideChats(); return true }
            do { _ = try await ChatActions.startSideChat(store, question: args); hooks.openSideChats() } catch { store.error = ChatError.text(error) }
        case "compact":
            do { try await ChatActions.compact(store, focus: args) } catch { store.error = ChatError.text(error) }
        case "loop":
            do { hooks.notify(try await ChatActions.runLoop(store, args: args)) } catch { store.error = ChatError.text(error) }
        default: break
        }
        return true
    }

    /// Creates the conversation with the page's choices, and opens it with the draft and its files carried over.
    private static func start(store: AppStore, hub: ChatHub) async throws {
        let options = hub.newOptions
        var params: [String: JSON] = ["mode": .string("chat")]
        if !store.selectedModel.isEmpty { params["model"] = .string(store.selectedModel) }
        if !store.selectedEffort.isEmpty { params["effort"] = .string(store.selectedEffort) }
        if let project = store.project { params["projectId"] = .string(project) }
        if !options.connectorsOff.isEmpty { params["connectorsOff"] = .array(options.connectorsOff.map(JSON.string)) }
        if options.research { params["research"] = .bool(true) }
        if !options.imageModel.isEmpty { params["imageModel"] = .string(options.imageModel) }
        if options.temporary { params["temporary"] = .bool(true) }
        if hub.prefs != .null { params["thinking"] = .bool(hub.thinkingDefault) }
        store.busy = true
        defer { store.busy = false }
        let created = try await store.rpc.call("sessions.create", params)
        let text = store.draft
        let files = store.attachments
        // The page for a new conversation keeps no copy of what is now being sent.
        store.draft = ""
        store.attachments = []
        store.saveDraft()
        try await store.open(created["id"].string)
        store.draft = text
        store.attachments = files
        options.reset()
    }
}

/// The message box: the text, what is attached, and the controls under it.
struct ChatComposer: View {
    @Bindable var store: AppStore
    let hub: ChatHub
    let session: Conversation?
    let running: Bool
    var placeholder = "Message Atelier"
    var readOnly: String?
    var compactChips = false
    var hooks: ChatSend.Hooks
    var onSent: () -> Void = {}
    @Binding var modelPicker: Bool
    @State private var filePicker = false
    @State private var camera = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var photoPicker = false
    @State private var dictation = Dictation()
    @State private var transcribing = false
    @State private var sending = false
    /// Skills and commands of the Code session's folder (the server lists them per folder).
    @State private var folderSlash: [JSON]?
    @Environment(\.scenePhase) private var phase
    @FocusState private var focused: Bool

    private var mode: String { session?.mode ?? "chat" }
    private var current: JSON? { store.models.first { $0["ref"].string == store.selectedModel } }
    private var modelName: String { current?["displayName"].string ?? "" }
    private var empty: Bool { store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.attachments.isEmpty }
    private var slashQuery: String? { ChatSlash.menuQuery(store.draft) }
    private var mention: String? { mode == "code" && session != nil ? ChatSlash.mention(in: store.draft) : nil }
    private var commandMatches: [ChatSlashCommand] {
        guard let query = slashQuery else { return [] }
        return ChatSlash.filter(ChatSend.commands(session: session, mode: mode, hub: hub, folder: folderSlash), query: query)
    }
    private var effortLevels: [String] { ChatEffort.choices(current, mode: mode, ultracode: hub.ultracodeOn) }
    private var effortLabel: String? {
        guard effortLevels.count > 1, let shown = ChatEffort.shown(session.map { $0.effort.isEmpty ? nil : $0.effort } ?? (store.selectedEffort.isEmpty ? nil : store.selectedEffort), model: current, mode: mode, ultracode: hub.ultracodeOn) else { return nil }
        return ChatEffort.name(shown, model: current)
    }

    var body: some View {
        if let readOnly {
            Label(readOnly, systemImage: "eye").font(.subheadline).foregroundStyle(Theme.inkSecondary).frame(maxWidth: .infinity, alignment: .leading).padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24, style: .continuous))
        } else {
            VStack(spacing: 8) {
                if !commandMatches.isEmpty { slashMenu.transition(.move(edge: .bottom).combined(with: .opacity)) }
                if let mention { FileMentionList(store: store, query: mention) { path in store.draft = ChatSlash.replacingMention(in: store.draft, with: path) } }
                box
            }
            .animation(.snappy, value: commandMatches.count)
            .task(id: session?.workspaceID) {
                guard mode == "code", let folder = session?.workspaceID else { folderSlash = nil; return }
                folderSlash = (try? await store.rpc.call("slash.list", ["workspaceId": .string(folder)]))?.array
            }
        }
    }

    // MARK: the box

    private var box: some View {
        VStack(alignment: .leading, spacing: 4) {
            attachmentRow
            TextField(placeholder, text: $store.draft, axis: .vertical)
                .lineLimit(1...8).focused($focused).font(.system(.body))
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 4)
                .submitLabel(.send)
                .onKeyPress(.return, phases: .down) { press in
                    // A hardware keyboard: Return sends, Shift+Return and Option+Return start a new line.
                    if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
                    submit()
                    return .handled
                }
                .onChange(of: store.draft) { _, _ in store.saveDraft() }
                .accessibilityLabel("Message")
            controls
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 28, style: .continuous))
        .fullScreenCover(isPresented: $camera) { CameraView { data in upload(data, name: "Camera.jpg", mime: "image/jpeg") } }
        .fileImporter(isPresented: $filePicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): for url in urls { Task { await upload(url) } }
            case .failure(let error): store.error = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $photoPicker, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in loadPhotos(items) }
        .onChange(of: phase) { _, value in if value != .active { dictation.cancel() } }
        .onDisappear { dictation.cancel() }
        .dropDestination(for: URL.self) { urls, _ in
            for url in urls { Task { await upload(url) } }
            return !urls.isEmpty
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            plusMenu
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    modelChip
                    if let effortLabel { effortChip(effortLabel) }
                    if hub.webSearchOn, mode != "code", session?.research ?? hub.newOptions.research { researchChip }
                    if mode == "code", session != nil { PermissionModeChip(store: store) }
                }
            }.scrollBounceBehavior(.basedOnSize).mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.92), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
            Spacer(minLength: 0)
            if hub.dictationOn { micButton }
            sendButton
        }.padding(.horizontal, 10).padding(.bottom, 10).padding(.top, 2)
    }

    private var modelChip: some View {
        Button { modelPicker = true } label: {
            HStack(spacing: 5) {
                Text(modelName.isEmpty ? "Choose a model" : modelName).font(.subheadline.weight(.medium)).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.fill, in: Capsule())
        }.buttonStyle(.plain).hoverEffect(.highlight).accessibilityLabel("Model: \(modelName.isEmpty ? "none chosen" : modelName)").accessibilityHint("Opens the model list")
        .popover(isPresented: $modelPicker, arrowEdge: .bottom) {
            ModelPicker(store: store).frame(minWidth: 340, idealWidth: 380, minHeight: 420).presentationCompactAdaptation(.sheet)
        }
    }

    private func effortChip(_ label: String) -> some View {
        Button { modelPicker = true } label: {
            Text(label).font(.subheadline).foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.fill, in: Capsule())
        }.buttonStyle(.plain).hoverEffect(.highlight).accessibilityLabel("Effort: \(label)").accessibilityHint("Opens the effort settings")
    }

    private var researchChip: some View {
        Button { setResearch(false) } label: {
            HStack(spacing: 6) { Image(systemName: "binoculars").font(.system(size: 12)); Text("Research").font(.subheadline); Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                .foregroundStyle(Theme.clay).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.clay.opacity(0.12), in: Capsule())
        }.buttonStyle(.plain).accessibilityLabel("Research is on").accessibilityHint("Switches it off")
    }

    // MARK: the + menu

    private var plusMenu: some View {
        Menu {
            if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take a photo", systemImage: "camera") { camera = true } }
            Button("Photo library", systemImage: "photo") { photoPicker = true }
            Button("Choose a file", systemImage: "doc") { filePicker = true }
            let skills = (folderSlash ?? hub.slash).filter { $0["kind"].string == "skill" }
            if !skills.isEmpty {
                Menu {
                    ForEach(skills, id: \.self) { skill in Button { store.draft = "/\(skill["name"].string) " } label: { Text(skill["name"].string); Text(skill["description"].string) } }
                } label: { Label("Skills", systemImage: "text.book.closed") }
            }
            connectorsMenu
            if store.isAdmin { Button("Add plugins", systemImage: "puzzlepiece.extension") { openSettings(.plugins) } }
            if hub.webSearchOn, mode != "code" { researchToggle }
            if hub.imageGenerationOn, mode != "code", hub.pictureModels.count >= 2 {
                ImageModelMenu(store: store, hub: hub, current: session?.imageModel ?? hub.newOptions.imageModel) { ref in setImageModel(ref) }
            }
        } label: {
            Image(systemName: "plus").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.inkSecondary).frame(width: 36, height: 36).background(Theme.fill, in: Circle())
        }.hoverEffect(.highlight).accessibilityLabel("Add files and more")
    }

    @ViewBuilder private var connectorsMenu: some View {
        let list = hub.mcp
        if !list.isEmpty {
            let off = session?.connectorsOff ?? hub.newOptions.connectorsOff
            Menu {
                ForEach(list, id: \.self) { connector in
                    let name = connector["name"].string
                    let state = connector["state"].string
                    Toggle(isOn: Binding(get: { !off.contains(name) }, set: { setConnector(name, on: $0, off: off) })) {
                        Text(name)
                        if state == "error" { Text("Not connected") } else if state == "disabled" { Text("Switched off by an admin") }
                    }.disabled(state == "disabled")
                }
            } label: { Label("Connectors, \(list.count - off.filter { name in list.contains { $0["name"].string == name } }.count) on", systemImage: "powerplug") }
        }
    }

    private var researchToggle: some View {
        Toggle(isOn: Binding(get: { session?.research ?? hub.newOptions.research }, set: { setResearch($0) })) { Label("Research", systemImage: "binoculars") }
    }

    private func setConnector(_ name: String, on: Bool, off: [String]) {
        let next = on ? off.filter { $0 != name } : off + [name]
        guard let session else { hub.newOptions.connectorsOff = next; return }
        Task { do { try await ChatActions.update(store, session.id, ["connectorsOff": .array(next.map(JSON.string))]) } catch { store.error = ChatError.text(error) } }
    }

    private func setResearch(_ on: Bool) {
        guard let session else { hub.newOptions.research = on; return }
        Task { do { try await ChatActions.update(store, session.id, ["research": .bool(on)]) } catch { store.error = ChatError.text(error) } }
    }

    private func setImageModel(_ ref: String?) {
        guard let session else { hub.newOptions.imageModel = ref ?? ""; return }
        Task { do { try await ChatActions.update(store, session.id, ["imageModel": ref.map(JSON.string) ?? .null]) } catch { store.error = ChatError.text(error) } }
    }

    // MARK: send and stop

    private var stopping: Bool { running && empty }

    private var sendButton: some View {
        Button { if stopping { stop() } else { submit() } } label: {
            ZStack {
                Circle().fill(Theme.clay.opacity(!stopping && empty ? 0.35 : 1))
                if sending { ProgressView().tint(.white) }
                else { Image(systemName: stopping ? "stop.fill" : "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(.white) }
            }.frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .disabled(sending || (!stopping && (empty || !store.connected || store.uncertainDelivery)))
        .accessibilityLabel(stopping ? "Stop" : running ? "Send, it joins at the next step" : "Send")
    }

    private func submit() {
        guard !sending, !empty, !store.busy, store.connected, !store.uncertainDelivery else { return }
        sending = true
        Task {
            defer { sending = false }
            if await ChatSend.submit(store: store, hub: hub, hooks: hooks) { onSent() }
        }
    }

    private func stop() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            do {
                // What was waiting goes back into the box, as on the desktop.
                let waiting = store.transcript.snapshot["outbox"].array
                try await ChatActions.stop(store)
                for item in waiting {
                    let parts = item["parts"].array
                    let text = parts.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n")
                    if !text.isEmpty { store.draft += (store.draft.isEmpty ? "" : "\n") + text }
                    store.attachments += parts.filter { ["image", "document"].contains($0["type"].string) }
                }
            } catch { store.error = ChatError.text(error) }
        }
    }

    // MARK: dictation

    private var micButton: some View {
        Button { toggleDictation() } label: {
            ZStack {
                Circle().fill(dictation.recording ? Theme.danger : Theme.fill)
                if transcribing { ProgressView() }
                else { Image(systemName: dictation.recording ? "stop.fill" : "mic").font(.system(size: 15, weight: .medium)).foregroundStyle(dictation.recording ? .white : Theme.inkSecondary) }
            }.frame(width: 36, height: 36)
        }.buttonStyle(.plain).disabled(transcribing).accessibilityLabel(dictation.recording ? "Stop dictation" : "Dictate")
    }

    private func toggleDictation() {
        Task {
            do {
                if dictation.recording {
                    transcribing = true
                    defer { transcribing = false }
                    let text = try await dictation.finish(rpc: store.rpc)
                    store.draft += (store.draft.isEmpty || text.isEmpty ? "" : " ") + text
                } else { try await dictation.start() }
            } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
        }
    }

    // MARK: attachments

    @ViewBuilder private var attachmentRow: some View {
        if !store.attachments.isEmpty || !hub.uploading.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(store.attachments.enumerated()), id: \.offset) { index, attachment in
                        AttachmentChip(attachment: attachment, thumbnail: hub.thumbnails[attachment["blob"].string]) { store.attachments.remove(at: index) }
                    }
                    ForEach(hub.uploading, id: \.self) { name in
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text(name).font(.footnote).lineLimit(1) }.padding(.horizontal, 12).padding(.vertical, 9).background(Theme.fill, in: Capsule())
                    }
                }.padding(.horizontal, 14).padding(.top, 12)
            }
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        for item in items {
            Task {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { return }
                    let mime = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                    let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    await uploadData(data, name: "Photo.\(ext)", mime: mime)
                } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
            }
        }
    }

    private func upload(_ data: Data, name: String, mime: String) { Task { await uploadData(data, name: name, mime: mime) } }

    private func uploadData(_ data: Data, name: String, mime: String) async {
        hub.uploading.append(name)
        defer { hub.uploading.removeAll { $0 == name } }
        do {
            try await store.upload(data, name: name, mime: mime)
            if mime.hasPrefix("image/"), let blob = store.attachments.last?["blob"].string, let image = UIImage(data: data) { hub.thumbnails[blob] = image.preparingThumbnail(of: CGSize(width: 160, height: 160)) ?? image }
        } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
    }

    private func upload(_ url: URL) async {
        hub.uploading.append(url.lastPathComponent)
        defer { hub.uploading.removeAll { $0 == url.lastPathComponent } }
        do {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            try await store.upload(data, name: url.lastPathComponent, mime: mime)
            if mime.hasPrefix("image/"), let blob = store.attachments.last?["blob"].string, let image = UIImage(data: data) { hub.thumbnails[blob] = image.preparingThumbnail(of: CGSize(width: 160, height: 160)) ?? image }
        } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
    }

    // MARK: the / menu

    private var slashMenu: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(commandMatches.prefix(40).enumerated()), id: \.element.id) { index, command in
                    Button { pick(command) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: command.symbol).font(.system(size: 14)).foregroundStyle(Theme.inkSecondary).frame(width: 22)
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 6) { Text("/\(command.name)").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink); if !command.hint.isEmpty { Text(command.hint).font(.footnote).foregroundStyle(Theme.inkMuted) } }
                                if !command.detail.isEmpty { Text(command.detail).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2).multilineTextAlignment(.leading) }
                            }
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 14).padding(.vertical, 9).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if index < min(commandMatches.count, 40) - 1 { Divider().overlay(Theme.hairline).padding(.leading, 48) }
                }
            }
        }
        .frame(maxHeight: 280)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
        .accessibilityLabel("Commands")
    }

    private func pick(_ command: ChatSlashCommand) {
        if command.kind == .builtIn, command.hint.isEmpty {
            store.draft = "/\(command.name)"
            submit()
        } else {
            store.draft = "/\(command.name) "
            focused = true
        }
    }
}

/// An attached file in the box: a picture as its thumbnail, a document by its name, a quoted passage as a quote.
struct AttachmentChip: View {
    let attachment: JSON
    var thumbnail: UIImage?
    let remove: () -> Void
    @State private var preview: URL?
    @Environment(\.chatServer) private var server

    private var isQuote: Bool { attachment["type"].string == "context" }
    private var isImage: Bool { attachment["type"].string == "image" }

    var body: some View {
        Group {
            if isQuote {
                HStack(alignment: .top, spacing: 8) {
                    Capsule().fill(Theme.inkMuted.opacity(0.4)).frame(width: 2)
                    Text(attachment["notice"]["text"].string).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(3).frame(maxWidth: 190, alignment: .leading)
                }.padding(10).frame(maxHeight: 80).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if isImage {
                Group {
                    if let thumbnail { Image(uiImage: thumbnail).resizable().scaledToFill() }
                    else { BlobImage(blob: attachment["blob"].string, mime: attachment["mime"].string, maxHeight: 64, corner: 0, fill: true) }
                }.frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "doc").font(.footnote)
                    Text(attachment["name"].string).font(.footnote).lineLimit(1).frame(maxWidth: 150)
                }.padding(.horizontal, 12).frame(height: 40).background(Theme.fill, in: Capsule())
            }
        }
        .overlay(alignment: .topTrailing) {
            Button(action: remove) { Image(systemName: "xmark.circle.fill").font(.system(size: 18)).symbolRenderingMode(.palette).foregroundStyle(.white, Color.black.opacity(0.55)) }
                .buttonStyle(.plain).offset(x: 6, y: -6).accessibilityLabel(isQuote ? "Remove quote" : "Remove \(attachment["name"].string.isEmpty ? "attachment" : attachment["name"].string)")
        }
        .padding(.top, 6).padding(.trailing, 6)
        .onTapGesture { if !isQuote { open() } }
        .quickLookPreview($preview)
        .accessibilityAddTraits(isQuote ? [] : .isButton)
    }

    /// A tap shows the file as it will arrive.
    private func open() {
        Task { preview = try? await ChatBlobs.shared.file(sha: attachment["blob"].string, mime: attachment["mime"].string, name: attachment["name"].string, server: server) }
    }
}
