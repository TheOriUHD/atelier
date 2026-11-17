import SwiftUI

/// Moving between conversations, leaving a temporary one, and the session the screen is looking at.
@MainActor enum ChatNav {
    /// The open conversation as a summary: from the list, else from the snapshot (a temporary chat is never listed).
    static func session(_ store: AppStore) -> Conversation? {
        guard let id = store.selected else { return nil }
        if let listed = store.sessions.first(where: { $0.id == id }) { return listed }
        let snapshot = store.transcript.snapshot["session"]
        return snapshot["id"].string == id ? Conversation(raw: snapshot) : nil
    }

    /// Whether the open conversation's snapshot has arrived (until then the page shows it loading).
    static func loaded(_ store: AppStore) -> Bool { store.selected == nil || store.transcript.snapshot["session"]["id"].string == store.selected }

    /// Leaving a temporary chat deletes it: it is never kept.
    static func leaveTemporary(_ store: AppStore) async {
        guard let id = store.selected, let session = session(store), session.isTemporary else { return }
        _ = try? await store.rpc.call("sessions.leave", ["id": .string(id)])
        store.sessions.removeAll { $0.id == id }
    }

    static func open(_ store: AppStore, _ id: String) async {
        let hub = ChatHub.of(store)
        if store.selected != id { await leaveTemporary(store) }
        hub.openError = nil
        do { try await store.open(id) } catch is CancellationError { return } catch { hub.openError = ChatError.text(error) }
    }

    static func newConversation(_ store: AppStore, project: String? = nil) {
        let hub = ChatHub.of(store)
        Task {
            await leaveTemporary(store)
            hub.newOptions.reset()
            hub.openError = nil
            store.newConversation()
            store.project = project
        }
    }
}

/// What a session's menu can ask the screen to do: a name to type, a deletion to confirm.
@MainActor @Observable final class ChatSessionPrompt {
    var rename: Conversation?
    var delete: Conversation?
    var leave: Conversation?
    var newGroup: Conversation?
    var name = ""
}

/// The actions on one conversation, as the desktop's menu has them: pin, read state, rename, fork, project, group,
/// archive, delete. A guest in someone else's co-op conversation files it for themselves and leaves instead of deleting.
struct ChatSessionActions: View {
    let store: AppStore
    let session: Conversation
    let prompt: ChatSessionPrompt
    var onForked: (String) -> Void = { _ in }
    private var hub: ChatHub { ChatHub.of(store) }

    var body: some View {
        Button(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin") { run { try await ChatActions.setPinned(store, session.id, !session.pinned) } }
        if session.unseen || session.status == "idle" {
            Button(session.unseen ? "Mark as read" : "Mark as unread", systemImage: session.unseen ? "envelope.open" : "envelope.badge") {
                run { if session.unseen { try await ChatActions.markSeen(store, session.id) } else { try await ChatActions.setUnread(store, session.id) } }
            }
        }
        Button("Rename", systemImage: "pencil") { prompt.name = session.raw["title"].string; prompt.rename = session }
        if !session.isGuest {
            Button("Fork", systemImage: "arrow.triangle.branch") { Task { do { let id = try await ChatActions.fork(store, session.id); try await store.refresh(); onForked(id) } catch { store.error = ChatError.text(error) } } }
        }
        Divider()
        groupMenu
        if session.mode == "chat", !session.isGuest { projectMenu }
        Divider()
        Button(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "archivebox.fill" : "archivebox") { run { try await ChatActions.setArchived(store, session.id, !session.archived) } }
        if session.isGuest, !session.coopEnded {
            Button("Leave", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { prompt.leave = session }
        } else {
            Button(session.isGuest ? "Remove from sidebar" : "Delete", systemImage: "trash", role: .destructive) { prompt.delete = session }
        }
    }

    private var groupMenu: some View {
        Menu {
            ForEach(hub.groups, id: \.self) { group in
                Button { run { try await ChatActions.move(store, session.id, toGroup: group["id"].string) } } label: {
                    if session.groupID == group["id"].string { Label(group["name"].string, systemImage: "checkmark") } else { Text(group["name"].string) }
                }
            }
            if !hub.groups.isEmpty { Divider() }
            Button("Ungrouped") { run { try await ChatActions.move(store, session.id, toGroup: nil) } }.disabled(session.groupID == nil)
            Button("New group…", systemImage: "plus") { prompt.name = ""; prompt.newGroup = session }
        } label: { Label("Move to group", systemImage: "folder") }
    }

    @ViewBuilder private var projectMenu: some View {
        if !store.projects.isEmpty {
            Menu {
                ForEach(store.projects, id: \.self) { project in
                    Button(project["name"].string) { run { try await ChatActions.move(store, session.id, toProject: project["id"].string) } }.disabled(session.projectID == project["id"].string)
                }
            } label: { Label("Add to project", systemImage: "folder.badge.plus") }
        }
        if session.projectID != nil {
            Button("Remove from project", systemImage: "folder.badge.minus") { run { try await ChatActions.move(store, session.id, toProject: nil) } }
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await operation() } catch { store.error = ChatError.text(error) }
        }
    }
}

/// The text field, the confirmation and the new group a session's menu asks for.
struct ChatSessionPrompts: ViewModifier {
    let store: AppStore
    @Bindable var prompt: ChatSessionPrompt
    var onGone: (String) -> Void = { _ in }
    @State private var failed: String?

