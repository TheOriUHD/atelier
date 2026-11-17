import SwiftUI

/// Takes the system's word that a model's background download finished while the app was away.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        Task { @MainActor in LocalModelStore.shared.handleBackgroundEvents(completionHandler) }
    }
}

@main struct AtelierApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store: AppStore
    @Environment(\.scenePhase) private var phase
    @AppStorage("appearance") private var appearance = "system"
    private let demo: Bool

    init() {
        #if DEBUG
        demo = Demo.requested != nil
        _store = State(initialValue: Demo.store())
        #else
        demo = false
        _store = State(initialValue: AppStore())
        #endif
    }

    /// The window itself is the paper colour, so what shows behind the keyboard's rounded top corners is not black.
    @MainActor private static func paintWindows() {
        let paper = UIColor { traits in UIColor(Theme.background).resolvedColor(with: traits) }
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] { window.backgroundColor = paper }
        }
    }

    var body: some Scene {
        WindowGroup {
            content
                .tint(Theme.clay)
                .onAppear { Self.paintWindows() }
                .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
                .task {
                    guard !demo else { return }
                    if let launch = Launch.autologin {
                        store.address = launch.address
                        store.perform { try await store.login(username: launch.user, password: launch.password) }
                    } else if let text = Launch.value("--pair"), let link = PairingLink.parse(text) {
                        store.perform { try await store.signIn(pairing: link) }
                    } else { await store.reconnectQuietly() }
                }
                .toasts(store)
                .onOpenURL { url in
                    // The Camera app scanning the QR code from the computer opens Atelier with it.
                    guard let link = PairingLink.parse(url.absoluteString) else { return }
                    store.perform { try await store.signIn(pairing: link) }
                }
                .task(id: "\(store.signedIn)|\(store.connected)") {
                    guard !demo else { return }
                    LocalModelStore.shared.onChange = { Task { await OnDeviceHub.shared.sync(store) } }
                    await OnDeviceHub.shared.sync(store)
                    #if DEBUG || E2E
                    await OnDeviceDebug.run(store)
                    #endif
                }
                .onChange(of: phase) { _, phase in
                    guard !demo else { return }
                    if phase == .active { Task { await OnDeviceHub.shared.foreground(store) } }
                    if phase == .active { store.lifecycle(active: true) }
                    else if phase == .background { store.lifecycle(active: false) }
                }
                .alert("Atelier", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                    Button("OK") { store.error = nil }
                } message: { Text(store.error ?? "") }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Conversation") { NotificationCenter.default.post(name: .atelierNewConversation, object: nil) }.keyboardShortcut("n", modifiers: .command)
            }
            CommandGroup(after: .appInfo) {
                Button("Settings…") { NotificationCenter.default.post(name: .atelierSettings, object: nil) }.keyboardShortcut(",", modifiers: .command)
            }
        }
    }

    @ViewBuilder private var content: some View {
        #if DEBUG
        if demo { DemoRoot(store: store) } else { RootView(store: store) }
        #else
        RootView(store: store)
        #endif
    }
}
