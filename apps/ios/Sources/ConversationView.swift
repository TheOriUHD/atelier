import SwiftUI

/// The sheets a conversation opens.
enum ChatSheet: String, Identifiable {
    case usage, coop, sideChats, details
    var id: String { rawValue }
}

struct ConversationView: View {
    @Bindable var store: AppStore
    @State private var modelPicker = false
    @State private var showArtifacts = false
    @State private var sheet: ChatSheet?
    /// Whether the page follows the newest text. It stops when the person scrolls away and starts again when they are back at the end.
    @State private var follow = true
    @State private var nearBottom = true
    @State private var scrolling = false
    /// How far the keyboard reaches up from the bottom of the screen.
    @State private var keyboard: CGFloat = 0
    @State private var prompt = ChatSessionPrompt()
    @State private var wholeFile: JSON?
    @State private var editing: Turn?
    @State private var openingArtifact: JSON?
    @State private var lastTyping = Date.distantPast
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { ChatNav.session(store) }
    private var modelName: String { ChatModels.name(store.selectedModel, in: store.models) }
    private var running: Bool { ["running", "waiting"].contains(store.transcript.status) && ChatNav.loaded(store) }
    private var isEmpty: Bool { store.selected == nil || (store.transcript.messages.isEmpty && !running && store.transcript.pending == .null && store.transcript.snapshot["outbox"].array.isEmpty) }
    private var wide: Bool { sizeClass == .regular }
    private var coop: JSON { hub.coop[store.selected ?? ""] ?? .null }
    private var shared: Bool { session?.isShared == true || coop != .null }
    private var readOnly: String? {
        guard shared else { return nil }
        if coop["ended"].bool { return "Co-op ended. This conversation is read only." }
        if coop["role"].string == "viewer" { return "You are watching. Only editors can send messages." }
        return nil
    }

    var body: some View {
        // The room for the keyboard is made here, from where UIKit says the keyboard is, not by SwiftUI's own inset: that one
        // could stay behind after the system took the keyboard away, and could be a little short when it changed height.
        ZStack {
            Theme.background.ignoresSafeArea(.all)
            KeyboardProbe(height: $keyboard).frame(width: 0, height: 0).allowsHitTesting(false).accessibilityHidden(true)
            VStack(spacing: 0) {
                if !store.connected, hub.linkStage >= 2 || store.connectionNote != nil { offline }
                if let parent = hub.sideChatParent[store.selected ?? ""] { sideChatBar(parent) }
                content
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if !(isEmpty && wide) { bottom } }
            .padding(.bottom, keyboard)
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .environment(\.keyboardHeight, keyboard)
        .environment(\.chatServer, store.address)
        #if DEBUG
        .modifier(DebugMediaViewer())
        #endif
        .navigationTitle(store.selected == nil ? "" : (session?.displayTitle ?? "Atelier"))
        .navigationSubtitle(store.selected == nil ? "" : modelName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu { if let session, store.selected != nil { ChatSessionActions(store: store, session: session, prompt: prompt) { id in Task { await ChatNav.open(store, id) } } } }
        .toolbar { toolbar }
        .chatSessionPrompts(store: store, prompt: prompt) { id in if id == store.selected { ChatNav.newConversation(store) } }
        .modifier(ArtifactsPresenter(store: store, shown: $showArtifacts, regular: sizeClass == .regular))
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .usage: UsageView(store: store)
            case .coop: ChatCoopSheet(store: store)
            case .sideChats: ChatSideChatsSheet(store: store) { id in self.sheet = nil; Task { await ChatNav.open(store, id) } }
            case .details: CodeSessionDetailsSheet(store: store) { openArtifact($0) }
            }
        }
        .sheet(item: Binding(get: { wholeFile.map { ChatFileBox(preview: $0) } }, set: { if $0 == nil { wholeFile = nil } })) { ChatChangeSheet(preview: $0.preview, title: "The file", actions: nil) }
        .sheet(item: $editing) { ChatEditSheet(store: store, turn: $0) }
        .sheet(item: Binding(get: { openingArtifact.map { ChatFileBox(preview: $0) } }, set: { if $0 == nil { openingArtifact = nil } })) { ArtifactView(artifact: $0.preview, store: store) }
        .onChange(of: store.selected) { _, _ in follow = true }
        .onChange(of: store.draft) { _, _ in ping() }
        .task(id: store.selected) { if let id = store.selected, session?.isShared == true { await hub.loadCoop(id) } }
        .onAppear {
            #if DEBUG
            ChatDemo.prepare(store)
            if let route = Launch.route("conversation") {
                switch route {
                case "usage": sheet = .usage
                case "coop": sheet = .coop
                case "sidechats": sheet = .sideChats
                case "model": modelPicker = true
                case "temporary": hub.newOptions.temporary = true
                case "temporary-chat":
                    if let i = store.sessions.firstIndex(where: { $0.id == store.selected }), case .object(var raw) = store.sessions[i].raw {
                        raw["temporary"] = .string("private")
                        store.sessions[i] = Conversation(raw: .object(raw))
                    }
                case "artifacts": showArtifacts = true
                default: break
                }
            }
            #endif
        }
        .background {
            if running {
                Button("") { Task { try? await ChatActions.stop(store) } }.keyboardShortcut(".", modifiers: .command).opacity(0).accessibilityHidden(true)
                // Esc stops the reply, only while the box is empty.
                if store.draft.isEmpty { Button("") { Task { try? await ChatActions.stop(store) } }.keyboardShortcut(.escape, modifiers: []).opacity(0).accessibilityHidden(true) }
            }
        }
    }

