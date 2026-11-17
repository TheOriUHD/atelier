import SwiftUI

// MARK: - Privacy: what is kept, a copy of everything, deleting it all, and what leaves this device

enum PersonalRetention {
    static let forever = "forever"
    static let standard: [(String, String)] = [(forever, "Keep everything"), ("30", "30 days"), ("90", "90 days"), ("365", "365 days")]

    /// The pick for a stored period (null keeps everything).
    static func pick(for value: JSON) -> String {
        guard case .number(let days) = value else { return forever }
        return String(Int(days))
    }

    /// A period set some other way is still listed as it is.
    static func options(including pick: String) -> [(String, String)] {
        standard.contains { $0.0 == pick } ? standard : standard + [(pick, "\(pick) days")]
    }

    static func value(for pick: String) -> JSON { pick == forever ? .null : .number(Double(pick) ?? 0) }
}

private enum PrivacyRoute: String, Hashable { case deleteAll, leaves }

struct PrivacySettings: View {
    let store: AppStore
    @State private var prefs: PersonalPrefs
    @State private var route: PrivacyRoute?
    @State private var exporting = false
    @State private var shared: PersonalSharedFile?
    @State private var confirmClear = false

    init(store: AppStore) {
        self.store = store
        _prefs = State(initialValue: PersonalPrefs(store: store))
        #if DEBUG
        _route = State(initialValue: Launch.value("--sub").flatMap(PrivacyRoute.init(rawValue:)))
        #endif
    }

    var body: some View {
        PersonalPage(title: "Privacy") {
            PersonalPrefsGate(prefs: prefs) {
                Section {
                    let pick = PersonalRetention.pick(for: prefs.value(["privacy", "historyRetentionDays"]))
                    PickRow(title: "Keep conversations", subtitle: "Conversations untouched for longer than this are deleted once a day. Pinned ones stay.",
                            selection: Binding(get: { PersonalRetention.pick(for: prefs.value(["privacy", "historyRetentionDays"])) },
                                               set: { value in Task { await prefs.set(["privacy", "historyRetentionDays"], PersonalRetention.value(for: value)) } }),
                            options: PersonalRetention.options(including: pick))
                } header: { Text("History") }
                Section {
                    Picker("Temporary chats", selection: prefs.stringBinding(["privacy", "temporaryChats"], default: "private")) {
                        Text("Don't save").tag("private")
                        Text("Start fresh").tag("fresh")
                    }
                    .pickerStyle(.inline).labelsHidden()
                } header: { Text("Temporary chats") } footer: {
                    Text("Temporary chats never appear in your history and are deleted when you leave them. “Don't save” lets the model use your memory and instructions; “Start fresh” also keeps your memory, personal instructions and projects away from the model.")
                }
            }
            Section {
                PersonalIconAction(title: "Export my data", symbol: "square.and.arrow.up", busy: exporting) { exportData() }
                NavigationLink { PersonalDeleteAllPage(store: store) } label: {
                    NavRow(symbol: "trash", tint: Theme.danger, title: "Delete all conversations")
                }
            } header: { Text("Your data") } footer: {
                Text("The export is a zip with all your conversations (as JSON and Markdown), projects, artifacts, files and memory. Deleting removes every chat and Code session, with its messages, files and artifacts. Projects stay. This can't be undone.")
            }
            Section {
                NavigationLink { PersonalLeavesDevicePage(store: store) } label: { NavRow(symbol: "network", title: "What leaves this device") }
                PersonalIconAction(title: "Clear drafts on this device", symbol: "eraser", destructive: true) { confirmClear = true }
            } header: { Text("On this device") } footer: {
                Text("Your sign-in stays in this device's Keychain. Drafts are protected by iOS and left out of backups. Messages and files go to your server.")
            }
        }
        .task { await prefs.load() }
        .refreshable { await prefs.load() }
        .navigationDestination(item: $route) { route in
            switch route {
            case .deleteAll: PersonalDeleteAllPage(store: store)
            case .leaves: PersonalLeavesDevicePage(store: store)
            }
        }
        .sheet(item: $shared) { file in PersonalShareSheet(url: file.url).presentationDetents([.medium, .large]) }
        .confirmationDialog("Clear drafts on this device?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear drafts", role: .destructive) { store.clearDrafts(); store.draft = ""; store.attachments = []; store.notify("Drafts cleared") }
        } message: { Text("Unsent messages and attachments saved on this device are removed. Nothing on your server changes.") }
    }

    private func exportData() {
        exporting = true
        personalAction(store) {
            defer { exporting = false }
            let made = try await store.rpc.call("privacy.export")
            let name = made["name"].string.isEmpty ? "atelier-export.zip" : made["name"].string
            shared = PersonalSharedFile(url: try await PersonalBlob.download(store: store, sha: made["sha256"].string, fileName: name))
        }
    }
}

