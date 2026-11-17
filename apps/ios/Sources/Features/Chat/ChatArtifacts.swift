import SwiftUI

enum ChatArtifactKind {
    static func symbol(_ type: String) -> String {
        switch type {
        case "code": "chevron.left.forwardslash.chevron.right"
        case "markdown": "text.alignleft"
        case "html": "safari"
        case "react": "atom"
        case "svg": "photo"
        case "mermaid": "point.3.connected.trianglepath.dotted"
        default: "doc"
        }
    }
    static func label(_ type: String) -> String {
        switch type {
        case "html": "Page"
        case "react": "React"
        case "svg": "Picture"
        case "mermaid": "Diagram"
        case "markdown": "Document"
        case "code": "Code"
        default: type.capitalized
        }
    }
}

/// The transcript's card for an `artifact` tool call: it opens the document, and says while it is still being written.
struct ArtifactCard: View {
    let step: ToolStep
    let artifacts: [JSON]
    let writing: Bool
    var partialInput: String?
    let open: (JSON) -> Void

    private var identifier: String {
        let given = step.call["input"]["identifier"].string
        if !given.isEmpty { return given }
        return ChatPartialJSON.field(partialInput, "identifier") ?? ""
    }
    private var artifact: JSON? { artifacts.first { $0["identifier"].string == identifier && !identifier.isEmpty } }
    private var title: String {
        artifact?["title"].string ?? (step.call["input"]["title"].stringOrNil ?? ChatPartialJSON.field(partialInput, "title") ?? "Artifact")
    }
    private var type: String { artifact?["type"].string ?? step.call["input"]["type"].stringOrNil ?? "code" }

    var body: some View {
        Button { if let artifact { open(artifact) } } label: {
            HStack(spacing: 14) {
                Image(systemName: ChatArtifactKind.symbol(type)).font(.system(size: 20, weight: .light)).foregroundStyle(Theme.inkSecondary)
                    .frame(width: 46, height: 46).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        if step.failed { Text("Failed").foregroundStyle(Theme.danger) }
                        else if writing && artifact == nil { ProgressView().controlSize(.mini); Text("Writing") }
                        else if let artifact { Text(ChatArtifactKind.label(type) + (artifact["versions"].int > 1 ? ", version \(artifact["version"].int)" : "")) }
                        else { Text(ChatArtifactKind.label(type)) }
                    }.font(.footnote).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 0)
                if artifact != nil { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted) }
            }
            .padding(12).card(radius: 18)
        }
        .buttonStyle(.plain).disabled(artifact == nil)
        .accessibilityLabel("\(title), \(ChatArtifactKind.label(type))")
        .accessibilityHint(artifact == nil ? "" : "Opens the artifact")
    }
}

/// Partly received tool input: a top-level string field read out of JSON that is still arriving.
enum ChatPartialJSON {
    static func field(_ json: String?, _ field: String) -> String? {
        guard let json, !json.isEmpty else { return nil }
        let needle = "\"\(field)\""
        guard let range = json.range(of: needle) else { return nil }
        var index = range.upperBound
        while index < json.endIndex, json[index].isWhitespace { index = json.index(after: index) }
        guard index < json.endIndex, json[index] == ":" else { return nil }
        index = json.index(after: index)
        while index < json.endIndex, json[index].isWhitespace { index = json.index(after: index) }
        guard index < json.endIndex, json[index] == "\"" else { return nil }
        index = json.index(after: index)
        var value = ""
        var escaped = false
        while index < json.endIndex {
            let character = json[index]
            if escaped {
                switch character { case "n": value.append("\n"); case "t": value.append("\t"); case "\"": value.append("\""); case "\\": value.append("\\"); default: value.append(character) }
                escaped = false
            } else if character == "\\" { escaped = true }
            else if character == "\"" { return value }
            else { value.append(character) }
            index = json.index(after: index)
        }
        return value
    }
}