    private struct ChatFileBox: Identifiable { let preview: JSON; let id = UUID() }

    // MARK: toolbar

    /// One button on the right, and one list behind it: everything for this conversation in a single step (several buttons
    /// side by side collapse into an overflow whose first row is another menu).
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if store.selected == nil {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.smooth(duration: 0.4)) { hub.newOptions.temporary.toggle() }
                } label: {
                    Image(systemName: "circle.dashed").font(.system(size: 17, weight: .medium)).frame(width: 22, height: 22)
                        .symbolEffect(.bounce, value: hub.newOptions.temporary)
                }
                .tint(hub.newOptions.temporary ? Theme.clay : Theme.inkSecondary).accessibilityLabel("Temporary chat").accessibilityValue(hub.newOptions.temporary ? "On" : "Off")
                .accessibilityHint("A temporary chat is deleted when you leave it")
            } else {
                Menu {
                    // A temporary chat has no banner: what matters about it is here, first.
                    if let session, session.isTemporary {
                        Button("Delete chat now", systemImage: "trash", role: .destructive) { deleteTemporaryNow() }
                        Button("Keep chat", systemImage: "tray.and.arrow.down") { keepTemporary() }
                        Divider()
                    }
                    Button("New conversation", systemImage: "square.and.pencil") { ChatNav.newConversation(store) }
                    if let session, !session.isTemporary, session.mode == "code" { Button("Session details", systemImage: "info.circle") { sheet = .details } }
                    Button("Context and usage", systemImage: "chart.pie") { sheet = .usage }
                    if !store.artifacts.isEmpty { Button("Artifacts (\(store.artifacts.count))", systemImage: "doc.on.doc") { showArtifacts = true } }
                    if let session, !session.isTemporary {
                        Button("Side chats", systemImage: "bubble.left.and.text.bubble.right") { sheet = .sideChats }
                        Button("Co-op", systemImage: "person.2") { sheet = .coop }
                        Button("Summarize the conversation", systemImage: "arrow.down.right.and.arrow.up.left") { Task { do { try await ChatActions.compact(store) } catch { store.error = ChatError.text(error) } } }
                        if !store.authStatus["local"].bool, !session.isGuest {
                            Toggle(isOn: Binding(get: { session.remoteControl && hub.prefs["remoteControl"] != .bool(false) }, set: { value in Task { do { try await ChatActions.update(store, session.id, ["remoteControl": .bool(value)]) } catch { store.error = ChatError.text(error) } } })) { Label(hub.prefs["remoteControl"] == .bool(false) ? "Remote control is off for your account" : "Remote control", systemImage: "antenna.radiowaves.left.and.right") }.disabled(hub.prefs["remoteControl"] == .bool(false))
                        }
                        if session.mode == "code" { CodeToolsMenu(store: store) }
                    }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Conversation actions")
            }
        }
    }

    // MARK: banners

    private var offline: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.slash")
            Text("Reconnecting. Your draft stays on this device.").font(.footnote)
            Spacer()
            Button("Retry") { store.perform { try await store.restore() } }.font(.footnote.weight(.semibold)).tint(Theme.clay)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.waiting.opacity(0.16))
        .foregroundStyle(Theme.ink)
        .accessibilityElement(children: .combine)
    }

    /// A side chat is a conversation of its own that was asked beside another: back to it, or close this one.
    private func sideChatBar(_ parent: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bubble.left.and.text.bubble.right")
            Text("Side chat").font(.subheadline.weight(.semibold))
            Spacer(minLength: 0)
            Button { Task { await ChatNav.open(store, parent) } } label: { Label(store.sessions.first { $0.id == parent }?.displayTitle ?? "Back", systemImage: "chevron.backward").font(.footnote.weight(.semibold)).lineLimit(1) }
            Button(role: .destructive) {
                guard let id = store.selected else { return }
                Task { do { try await ChatActions.delete(store, id); hub.sideChatParent[id] = nil; await ChatNav.open(store, parent) } catch { store.error = ChatError.text(error) } }
            } label: { Image(systemName: "xmark.bin") }.accessibilityLabel("Close side chat")
        }
        .tint(Theme.clay).padding(.horizontal, 16).padding(.vertical, 9).background(Theme.fill)
        .accessibilityElement(children: .contain)
    }

    // MARK: the page

    /// Which page the conversation area shows; a change between them is a fade, never a switch.
    private enum Page: Equatable { case failed, loading, starting, greeting, chat }
    private var page: Page {
        if hub.openError != nil, store.selected != nil, !ChatNav.loaded(store) { return .failed }
        // While a conversation is being started the first message stays on screen, so the greeting never comes back for a moment.
        if hub.starting != nil, isEmpty { return .starting }
        if !ChatNav.loaded(store) { return .loading }
        return isEmpty ? .greeting : .chat
    }

    @ViewBuilder private var content: some View {
        Group {
            switch page {
            case .failed:
                ScrollView { InlineError(message: hub.openError ?? "") { if let id = store.selected { Task { await ChatNav.open(store, id) } } }.padding(.top, 60) }.transition(.opacity)
            case .loading: ChatSkeleton().transition(.opacity)
            case .greeting: (wide ? AnyView(centeredStart) : AnyView(NewConversation(store: store))).transition(.opacity.combined(with: .scale(scale: 0.97)))
            // The first message is shown by the same view that shows the conversation, so when the conversation opens
            // nothing is replaced: the real message simply takes the place of the one that was waiting.
            case .starting, .chat: transcript.transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.4), value: page)
        .onChange(of: isEmpty) { _, empty in if !empty { hub.starting = nil } }
        .task(id: hub.starting?.id) {
            // If nothing came of it (the send failed), the greeting returns after a few seconds.
            guard hub.starting != nil else { return }
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { hub.starting = nil }
        }
    }

    private var transcript: some View {
        let branch = Branching.resolve(messages: store.transcript.messages, siblings: store.transcript.snapshot["siblings"])
        let turns = Turn.build(branch.messages, streamingMessageID: store.transcript.snapshot["streamingMessageId"].stringOrNil, stopReasons: hub.stopReasons)
        let snapshot = store.transcript.snapshot
        return ScrollViewReader { proxy in
            ScrollView {
                transcriptStack(laziness: turns.count > 60) {
                    if turns.isEmpty, let starting = hub.starting {
                        ChatStartingBubble(starting: starting, store: store)
                        ChatRunLine(snapshot: .null, lastIsAssistant: false, activity: nil)
                    }
                    ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                        TurnView(turn: turn, store: store, isLast: index == turns.count - 1, running: running, onEdit: { editing = $0 }, onOpenArtifact: { openArtifact($0) }, onViewEdit: { viewEdit($0) }, siblings: branch.siblings).id(turn.id)
                    }
                    if running { ChatRunLine(snapshot: snapshot, lastIsAssistant: turns.last?.role == .assistant, activity: activity(of: turns.last)).transition(.opacity) }
                    if store.transcript.pending != .null { InteractionView(store: store, pending: store.transcript.pending).id(store.transcript.pending["id"].string) }
                    ForEach(snapshot["outbox"].array, id: \.self) { item in ChatOutboxRow(store: store, item: item, coop: coop) }
                    if store.transcript.status == "interrupted" {
                        HStack(spacing: 12) {
                            Text("Atelier restarted and cut off this reply.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                            Button { Task { do { try await ChatActions.carryOn(store) } catch { store.error = ChatError.text(error) } } } label: { Label("Continue", systemImage: "arrow.clockwise") }.buttonStyle(.bordered).tint(Theme.clay)
                        }
                    }
                    if !store.artifacts.isEmpty { artifactsEntry }
                    // The end of the page is this, so the newest text always has room between it and the box.
                    Color.clear.frame(height: 24).id("bottom")
                }
                .frame(maxWidth: Theme.readingWidth, alignment: .leading)
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 16)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.top, for: .alignment)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .scrollEdgeEffectStyle(.hard, for: .top)
            .onScrollPhaseChange { _, phase in
                scrolling = phase == .interacting
                if phase == .interacting { follow = false } else if phase == .idle { follow = nearBottom }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 56
            } action: { _, atEnd in
                nearBottom = atEnd
                if atEnd, !scrolling { follow = true }
            }
            .onChange(of: store.transcript.seq) { _, _ in if follow { proxy.scrollTo("bottom", anchor: .bottom) } }
            .overlay(alignment: .bottom) {
                // Only when the page is really away from the end: touching or pulling it at the end does not call for it.
                if !follow, !nearBottom {
                    Button { follow = true; withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                        Image(systemName: "arrow.down").font(.system(size: 15, weight: .regular)).foregroundStyle(Theme.ink)
                            .frame(width: 38, height: 38)
                            .background(Theme.surface, in: Circle())
                            .overlay(Circle().stroke(Theme.hairline, lineWidth: 0.5))
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 12)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel(running ? "Scroll to the end, still working" : "Scroll to the end")
                }
            }
            .animation(.snappy, value: !follow && !nearBottom)
        }
    }

    @ViewBuilder private func transcriptStack<Content: View>(laziness lazy: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        if lazy { LazyVStack(alignment: .leading, spacing: 26) { content() } }
        else { VStack(alignment: .leading, spacing: 26) { content() } }
    }

    /// What the newest part of the running reply is doing, in a few words.
    private func activity(of turn: Turn?) -> String? {
        guard let turn, turn.role == .assistant, let last = turn.blocks.last else { return nil }
        switch last {
        case .thinking: return "Thinking"
        case .text: return "Writing"
        case .tools(_, let steps):
            guard let step = steps.last(where: { !$0.finished }) else { return nil }
            switch ToolInfo(step.call).kind {
            case .run: return "Running a command"
            case .read: return "Reading a file"
            case .edit: return "Changing a file"
            case .search: return "Searching"
            case .web: return step.name == "WebFetch" ? "Reading the web" : "Searching the web"
            case .agent: return "Running an agent"
            case .memory: return "Using memory"
            default: return step.name.hasPrefix("mcp__") ? "Using a connector" : "Working"
            }
        case .media(_, let step): return step.finished ? nil : (step.name == "GenerateVideo" ? "Making a clip" : step.name == "GenerateAudio" ? "Making a sound" : "Making a picture")
        case .artifact: return "Writing a document"
        default: return nil
        }
    }

    private var artifactsEntry: some View {
        Button { showArtifacts = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "doc.on.doc").foregroundStyle(Theme.clay)
                Text("\(store.artifacts.count) artifact\(store.artifacts.count == 1 ? "" : "s")").font(.subheadline.weight(.medium))
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            }
            .padding(.horizontal, 16).padding(.vertical, 14).card(radius: 16)
        }.buttonStyle(.plain)
    }

    /// On an iPad the new-conversation page is one group in the middle: the greeting, and the box right under it.
    private var centeredStart: some View {
        VStack(spacing: 30) {
            Spacer(minLength: 0)
            NewConversation(store: store, inline: true)
            HomeModePicker()
            bottom
            Spacer(minLength: 0)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: below the page

    private var bottom: some View {
        VStack(spacing: 10) {
            let snapshot = store.transcript.snapshot
            let todos = snapshot["todos"].array
            if store.selected != nil, !todos.isEmpty, todos.contains(where: { $0["status"].string != "completed" }) || running { TodosCard(todos: todos).transition(.move(edge: .bottom).combined(with: .opacity)) }
            limitBanner
            if coop["hostAway"].bool || hub.hostAway[store.selected ?? ""] == true {
                Label("The host's computer is away. What you send waits for it.", systemImage: "moon.zzz").font(.footnote).foregroundStyle(Theme.ink).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.waiting.opacity(0.16), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if let line = typingLine { Text(line).font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8) }
            if store.uncertainDelivery {
                VStack(alignment: .leading, spacing: 8) {
                    Label("The last message may not have arrived.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.ink)
                    Button("Check and send again") { store.perform { try await store.reconcileSend() } }.font(.footnote.weight(.semibold)).tint(Theme.clay)
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Theme.waiting.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            if store.draft.isEmpty, let suggestion = hub.suggestion[store.selected ?? ""] ?? snapshot["suggestion"].stringOrNil, !suggestion.isEmpty, !running {
                Button { store.draft = suggestion } label: {
                    HStack(spacing: 8) { Image(systemName: "sparkle").font(.system(size: 12)); Text(suggestion).font(.footnote).lineLimit(1) }.foregroundStyle(Theme.inkSecondary).padding(.horizontal, 14).padding(.vertical, 8).background(Theme.fill, in: Capsule())
                }.buttonStyle(.plain).accessibilityLabel("Suggested reply: \(suggestion)")
            }
            composer
        }
        .frame(maxWidth: Theme.readingWidth + 40)
        .padding(.horizontal, 12).padding(.bottom, 6)
        .frame(maxWidth: .infinity)
        .animation(.snappy, value: store.transcript.snapshot["todos"].array.count)
    }

    @ViewBuilder private var limitBanner: some View {
        let context = store.transcript.snapshot["context"]
        let warning = hub.limitWarning[store.selected ?? ""] ?? store.transcript.snapshot["limitWarning"]
        if warning != .null, !warning["message"].string.isEmpty {
            Button { sheet = .usage } label: {
                HStack(spacing: 8) {
                    Image(systemName: "gauge.with.dots.needle.67percent")
                    Text(warning["message"].string).font(.footnote.weight(.medium)).multilineTextAlignment(.leading)
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                }.foregroundStyle(Theme.ink).padding(.horizontal, 14).padding(.vertical, 9).glassEffect(.regular.tint(Theme.waiting.opacity(0.25)), in: .rect(cornerRadius: 18))
            }.buttonStyle(.plain)
        } else if context["limit"].int > 0, Double(context["used"].int) / Double(context["limit"].int) >= 0.8 {
            Button { sheet = .usage } label: {
                HStack(spacing: 8) {
                    Image(systemName: "gauge.with.dots.needle.67percent")
                    Text("This conversation is close to its limit").font(.footnote.weight(.medium))
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                }.foregroundStyle(Theme.ink).padding(.horizontal, 14).padding(.vertical, 9).glassEffect(.regular.tint(Theme.waiting.opacity(0.25)), in: .capsule)
            }.buttonStyle(.plain)
        }
    }

    private var typingLine: String? {
        guard shared, let id = store.selected else { return nil }
        let me = coop["me"].string
        let names = (hub.typing[id] ?? [:]).filter { $0.key != me && Date.now.timeIntervalSince($0.value) < 5 }.keys.compactMap { key in coop["participants"].array.first { $0["id"].string == key }?["name"].string }.sorted()
        switch names.count {
        case 0: return nil
        case 1: return "\(names[0]) is typing…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "\(names.count) people are typing…"
        }
    }

    private var composer: some View {
        ChatComposer(
            store: store, hub: hub, session: session, running: running,
            placeholder: store.project.flatMap { id in store.projects.first { $0["id"].string == id }?["name"].stringOrNil }.map { "New chat in \($0)" } ?? "Message Atelier",
            readOnly: readOnly,
            hooks: ChatSend.Hooks(newConversation: { ChatNav.newConversation(store, project: session?.projectID) }, openModelPicker: { modelPicker = true }, openSideChats: { sheet = .sideChats }, notify: { store.notify($0) }),
            onSent: { follow = true },
            modelPicker: $modelPicker
        )
    }

    // MARK: actions

    /// Deletes the temporary chat that is open, now, and leaves it for a new conversation.
    private func deleteTemporaryNow() {
        guard let id = store.selected else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        Task {
            do {
                try await ChatActions.delete(store, id)
                ChatNav.newConversation(store)
            } catch { store.error = ChatError.text(error) }
        }
    }

    /// Makes the temporary chat that is open an ordinary one.
    private func keepTemporary() {
        guard let id = store.selected else { return }
        Task {
            do {
                try await ChatActions.keep(store, id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                store.notify("Chat kept")
            } catch let MobileError.rpc(code, _, _, _) where code == -32601 {
                // A server from before this existed doesn't know the call.
                store.error = "This server needs to be updated before it can keep a temporary chat."
            } catch { store.error = ChatError.text(error) }
        }
    }

    private func openArtifact(_ summary: JSON) {
        Task {
            do { openingArtifact = try await store.rpc.call("artifacts.get", ["id": summary["id"]]) } catch { store.error = ChatError.text(error) }
        }
    }

    private func viewEdit(_ step: ToolStep) {
        Task {
            do { wholeFile = try await store.rpc.call("chat.editPreview", ["sessionId": .string(store.selected ?? ""), "callId": .string(step.id)]) } catch { store.error = ChatError.text(error) }
        }
    }

    /// Tells the others in a shared conversation that this person is typing, at most every two seconds.
    private func ping() {
        guard shared, coop["role"].string != "viewer", let id = store.selected, !store.draft.isEmpty, Date.now.timeIntervalSince(lastTyping) > 2 else { return }
        lastTyping = .now
        Task { _ = try? await store.rpc.call("coop.typing", ["sessionId": .string(id)]) }
    }
}

// MARK: - New conversation

/// The new-conversation page: a greeting, what to try, and the box below it.
struct NewConversation: View {
    let store: AppStore
    /// Without the spacers that centre it on its own: the caller places it.
    var inline = false
    @State private var starter: ChatStarter?
    @State private var naming = false
    @State private var projectName = ""
    private var hub: ChatHub { ChatHub.of(store) }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: .now)
        if hour < 5 { return "Hello, night owl" }
        let part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
        let name = (hub.callMe.isEmpty ? store.userName : hub.callMe).components(separatedBy: " ").first ?? ""
        return name.isEmpty ? part : "\(part), \(name)"
    }
    private var fewChats: Bool { store.sessions.filter { $0.mode == "chat" && !$0.archived }.count < 5 }
    private var temporary: Bool { hub.newOptions.temporary }
    /// A temporary chat belongs to no project.
    private var offersProject: Bool { !temporary }

    var body: some View {
        VStack(spacing: 18) {
            if !inline { Spacer() }
            ZStack {
                AtelierMark(size: 54).opacity(temporary ? 0 : 1).scaleEffect(temporary ? 0.8 : 1)
                Image(systemName: "circle.dashed").font(.system(size: 46, weight: .light)).foregroundStyle(Theme.inkSecondary).opacity(temporary ? 1 : 0).scaleEffect(temporary ? 1 : 1.2)
            }
            Text(temporary ? "You're in a temporary chat" : greeting).font(.system(.title, design: .serif, weight: .medium)).multilineTextAlignment(.center).foregroundStyle(Theme.ink).minimumScaleFactor(0.8)
                .contentTransition(.opacity)
            if temporary {
                Text(hub.temporaryMode == "fresh" ? "It stays out of your history, and starts fresh: no memory, personal instructions or projects. It is deleted when you leave it." : "It stays out of your history and memory, and is deleted when you leave it.")
                    .font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center).frame(maxWidth: 360)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if offersProject { projectChip.transition(.opacity) }
            if !temporary, fewChats { starters.transition(.opacity) }
            if !inline { Spacer(); Spacer() }
        }
        .animation(.smooth(duration: 0.4), value: temporary)
        .padding(inline ? 0 : 24).frame(maxWidth: .infinity)
        .alert("New project", isPresented: $naming) {
            TextField("Name", text: $projectName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = projectName
                Task { do { let project = try await ChatActions.createProject(store, name: name, description: ""); store.project = project["id"].string } catch { store.error = ChatError.text(error) } }
            }
        }
    }

    private var projectChip: some View {
        let current = store.project.flatMap { id in store.projects.first { $0["id"].string == id } }
        return Menu {
            Button { store.project = nil } label: { if current == nil { Label("No project", systemImage: "checkmark") } else { Text("No project") } }
            if !store.projects.isEmpty { Divider() }
            ForEach(store.projects, id: \.self) { project in
                Button { store.project = project["id"].string } label: { if project["id"].string == store.project { Label(project["name"].string, systemImage: "checkmark") } else { Text(project["name"].string) } }
            }
            Divider()
            Button("New project…", systemImage: "plus") { projectName = ""; naming = true }
        } label: {
            Label(current?["name"].string ?? "Project", systemImage: "folder").font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
                .padding(.horizontal, 14).padding(.vertical, 8).background(Theme.fill, in: Capsule())
        }.accessibilityLabel("Project: \(current?["name"].string ?? "none")")
    }

    private var starters: some View {
        VStack(spacing: 10) {
            if let starter {
                VStack(spacing: 0) {
                    HStack { Label(starter.title, systemImage: starter.symbol).font(.subheadline.weight(.medium)); Spacer(); Button { self.starter = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.inkMuted) }.buttonStyle(.plain).accessibilityLabel("Close") }.padding(14)
                    ForEach(starter.prompts, id: \.self) { prompt in
                        Divider().overlay(Theme.hairline)
                        Button { store.draft = prompt; self.starter = nil } label: { Text(prompt.trimmingCharacters(in: .whitespaces)).font(.subheadline).foregroundStyle(Theme.ink).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading).padding(14).contentShape(Rectangle()) }.buttonStyle(.plain)
                    }
                }.card(radius: 18).frame(maxWidth: 420)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(ChatStarter.all) { item in
                            Button { starter = item } label: { Label(item.title, systemImage: item.symbol).font(.subheadline).foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).padding(.vertical, 8).overlay(Capsule().stroke(Theme.hairline, lineWidth: 1)) }.buttonStyle(.plain)
                        }
                        Button { starter = ChatStarter(title: "Surprise me", symbol: "dice", prompts: Array(ChatStarter.surprises.shuffled().prefix(4))) } label: { Label("Surprise me", systemImage: "dice").font(.subheadline).foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).padding(.vertical, 8).overlay(Capsule().stroke(Theme.hairline, lineWidth: 1)) }.buttonStyle(.plain)
                    }.padding(.horizontal, 4)
                }.scrollBounceBehavior(.basedOnSize)
            }
        }.frame(maxWidth: 480).accessibilityElement(children: .contain)
    }
}

