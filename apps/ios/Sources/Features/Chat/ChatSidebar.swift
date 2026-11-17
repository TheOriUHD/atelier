import SwiftUI

/// Where the detail column is: a conversation, or one of the pages the sidebar leads to.
enum ChatRoute: Hashable {
    case conversation, projects, artifacts, images, archived, newCode
}

/// What the sidebar asks the screen around it to do.
struct ChatSidebarActions {
    var open: (String) -> Void
    var compose: () -> Void
    var show: (ChatRoute) -> Void
    var settings: () -> Void
    var openProject: (String) -> Void
}

/// The conversation list: pinned things, then the person's conversations grouped by day, by their own groups, by folder
/// or by status; search across titles and message text; the pages that hold projects, artifacts and pictures.
struct ChatSidebar: View {
    @Bindable var store: AppStore
    @Binding var mode: HomeMode
    let actions: ChatSidebarActions
    /// What the detail column shows next to the list. The open conversation is marked in the list only when it is on
    /// screen beside it: on a phone the list is the whole screen, so nothing is "open" there.
    var route: ChatRoute = .conversation
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("chat.grouping") private var chatGrouping = ChatGrouping.date.rawValue
    @AppStorage("chat.sorting") private var chatSorting = ChatSorting.activity.rawValue
    @State private var search = ""
    @State private var searching = false
    @State private var prompt = ChatSessionPrompt()
    @State private var groupPrompt = ChatGroupPrompt()
    @State private var managing = false
    @State private var joining = false
    @State private var results = ChatSearchModel()
    /// The computers linked to this server (Code mode shows them above the sessions).
    @State private var devices: [JSON] = []
    /// How far the list is pulled down past its top, and whether that is far enough to open search on letting go.
    @State private var pull: CGFloat = 0
    @State private var pullArmed = false
    @State private var touching = false
    private let pullThreshold: CGFloat = 54
    private var hub: ChatHub { ChatHub.of(store) }

    private var visible: [Conversation] {
        store.sessions.filter { ($0.mode == "code") == (mode == .code) && !$0.archived && !$0.isTemporary }
    }
    private var grouping: ChatGrouping {
        if mode == .code { return hub.sidebarGrouping }
        let value = ChatGrouping(rawValue: chatGrouping) ?? .date
        return [.date, .custom, .state, .none].contains(value) ? value : .date
    }
    private var sorting: ChatSorting { mode == .code ? hub.sidebarSorting : (ChatSorting(rawValue: chatSorting) ?? .activity) }
    private var arranged: (pinned: [Conversation], groups: [ChatListGroup]) {
        ChatArrange.arrange(visible, grouping: grouping, sorting: sorting, groups: hub.groups, workspaces: hub.workspaces, showEmptyGroups: hub.showEmptyGroups)
    }
    private var pinnedProjects: [JSON] { mode == .chat ? store.projects.filter { $0["pinnedAt"] != .null } : [] }
    private var isSearching: Bool { !search.trimmingCharacters(in: .whitespaces).isEmpty }
    private var loading: Bool { !hub.listLoaded && store.sessions.isEmpty }

