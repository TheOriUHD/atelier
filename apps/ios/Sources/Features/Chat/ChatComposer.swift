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
            if store.selected == nil {
                withAnimation(.smooth(duration: 0.4)) { hub.starting = ChatStarting(text: text, parts: store.attachments.map(ChatStarting.part(for:))) }
                try await start(store: store, hub: hub)
            }
            try await store.send()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        } catch is CancellationError {
            withAnimation(.smooth) { hub.starting = nil }
            return false
        } catch {
            withAnimation(.smooth) { hub.starting = nil }
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
    /// What was in the box when dictation began: the words heard are added after it.
    @State private var voiceBase = ""
    @State private var addSheet = false
    /// The effort panel is open: it covers the box, bottom edges together, until the person taps elsewhere.
    @State private var effortOpen = false
    @State private var afterAdd: ChatAddChoice?
    @State private var sending = false
    /// Send was tapped while files were still uploading: the message goes out by itself when they are done.
    @State private var waitingForUploads = false
    @State private var failuresAtTap = 0
    /// Skills and commands of the Code session's folder (the server lists them per folder).
    @State private var folderSlash: [JSON]?
    @Environment(\.scenePhase) private var phase
    @Environment(\.keyboardHeight) private var keyboardHeight
    @FocusState private var focused: Bool

    private var mode: String { session?.mode ?? "chat" }
    private var temporaryBox: Bool { session?.isTemporary == true || (session == nil && hub.newOptions.temporary) }
    private var current: JSON? { store.models.first { $0["ref"].string == store.selectedModel } }
    private var modelName: String { current?["displayName"].string ?? "" }
    private var empty: Bool { store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.attachments.isEmpty }
    private var uploading: Bool { !hub.uploading.isEmpty }
    /// Something to send now, or files on their way that a message can wait for.
    private var canSend: Bool { !empty || uploading }
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
            Label(readOnly, systemImage: "eye").font(.subheadline).foregroundStyle(Theme.inkSecondary).frame(maxWidth: .infinity, alignment: .leading).padding(16).raisedBox(radius: 24)
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
        composerBox
            .opacity(effortOpen ? 0 : 1)
            .allowsHitTesting(!effortOpen)
            .overlay(alignment: .bottom) {
                if effortOpen, let current {
                    EffortPanel(store: store, model: current, mode: mode)
                        .frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                        .raisedBox()
                        .background(alignment: .bottom) {
                            // Anywhere else on the screen closes it.
                            Color.black.opacity(0.18).frame(width: 3000, height: 3000)
                                .contentShape(Rectangle()).onTapGesture { effortOpen = false }
                                .accessibilityHidden(true)
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(.snappy(duration: 0.22), value: effortOpen)
            #if DEBUG
            .onReceive(NotificationCenter.default.publisher(for: .previewEffort)) { effortOpen = ($0.userInfo?["open"] as? Bool) ?? false }
            #endif
    }

    private var composerBox: some View {
        VStack(alignment: .leading, spacing: 4) {
            attachmentRow
            TextField(dictation.active ? "Listening…" : placeholder, text: $store.draft, axis: .vertical)
                .lineLimit(1...8).focused($focused).font(.system(.body))
                .allowsHitTesting(!dictation.active)
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 4)
                .submitLabel(.send)
                .onKeyPress(.return, phases: .down) { press in
                    // A hardware keyboard: Return sends, Shift+Return and Option+Return start a new line.
                    if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
                    sendTapped()
                    return .handled
                }
                .onChange(of: store.draft) { _, _ in store.saveDraft() }
                .accessibilityLabel("Message")
            if dictation.active { voiceControls.transition(.opacity) } else { controls.transition(.opacity) }
        }
        .animation(.snappy(duration: 0.2), value: dictation.active)
        .raisedBox()
        // A temporary chat's box has a dashed edge, like the icon that switches it on.
        .overlay {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Theme.inkMuted.opacity(0.6), style: StrokeStyle(lineWidth: 1.4, dash: [6, 5]))
                .opacity(temporaryBox ? 1 : 0).allowsHitTesting(false)
        }
        .animation(.smooth(duration: 0.4), value: temporaryBox)
        .sheet(isPresented: $addSheet, onDismiss: runAfterAdd) {
            ChatAddSheet(store: store, hub: hub, mode: mode, folderSlash: folderSlash, choose: { afterAdd = $0 }, upload: { data, name, mime in await uploadData(data, name: name, mime: mime) })
        }
        .fullScreenCover(isPresented: $camera) { CameraView { data in upload(data, name: "Camera.jpg", mime: "image/jpeg") } }
        .fileImporter(isPresented: $filePicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): for url in urls { Task { await upload(url) } }
            case .failure(let error): store.error = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $photoPicker, selection: $photos, maxSelectionCount: 20, matching: .images)
        .onChange(of: photos) { _, items in loadPhotos(items) }
        .onChange(of: phase) { _, value in if value != .active { cancelDictation() } }
        .onChange(of: dictation.heard) { _, words in if dictation.active { store.draft = Self.join(voiceBase, words) } }
        .onAppear {
            dictation.onFailure = { message in store.draft = voiceBase; store.error = message }
            #if DEBUG
            switch Launch.route("conversation") {
            case "add", "add-large", "add-plugins": addSheet = true
            case "voice": voiceBase = ""; dictation.demo(words: "Hello, this is an example voice")
            case "listening": voiceBase = ""; dictation.demo(words: "")
            case "effort": Task { try? await Task.sleep(for: .seconds(1)); effortOpen = true }
            case "uploading":
                let picture = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 160)).image { context in
                    let colors = [UIColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).cgColor, UIColor(red: 0.2, green: 0.25, blue: 0.4, alpha: 1).cgColor] as CFArray
                    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
                    context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 160, y: 160), options: [])
                }
                hub.uploading = [ChatUpload(name: "Photo.jpg", thumbnail: picture, bytes: 9_000_000), ChatUpload(name: "Report.pdf", thumbnail: nil, bytes: 4_000_000)]
            default: break
            }
            #endif
        }
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
                    if let effortLabel, let current { EffortChip(label: effortLabel) { focused = false; effortOpen = true } }
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

    private var researchChip: some View {
        Button { setResearch(false) } label: {
            HStack(spacing: 6) { Image(systemName: "binoculars").font(.system(size: 12)); Text("Research").font(.subheadline); Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                .foregroundStyle(Theme.clay).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.clay.opacity(0.12), in: Capsule())
        }.buttonStyle(.plain).accessibilityLabel("Research is on").accessibilityHint("Switches it off")
    }

    // MARK: the + menu

    private var plusMenu: some View {
        Button { focused = false; addSheet = true } label: {
            Image(systemName: "plus").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.inkSecondary).frame(width: 36, height: 36).background(Theme.fill, in: Circle())
        }.buttonStyle(.plain).hoverEffect(.highlight).accessibilityLabel("Add files and more")
    }

    /// What the + sheet asked for that needs the screen to itself (the camera, the file list, the photo library).
    private func runAfterAdd() {
        guard let choice = afterAdd else { return }
        afterAdd = nil
        switch choice {
        case .camera: camera = true
        case .files: filePicker = true
        case .photos: photoPicker = true
        }
    }

    private func setResearch(_ on: Bool) {
        guard let session else { hub.newOptions.research = on; return }
        Task { do { try await ChatActions.update(store, session.id, ["research": .bool(on)]) } catch { store.error = ChatError.text(error) } }
    }

    // MARK: send and stop

    private var stopping: Bool { running && empty && !uploading && !waitingForUploads }

    private var sendButton: some View {
        Button { sendTapped() } label: {
            ZStack {
                Circle().fill(waitingForUploads ? Theme.fillStrong : Theme.clay.opacity(!stopping && !canSend ? 0.35 : 1))
                if waitingForUploads { ProgressView().tint(Theme.inkSecondary) }
                else if sending { ProgressView().tint(.white) }
                else { Image(systemName: stopping ? "stop.fill" : "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(.white) }
            }.frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .disabled(sending || (!stopping && !waitingForUploads && (!canSend || !store.connected || store.uncertainDelivery)))
        .animation(.smooth(duration: 0.2), value: waitingForUploads)
        .accessibilityLabel(waitingForUploads ? "Sends when the upload is done. Tap to cancel" : stopping ? "Stop" : running ? "Send, it joins at the next step" : "Send")
        .onChange(of: hub.uploading.isEmpty) { _, none in
            guard none, waitingForUploads else { return }
            waitingForUploads = false
            // A file that failed is not sent without: the message stays in the box for the person to look at.
            if hub.uploadFailures == failuresAtTap { submit() }
        }
    }

    /// The button and the Return key: send now, or, with files still uploading, send as soon as they are done.
    private func sendTapped() {
        if waitingForUploads { waitingForUploads = false; return }
        if stopping { stop(); return }
        if uploading {
            guard store.connected, !store.uncertainDelivery else { return }
            failuresAtTap = hub.uploadFailures
            waitingForUploads = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return
        }
        submit()
    }

    private func submit() {
        guard !sending, !empty, !store.busy, store.connected, !store.uncertainDelivery else { return }
        sending = true
        // The on-screen keyboard goes down with the message (and the box with it); a hardware keyboard keeps its place.
        if keyboardHeight > 0 { focused = false }
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
        Button { startDictation() } label: {
            Image(systemName: "mic").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.inkSecondary).frame(width: 36, height: 36).background(Theme.fill, in: Circle())
        }.buttonStyle(.plain).disabled(dictation.phase == .starting).accessibilityLabel("Dictate")
    }

    /// While someone speaks the controls give way to the sound: cancel, the waveform, stop (keep the words to edit), send.
    private var voiceControls: some View {
        let finishing = dictation.phase == .finishing
        return HStack(spacing: 10) {
            Button { cancelDictation() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink).frame(width: 36, height: 36).background(Theme.fill, in: Circle())
            }.buttonStyle(.plain).disabled(finishing).accessibilityLabel("Cancel dictation")
            VoiceWave(levels: dictation.levels).frame(height: 36).frame(maxWidth: .infinity)
            Button { finishDictation(send: false) } label: {
                ZStack {
                    Circle().fill(Theme.fill)
                    if finishing { ProgressView() } else { Image(systemName: "stop.fill").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink) }
                }.frame(width: 36, height: 36)
            }.buttonStyle(.plain).disabled(finishing).accessibilityLabel("Stop dictation and keep the words")
            Button { finishDictation(send: true) } label: {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(.white).frame(width: 36, height: 36).background(Theme.clay, in: Circle())
            }.buttonStyle(.plain).disabled(finishing || !store.connected).accessibilityLabel("Stop dictation and send")
        }.padding(.horizontal, 10).padding(.bottom, 10).padding(.top, 2)
    }

    private func startDictation() {
        focused = false
        voiceBase = store.draft
        Task {
            do { try await dictation.start(rpc: store.rpc, hub: hub) } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
        }
    }

    private func cancelDictation() {
        guard dictation.active else { return }
        dictation.cancel()
        store.draft = voiceBase
    }

    private func finishDictation(send: Bool) {
        Task {
            do {
                let words = try await dictation.finish()
                store.draft = Self.join(voiceBase, words)
                if send { submit() }
            } catch is CancellationError { return } catch {
                // What was heard stays in the box.
                store.error = ChatError.text(error)
            }
        }
    }

    /// The words after what was already typed, with one space between.
    static func join(_ base: String, _ words: String) -> String {
        let spoken = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return base }
        guard let last = base.last else { return spoken }
        return last.isWhitespace ? base + spoken : base + " " + spoken
    }

    // MARK: attachments

    @ViewBuilder private var attachmentRow: some View {
        if !store.attachments.isEmpty || !hub.uploading.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(store.attachments.enumerated()), id: \.offset) { index, attachment in
                        AttachmentChip(attachment: attachment, thumbnail: hub.thumbnails[attachment["blob"].string]) { store.attachments.remove(at: index) }
                    }
                    ForEach(hub.uploading) { upload in UploadingChip(upload: upload).transition(.opacity.combined(with: .scale(scale: 0.9))) }
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
                    guard let file = try await ChatPhotoFile.load(item) else { store.error = "That photo's format isn't supported."; return }
                    await uploadData(file.data, name: file.name, mime: file.mime)
                } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
            }
        }
    }

    private func upload(_ data: Data, name: String, mime: String) { Task { await uploadData(data, name: name, mime: mime) } }

    private func uploadData(_ original: Data, name originalName: String, mime originalMime: String) async {
        var data = original, name = originalName, mime = originalMime
        // A big picture (a camera photo, an image from Files) is scaled down first: it has to cross the network in one piece.
        if mime.hasPrefix("image/"), let prepared = ChatPhotoFile.prepare(original), prepared.data.count < original.count {
            data = prepared.data
            mime = prepared.mime
            name = (originalName as NSString).deletingPathExtension + (mime == "image/png" ? ".png" : ".jpg")
        }
        let picture = mime.hasPrefix("image/") ? UIImage(data: data) : nil
        // The message shows the picture from this copy until the full one has come back from the server.
        let preview = picture.flatMap { $0.preparingThumbnail(of: CGSize(width: 720, height: 720)) ?? $0 }
        let thumbnail = preview.flatMap { $0.preparingThumbnail(of: CGSize(width: 160, height: 160)) ?? $0 }
        await send(data, name: name, mime: mime, thumbnail: thumbnail, preview: preview)
    }

    private func upload(_ url: URL) async {
        do {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            await uploadData(data, name: url.lastPathComponent, mime: mime)
        } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
    }

    /// Adds the file to the message: it shows at once with its progress, and is replaced by the attached file when done.
    private func send(_ data: Data, name: String, mime: String, thumbnail: UIImage?, preview: UIImage? = nil) async {
        let item = ChatUpload(name: name, thumbnail: thumbnail, bytes: data.count)
        withAnimation(.smooth(duration: 0.25)) { hub.uploading.append(item) }
        do {
            let file = try await store.uploadFile(data, name: name, mime: mime)
            if let index = hub.uploading.firstIndex(where: { $0.id == item.id }) { hub.uploading[index].finished = true }
            try? await Task.sleep(for: .milliseconds(220))
            // The ring has filled: the attached file takes the place of the one on its way, in one step, so the two are never both there.
            if let thumbnail { hub.thumbnails[file["blob"].string] = thumbnail }
            if let preview { ChatBlobs.shared.setPreview(preview, sha: file["blob"].string) }
            var swap = Transaction(animation: nil)
            swap.disablesAnimations = true
            withTransaction(swap) {
                store.attachments.append(file)
                hub.uploading.removeAll { $0.id == item.id }
            }
        } catch is CancellationError {
            hub.uploading.removeAll { $0.id == item.id }
        } catch {
            hub.uploadFailures += 1
            store.error = ChatError.text(error)
            withAnimation(.smooth(duration: 0.25)) { hub.uploading.removeAll { $0.id == item.id } }
        }
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
    @State private var viewing = false
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
        .onTapGesture { if isImage { viewing = true } else if !isQuote { open() } }
        .quickLookPreview($preview)
        .fullScreenCover(isPresented: $viewing) { MediaViewer(items: [attachment], start: 0).environment(\.chatServer, server) }
        .accessibilityAddTraits(isQuote ? [] : .isButton)
    }

    /// A tap shows the file as it will arrive.
    private func open() {
        Task { preview = try? await ChatBlobs.shared.file(sha: attachment["blob"].string, mime: attachment["mime"].string, name: attachment["name"].string, server: server) }
    }
}

