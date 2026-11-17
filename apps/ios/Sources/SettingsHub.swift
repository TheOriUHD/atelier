import SwiftUI

/// Every page of Settings. The personal ones are for everyone; the admin ones only for admins, and only where the server
/// offers them (the desktop app's own pages for this computer have no counterpart on a phone).
enum SettingsPageID: String, CaseIterable, Identifiable, Hashable {
    // Settings
    case general, account, privacy, memory, usage, code, folders, cloud, yourModels, personalConnectors, skills, plugins, shortcuts, help
    // Admin
    case providers, media, models, capabilities, adminCode, connectors, secrets, users, limits, server, activity
    // Switched on by tapping the version ten times
    case developer

    var id: String { rawValue }
    var isAdmin: Bool {
        switch self {
        case .providers, .media, .models, .capabilities, .adminCode, .connectors, .secrets, .users, .limits, .server, .activity: true
        default: false
        }
    }
    var title: String {
        switch self {
        case .general: "General"
        case .account: "Account"
        case .privacy: "Privacy"
        case .memory: "Memory"
        case .usage: "Usage"
        case .code: "Code"
        case .folders: "Folders"
        case .cloud: "Cloud"
        case .yourModels: "Your models"
        case .personalConnectors: "Your connectors"
        case .skills: "Skills"
        case .shortcuts: "Shortcuts"
        case .help: "Help and feedback"
        case .providers: "Providers"
        case .media: "Media"
        case .models: "Models"
        case .capabilities: "Capabilities"
        case .adminCode: "Code defaults"
        case .connectors: "Connectors"
        case .plugins: "Plugins"
        case .secrets: "Keys and secrets"
        case .users: "Users"
        case .limits: "Limits"
        case .server: "Server"
        case .activity: "Activity"
        case .developer: "Developer"
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .account: "person.crop.circle"
        case .privacy: "hand.raised"
        case .memory: "brain"
        case .usage: "chart.bar"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .folders: "folder"
        case .cloud: "cloud"
        case .yourModels: "cpu"
        case .personalConnectors: "powerplug"
        case .skills: "text.book.closed"
        case .shortcuts: "keyboard"
        case .help: "lifepreserver"
        case .providers: "bolt.horizontal"
        case .media: "photo.on.rectangle"
        case .models: "square.stack.3d.up"
        case .capabilities: "briefcase"
        case .adminCode: "curlybraces.square"
        case .connectors: "powerplug"
        case .plugins: "puzzlepiece.extension"
        case .secrets: "key"
        case .users: "person.2"
        case .limits: "gauge.with.dots.needle.50percent"
        case .server: "server.rack"
        case .activity: "clock.arrow.circlepath"
        case .developer: "hammer"
        }
    }
    /// Whether this person may open it here.
    @MainActor func available(for store: AppStore) -> Bool {
        if isAdmin && !store.isAdmin { return false }
        switch self {
        case .developer: return DeveloperOptions.shared.enabled
        case .media: return store.offers("imageGeneration")
        case .users: return !store.offers("sharedComputer")
        case .limits: return !store.authStatus["local"].bool && !store.offers("sharedComputer") && store.offers("usageLimits")
        case .activity: return store.offers("auditLog")
        case .yourModels, .personalConnectors: return !store.authStatus["local"].bool && !store.offers("sharedComputer")
        default: return true
        }
    }
}

struct SettingsView: View {
    @Bindable var store: AppStore
    /// The page to open on, as a deep link from elsewhere in the app.
    var start: SettingsPageID?
    @Environment(\.dismiss) private var dismiss
    @State private var path: [SettingsPageID] = []
    @State private var signOut = false

    init(store: AppStore, start: SettingsPageID? = nil) {
        self.store = store
        let launched = Launch.route("settings").flatMap(SettingsPageID.init(rawValue:))
        self.start = start ?? launched
        _path = State(initialValue: (start ?? launched).map { [$0] } ?? [])
    }

    private var personal: [SettingsPageID] { SettingsPageID.allCases.filter { !$0.isAdmin && $0 != .developer && $0.available(for: store) } }
    private var admin: [SettingsPageID] { SettingsPageID.allCases.filter { $0.isAdmin && $0.available(for: store) } }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack(spacing: 14) {
                        Avatar(name: store.userName, size: 54)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(store.userName.isEmpty ? "Your account" : store.userName).font(.system(.title3, design: .serif, weight: .medium))
                                if store.isAdmin { StatusBadge(text: "Admin", tone: .clay) }
                            }
                            Text(URL(string: store.address)?.host ?? store.address).font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                    }.padding(.vertical, 6)
                }
                Section { ForEach(personal) { page in row(page) } }
                if !admin.isEmpty {
                    Section {
                        ForEach(admin) { page in row(page) }
                    } header: { Text("Admin") } footer: { Text("Changes here apply to everyone on this server.") }
                }
                if SettingsPageID.developer.available(for: store) {
                    Section { row(.developer) }
                }
                Section {
                    // Ten quick taps turn on the developer options.
                    LabeledContent("Atelier for iPhone and iPad", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                        .contentShape(Rectangle())
                        .onTapGesture { if let message = DeveloperOptions.shared.tapVersion() { store.notify(message) } }
                    LabeledContent("Server", value: store.info["version"].string)
                }
                Section { Button("Sign out", role: .destructive) { signOut = true } }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.sunken)
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: SettingsPageID.self) { destination($0) }
            .confirmationDialog("Sign out of this server?", isPresented: $signOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { store.perform { try await store.logout(); dismiss() } }
            }
        }
        .tint(Theme.clay)
        .toasts(store)
    }

    private func row(_ page: SettingsPageID) -> some View {
        NavigationLink(value: page) { NavRow(symbol: page.symbol, title: page.title) }
    }

    @ViewBuilder private func destination(_ page: SettingsPageID) -> some View {
        switch page {
        case .general: GeneralSettings(store: store)
        case .account: AccountSettings(store: store)
        case .privacy: PrivacySettings(store: store)
        case .memory: MemorySettings(store: store)
        case .usage: UsageSettings(store: store)
        case .code: CodeSettings(store: store)
        case .folders: FoldersSettings(store: store)
        case .cloud: CloudSettings(store: store)
        case .yourModels: PersonalModelsSettings(store: store)
        case .personalConnectors: ConnectorsSettings(store: store, admin: false)
        case .skills: SkillsSettings(store: store)
        case .shortcuts: ShortcutsSettings(store: store)
        case .help: HelpSettings(store: store)
        case .providers: ProvidersSettings(store: store)
        case .media: MediaSettings(store: store)
        case .models: ModelsSettings(store: store)
        case .capabilities: CapabilitiesSettings(store: store)
        case .adminCode: AdminCodeSettings(store: store)
        case .connectors: ConnectorsSettings(store: store, admin: true)
        case .plugins: PluginsSettings(store: store)
        case .secrets: SecretsSettings(store: store)
        case .users: UsersSettings(store: store)
        case .limits: LimitsSettings(store: store)
        case .server: ServerSettings(store: store)
        case .activity: ActivitySettings(store: store)
        case .developer: DeveloperSettings(store: store)
        }
    }
}

extension Notification.Name {
    /// Posted with `userInfo["page"]` (a `SettingsPageID.rawValue`) to open Settings on a page from anywhere in the app.
    static let atelierOpenSettings = Notification.Name("atelier.openSettings")
}

@MainActor func openSettings(_ page: SettingsPageID) {
    NotificationCenter.default.post(name: .atelierOpenSettings, object: nil, userInfo: ["page": page.rawValue])
}