/// Ideas for people with few conversations: a category opens a few prompts, and picking one puts it in the box.
struct ChatStarter: Identifiable, Hashable {
    let title: String
    let symbol: String
    let prompts: [String]
    var id: String { title }

    static let all: [ChatStarter] = [
        ChatStarter(title: "Write", symbol: "pencil.line", prompts: ["Help me write a warm thank-you note to a colleague who covered for me", "Turn these rough notes into a clear project update: ", "Draft a short speaker bio for a talk about ", "Rewrite this paragraph so it reads more easily: "]),
        ChatStarter(title: "Learn", symbol: "graduationcap", prompts: ["Explain how vaccines teach the immune system, for someone curious but not a biologist", "What's the difference between weather and climate?", "Give me a ten-minute crash course on compound interest", "Quiz me on the basics of the French Revolution"]),
        ChatStarter(title: "Code", symbol: "chevron.left.forwardslash.chevron.right", prompts: ["Explain what this regular expression matches: ", "Write a Python script that renames photos by the date they were taken", "Help me understand this error message: ", "How should I structure a small REST API?"]),
        ChatStarter(title: "Life stuff", symbol: "cup.and.saucer", prompts: ["Plan a relaxed weekend in a city I've never been to", "Suggest a week of simple dinners made mostly from pantry staples", "Help me prepare for a difficult conversation with my landlord", "Make me a four-week running plan for a beginner"]),
    ]