/// The conversation's artifacts, in the panel beside it on an iPad and as a sheet on a phone.
struct ArtifactList: View {
    let store: AppStore
    /// In the side panel on an iPad: no navigation bar of its own (it would take over the conversation's).
    var embedded = false
    /// Closes the side panel (an iPad); the phone sheet has its own Done button.
    var close: (() -> Void)?
    @State private var content: JSON?
    @State private var opening: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if embedded {
            VStack(spacing: 0) {
                HStack {
                    Text("Artifacts").font(.headline)
                    Spacer()
                    Text("\(store.artifacts.count)").font(.subheadline).foregroundStyle(Theme.inkMuted)
                    if let close {
                        Button(action: close) { Image(systemName: "xmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.inkSecondary).frame(width: 32, height: 32).background(Theme.fill, in: Circle()) }
                            .buttonStyle(.plain).accessibilityLabel("Close artifacts")
                    }
                }.padding(.horizontal, 20).padding(.vertical, 12)
                rows
            }
            .background(Theme.sunken)
            .sheet(isPresented: Binding(get: { content != nil }, set: { if !$0 { content = nil } })) { ArtifactView(artifact: content ?? .null, store: store) }
        } else {
            NavigationStack {
                rows
                    .navigationTitle("Artifacts").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                    .sheet(isPresented: Binding(get: { content != nil }, set: { if !$0 { content = nil } })) { ArtifactView(artifact: content ?? .null, store: store) }
            }
            .tint(Theme.clay)
        }
    }

    @ViewBuilder private var rows: some View {
        if store.artifacts.isEmpty {
            ScrollView { EmptyState(title: "No artifacts here", symbol: "doc.on.doc", message: "Documents, pages and code that Atelier writes in this conversation collect here.").padding(.top, 40) }.background(Theme.sunken)
        } else {
            List(store.artifacts, id: \.self) { artifact in
                ChatArtifactRow(artifact: artifact, busy: opening == artifact["id"].string) { open(artifact) }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
        }
    }

    private func open(_ artifact: JSON) {
        opening = artifact["id"].string
        Task {
            defer { opening = nil }
            do { content = try await store.rpc.call("artifacts.get", ["id": artifact["id"]]) } catch { store.error = ChatError.text(error) }
        }
    }
}

struct ChatArtifactRow: View {
    let artifact: JSON
    var busy = false
    var subtitle: String?
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                IconTile(symbol: ChatArtifactKind.symbol(artifact["type"].string), size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact["title"].string.isEmpty ? "Untitled" : artifact["title"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(subtitle ?? ChatArtifactKind.label(artifact["type"].string)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
                }
                Spacer()
                if busy { ProgressView() } else { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted) }
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(busy)
    }
}

@MainActor @Observable final class ChatArtifactsModel {
    var items: [JSON] = []
    var cursor: String?
    var state: ChatGalleryModel.LoadState = .idle
    var type = ""

    func load(store: AppStore, more: Bool = false) async {
        if more { guard cursor != nil else { return }; state = .more } else { state = .loading }
        var params: [String: JSON] = ["limit": 60]
        if more, let cursor { params["cursor"] = .string(cursor) }
        if !type.isEmpty { params["type"] = .string(type) }
        do {
            let page = try await store.rpc.call("artifacts.listAll", params)
            items = more ? items + page["items"].array : page["items"].array
            cursor = page["nextCursor"].stringOrNil
            state = .loaded
        } catch is CancellationError { return } catch { state = .failed(ChatError.text(error)) }
    }
}

/// Every artifact across the person's conversations, newest first; it opens the document or its conversation.
struct ArtifactsPage: View {
    let store: AppStore
    var openConversation: (String) -> Void = { _ in }
    @State private var model = ChatArtifactsModel()
    @State private var content: JSON?
    @State private var opening: String?
    @State private var query = ""

    private var shown: [JSON] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? model.items : model.items.filter { $0["title"].string.lowercased().contains(needle) || $0["sessionTitle"].string.lowercased().contains(needle) }
    }

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message): ScrollView { InlineError(message: ChatError.isUnsupported(MobileError.message(message)) ? ChatError.unsupported : message) { Task { await model.load(store: store) } }.padding(.top, 60) }
            default:
                if shown.isEmpty {
                    ScrollView { EmptyState(title: model.items.isEmpty ? "No artifacts yet" : "Nothing matches", symbol: "doc.on.doc", message: model.items.isEmpty ? "Documents, pages and code that Atelier writes for you collect here." : "Try another search or type.").padding(.top, 60) }
                } else {
                    List {
                        ForEach(shown, id: \.self) { artifact in
                            ChatArtifactRow(artifact: artifact, busy: opening == artifact["id"].string, subtitle: "\(ChatArtifactKind.label(artifact["type"].string)) · \(artifact["sessionTitle"].string.isEmpty ? "Untitled conversation" : artifact["sessionTitle"].string)") { open(artifact) }
                                .swipeActions { Button { openConversation(artifact["sessionId"].string) } label: { Label("Conversation", systemImage: "bubble.left") }.tint(Theme.clay) }
                                .onAppear { if artifact == model.items.last { Task { await model.load(store: store, more: true) } } }
                        }
                        if model.state == .more { HStack { Spacer(); ProgressView(); Spacer() } }
                    }.scrollContentBackground(.hidden)
                }
            }
        }
        .background(Theme.sunken)
        .navigationTitle("Artifacts").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search artifacts")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Show", selection: $model.type) {
                        Text("All types").tag("")
                        ForEach(["markdown", "html", "svg", "mermaid", "react", "code"], id: \.self) { Text(ChatArtifactKind.label($0)).tag($0) }
                    }
                } label: { Image(systemName: model.type.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }.accessibilityLabel("Filter by type")
            }
        }
        .onChange(of: model.type) { _, _ in Task { await model.load(store: store) } }
        .refreshable { await model.load(store: store) }
        .task { if model.state == .idle { await model.load(store: store) } }
        .sheet(isPresented: Binding(get: { content != nil }, set: { if !$0 { content = nil } })) { ArtifactView(artifact: content ?? .null, store: store) }
    }

    private func open(_ artifact: JSON) {
        opening = artifact["id"].string
        Task {
            defer { opening = nil }
            do { content = try await store.rpc.call("artifacts.get", ["id": artifact["id"]]) } catch { store.error = ChatError.text(error) }
        }
    }
}
