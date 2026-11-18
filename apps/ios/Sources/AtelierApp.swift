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
        #if DEBUG || E2E
        // `--set-server <address>`: points the app at that server before it starts (to undo a test that signed in elsewhere).
        if let address = Launch.value("--set-server") { UserDefaults.standard.set(address, forKey: "server") }
        #endif
        #if DEBUG
        demo = Demo.requested != nil
        _store = State(initialValue: Demo.store())
        #else
        demo = false
        _store = State(initialValue: AppStore())
        #endif
    }

    #if DEBUG
    /// `--dump-views`: prints the views near the top of every window with their background colours (where a black void could come from).
    @MainActor static func dumpViews() {
        func describe(_ view: UIView, _ depth: Int) {
            guard depth < 7 else { return }
            let color = view.backgroundColor.map { c -> String in var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0; c.resolvedColor(with: view.traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a); return String(format: "#%02X%02X%02X a%.2f", Int(r * 255), Int(g * 255), Int(b * 255), a) } ?? "-"
            NSLog("VIEWS %@%@ %@ bg=%@ hidden=%d", String(repeating: "  ", count: depth), NSStringFromClass(type(of: view)), NSCoder.string(for: view.frame), color, view.isHidden ? 1 : 0)
            for sub in view.subviews { describe(sub, depth + 1) }
        }
        for scene in UIApplication.shared.connectedScenes { for window in (scene as? UIWindowScene)?.windows ?? [] { NSLog("VIEWS window %@", NSStringFromClass(type(of: window))); describe(window, 0) } }
    }
    #endif

    /// The window and the containers UIKit puts under a SwiftUI app are the paper colour, so whatever is ever drawn short of its
    /// edge (the keyboard's rounded top corners, a page that moved, a bar that gave way) shows the same grey as the page, never
    /// black. The root hosting view and the split view's own view are opaque black in dark mode by default.
    @MainActor private static func paintWindows() {
        for scene in UIApplication.shared.connectedScenes {
            // Only the app's own windows: the ones UIKit adds for the keyboard and text effects sit above it and are not painted.
            for window in (scene as? UIWindowScene)?.windows ?? [] where window.windowLevel == .normal { PaperVoid.paint(window) }
        }
    }

    var body: some Scene {
        WindowGroup {
            content
                .tint(Theme.clay)
                .onReceive(NotificationCenter.default.publisher(for: UIWindow.didBecomeKeyNotification)) { _ in Self.paintWindows() }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Self.paintWindows() }
                .onAppear {
                    Self.paintWindows()
                    #if DEBUG
                    if Launch.value("--dump-views") != nil { Task { try? await Task.sleep(for: .seconds(5)); Self.dumpViews() } }
                    #endif
                }
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
                .task(id: "\(store.signedIn)|\(store.connected)|\(store.info != .null)") {
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