    var body: some View {
        List {
            if !store.connected { banner(store.connectionNote ?? "Reconnecting. Your draft stays on this device.", symbol: "wifi.slash", action: "Retry") { store.perform { try await store.restore() } } }
            if let error = hub.listError { banner(error, symbol: "exclamationmark.triangle", action: "Try again") { Task { await hub.reloadAll() } } }
            if isSearching { searchRows } else if searching { recentRows } else { browseRows }
        }
        .listStyle(.plain)
        .listSectionSpacing(0)
        .environment(\.defaultMinListRowHeight, 1)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .overlay { overlay }
        .task(id: "\(store.connected)\(mode.rawValue)") {
            guard store.connected, mode == .code else { return }
            let all = (try? await store.rpc.call("account.devices"))?.array ?? []
            devices = all.filter { !$0["current"].bool && $0["platform"].string != "ios" }
        }
        .searchable(text: $search, isPresented: $searching, prompt: mode == .code ? "Search sessions" : "Search conversations")
        .navigationTitle("Atelier")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in max(0, -(geometry.contentOffset.y + geometry.contentInsets.top)) } action: { _, distance in
            pull = distance
            let armed = distance >= pullThreshold
            if armed != pullArmed {
                pullArmed = armed
                if armed, touching { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
            }
        }
        .onScrollPhaseChange { _, phase in
            let wasTouching = touching
            touching = phase == .interacting
            // Letting go while the ring is full opens search (and reads the list again, as pulling used to).
            if wasTouching, !touching, pullArmed, !searching {
                searching = true
                Task { await hub.reloadAll() }
            }
        }
        .overlay(alignment: .top) { pullIndicator }
        .chatSessionPrompts(store: store, prompt: prompt) { id in if id == store.selected { ChatNav.newConversation(store) } }
        .modifier(ChatGroupPrompts(store: store, prompt: groupPrompt))
        .sheet(isPresented: $managing) { ChatGroupsSheet(store: store, hub: hub) }
        .sheet(isPresented: $joining) { ChatJoinCoopSheet(store: store) { actions.open($0) } }
        .onChange(of: search) { _, value in results.schedule(value, store: store, mode: mode) }
        .onChange(of: mode) { _, _ in if isSearching { results.schedule(search, store: store, mode: mode) } }
        .onReceive(NotificationCenter.default.publisher(for: .atelierSearch)) { _ in searching = true }
        .background { Button("") { searching = true }.keyboardShortcut("k", modifiers: .command).opacity(0).accessibilityHidden(true) }
        .onAppear {
            #if DEBUG
            if let route = Launch.route("home") {
                switch route {
                case "search": search = "plan"; searching = true
                case "recents": searching = true
                case "groups": managing = true
                default: break
                }
            }
            #endif
        }
    }

    /// The search button that fills with a ring as the list is pulled down; full, it clicks, and letting go opens search.
    @ViewBuilder private var pullIndicator: some View {
        if pull > 6, !searching {
            let progress = min(pull / pullThreshold, 1)
            ZStack {
                Circle().fill(Theme.surface)
                Circle().stroke(Theme.hairline, lineWidth: 3)
                Circle().trim(from: 0, to: progress).stroke(Theme.clay, style: StrokeStyle(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(pullArmed ? Theme.clay : Theme.ink)
            }
            .frame(width: 40, height: 40)
            .shadow(color: .black.opacity(0.1), radius: 5, y: 1)
            .scaleEffect(0.7 + 0.3 * progress)
            .opacity(Double(min(pull / 30, 1)))
            .padding(.top, max(4, min(pull, pullThreshold * 1.4) / 2 - 20))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    // MARK: toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { actions.settings() } label: { Avatar(name: store.userName, size: 34, ring: true) }
                .buttonStyle(.plain).accessibilityLabel("Settings")
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .principal) {
            Picker("Mode", selection: $mode) { ForEach(HomeMode.allCases) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented).frame(width: 170)
        }
        ToolbarItem(placement: .topBarTrailing) { viewMenu }
        if sizeClass != .regular {
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) { Button { actions.compose() } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel(mode == .code ? "New Code session" : "New conversation") }
        }
    }

    private var viewMenu: some View {
        Menu {
            Picker("Group by", selection: Binding(get: { grouping }, set: { setGrouping($0) })) {
                ForEach(mode == .code ? ChatGrouping.allCases : [ChatGrouping.date, .custom, .state, .none]) { Text($0.title).tag($0) }
            }
            Picker("Sort by", selection: Binding(get: { sorting }, set: { setSorting($0) })) {
                ForEach(ChatSorting.allCases) { Text($0.title).tag($0) }
            }
            if grouping == .custom {
                Toggle("Show empty groups", isOn: Binding(get: { hub.showEmptyGroups }, set: { value in Task { await hub.setPref(["sidebar", "showEmptyGroups"], .bool(value)) } }))
            }
            Divider()
            Button("Your groups", systemImage: "folder.badge.gearshape") { managing = true }
            Button("Join a co-op session…", systemImage: "person.2") { joining = true }
            Button("Archived", systemImage: "archivebox") { actions.show(.archived) }
        } label: { Image(systemName: "line.3.horizontal.decrease") }.accessibilityLabel("View options")
    }

    private func setGrouping(_ value: ChatGrouping) {
        if mode == .code { Task { await hub.setPref(["sidebar", "groupBy"], .string(value.rawValue)) } } else { chatGrouping = value.rawValue }
    }
    private func setSorting(_ value: ChatSorting) {
        if mode == .code { Task { await hub.setPref(["sidebar", "sortBy"], .string(value.rawValue)) } } else { chatSorting = value.rawValue }
    }

    // MARK: browsing

    @ViewBuilder private var browseRows: some View {
        if sizeClass == .regular { newRow }
        if mode == .chat {
            navRow("folder", "Projects", count: store.projects.count) { actions.show(.projects) }
            navRow("doc.on.doc", "Artifacts", count: nil) { actions.show(.artifacts) }
            if store.offers("imageGeneration") { navRow("photo.on.rectangle", "Images", count: nil) { actions.show(.images) } }
        }
        if mode == .code, !devices.isEmpty { CodeDevicesStrip(devices: devices) }
        if loading {
            ForEach(Array([190, 150, 230, 170, 210, 140, 200].enumerated()), id: \.offset) { _, width in skeletonRow(width: CGFloat(width)) }
        } else {
            let arranged = arranged
            if !arranged.pinned.isEmpty || !pinnedProjects.isEmpty {
                Section {
                    ForEach(pinnedProjects, id: \.self) { project in pinnedProject(project) }
                    ForEach(arranged.pinned) { session in row(session) }
                } header: { header("Pinned") }
            }
            ForEach(arranged.groups) { group in
                Section {
                    if !group.collapsed { ForEach(group.sessions) { session in row(session) } }
                } header: { groupHeader(group) }
            }
        }
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted).textCase(nil).padding(.top, 12)
    }

