import SwiftUI

enum HomeMode: String, CaseIterable, Identifiable {
    case chat = "Chat", code = "Code"
    var id: String { rawValue }
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
    @State private var settings = false
    @State private var settingsStart: SettingsPageID?
    @State private var mode: HomeMode
    @State private var column: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var route: ChatRoute = .conversation
    @State private var openProject: String?
    @State private var newCode = false
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
            .tint(Theme.clay)
            .environment(\.chatServer, store.address)
            .onReceive(NotificationCenter.default.publisher(for: .atelierNewConversation)) { _ in compose() }
            .onReceive(NotificationCenter.default.publisher(for: .atelierSettings)) { _ in settings = true }
            .sheet(isPresented: $settings, onDismiss: { settingsStart = nil }) { SettingsView(store: store, start: settingsStart) }
            .sheet(isPresented: $newCode) { NewCodeSessionSheet(store: store) { id in newCode = false; open(id) } }
            .onReceive(NotificationCenter.default.publisher(for: .atelierOpenSettings)) { note in
                settingsStart = (note.userInfo?["page"] as? String).flatMap(SettingsPageID.init(rawValue:))
                settings = true
            }
            .task(id: store.connected) { if store.connected { await hub.reloadAll() } }
            #if DEBUG
            // `--open settings/<page>` opens Settings on launch, with a demo or after `--autologin`.
            .onAppear { if let page = Launch.route("settings").flatMap(SettingsPageID.init(rawValue:)) { settingsStart = page; settings = true } }
            #endif
            .onChange(of: store.signedIn) { _, signedIn in if !signedIn { hub.clearCaches() } }
            .onAppear {
                #if DEBUG
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
            settings: { settings = true },
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
        }
    }

    /// On a phone the detail slides over the list; on an iPad the list stays where the person left it.
    private func showDetail() { compactColumn = .detail }

    private func open(_ id: String) {
        route = .conversation
        showDetail()
        Task { await ChatNav.open(store, id) }
    }

    private func compose() {
        if mode == .code { newCode = true; return }
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

extension Notification.Name {
    static let atelierNewConversation = Notification.Name("atelier.newConversation")
    static let atelierSettings = Notification.Name("atelier.settings")
}