    static let surprises = [
        "Invent a board game played with a deck of cards and a teaspoon",
        "Write a haiku from the point of view of a houseplant",
        "If octopuses built cities, what would their architecture look like?",
        "Tell the history of the sandwich as a dramatic movie trailer",
        "Design a holiday that celebrates something small and ordinary",
        "What would a weather report on Mars sound like today?",
        "Describe a color to someone who has never seen it",
        "Write a short, polite complaint letter from a cat to its owner",
    ]
}

// MARK: - Running, waiting, loading

/// "Working": three dots that rise in turn, under what the assistant has written so far.
struct Working: View {
    var body: some View {
        // Drawn from the clock, frame by frame: a value animated between two states would only fade between them.
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3) { index in
                    let wave = max(0, sin((time / 1.3 - Double(index) * 0.35) * 2 * .pi))
                    Circle().fill(Theme.inkMuted).frame(width: 6, height: 6)
                        .opacity(0.3 + 0.7 * wave).scaleEffect(0.8 + 0.3 * wave)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement().accessibilityLabel("The assistant is working")
    }
}

/// A small clock whose hands go round: for a request that is waiting its turn.
struct WaitingClock: View {
    @State private var spinning = false
    var body: some View {
        ZStack {
            Circle().stroke(Theme.inkMuted, lineWidth: 1.5)
            Capsule().fill(Theme.inkMuted).frame(width: 1.5, height: 5).offset(y: -2.5).rotationEffect(.degrees(spinning ? 360 : 0), anchor: .center)
                .animation(.linear(duration: 6).repeatForever(autoreverses: false), value: spinning)
            Capsule().fill(Theme.inkMuted).frame(width: 1.5, height: 3.5).offset(y: -1.75).rotationEffect(.degrees(spinning ? 360 * 12 : 0), anchor: .center)
                .animation(.linear(duration: 72).repeatForever(autoreverses: false), value: spinning)
        }
        .frame(width: 15, height: 15).padding(.vertical, 4)
        .onAppear { spinning = true }
        .accessibilityLabel("Waiting in line")
    }
}