    @ViewBuilder private func groupHeader(_ group: ChatListGroup) -> some View {
        if let custom = group.custom {
            Button { Task { do { try await ChatActions.collapseGroup(store, hub, id: custom["id"].string, collapsed: !group.collapsed) } catch { store.error = ChatError.text(error) } } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(group.collapsed ? 0 : 90))
                    Text(group.title).font(.footnote.weight(.semibold))
                    Text("\(group.sessions.count)").font(.footnote).foregroundStyle(Theme.inkMuted)
                    Spacer()
                }.foregroundStyle(Theme.inkMuted).padding(.top, 12).contentShape(Rectangle())
            }
            .buttonStyle(.plain).textCase(nil)
            .accessibilityLabel("\(group.title), \(group.sessions.count) conversations, \(group.collapsed ? "collapsed" : "expanded")")
            .contextMenu {
                Button("Rename", systemImage: "pencil") { groupPrompt.name = group.title; groupPrompt.rename = custom }
                Button("Delete group", systemImage: "trash", role: .destructive) { groupPrompt.delete = custom }
            }
        } else { header(group.title) }
    }

    private func banner(_ text: String, symbol: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
            Text(text).font(.footnote).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(action, action: perform).font(.footnote.weight(.semibold)).tint(Theme.clay)
        }
        .padding(.horizontal, 14).padding(.vertical, 10).background(Theme.waiting.opacity(0.16), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .foregroundStyle(Theme.ink)
        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 6, leading: 18, bottom: 6, trailing: 18))
        .accessibilityElement(children: .combine)
    }

    private func skeletonRow(width: CGFloat) -> some View {
        HStack(spacing: 10) {
            Color.clear.frame(width: 8)
            VStack(alignment: .leading, spacing: 7) {
                RoundedRectangle(cornerRadius: 5).fill(Theme.fill).frame(width: width, height: 14)
                RoundedRectangle(cornerRadius: 4).fill(Theme.fill).frame(width: 80, height: 10)
            }
            Spacer()
        }
        .padding(.vertical, 9).listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18)).accessibilityHidden(true)
    }

    /// The first row of the list on an iPad, where there is no bar at the bottom to hold the button.
    private var newRow: some View {
        Button { actions.compose() } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.and.pencil").font(.system(size: 15, weight: .medium)).foregroundStyle(.white).frame(width: 32, height: 32).background(Theme.clay, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(mode == .code ? "New Code session" : "New conversation").font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain).hoverEffect(.highlight)
        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 4, leading: 18, bottom: 4, trailing: 18))
    }

    private func navRow(_ symbol: String, _ title: String, count: Int?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.clay).frame(width: 32, height: 32).background(Theme.clay.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(title).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
                if let count, count > 0 { Text("\(count)").font(.footnote).foregroundStyle(Theme.inkMuted) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain).hoverEffect(.highlight)
        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 4, leading: 18, bottom: 4, trailing: 18))
    }

    private func pinnedProject(_ project: JSON) -> some View {
        Button { actions.openProject(project["id"].string) } label: {
            HStack(spacing: 10) {
                Color.clear.frame(width: 8)
                Text(project["name"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 8)
                Label("Project", systemImage: "folder").font(.footnote).foregroundStyle(Theme.inkMuted).labelStyle(.titleAndIcon)
            }.padding(.vertical, 9).contentShape(Rectangle())
        }
        .buttonStyle(.plain).hoverEffect(.highlight)
        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        .contextMenu { Button("Unpin", systemImage: "pin.slash") { Task { _ = try? await ChatActions.updateProject(store, id: project["id"].string, patch: ["pinned": .bool(false)]); await hub.reloadProjects() } } }
    }

    // MARK: rows

    private func isOpen(_ session: Conversation) -> Bool {
        sizeClass == .regular && route == .conversation && store.selected == session.id
    }

    private func row(_ session: Conversation) -> some View {
        ChatSessionRow(store: store, session: session, selected: isOpen(session)) { actions.open(session.id) }
            .listRowBackground(isOpen(session) ? Theme.fill : Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
            .listRowSeparator(.hidden)
            .swipeActions(edge: .leading) {
                Button { Task { do { try await ChatActions.setPinned(store, session.id, !session.pinned) } catch { store.error = ChatError.text(error) } } } label: { Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin") }.tint(Theme.clay)
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { if session.isGuest && !session.coopEnded { prompt.leave = session } else { prompt.delete = session } } label: { Label(session.isGuest ? "Leave" : "Delete", systemImage: "trash") }
                Button { Task { do { try await ChatActions.setArchived(store, session.id, true) } catch { store.error = ChatError.text(error) } } } label: { Label("Archive", systemImage: "archivebox") }.tint(.gray)
            }
            .contextMenu { ChatSessionActions(store: store, session: session, prompt: prompt) { id in actions.open(id) } }
    }

    // MARK: states

    @ViewBuilder private var overlay: some View {
        if isSearching {
            switch results.state {
            case .loading where results.items.isEmpty: ProgressView().controlSize(.large)
            case .failed(let message): InlineError(message: message) { results.schedule(search, store: store, mode: mode) }
            case .loaded where results.items.isEmpty: ContentUnavailableView.search(text: search)
            default: EmptyView()
            }
        } else if !loading, visible.isEmpty, pinnedProjects.isEmpty {
            if mode == .code { ContentUnavailableView("No Code sessions", systemImage: "chevron.left.forwardslash.chevron.right", description: Text("Start one with the button below.")) }
            else { ContentUnavailableView("No conversations yet", systemImage: "bubble.left", description: Text("Start one with the button below.")) }
        }
    }

    /// What search shows before anything is typed: the latest conversations, and the projects.
    @ViewBuilder private var recentRows: some View {
        let recent = Array(visible.sorted { $0.updated > $1.updated }.prefix(8))
        if !recent.isEmpty { Section { ForEach(recent) { session in row(session) } } header: { header("Recents") } }
        if mode == .chat, !store.projects.isEmpty {
            Section {
                ForEach(store.projects, id: \.self) { project in
                    Button { actions.openProject(project["id"].string) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "folder").font(.system(size: 15)).foregroundStyle(Theme.inkSecondary).frame(width: 22)
                            Text(project["name"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                            Spacer(minLength: 0)
                        }.padding(.vertical, 9).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
                }
            } header: { header("Projects") }
        }
    }

    @ViewBuilder private var searchRows: some View {
        ForEach(results.items) { session in
            ChatSessionRow(store: store, session: session, selected: isOpen(session), showsArchived: true) { actions.open(session.id) }
                .listRowBackground(isOpen(session) ? Theme.fill : Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18)).listRowSeparator(.hidden)
        }
    }
}

/// One conversation in a list: its state, title, model and when it last moved.
struct ChatSessionRow: View {
    let store: AppStore
    let session: Conversation
    var selected = false
    var showsArchived = false
    let open: () -> Void

    /// A Code session's second line: where it works, or that it is waiting for an answer.
    private var codeLine: String {
        let workspace = session.workspaceID.flatMap { id in ChatHub.of(store).workspaces.first { $0["id"].string == id } }
        // A session without a folder says which model it uses instead.
        let place = workspace == nil || workspace?["scratch"].bool == true ? ChatModels.name(session.model, in: store.models) : ChatFolders.name(workspace)
        return session.status == "waiting" ? (place.isEmpty ? "Waiting for you" : "Waiting for you · \(place)") : place
    }

    var body: some View {
        let model = ChatModels.name(session.model, in: store.models)
        Button(action: open) {
            HStack(alignment: .center, spacing: 10) {
                Group { if let dot = session.dot { StatusDot(kind: dot) } else { Color.clear } }.frame(width: 8)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.displayTitle).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    HStack(spacing: 6) {
                        if session.isShared { Image(systemName: "person.2").font(.system(size: 11)).accessibilityLabel(session.isGuest ? "Co-op with \(session.coopHost)" : "Co-op") }
                        if session.madeSomething { Image(systemName: "doc.text").font(.system(size: 11)).accessibilityLabel("Made an artifact") }
                        if showsArchived, session.archived { Text("Archived") }
                        else if session.mode == "code" { Text(codeLine).lineLimit(1) }
                        else if !model.isEmpty { Text(model).lineLimit(1) }
                        if session.isGuest, !session.coopHost.isEmpty { Text("· \(session.coopHost)").lineLimit(1) }
                    }.font(.footnote).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 8)
                Text(session.updated, format: .relative(presentation: .numeric, unitsStyle: .narrow)).font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
            }
            .padding(.vertical, 7).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.displayTitle), \(model), \(session.status == "running" ? "working" : session.status == "waiting" ? "needs your answer" : session.unseen ? "new reply" : "")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Search

/// Searches every conversation, by title and by what was said in it (the server does the looking).
@MainActor @Observable final class ChatSearchModel {
    var items: [Conversation] = []
    var state: State = .idle
    enum State: Equatable { case idle, loading, loaded, failed(String) }
    @ObservationIgnored private var task: Task<Void, Never>?

    func schedule(_ query: String, store: AppStore, mode: HomeMode) {
        task?.cancel()
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { items = []; state = .idle; return }
        state = .loading
        task = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                let list = try await store.rpc.call("sessions.list", ["query": .string(text), "archived": .string("all"), "limit": 60])
                guard !Task.isCancelled else { return }
                self?.items = list.array.map(Conversation.init).filter { ($0.mode == "code") == (mode == .code) && !$0.isTemporary }.sorted { $0.updated > $1.updated }
                self?.state = .loaded
            } catch is CancellationError { return } catch { self?.state = .failed(ChatError.text(error)) }
        }
    }
}