/// The desktop's strong confirmation: the person types DELETE before the button works.
struct PersonalDeleteAllPage: View {
    let store: AppStore
    @State private var typed = ""
    @State private var deleting = false
    @Environment(\.dismiss) private var dismiss
    private var armed: Bool { typed.trimmingCharacters(in: .whitespaces).uppercased() == "DELETE" }

    var body: some View {
        PersonalPage(title: "Delete all conversations") {
            Section {
                Label {
                    Text("Every chat and Code session is deleted with its messages, files and artifacts. Projects stay, without their chats. This can't be undone.")
                        .foregroundStyle(Theme.ink)
                } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.danger) }
            }
            Section {
                FieldRow(title: "Type DELETE to confirm", placeholder: "DELETE", text: $typed, mono: true)
                    .textInputAutocapitalization(.characters).disabled(deleting)
                ActionRow(title: "Delete all conversations", symbol: "trash", destructive: true, busy: deleting) { deleteAll() }
                    .disabled(!armed)
            } footer: { Text("Export your data first if you want a copy.") }
        }
    }

    private func deleteAll() {
        guard armed else { return }
        deleting = true
        personalAction(store) {
            defer { deleting = false }
            let result = try await store.rpc.call("privacy.deleteConversations")
            let count = result["deleted"].int
            store.notify(count == 1 ? "Deleted 1 conversation" : "Deleted \(count) conversations")
            try? await store.refresh()
            if let open = store.selected, !store.sessions.contains(where: { $0.id == open }) { store.newConversation() }
            dismiss()
        }
    }
}

/// Where the app's data goes, in a few plain sentences, and a link to the full list.
struct PersonalLeavesDevicePage: View {
    let store: AppStore
    var body: some View {
        PersonalPage(title: "What leaves this device") {
            Section {
                fact("server.rack", "Your Atelier server", "Everything you do in the app goes to \(URL(string: store.address)?.host ?? "your server") and nowhere else: your messages, the files and photos you attach, what you dictate while the microphone is on, and your settings. The app has no other connection.")
                fact("cpu", "From your server onward", "Your server passes your conversations to the model providers that were set up for it, and to services you switch on, such as web search and connectors. What each of them receives is in the full list.")
                fact("paperplane", "The Atelier developer", "Only when you press Send on an issue report or a feature request: what you wrote and what you chose to attach. You see all of it first.")
                fact("eye.slash", "Never", "No analytics, no advertising, no tracking and no automatic crash reports. The app sets no cookies.")
            }
            Section("Kept on this device") {
                fact("key", "Your sign-in", "In this device's Keychain, only while it is unlocked and never copied to other devices.")
                fact("square.and.pencil", "Unsent drafts", "Protected by iOS and left out of backups. You can clear them under Privacy.")
            }
            Section { PersonalLinkRow(title: "The full list", symbol: "doc.text", url: "https://docs.atelierhq.dev/privacy/", subtitle: "Every connection Atelier makes, and whether you can turn it off") }
        }
    }

    private func fact(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink)
                Text(text).font(.subheadline).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}