/// The first message of a conversation that is being started, where it will be once the conversation has opened.
struct ChatStartingBubble: View {
    let starting: ChatStarting
    let store: AppStore

    /// Built exactly as a person's message in the transcript is (same stack, same widths, the same pictures), so when the real
    /// message takes its place nothing moves.
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(Array(starting.parts.enumerated()), id: \.offset) { _, part in
                AttachmentView(part: part, store: store, alignment: .trailing)
            }
            if !starting.text.isEmpty {
                Text(starting.text).font(.system(.body)).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(Theme.fill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        }
        .frame(maxWidth: 560, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 44)
        .accessibilityElement(children: .contain)
    }
}

/// What the run is doing now: waiting in line for a local model, compacting, loading a model, calling a tool or writing,
/// and for how long the turn has gone on.
struct ChatRunLine: View {
    let snapshot: JSON
    let lastIsAssistant: Bool
    /// What the newest part of the reply is ("Thinking", "Running a command"), when there is one.
    var activity: String?

    private var text: String? {
        if snapshot["queued"] != .null {
            let ahead = snapshot["queued"].int
            return ahead > 0 ? "Waiting in line for the model, \(ChatText.plural(ahead, "request")) ahead" : "Waiting for the model"
        }
        if snapshot["compacting"].bool { return "Compacting the conversation" }
        switch snapshot["phase"].string {
        case "loading": return "Loading the model"
        case "reading": return "Reading the conversation"
        case "waking": return "Waking the codespace"
        case "retrying": return "Connection interrupted. Retry \(max(1, snapshot["retryAttempt"].int)) of 10"
        case "quiet": return "Still working"
        case "thinking": return "Thinking"
        default: return activity
        }
    }

