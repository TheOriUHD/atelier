import SwiftUI

// MARK: - Shortcuts: a reference. The iPad app's keys, and the desktop's for comparison.

enum PersonalShortcuts {
    struct Entry: Identifiable, Equatable {
        let id: String
        let title: String
        /// One key cap each: ["⇧", "⌘", "N"].
        let keys: [String]?
    }

    /// The keys the iPad app answers to with a hardware keyboard, as the app implements them (AtelierApp's menu and the message box).
    static let thisApp: [Entry] = [
        Entry(id: "new", title: "New conversation", keys: ["⌘", "N"]),
        Entry(id: "settings", title: "Settings", keys: ["⌘", ","]),
        Entry(id: "send", title: "Send the message", keys: ["Return"]),
        Entry(id: "newline", title: "New line in the message", keys: ["⇧", "Return"]),
    ]

    /// The desktop's changeable shortcuts and their defaults (packages/protocol shortcuts.ts); the lock exists only on "Run on this computer".
    static let desktopApp: [(id: String, title: String, binding: String)] = [
        ("new-chat", "New chat, task or session", "Mod+N"),
        ("new-temporary-chat", "New temporary chat", "Mod+Shift+N"),
        ("search", "Search", "Mod+K"),
        ("settings", "Settings", "Mod+,"),
        ("toggle-sidebar", "Show or hide the sidebar", "Mod+B"),
        ("report-issue", "Report an issue, with a screenshot", "F1"),
    ]
    static let desktopMessageBox: [(id: String, title: String, binding: String)] = [
        ("upload", "Upload or add files", "Mod+U"),
        ("effort", "Change effort", "Mod+Shift+E"),
        ("dictate", "Dictate", "Mod+Shift+Space"),
    ]
    /// Always the same on the desktop.
    static let desktopFixed: [Entry] = [
        Entry(id: "send", title: "Send", keys: ["Return"]),
        Entry(id: "newline", title: "New line", keys: ["⇧", "Return"]),
        Entry(id: "stop", title: "Stop while it works (empty box)", keys: ["Esc"]),
        Entry(id: "commands", title: "Commands and skills", keys: ["/"]),
        Entry(id: "mention", title: "Mention a file (Code)", keys: ["@"]),
        Entry(id: "mode", title: "Switch permission mode (Code)", keys: ["⇧", "Tab"]),
    ]

    /// "Mod+Shift+N" as key caps in the Mac's order: ⌃ ⌥ ⇧ ⌘ then the key.
    static func keys(for binding: String) -> [String] {
        let parts = binding.split(separator: "+", omittingEmptySubsequences: true).map(String.init)
        guard let key = parts.last else { return [] }
        let modifiers = Set(parts.dropLast())
        var caps: [String] = []
        if modifiers.contains("Ctrl") { caps.append("⌃") }
        if modifiers.contains("Alt") { caps.append("⌥") }
        if modifiers.contains("Shift") { caps.append("⇧") }
        if modifiers.contains("Mod") { caps.append("⌘") }
        let names = ["Enter": "Return", "ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "Backspace": "Delete", "Space": "Space"]
        caps.append(names[key] ?? key)
        return caps
    }

    /// A desktop shortcut with the person's own change applied: their binding, or nil for turned off.
    static func entries(_ list: [(id: String, title: String, binding: String)], changes: JSON) -> [Entry] {
        list.map { item in
            let change = changes[item.id]
            if case .string(let binding) = change { return Entry(id: item.id, title: item.title, keys: keys(for: binding)) }
            if change == .null, case .object(let object) = changes, object.keys.contains(item.id) { return Entry(id: item.id, title: item.title, keys: nil) }
            return Entry(id: item.id, title: item.title, keys: keys(for: item.binding))
        }
    }
}

struct ShortcutsSettings: View {
    let store: AppStore
    @State private var prefs: PersonalPrefs

    init(store: AppStore) {
        self.store = store
        _prefs = State(initialValue: PersonalPrefs(store: store))
    }

    var body: some View {
        let changes = prefs.value(["shortcuts"])
        PersonalPage(title: "Shortcuts") {
            Section {
                ForEach(PersonalShortcuts.thisApp) { row($0) }
            } header: { Text("On iPad") } footer: {
                Text("Connect a hardware keyboard to use these. Shortcuts here can't be changed. On iPhone, the same keys work with a connected keyboard.")
            }
            Section {
                ForEach(PersonalShortcuts.entries(PersonalShortcuts.desktopApp, changes: changes)) { row($0) }
            } header: { Text("Desktop app and browser: App") }
            Section {
                ForEach(PersonalShortcuts.desktopFixed.prefix(3)) { row($0) }
                ForEach(PersonalShortcuts.entries(PersonalShortcuts.desktopMessageBox, changes: changes)) { row($0) }
                ForEach(PersonalShortcuts.desktopFixed.dropFirst(3)) { row($0) }
            } header: { Text("Desktop app and browser: Message box") } footer: {
                Text("On Windows and Linux, ⌘ is Ctrl. You can change these under Settings › Shortcuts on your computer; what you changed shows here.")
            }
        }
        .task { await prefs.load() }
    }

    private func row(_ entry: PersonalShortcuts.Entry) -> some View {
        HStack(spacing: 12) {
            Text(entry.title).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            if let keys = entry.keys {
                HStack(spacing: 4) { ForEach(Array(keys.enumerated()), id: \.offset) { PersonalKeyCap(text: $1) } }
            } else {
                Text("Off").font(.subheadline).foregroundStyle(Theme.inkMuted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entry.title): \(entry.keys.map { $0.joined(separator: " ") } ?? "off")")
    }
}