extension Notification.Name {
    static let atelierSearch = Notification.Name("atelier.search")
}

// MARK: - Groups

@MainActor @Observable final class ChatGroupPrompt {
    var rename: JSON?
    var delete: JSON?
    var name = ""
}

struct ChatGroupPrompts: ViewModifier {
    let store: AppStore
    @Bindable var prompt: ChatGroupPrompt

    func body(content: Content) -> some View {
        content
            .alert("Rename group", isPresented: Binding(get: { prompt.rename != nil }, set: { if !$0 { prompt.rename = nil } })) {
                TextField("Group name", text: $prompt.name)
                Button("Cancel", role: .cancel) { prompt.rename = nil }
                Button("Save") {
                    guard let group = prompt.rename, !prompt.name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    let name = prompt.name
                    Task { do { try await ChatActions.renameGroup(store, ChatHub.of(store), id: group["id"].string, name: name) } catch { store.error = ChatError.text(error) } }
                }
            }
            .confirmationDialog("Delete this group?", isPresented: Binding(get: { prompt.delete != nil }, set: { if !$0 { prompt.delete = nil } }), titleVisibility: .visible) {
                Button("Delete group", role: .destructive) {
                    guard let group = prompt.delete else { return }
                    Task { do { try await ChatActions.deleteGroup(store, ChatHub.of(store), id: group["id"].string) } catch { store.error = ChatError.text(error) } }
                }
            } message: { Text("Its conversations are kept, and become ungrouped.") }
    }
}

