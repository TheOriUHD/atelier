import SwiftUI

/// Side chats (`/btw`): a question beside a conversation. It sees the conversation, only reads, and never joins it.
struct ChatSideChatsSheet: View {
    let store: AppStore
    var open: (String) -> Void
    @State private var chats: [JSON] = []
    @State private var state: ChatGalleryModel.LoadState = .idle
    @State private var question = ""
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    private var hub: ChatHub { ChatHub.of(store) }
    private var parent: String { store.selected ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("Ask a side question", text: $question, axis: .vertical).lineLimit(1...5)
                        Button { start() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).foregroundStyle(Theme.clay) }.buttonStyle(.plain).disabled(busy || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityLabel("Ask")
                    }
                } footer: { Text("A side chat sees this conversation and only reads. It doesn't join it or wait for it.") }
                Section {
                    switch state {
                    case .idle, .loading: HStack { Spacer(); ProgressView(); Spacer() }
                    case .failed(let message): InlineError(message: message) { Task { await load() } }.listRowBackground(Color.clear)
                    default:
                        if chats.isEmpty { Text("No side chats yet.").foregroundStyle(Theme.inkMuted) }
                        ForEach(chats, id: \.self) { chat in
                            Button { go(chat["id"].string) } label: {
                                HStack(spacing: 12) {
                                    IconTile(symbol: "bubble.left.and.text.bubble.right", size: 32)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(chat["title"].string.isEmpty ? "Side chat" : chat["title"].string).font(.body).foregroundStyle(Theme.ink).lineLimit(2)
                                        Text(Date(timeIntervalSince1970: chat["updatedAt"].double / 1000).relative).font(.footnote).foregroundStyle(Theme.inkMuted)
                                    }
                                    Spacer()
                                    if chat["status"].string == "running" { ProgressView().controlSize(.small) }
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            .swipeActions { Button(role: .destructive) { close(chat) } label: { Label("Close", systemImage: "xmark.bin") } }
                        }
                    }
                } header: { Text("Side chats") }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Side chats").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
            .onChange(of: hub.sideChatTick[parent]) { _, _ in Task { await load() } }
        }.tint(Theme.clay).presentationDetents([.medium, .large])
    }

    private func load() async {
        do { chats = try await ChatActions.sideChats(store, of: parent); state = .loaded } catch is CancellationError { return } catch { state = chats.isEmpty ? .failed(ChatError.text(error)) : .loaded }
    }

    private func start() {
        busy = true
        let text = question
        Task {
            defer { busy = false }
            do { let id = try await ChatActions.startSideChat(store, question: text); question = ""; go(id) } catch { store.error = ChatError.text(error) }
        }
    }

    private func go(_ id: String) {
        hub.sideChatParent[id] = parent
        open(id)
    }

    private func close(_ chat: JSON) {
        Task {
            do { try await ChatActions.delete(store, chat["id"].string); chats.removeAll { $0["id"] == chat["id"] } } catch { store.error = ChatError.text(error) }
        }
    }
}
