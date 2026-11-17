import SwiftUI
import PhotosUI
import ImageIO
import UniformTypeIdentifiers

/// What the + sheet hands back to the message box once it has closed: things that need the whole screen.
enum ChatAddChoice { case camera, files, photos }

/// The + sheet: recent photos on top, then the camera, files and the project, then what this conversation may use
/// (permission, research, connectors, skills, the image model).
struct ChatAddSheet: View {
    @Bindable var store: AppStore
    let hub: ChatHub
    let mode: String
    var folderSlash: [JSON]?
    let choose: (ChatAddChoice) -> Void
    let upload: (Data, String, String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [PhotosPickerItem] = []
    @State private var research = false
    @State private var connectorsOff: [String] = []
    @State private var detent: PresentationDetent = {
        #if DEBUG
        if Launch.route("conversation") == "add-large" { return .large }
        #endif
        return .medium
    }()

    private var session: Conversation? { ChatNav.session(store) }
    private var isCode: Bool { mode == "code" }
    private var projectName: String {
        let id = session?.projectID ?? (session == nil ? store.project : nil)
        return id.flatMap { id in store.projects.first { $0["id"].string == id }?["name"].stringOrNil } ?? "None"
    }
    private var skills: [JSON] { (folderSlash ?? hub.slash).filter { $0["kind"].string == "skill" } }
    private var connectorsOn: Int { hub.mcp.filter { !connectorsOff.contains($0["name"].string) }.count }

    var body: some View {
        NavigationStack {
            List {
                photos
                Section {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { choose(.camera); dismiss() } label: { row("camera", "Camera") }
                    }
                    Button { choose(.files); dismiss() } label: { row("doc.badge.arrow.up", "Add files") }
                    if !isCode, !store.projects.isEmpty || session?.projectID != nil {
                        NavigationLink { ChatAddProjectPage(store: store) } label: { row("folder", "Add to project", value: projectName) }
                    }
                }
                if isCode, session != nil {
                    Section {
                        HStack(spacing: 14) {
                            Image(systemName: "checkmark.shield").font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 26)
                            Text("Permission").foregroundStyle(Theme.ink)
                            Spacer(minLength: 8)
                            PermissionModeChip(store: store)
                        }
                    }
                }
                Section {
                    if hub.webSearchOn, !isCode {
                        Toggle(isOn: Binding(get: { research }, set: { setResearch($0) })) { row("binoculars", "Research") }.tint(Theme.clay)
                    }
                    if !hub.mcp.isEmpty {
                        NavigationLink { ChatAddConnectorsPage(store: store, hub: hub, off: $connectorsOff, change: setConnectors) } label: { row("powerplug", "Connectors", value: "\(connectorsOn) on") }
                    }
                    if !skills.isEmpty {
                        NavigationLink { ChatAddSkillsPage(skills: skills) { name in store.draft = "/\(name) "; dismiss() } } label: { row("text.book.closed", "Skills") }
                    }
                    if hub.imageGenerationOn, !isCode, hub.pictureModels.count >= 2 {
                        ImageModelMenu(store: store, hub: hub, current: session?.imageModel ?? hub.newOptions.imageModel) { ref in setImageModel(ref) }
                            .foregroundStyle(Theme.ink)
                    }
                    if store.isAdmin {
                        Button { openPlugins() } label: { row("puzzlepiece.extension", "Add plugins") }
                    }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle(isCode ? "Add to session" : "Add to conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(role: .close) { dismiss() }.tint(Theme.ink) }
                ToolbarItem(placement: .topBarTrailing) { Button("Photos") { choose(.photos); dismiss() }.tint(Theme.inkSecondary) }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large], selection: $detent).presentationDragIndicator(.visible)
        .onChange(of: picked) { _, items in add(items) }
        .onAppear {
            research = session?.research ?? hub.newOptions.research
            connectorsOff = session?.connectorsOff ?? hub.newOptions.connectorsOff
            #if DEBUG
            if Launch.route("conversation") == "add-plugins" { Task { try? await Task.sleep(for: .seconds(1.5)); openPlugins() } }
            #endif
        }
    }

    /// Settings opens on the Plugins page once this sheet has finished closing, so the two don't fight over the screen.
    private func openPlugins() {
        dismiss()
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            openSettings(.plugins)
        }
    }