/// The person's own groups: add, rename, delete.
struct ChatGroupsSheet: View {
    let store: AppStore
    let hub: ChatHub
    @State private var prompt = ChatGroupPrompt()
    @State private var adding = false
    @State private var name = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if hub.groups.isEmpty {
                    EmptyState(title: "No groups yet", symbol: "folder", message: "Groups keep related conversations together. Move a conversation into one from its menu.", actionTitle: "New group") { name = ""; adding = true }
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else {
                    Section {
                        ForEach(hub.groups, id: \.self) { group in
                            let count = store.sessions.filter { $0.groupID == group["id"].string && !$0.archived }.count
                            NavRow(symbol: "folder", title: group["name"].string, value: "\(count)")
                                .swipeActions { Button(role: .destructive) { prompt.delete = group } label: { Label("Delete", systemImage: "trash") }
                                    Button { prompt.name = group["name"].string; prompt.rename = group } label: { Label("Rename", systemImage: "pencil") }.tint(Theme.clay) }
                                .contextMenu { Button("Rename", systemImage: "pencil") { prompt.name = group["name"].string; prompt.rename = group }; Button("Delete", systemImage: "trash", role: .destructive) { prompt.delete = group } }
                        }
                    } footer: { Text("Deleting a group keeps its conversations.") }
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Your groups").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button { name = ""; adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("New group") }
            }
            .alert("New group", isPresented: $adding) {
                TextField("Group name", text: $name)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    let value = name
                    guard !value.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    Task { do { _ = try await ChatActions.createGroup(store, hub, name: value) } catch { store.error = ChatError.text(error) } }
                }
            }
            .modifier(ChatGroupPrompts(store: store, prompt: prompt))
        }
        .tint(Theme.clay).presentationDetents([.medium, .large])
    }
}