    private var since: Date? {
        let started = snapshot["runStartedAt"].double
        return started > 0 ? Date(timeIntervalSince1970: started / 1000) : nil
    }

    var body: some View {
        if text != nil || !lastIsAssistant {
            HStack(spacing: 8) {
                if snapshot["queued"] != .null { WaitingClock() } else { Working() }
                Text(text ?? "Working").font(.footnote).foregroundStyle(Theme.inkMuted)
                if let since {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(ChatText.elapsed(context.date.timeIntervalSince(since) * 1000)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.inkMuted)
                    }
                }
            }.accessibilityElement(children: .combine)
        } else { EmptyView() }
    }
}

/// A message sent while the agent works: it waits, joins at the agent's next step, and can be taken back or sent now.
struct ChatOutboxRow: View {
    let store: AppStore
    let item: JSON
    let coop: JSON
    private var parts: [JSON] { item["parts"].array }
    private var text: String { parts.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n") }
    private var files: Int { parts.filter { ["image", "document"].contains($0["type"].string) }.count }
    private var mine: Bool { coop == .null || (item["author"].string.isEmpty ? coop["participants"].array.first { $0["role"].string == "host" }?["id"].string ?? "" : item["author"].string) == coop["me"].string }
    private var author: String { coop["participants"].array.first { $0["id"].string == item["author"].string }?["name"].string ?? "" }

    private var status: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock").font(.system(size: 12)).foregroundStyle(Theme.inkMuted)
            Text(mine ? "Waiting for the next step" : "Waiting for \(author.isEmpty ? "their" : "\(author)'s") turn").font(.footnote).foregroundStyle(Theme.inkMuted)
        }
    }