    func body(content: Content) -> some View {
        content
            .alert("Rename", isPresented: Binding(get: { prompt.rename != nil }, set: { if !$0 { prompt.rename = nil } })) {
                TextField("Name", text: $prompt.name)
                Button("Cancel", role: .cancel) { prompt.rename = nil }
                Button("Save") {
                    guard let session = prompt.rename else { return }
                    let name = prompt.name
                    Task { do { try await ChatActions.rename(store, session.id, to: name) } catch { store.error = ChatError.text(error) } }
                }
            }
            .alert("New group", isPresented: Binding(get: { prompt.newGroup != nil }, set: { if !$0 { prompt.newGroup = nil } })) {
                TextField("Group name", text: $prompt.name)
                Button("Cancel", role: .cancel) { prompt.newGroup = nil }
                Button("Create and move") {
                    guard let session = prompt.newGroup, !prompt.name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    let name = prompt.name
                    Task {
                        do {
                            let group = try await ChatActions.createGroup(store, ChatHub.of(store), name: name)
                            try await ChatActions.move(store, session.id, toGroup: group["id"].string)
                        } catch { store.error = ChatError.text(error) }
                    }
                }
            }
            .confirmationDialog(deleteTitle, isPresented: Binding(get: { prompt.delete != nil }, set: { if !$0 { prompt.delete = nil } }), titleVisibility: .visible) {
                Button(prompt.delete?.isGuest == true ? "Remove" : "Delete", role: .destructive) {
                    guard let session = prompt.delete else { return }
                    Task { do { try await ChatActions.delete(store, session.id); onGone(session.id) } catch { store.error = ChatError.text(error) } }
                }
            } message: { Text(deleteMessage) }
            .confirmationDialog("Leave this session?", isPresented: Binding(get: { prompt.leave != nil }, set: { if !$0 { prompt.leave = nil } }), titleVisibility: .visible) {
                Button("Leave", role: .destructive) {
                    guard let session = prompt.leave else { return }
                    Task { do { try await ChatActions.leaveCoop(store, session.id); onGone(session.id) } catch { store.error = ChatError.text(error) } }
                }
            } message: { Text("You need a new invite to come back.") }
    }

    private var deleteTitle: String {
        guard let session = prompt.delete else { return "Delete?" }
        return session.isGuest ? "Remove from your list?" : "Delete this \(session.noun)?"
    }
    private var deleteMessage: String {
        guard let session = prompt.delete else { return "" }
        return session.isGuest ? "Co-op in \"\(session.displayTitle)\" ended. It goes from your list." : "\"\(session.displayTitle)\" and its artifacts will be deleted. This can't be undone."
    }
}

extension View {
    func chatSessionPrompts(store: AppStore, prompt: ChatSessionPrompt, onGone: @escaping (String) -> Void = { _ in }) -> some View {
        modifier(ChatSessionPrompts(store: store, prompt: prompt, onGone: onGone))
    }
}