// MARK: - Archived

/// Conversations that were put away: they come back with Unarchive, or go for good with Delete.
struct ChatArchivedPage: View {
    let store: AppStore
    var open: (String) -> Void
    @State private var resource: Resource<[Conversation]>
    @State private var prompt = ChatSessionPrompt()

    init(store: AppStore, open: @escaping (String) -> Void) {
        self.store = store; self.open = open
        _resource = State(initialValue: Resource { try await store.rpc.call("sessions.list", ["archived": .string("archived"), "limit": 200]).array.map(Conversation.init).sorted { $0.updated > $1.updated } })
    }

    var body: some View {
        ResourceList(resource: resource, isEmpty: { $0.isEmpty }, empty: { EmptyState(title: "Nothing archived", symbol: "archivebox", message: "Conversations you archive wait here. They are not deleted.") }) { sessions in
            ForEach(sessions) { session in
                ChatSessionRow(store: store, session: session, showsArchived: false) { open(session.id) }
                    .swipeActions(edge: .leading) { Button { unarchive(session) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }.tint(Theme.clay) }
                    .swipeActions(edge: .trailing) { Button(role: .destructive) { prompt.delete = session } label: { Label("Delete", systemImage: "trash") } }
                    .contextMenu {
                        Button("Unarchive", systemImage: "tray.and.arrow.up") { unarchive(session) }
                        Button("Delete", systemImage: "trash", role: .destructive) { prompt.delete = session }
                    }
            }
        }
        .navigationTitle("Archived").navigationBarTitleDisplayMode(.inline)
        .chatSessionPrompts(store: store, prompt: prompt) { _ in Task { await resource.reload() } }
        .onReceive(NotificationCenter.default.publisher(for: .atelierArchivedChanged)) { _ in Task { await resource.reload() } }
    }

    private func unarchive(_ session: Conversation) {
        Task {
            do {
                try await ChatActions.setArchived(store, session.id, false)
                if case .loaded(let list) = resource.state { resource.set(list.filter { $0.id != session.id }) }
                try? await store.refresh()
                store.notify("Brought back")
            } catch { store.error = ChatError.text(error) }
        }
    }
}

extension Notification.Name {
    static let atelierArchivedChanged = Notification.Name("atelier.archivedChanged")
}

/// The computers that run Code sessions (the desktop apps linked to this server), each with whether it is online.
struct CodeDevicesStrip: View {
    let devices: [JSON]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Devices").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(devices, id: \.self) { device in
                        let online = device["online"].bool
                        HStack(spacing: 9) {
                            Image(systemName: "laptopcomputer").font(.system(size: 16)).foregroundStyle(Theme.ink)
                                .overlay(alignment: .topTrailing) { Circle().fill(online ? Theme.success : Theme.inkMuted.opacity(0.6)).frame(width: 8, height: 8).offset(x: 4, y: -3) }
                            Text(device["name"].string).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                        }
                        .padding(.horizontal, 14).frame(height: 40)
                        .background(Capsule().stroke(Theme.hairline, lineWidth: 1))
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(device["name"].string), \(online ? "online" : "offline")")
                    }
                }
            }
        }
        .padding(.top, 6)
        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 4, leading: 18, bottom: 6, trailing: 0))
    }
}
