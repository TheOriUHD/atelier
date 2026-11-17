import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

enum ChatProjectMeta {
    /// "Updated 3 days ago · 4 chats · 2 files"; zero counts are left out.
    static func line(_ project: JSON) -> String {
        let updated = Date(timeIntervalSince1970: project["updatedAt"].double / 1000)
        return ["Updated \(updated.relative)", project["sessionCount"].int > 0 ? ChatText.plural(project["sessionCount"].int, "chat") : nil, project["fileCount"].int > 0 ? ChatText.plural(project["fileCount"].int, "file") : nil].compactMap { $0 }.joined(separator: " · ")
    }

    /// Short type label from the extension, else the MIME subtype: "PDF", "MD".
    static func fileType(_ file: JSON) -> String {
        let ext = URL(fileURLWithPath: file["name"].string).pathExtension
        if !ext.isEmpty, ext.count <= 5 { return ext.uppercased() }
        return file["mime"].string.split(separator: "/").last.map { String($0).uppercased() } ?? "FILE"
    }

    static let budget = 60_000

    /// How a project's files use the prompt budget: in upload order, each file whose text still fits goes in.
    static func fileBudget(_ files: [JSON]) -> (total: Int, over: Set<String>) {
        var left = budget
        var included = Set<String>()
        for file in files {
            guard file["tokens"] != .null else { continue }
            let tokens = file["tokens"].int
            if tokens > left { continue }
            left -= tokens
            included.insert(file["id"].string)
        }
        let over = Set(files.filter { $0["tokens"] != .null && !included.contains($0["id"].string) }.map { $0["id"].string })
        return (files.reduce(0) { $0 + ($1["tokens"] == .null ? 0 : $1["tokens"].int) }, over)
    }
}

/// Projects keep related conversations together and give each new one the same instructions and files.
struct ChatProjectsPage: View {
    let store: AppStore
    var initial: String?
    let open: (String) -> Void
    let startIn: (String) -> Void
    @State private var resource: Resource<[JSON]>
    @State private var path: [String] = []
    @State private var query = ""
    @State private var sort = "updated"
    @State private var creating = false
    @State private var name = ""
    @State private var description = ""
    @State private var didStart = false

    init(store: AppStore, initial: String? = nil, open: @escaping (String) -> Void, startIn: @escaping (String) -> Void) {
        self.store = store; self.initial = initial; self.open = open; self.startIn = startIn
        _resource = State(initialValue: Resource { try await store.rpc.call("projects.list").array })
    }

    private func visible(_ projects: [JSON]) -> [JSON] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let matches = needle.isEmpty ? projects : projects.filter { $0["name"].string.lowercased().contains(needle) || $0["description"].string.lowercased().contains(needle) }
        return matches.sorted {
            sort == "name" ? $0["name"].string.localizedCaseInsensitiveCompare($1["name"].string) == .orderedAscending : $0["updatedAt"].double > $1["updatedAt"].double
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ResourceList(resource: resource, isEmpty: { $0.isEmpty }, empty: { EmptyState(title: "Start a project", symbol: "folder", message: "Keep related chats together and give every new one the same instructions and files.", actionTitle: "New project") { creating = true } }) { projects in
                let shown = visible(projects)
                if shown.isEmpty { Text("No projects match \"\(query.trimmingCharacters(in: .whitespaces))\".").foregroundStyle(Theme.inkMuted) }
                ForEach(shown, id: \.self) { project in
                    NavigationLink(value: project["id"].string) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(project["name"].string).font(.system(.body, weight: .medium)).lineLimit(1)
                                if project["pinnedAt"] != .null { Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(Theme.inkMuted).accessibilityLabel("Pinned") }
                            }
                            if !project["description"].string.isEmpty { Text(project["description"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary).lineLimit(2) }
                            Text(ChatProjectMeta.line(project)).font(.footnote).foregroundStyle(Theme.inkMuted)
                        }.padding(.vertical, 4)
                    }
                }
            }
            .searchable(text: $query, prompt: "Search projects")
            .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu { Picker("Sort", selection: $sort) { Text("Recently updated").tag("updated"); Text("Name").tag("name") } } label: { Image(systemName: "arrow.up.arrow.down") }.accessibilityLabel("Sort")
                }
                ToolbarItem(placement: .topBarTrailing) { Button { name = ""; description = ""; creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New project") }
            }
            .navigationDestination(for: String.self) { id in
                ChatProjectView(store: store, id: id, open: open, startIn: startIn) { Task { await resource.reload() } }
            }
            .sheet(isPresented: $creating) { ChatProjectDetailsSheet(store: store, project: nil) { project in Task { await resource.reload(); path.append(project["id"].string) } } }
            .task { if !didStart, let initial { didStart = true; path = [initial] } }
            .onReceive(NotificationCenter.default.publisher(for: .atelierProjectsChanged)) { _ in Task { await resource.reload() } }
        }
    }
}