    @ViewBuilder private var actions: some View {
        if mine {
            Button("Take back") { Task { do { try await ChatActions.takeBack(store, id: item["id"].string) } catch { store.error = ChatError.text(error) } } }.font(.footnote.weight(.semibold)).tint(Theme.clay)
            Button("Send now") { Task { do { try await ChatActions.sendNow(store, id: item["id"].string) } catch { store.error = ChatError.text(error) } } }.font(.footnote.weight(.semibold)).tint(Theme.clay)
        } else if coop["role"].string == "host" {
            Button("Remove") { Task { _ = try? await store.rpc.call("chat.unqueue", ["sessionId": .string(store.selected ?? ""), "id": item["id"]]) } }.font(.footnote.weight(.semibold)).tint(Theme.danger)
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if coop != .null, !author.isEmpty { ChatAuthorLabel(name: mine ? "You" : author) }
            VStack(alignment: .trailing, spacing: 4) {
                if !text.isEmpty { Text(text).font(.system(.body)).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.leading) }
                if files > 0 { Label(ChatText.plural(files, "file"), systemImage: "paperclip").font(.footnote).foregroundStyle(Theme.inkMuted) }
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { status.lineLimit(1); actions }
                VStack(alignment: .trailing, spacing: 6) { status; HStack(spacing: 16) { actions } }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 44)
        .accessibilityElement(children: .contain)
    }
}