    private func row(_ symbol: String, _ title: String, value: String? = nil) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 26)
            Text(title).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            if let value { Text(value).foregroundStyle(Theme.inkMuted).lineLimit(1) }
        }.contentShape(Rectangle())
    }

    /// iOS's own picker, built into the sheet: it runs outside the app, so Atelier sees only the pictures that are tapped
    /// and needs no access to the library.
    private var photos: some View {
        PhotosPicker(selection: $picked, maxSelectionCount: 20, selectionBehavior: .continuous, matching: .images) { Label("Photos", systemImage: "photo") }
            .photosPickerStyle(.compact)
            .photosPickerAccessoryVisibility(.hidden, edges: .all)
            .frame(height: 124)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 16)
            .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
    }

    private func add(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        picked = []
        for item in items {
            Task {
                do {
                    guard let file = try await ChatPhotoFile.load(item) else { store.error = "That photo's format isn't supported."; return }
                    await upload(file.data, file.name, file.mime)
                } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
            }
        }
    }

    // MARK: changes

    private func setResearch(_ on: Bool) {
        research = on
        guard let session else { hub.newOptions.research = on; return }
        Task { do { try await ChatActions.update(store, session.id, ["research": .bool(on)]) } catch { research = !on; store.error = ChatError.text(error) } }
    }

    private func setConnectors(_ next: [String]) {
        connectorsOff = next
        guard let session else { hub.newOptions.connectorsOff = next; return }
        Task { do { try await ChatActions.update(store, session.id, ["connectorsOff": .array(next.map(JSON.string))]) } catch { store.error = ChatError.text(error) } }
    }

    private func setImageModel(_ ref: String?) {
        guard let session else { hub.newOptions.imageModel = ref ?? ""; return }
        Task { do { try await ChatActions.update(store, session.id, ["imageModel": ref.map(JSON.string) ?? .null]) } catch { store.error = ChatError.text(error) } }
    }
}

// MARK: - Pictures

/// A picked picture as a model can read it: PNG, JPEG and GIF as they are, HEIC and the rest as JPEG.
enum ChatPhotoFile {
    static func load(_ item: PhotosPickerItem) async throws -> (data: Data, name: String, mime: String)? {
        guard let data = try await item.loadTransferable(type: Data.self) else { return nil }
        return prepare(data)
    }

    static func prepare(_ data: Data) -> (data: Data, name: String, mime: String)? {
        let kind = CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceGetType($0) }.flatMap { UTType($0 as String) }
        let stem = "Photo-" + UUID().uuidString.prefix(4)
        if kind?.conforms(to: .png) == true { return (data, stem + ".png", "image/png") }
        if kind?.conforms(to: .jpeg) == true { return (data, stem + ".jpg", "image/jpeg") }
        if kind?.conforms(to: .gif) == true { return (data, stem + ".gif", "image/gif") }
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else { return nil }
        return (jpeg, stem + ".jpg", "image/jpeg")
    }
}

// MARK: - Pages the sheet opens

/// Which project a conversation belongs to (a new one starts in the chosen project).
private struct ChatAddProjectPage: View {
    @Bindable var store: AppStore
    private var session: Conversation? { ChatNav.session(store) }
    private var current: String? { session != nil ? session?.projectID : store.project }

    var body: some View {
        List {
            Section {
                pick(nil, "None")
                ForEach(store.projects, id: \.self) { project in pick(project["id"].string, project["name"].string) }
            } footer: { Text("A project's instructions and files go with every conversation in it.") }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Add to project").navigationBarTitleDisplayMode(.inline)
    }

    private func pick(_ id: String?, _ name: String) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            if let session { Task { do { try await ChatActions.move(store, session.id, toProject: id) } catch { store.error = ChatError.text(error) } } }
            else { store.project = id }
        } label: {
            HStack {
                Text(name).foregroundStyle(Theme.ink)
                Spacer()
                if current == id { Image(systemName: "checkmark").foregroundStyle(Theme.clay).fontWeight(.semibold) }
            }.contentShape(Rectangle())
        }
    }
}

/// The connectors this conversation may use, each one switched on or off.
private struct ChatAddConnectorsPage: View {
    let store: AppStore
    let hub: ChatHub
    @Binding var off: [String]
    let change: ([String]) -> Void

    var body: some View {
        List {
            Section {
                ForEach(hub.mcp, id: \.self) { connector in
                    let name = connector["name"].string
                    let state = connector["state"].string
                    Toggle(isOn: Binding(get: { !off.contains(name) }, set: { on in change(on ? off.filter { $0 != name } : off + [name]) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name).foregroundStyle(Theme.ink)
                            if state == "error" { Text("Not connected").font(.footnote).foregroundStyle(Theme.inkMuted) }
                            else if state == "disabled" { Text("Switched off by an admin").font(.footnote).foregroundStyle(Theme.inkMuted) }
                        }
                    }.tint(Theme.clay).disabled(state == "disabled")
                }
            } footer: { Text("What is switched off here stays off for this conversation only.") }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Connectors").navigationBarTitleDisplayMode(.inline)
    }
}

/// The skills to start from: choosing one puts its command in the box.
private struct ChatAddSkillsPage: View {
    let skills: [JSON]
    let use: (String) -> Void

    var body: some View {
        List {
            Section {
                ForEach(skills, id: \.self) { skill in
                    Button { use(skill["name"].string) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(skill["name"].string).foregroundStyle(Theme.ink)
                            if !skill["description"].string.isEmpty { Text(skill["description"].string).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(3) }
                        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Skills").navigationBarTitleDisplayMode(.inline)
    }
}