extension Notification.Name {
    static let atelierProjectsChanged = Notification.Name("atelier.projectsChanged")
}

/// Name and description: creates a project, or edits one.
struct ChatProjectDetailsSheet: View {
    let store: AppStore
    let project: JSON?
    var saved: (JSON) -> Void
    @State private var name: String
    @State private var description: String
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, project: JSON?, saved: @escaping (JSON) -> Void) {
        self.store = store; self.project = project; self.saved = saved
        _name = State(initialValue: project?["name"].string ?? "")
        _description = State(initialValue: project?["description"].string ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("Name your project", text: $name).onChange(of: name) { _, value in if value.count > 120 { name = String(value.prefix(120)) } } }
                Section { TextField("What is this project about?", text: $description, axis: .vertical).lineLimit(3...8).onChange(of: description) { _, value in if value.count > 2000 { description = String(value.prefix(2000)) } } } header: { Text("Description") }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle(project == nil ? "New project" : "Edit details").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(project == nil ? "Create" : "Save") { save() }.disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }.tint(Theme.clay).presentationDetents([.medium, .large])
    }

    private func save() {
        busy = true
        Task {
            defer { busy = false }
            do {
                let result: JSON
                if let project { result = try await ChatActions.updateProject(store, id: project["id"].string, patch: ["name": .string(name.trimmingCharacters(in: .whitespaces)), "description": .string(description.trimmingCharacters(in: .whitespaces))]) }
                else { result = try await ChatActions.createProject(store, name: name, description: description) }
                saved(result)
                dismiss()
            } catch { store.error = ChatError.text(error) }
        }
    }
}

@MainActor @Observable final class ChatProjectModel {
    var project: JSON = .null
    var chats: [JSON] = []
    var state: ChatGalleryModel.LoadState = .idle
    var uploading: [String] = []

    func load(_ store: AppStore, id: String) async {
        if project == .null { state = .loading }
        do {
            async let detail = store.rpc.call("projects.get", ["id": .string(id)])
            async let sessions = store.rpc.call("sessions.list", ["projectId": .string(id), "mode": .string("chat"), "limit": 100])
            project = try await detail
            chats = try await sessions.array.sorted { $0["updatedAt"].double > $1["updatedAt"].double }
            state = .loaded
        } catch is CancellationError { return } catch {
            state = project == .null ? .failed(ChatError.text(error)) : .loaded
        }
    }

    func add(_ store: AppStore, id: String, data: Data, name: String, mime: String) async {
        uploading.append(name)
        defer { uploading.removeAll { $0 == name } }
        do {
            _ = try await ChatActions.addProjectFile(store, projectId: id, data: data, name: name, mime: mime)
            await load(store, id: id)
        } catch is CancellationError { return } catch { store.error = "\(name): \(ChatError.text(error))" }
    }
}