/// A conversation on its way: shapes where the messages will be.
struct ChatSkeleton: View {
    @State private var on = false
    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            VStack(alignment: .trailing, spacing: 8) { bar(width: 220, height: 40, radius: 20).frame(maxWidth: .infinity, alignment: .trailing) }
            VStack(alignment: .leading, spacing: 10) { bar(width: 300, height: 14); bar(width: 260, height: 14); bar(width: 180, height: 14) }
            VStack(alignment: .trailing, spacing: 8) { bar(width: 160, height: 40, radius: 20).frame(maxWidth: .infinity, alignment: .trailing) }
            VStack(alignment: .leading, spacing: 10) { bar(width: 280, height: 14); bar(width: 310, height: 14); bar(width: 120, height: 14) }
            Spacer()
        }
        .padding(.horizontal, 20).padding(.top, 24).frame(maxWidth: Theme.readingWidth).frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(on ? 0.5 : 1).onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true } }
        .accessibilityElement(children: .ignore).accessibilityLabel("Loading the conversation")
    }
    private func bar(width: CGFloat, height: CGFloat, radius: CGFloat = 7) -> some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.fill).frame(width: width, height: height)
    }
}

extension JSON: Hashable {
    func hash(into hasher: inout Hasher) { hasher.combine(pretty) }
}

/// Artifacts open as a sheet on a phone and as a side panel on an iPad.
struct ArtifactsPresenter: ViewModifier {
    let store: AppStore
    @Binding var shown: Bool
    let regular: Bool
    func body(content: Content) -> some View {
        if regular {
            content.inspector(isPresented: $shown) { ArtifactList(store: store, embedded: true, close: { shown = false }).inspectorColumnWidth(min: 300, ideal: 400, max: 600) }
        } else {
            content.sheet(isPresented: $shown) { ArtifactList(store: store) }
        }
    }
}

#if DEBUG
/// `--open conversation/viewer`: the full-screen picture viewer on a generated picture, for trying the swipe away.
struct DebugMediaViewer: ViewModifier {
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .onAppear {
                if Launch.route("conversation") == "attachment" {
                    // A tall phone screenshot, as in the conversation that looked wrong.
                    let tall = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 1300)).image { context in
                        UIColor(red: 0.12, green: 0.14, blue: 0.2, alpha: 1).setFill()
                        context.fill(CGRect(x: 0, y: 0, width: 600, height: 1300))
                        UIColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).setFill()
                        context.fill(CGRect(x: 60, y: 200, width: 480, height: 600))
                    }
                    ChatBlobs.shared.seed(sha: String(repeating: "a", count: 64), image: tall)
                }
                guard Launch.route("conversation") == "viewer", !shown else { return }
                let picture = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 1200)).image { context in
                    let colors = [UIColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).cgColor, UIColor(red: 0.15, green: 0.2, blue: 0.4, alpha: 1).cgColor] as CFArray
                    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
                    context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 900, y: 1200), options: [])
                }
                ChatBlobs.shared.seed(sha: "demo-viewer", image: picture)
                shown = true
            }
            .fullScreenCover(isPresented: $shown) {
                MediaViewer(items: [["type": "image", "blob": "demo-viewer", "mime": "image/png", "name": "Photo.jpg"]], start: 0)
            }
    }
}
#endif