/// A file on its way, as it will look once attached; a picture shows its preview with a ring that fills as it goes.
struct UploadingChip: View {
    let upload: ChatUpload

    var body: some View {
        Group {
            if let thumbnail = upload.thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill().frame(width: 64, height: 64)
                    .overlay(Color.black.opacity(0.38))
                    .overlay { UploadRing(upload: upload, size: 26) }
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else {
                HStack(spacing: 8) {
                    UploadRing(upload: upload, size: 18, onDark: false)
                    Text(upload.name).font(.footnote).lineLimit(1).frame(maxWidth: 150)
                }.padding(.horizontal, 12).frame(height: 40).background(Theme.fill, in: Capsule())
            }
        }
        .padding(.top, 6).padding(.trailing, 6)
        .accessibilityElement(children: .ignore).accessibilityLabel("Uploading \(upload.name)")
    }
}

/// A circle that fills clockwise as the upload goes on.
struct UploadRing: View {
    let upload: ChatUpload
    let size: CGFloat
    var onDark = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: upload.finished)) { context in
            let progress = upload.progress(at: context.date)
            let tint: Color = onDark ? .white : Theme.clay
            ZStack {
                Circle().stroke(tint.opacity(0.3), lineWidth: size * 0.12)
                Circle().trim(from: 0, to: max(0.02, progress)).stroke(tint, style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: size, height: size)
            .animation(.smooth(duration: 0.25), value: upload.finished)
        }
    }
}