/// One project: its instructions and files, its chats, and a way to start a new one inside it.
struct ChatProjectView: View {
    let store: AppStore
    let id: String
    let open: (String) -> Void
    let startIn: (String) -> Void
    var changed: () -> Void = {}
    @State private var model = ChatProjectModel()
    @State private var editing = false
    @State private var instructions = false
    @State private var deleting = false
    @State private var filePicker = false
    @State private var photoPicker = false
    @State private var photos: [PhotosPickerItem] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message): ScrollView { InlineError(message: message) { Task { await model.load(store, id: id) } }.padding(.top, 60) }
            default: list
            }
        }
        .background(Theme.sunken)
        .navigationTitle(model.project["name"].string).navigationBarTitleDisplayMode(.inline)
        .toolbar { if model.project != .null { ToolbarItem(placement: .topBarTrailing) { menu } } }
        .task { await model.load(store, id: id) }
        .refreshable { await model.load(store, id: id) }
        .sheet(isPresented: $editing) { ChatProjectDetailsSheet(store: store, project: model.project) { _ in changed(); Task { await model.load(store, id: id) } } }
        .sheet(isPresented: $instructions) { ChatInstructionsSheet(store: store, project: model.project) { changed(); Task { await model.load(store, id: id) } } }
        .confirmationDialog("Delete \"\(model.project["name"].string)\"?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete project", role: .destructive) { Task { do { try await ChatActions.deleteProject(store, id: id); changed(); dismiss() } catch { store.error = ChatError.text(error) } } }
        } message: { Text("Its instructions and files will be deleted. Its chats are kept, outside any project. This can't be undone.") }
        .fileImporter(isPresented: $filePicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { for url in urls { Task { await addFile(url) } } } else if case .failure(let error) = result { store.error = error.localizedDescription }
        }
        .photosPicker(isPresented: $photoPicker, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            for item in items { Task { if let data = try? await item.loadTransferable(type: Data.self) { await model.add(store, id: id, data: data, name: "Photo.\(item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")", mime: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg") } } }
        }
    }

    private var menu: some View {
        Menu {
            Button(model.project["pinnedAt"] == .null ? "Pin" : "Unpin", systemImage: model.project["pinnedAt"] == .null ? "pin" : "pin.slash") {
                Task { do { _ = try await ChatActions.updateProject(store, id: id, patch: ["pinned": .bool(model.project["pinnedAt"] == .null)]); changed(); await ChatHub.of(store).reloadProjects(); await model.load(store, id: id) } catch { store.error = ChatError.text(error) } }
            }
            Button("Edit details", systemImage: "pencil") { editing = true }
            Divider()
            Button("Delete project", systemImage: "trash", role: .destructive) { deleting = true }
        } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Project actions")
    }

    private var list: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.project["name"].string).font(.system(.title2, design: .serif, weight: .medium))
                    if !model.project["description"].string.isEmpty { Text(model.project["description"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary) }
                }.padding(.vertical, 4)
                Button { startIn(id) } label: { Label("New chat in this project", systemImage: "square.and.pencil").foregroundStyle(Theme.clay).font(.system(.body, weight: .medium)) }
            }
            Section {
                Button { instructions = true } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Label("Instructions", systemImage: "note.text").foregroundStyle(Theme.ink); Spacer(); Text(model.project["instructions"].string.isEmpty ? "Add" : "Edit").foregroundStyle(Theme.clay) }
                        if !model.project["instructions"].string.isEmpty { Text(model.project["instructions"].string).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(3).multilineTextAlignment(.leading) }
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            } footer: { Text("Every new chat in this project starts with these instructions.") }
            filesSection
            chatsSection
        }
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder private var filesSection: some View {
        let files = model.project["files"].array
        let budget = ChatProjectMeta.fileBudget(files)
        Section {
            if files.isEmpty && model.uploading.isEmpty {
                Text("Add files to include their text in every new chat in this project.").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            if !files.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Prompt budget").font(.caption).foregroundStyle(Theme.inkMuted); Spacer(); Text("\(ChatText.tokens(budget.total)) / \(ChatText.tokens(ChatProjectMeta.budget)) tokens").font(.caption.monospacedDigit()).foregroundStyle(Theme.inkMuted) }
                    ProgressView(value: min(1, Double(budget.total) / Double(ChatProjectMeta.budget))).tint(budget.over.isEmpty ? Theme.clay : Color(hex: 0xB77800))
                    if !budget.over.isEmpty { Label("\(budget.over.count == 1 ? "1 file doesn't fit the budget and is" : "\(budget.over.count) files don't fit the budget and are") left out of new chats.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Color(hex: 0xB77800)) }
                }
            }
            ForEach(files, id: \.self) { file in
                HStack(spacing: 12) {
                    IconTile(symbol: "doc.text", size: 34)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file["name"].string).font(.body).lineLimit(1).truncationMode(.middle)
                        Text([ChatProjectMeta.fileType(file), ChatText.bytes(file["size"].int), file["tokens"] == .null ? "No readable text" : "\(ChatText.tokens(file["tokens"].int)) tokens", budget.over.contains(file["id"].string) ? "Over budget" : nil].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
                    }
                }
                .swipeActions { Button(role: .destructive) { remove(file) } label: { Label("Remove", systemImage: "trash") } }
                .contextMenu { Button("Remove", systemImage: "trash", role: .destructive) { remove(file) } }
            }
            ForEach(model.uploading, id: \.self) { name in HStack(spacing: 12) { ProgressView(); Text(name).foregroundStyle(Theme.inkSecondary).lineLimit(1) } }
        } header: {
            HStack {
                Text("Files")
                Spacer()
                Menu { Button("Choose a file", systemImage: "doc") { filePicker = true }; Button("Photo library", systemImage: "photo") { photoPicker = true } } label: { Text("Add").font(.footnote.weight(.semibold)).textCase(nil) }
            }
        }
    }

    @ViewBuilder private var chatsSection: some View {
        Section {
            if model.chats.isEmpty {
                Text("Chats you start here use this project's instructions and files.").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            ForEach(model.chats, id: \.self) { chat in
                Button { open(chat["id"].string) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(chat["title"].string.isEmpty ? "New conversation" : chat["title"].string).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                        Text("Last activity \(Date(timeIntervalSince1970: chat["updatedAt"].double / 1000).relative)").font(.footnote).foregroundStyle(Theme.inkMuted)
                    }.padding(.vertical, 2)
                }.buttonStyle(.plain)
            }
        } header: { Text("Chats") }
    }

    private func remove(_ file: JSON) {
        Task { do { try await ChatActions.removeProjectFile(store, projectId: id, fileId: file["id"].string); await model.load(store, id: id) } catch { store.error = ChatError.text(error) } }
    }

    private func addFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { store.error = "\(url.lastPathComponent) could not be read."; return }
        await model.add(store, id: id, data: data, name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
    }
}

struct ChatInstructionsSheet: View {
    let store: AppStore
    let project: JSON
    var saved: () -> Void
    @State private var text: String
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, project: JSON, saved: @escaping () -> Void) {
        self.store = store; self.project = project; self.saved = saved
        _text = State(initialValue: project["instructions"].string)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text).font(.body).scrollContentBackground(.hidden).padding().background(Theme.background)
                .overlay(alignment: .topLeading) { if text.isEmpty { Text("How should chats in this project respond? For example: tone, audience, format, or what to keep in mind.").foregroundStyle(Theme.inkMuted).padding(.horizontal, 21).padding(.top, 24).allowsHitTesting(false) } }
                .navigationTitle("Project instructions").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(busy) }
                }
        }.tint(Theme.clay).presentationDetents([.large])
    }

    private func save() {
        busy = true
        Task {
            defer { busy = false }
            do { _ = try await ChatActions.updateProject(store, id: project["id"].string, patch: ["instructions": .string(text.trimmingCharacters(in: .whitespacesAndNewlines))]); saved(); dismiss() } catch { store.error = ChatError.text(error) }
        }
    }
}
