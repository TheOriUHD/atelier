import SwiftUI

enum HomeMode: String, CaseIterable, Identifiable {
    case chat = "Chat", code = "Code"
    var id: String { rawValue }
}

/// What the new-conversation pages need to offer the Chat | Code choice: which one is chosen, and how to change it (which
/// also changes the page and the list beside it).
struct HomeModeControl: @unchecked Sendable {
    var mode: HomeMode
    var set: (HomeMode) -> Void
}

private struct HomeModeKey: EnvironmentKey { static let defaultValue: HomeModeControl? = nil }

extension EnvironmentValues {
    var homeMode: HomeModeControl? {
        get { self[HomeModeKey.self] }
        set { self[HomeModeKey.self] = newValue }
    }
}

/// The Chat | Code choice on an iPad, over the box a new conversation starts from: the box and what it starts depend on it.
/// A phone keeps it in the list's own bar and shows nothing here.
struct HomeModePicker: View {
    @Environment(\.homeMode) private var control
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if sizeClass == .regular, let control {
            Picker("Mode", selection: Binding(get: { control.mode }, set: { control.set($0) })) {
                ForEach(HomeMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).frame(width: 200).frame(maxWidth: .infinity)
        }
    }
}

extension Conversation {
    var updated: Date { Date(timeIntervalSince1970: Double(raw["updatedAt"].int) / 1000) }
    var unseen: Bool { raw["finishedUnseen"].bool }
    var dot: StatusDot.Kind? {
        switch status {
        case "running": .running
        case "waiting": .waiting
        default: unseen ? .unseen : nil
        }
    }
}

/// The app once signed in: the list of conversations on the left, the conversation (or one of the pages the list leads
/// to) on the right. On a phone the two are one stack; on an iPad they sit side by side.
struct RootView: View {
    @Bindable var store: AppStore
    var startIn: HomeMode = .chat
    /// Settings, with the page to open on when something elsewhere in the app links to one. Being the presentation's own
    /// item, the page can't be lost to the timing of another sheet closing.
    @State private var settings: SettingsRequest?
    @State private var mode: HomeMode
    @State private var column: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var route: ChatRoute = .conversation
    @State private var openProject: String?
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(store: AppStore, startIn: HomeMode = .chat) {
        self.store = store
        self.startIn = startIn
        _mode = State(initialValue: startIn)
    }

    private var hub: ChatHub { ChatHub.of(store) }
    private var needsNewPassword: Bool { store.authStatus["user"]["mustChangePassword"].bool }

    var body: some View {
        if store.signedIn, !needsNewPassword {
            NavigationSplitView(columnVisibility: $column, preferredCompactColumn: $compactColumn) {
                ChatSidebar(store: store, mode: $mode, actions: sidebarActions, route: route)
                    .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 420)
            } detail: {
                detail
            }
            .navigationSplitViewStyle(.balanced)
            .environment(\.homeMode, HomeModeControl(mode: mode, set: { switchMode($0) }))
            .tint(Theme.clay)
            .environment(\.chatServer, store.address)
            .onReceive(NotificationCenter.default.publisher(for: .atelierNewConversation)) { _ in compose() }
            .onReceive(NotificationCenter.default.publisher(for: .atelierSettings)) { _ in settings = SettingsRequest() }
            .sheet(item: $settings) { SettingsView(store: store, start: $0.page) }
            .onReceive(NotificationCenter.default.publisher(for: .atelierOpenSettings)) { note in
                settings = SettingsRequest(page: (note.userInfo?["page"] as? String).flatMap(SettingsPageID.init(rawValue:)))
            }
            .task(id: store.connected) { if store.connected { await hub.reloadAll() } }
            .task(id: store.connected) { await hub.watchLink(connected: store.connected) }
            #if DEBUG
            // `--open settings/<page>` opens Settings on launch, with a demo or after `--autologin`.
            .onAppear { if let page = Launch.route("settings").flatMap(SettingsPageID.init(rawValue:)) { settings = SettingsRequest(page: page) } }
            #endif
            .onChange(of: store.signedIn) { _, signedIn in if !signedIn { hub.clearCaches() } }
            .onAppear {
                #if DEBUG
                if Demo.requested == "conversation-root" { showDetail() }
                switch Launch.route("home") {
                case "projects": route = .projects; showDetail()
                case "project": route = .projects; openProject = store.projects.first?["id"].string; showDetail()
                case "artifacts": route = .artifacts; showDetail()
                case "images": route = .images; showDetail()
                case "archived": route = .archived; showDetail()
                case "conversation": showDetail()
                default: break
                }
                #endif
            }
        } else { SignInView(store: store) }
    }

    private var sidebarActions: ChatSidebarActions {
        ChatSidebarActions(
            open: { open($0) },
            compose: { compose() },
            show: { route = $0; openProject = nil; showDetail() },
            settings: { settings = SettingsRequest() },
            openProject: { openProject = $0; route = .projects; showDetail() }
        )
    }

    @ViewBuilder private var detail: some View {
        switch route {
        case .conversation: ConversationView(store: store)
        case .projects: ChatProjectsPage(store: store, initial: openProject, open: { open($0) }, startIn: { startIn(project: $0) })
        case .artifacts: NavigationStack { ArtifactsPage(store: store, openConversation: { open($0) }) }
        case .images: NavigationStack { GalleryPage(store: store, open: { open($0) }) }
        case .archived: NavigationStack { ChatArchivedPage(store: store, open: { open($0) }) }
        case .newCode: NewCodeSessionPage(store: store) { open($0) }
        }
    }

    /// On a phone the detail slides over the list; on an iPad the list stays where the person left it.
    private func showDetail() { compactColumn = .detail }

    /// The Chat | Code choice over the box of a new conversation: the page and the list follow it.
    private func switchMode(_ new: HomeMode) {
        guard new != mode else { return }
        withAnimation(.smooth(duration: 0.25)) { mode = new }
        if new == .code { route = .newCode } else { route = .conversation; ChatNav.newConversation(store) }
        showDetail()
    }

    private func open(_ id: String) {
        // The list beside it shows what the open conversation is: chats, or Code sessions.
        if let session = store.sessions.first(where: { $0.id == id }) { mode = session.mode == "code" ? .code : .chat }
        route = .conversation
        showDetail()
        Task { await ChatNav.open(store, id) }
    }

    private func compose() {
        if mode == .code { route = .newCode; showDetail(); return }
        route = .conversation
        ChatNav.newConversation(store)
        showDetail()
    }

    private func startIn(project id: String) {
        route = .conversation
        ChatNav.newConversation(store, project: id)
        showDetail()
    }
}

/// A request to show Settings, optionally on one page.
struct SettingsRequest: Identifiable {
    let id = UUID()
    var page: SettingsPageID?
}

extension Notification.Name {
    static let atelierNewConversation = Notification.Name("atelier.newConversation")
    static let atelierSettings = Notification.Name("atelier.settings")
}
