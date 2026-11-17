import SwiftUI
import UniformTypeIdentifiers

// A ComfyUI provider's own workflows: each one becomes an image model. Importing reads a workflow on the server (pasted
// JSON, a file, or one saved on the server) and shows which of its inputs it found, so a person can correct that before
// saving. A port of the desktop's image-workflow.ts and image-workflows-dialog.tsx.

/// One input of a workflow's graph that holds a value of its own and could be filled in by Atelier.
struct AMWorkflowInput: Identifiable, Equatable {
    let node: String
    let input: String
    let label: String
    let isText: Bool
    var id: String { value }
    /// How the pick is kept in a menu: `node|input`.
    var value: String { "\(node)|\(input)" }
}

enum AMWorkflow {
    struct Slot: Identifiable { let key: String; let label: String; let text: Bool; var sound = false; var id: String { key } }

    static let slots: [Slot] = [
        Slot(key: "prompt", label: "Prompt", text: true), Slot(key: "negative", label: "Negative prompt", text: true),
        Slot(key: "seed", label: "Seed", text: false), Slot(key: "steps", label: "Steps", text: false), Slot(key: "guidance", label: "Guidance", text: false),
        Slot(key: "sampler", label: "Sampler", text: true), Slot(key: "scheduler", label: "Scheduler", text: true),
        Slot(key: "width", label: "Width", text: false), Slot(key: "height", label: "Height", text: false), Slot(key: "count", label: "Images per run", text: false),
        Slot(key: "image", label: "Input image", text: true), Slot(key: "mask", label: "Mask", text: true),
        Slot(key: "seconds", label: "Length in seconds", text: false, sound: true), Slot(key: "lyrics", label: "Lyrics", text: true, sound: true),
    ]

    /// Whether the workflow's result is a sound: its output node saves or previews audio.
    static func savesSound(_ workflow: JSON) -> Bool {
        let node = workflow["map"]["output"].stringOrNil.map { workflow["graph"][$0] } ?? .null
        let type = node["class_type"].string
        return type.hasPrefix("SaveAudio") || type.hasPrefix("PreviewAudio")
    }

    static func slots(for workflow: JSON) -> [Slot] { slots.filter { !$0.sound || savesSound(workflow) } }

    /// "CLIP Text Encode #6": the title someone gave a node, else its type, with its number to tell two of a kind apart.
    private static func nodeLabel(_ id: String, _ node: JSON) -> String {
        let title = node["_meta"]["title"].stringOrNil ?? node["class_type"].stringOrNil ?? "Node"
        return "\(title) #\(id)"
    }

    /// The inputs that hold a value of their own, by node number. A link to another node isn't something to fill in.
    static func inputs(_ graph: JSON) -> [AMWorkflowInput] {
        graph.entries.sorted { $0.0.compare($1.0, options: .numeric) == .orderedAscending }.flatMap { id, node -> [AMWorkflowInput] in
            guard case .object = node, case .object(let inputs) = node["inputs"] else { return [] }
            let where_ = nodeLabel(id, node)
            return inputs.sorted { $0.key < $1.key }.compactMap { name, held in
                switch held {
                case .string: AMWorkflowInput(node: id, input: name, label: "\(where_) · \(name)", isText: true)
                case .number: AMWorkflowInput(node: id, input: name, label: "\(where_) · \(name)", isText: false)
                default: nil
                }
            }
        }
    }

    /// What can fill a slot; what the parser chose stays listed even if it isn't of that kind.
    static func options(_ workflow: JSON, slot: Slot, inputs: [AMWorkflowInput]) -> [(value: String, label: String)] {
        var options = inputs.filter { $0.isText == slot.text }.map { ($0.value, $0.label) }
        let chosen = workflow["map"][slot.key]
        if chosen != .null {
            let value = "\(chosen["node"].string)|\(chosen["input"].string)"
            if !options.contains(where: { $0.0 == value }) { options.append((value, inputs.first { $0.value == value }?.label ?? "#\(chosen["node"].string) · \(chosen["input"].string)")) }
        }
        return options
    }

    static func chosen(_ workflow: JSON, slot: Slot) -> String? {
        let chosen = workflow["map"][slot.key]
        return chosen == .null ? nil : "\(chosen["node"].string)|\(chosen["input"].string)"
    }

    /// The workflow with one slot set, or cleared on nil.
    static func setting(_ workflow: JSON, slot: String, to value: String?) -> JSON {
        guard let value else { return workflow.replacing(["map", .string(slot)], with: nil) }
        let split = value.firstIndex(of: "|") ?? value.endIndex
        let input: JSON = ["node": .string(String(value[..<split])), "input": .string(String(value[value.index(after: split)...]))]
        return workflow.replacing(["map", .string(slot)], with: input)
    }

    /// "Prompt, Seed, Steps and 3 more": what a workflow in the list takes.
    static func summary(_ workflow: JSON) -> String {
        let names = slots.filter { workflow["map"][$0.key] != .null }.map(\.label)
        return names.count > 3 ? "\(names.prefix(3).joined(separator: ", ")) and \(names.count - 3) more" : names.joined(separator: ", ")
    }
}

// MARK: - The page

struct AMWorkflowsPage: View {
    let store: AppStore
    let model: AMMediaPageModel
    let providerID: String
    @State private var mapping: AMWorkflowDraft?
    @State private var paste = ""
    @State private var reading = false
    @State private var readError: String?
    @State private var saved: Load<[JSON]> = .loading
    @State private var importing = false
    @State private var confirmRemove: JSON?

    enum Load<Value> { case loading, loaded(Value), failed(String) }

    private var provider: AMMediaProvider? { model.resource.value?.providers.first { $0.id == providerID } }

    var body: some View {
        SettingsPage(title: "Workflows") {
            if let provider {
                Section {
                    if provider.workflows.isEmpty { AMNote(text: "None yet. Import one below, and it shows up as an image model.") }
                    ForEach(Array(provider.workflows.enumerated()), id: \.offset) { _, workflow in
                        Button { mapping = AMWorkflowDraft(workflow: workflow) } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(workflow["name"].string).foregroundStyle(Theme.ink)
                                    Text(AMWorkflow.summary(workflow)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted.opacity(0.6))
                            }.contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions { Button("Remove", role: .destructive) { confirmRemove = workflow } }
                    }
                } header: { Text("Your workflows") } footer: { Text("Your own workflows on \(provider.name). Each one shows up as an image model. Tap one to change which inputs Atelier fills in.") }

                savedSection
                importSection
                readButton
            }
        }
        .task { await loadSaved() }
        .navigationDestination(item: $mapping) { draft in AMWorkflowMapping(store: store, model: model, providerID: providerID, draft: draft) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .png], allowsMultipleSelection: false) { result in Task { await readFile(result) } }
        .confirmationDialog("Remove \(confirmRemove?["name"].string ?? "this workflow")?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let workflow = confirmRemove { Task { await remove(workflow) } } }
        } message: { Text("It leaves the image model picker. Images it already made stay in their conversations.") }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Importing

    @ViewBuilder private var savedSection: some View {
        switch saved {
        case .loaded(let list) where !list.isEmpty:
            Section {
                ForEach(Array(list.enumerated()), id: \.offset) { _, item in
                    Button { Task { await read(["saved": item["path"]]) } } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text((item["path"].string as NSString).lastPathComponent).foregroundStyle(Theme.ink)
                            Text(item["path"].string).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.head)
                        }
                    }.buttonStyle(.plain).disabled(reading)
                }
            } header: { Text("Saved on the server") } footer: { Text("Workflows in ComfyUI's own folder on the server, so nobody has to export a file.") }
        case .failed(let message):
            Section { AMNote(text: "Couldn't list the workflows saved on the server: \(message == "fetch failed" ? "ComfyUI didn't answer." : message)") }
        default: EmptyView()
        }
    }

    private var importSection: some View {
        Section {
            ActionRow(title: "Choose a file", symbol: "doc.badge.plus", busy: reading) { importing = true }
            VStack(alignment: .leading, spacing: 6) {
                Text("Or paste the JSON").font(.footnote).foregroundStyle(Theme.inkMuted)
                TextEditor(text: $paste).font(.mono(.footnote)).frame(minHeight: 110).scrollContentBackground(.hidden)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .overlay(alignment: .topLeading) {
                        if paste.isEmpty { Text(#"{ "3": { "class_type": "KSampler", … } }"#).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                    }
            }
            if let readError { AMOutcome(kind: .bad, text: readError) }
        } header: { Text("Import a workflow") } footer: { Text("Use Save (API) in ComfyUI and pick that file, or a PNG ComfyUI made, or paste the JSON.") }
    }

    private var readButton: some View {
        AMButtonRow {
            Button("Read workflow") { Task { await read(["text": .string(paste)]) } }
                .buttonStyle(ClayButtonStyle(busy: reading)).disabled(paste.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reading)
        }
    }

    private func read(_ source: [String: JSON]) async {
        reading = true; readError = nil
        defer { reading = false }
        var params = source
        params["providerId"] = .string(providerID)
        do { mapping = AMWorkflowDraft(workflow: try await AMAPI(store: store).call("imageProviders.parseWorkflow", params)) }
        catch is CancellationError {} catch { readError = AMFailure.from(error).localizedDescription }
    }

    private func readFile(_ result: Result<[URL], Error>) async {
        readError = nil
        guard case .success(let urls) = result, let url = urls.first else { if case .failure(let error) = result { readError = error.localizedDescription }; return }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 32 * 1024 * 1024 else { readError = "\(url.lastPathComponent) is too big to be a workflow."; return }
            let data = try Data(contentsOf: url)
            if url.pathExtension.lowercased() == "png" { await read(["pngBase64": .string(data.base64EncodedString())]) }
            else if let text = String(data: data, encoding: .utf8) { await read(["text": .string(text)]) }
            else { readError = "Pick a PNG or JSON file." }
        } catch { readError = "Couldn't read \(url.lastPathComponent)." }
    }

    private func loadSaved() async {
        do { saved = .loaded(try await AMAPI(store: store).call("imageProviders.savedWorkflows", ["id": .string(providerID)]).array) }
        catch is CancellationError {} catch { saved = .failed(AMFailure.from(error).localizedDescription) }
    }

    private func remove(_ workflow: JSON) async {
        guard let provider else { return }
        let rest = provider.workflows.filter { $0["id"] != workflow["id"] }
        if await store.attempt({ try await model.saveWorkflows(provider, rest) }) { store.notify("Removed \(workflow["name"].string)") }
    }
}

struct AMWorkflowDraft: Hashable, Identifiable {
    let workflow: JSON
    var id: String { workflow["id"].string }
    func hash(into hasher: inout Hasher) { hasher.combine(workflow["id"].string) }
    static func == (lhs: AMWorkflowDraft, rhs: AMWorkflowDraft) -> Bool { lhs.workflow == rhs.workflow }
}

// MARK: - Mapping

struct AMWorkflowMapping: View {
    let store: AppStore
    let model: AMMediaPageModel
    let providerID: String
    @State private var workflow: JSON
    @State private var saving = false
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, model: AMMediaPageModel, providerID: String, draft: AMWorkflowDraft) {
        self.store = store; self.model = model; self.providerID = providerID
        _workflow = State(initialValue: draft.workflow)
    }

    var body: some View {
        let inputs = AMWorkflow.inputs(workflow["graph"])
        SettingsPage(title: "Map \(workflow["name"].string)") {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Name").font(.footnote).foregroundStyle(Theme.inkMuted)
                    TextField("Name", text: Binding(get: { workflow["name"].string }, set: { workflow = workflow.replacing(["name"], with: .string(String($0.prefix(100)))) }))
                }
            }
            Section {
                ForEach(AMWorkflow.slots(for: workflow)) { slot in
                    let options = AMWorkflow.options(workflow, slot: slot, inputs: inputs)
                    Picker(slot.label, selection: Binding(
                        get: { AMWorkflow.chosen(workflow, slot: slot) ?? "none" },
                        set: { workflow = AMWorkflow.setting(workflow, slot: slot.key, to: $0 == "none" ? nil : $0) }
                    )) {
                        Text("Not used").tag("none")
                        ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
                    }
                }
            } header: { Text("Which inputs Atelier fills in") } footer: {
                Text("Anything left as it is keeps the value in the workflow. The prompt is required.")
            }
            if let problem { Section { AMOutcome(kind: .bad, text: problem) } }
            AMButtonRow { Button("Save workflow") { Task { await save() } }.buttonStyle(ClayButtonStyle(busy: saving)).disabled(saving) }
        }
    }

    private func save() async {
        guard !workflow["name"].string.trimmingCharacters(in: .whitespaces).isEmpty else { problem = "Enter a name."; return }
        guard workflow["map"]["prompt"] != .null else { problem = "Choose which input takes the prompt."; return }
        guard let provider = model.resource.value?.providers.first(where: { $0.id == providerID }) else { return }
        saving = true; problem = nil
        defer { saving = false }
        var list = provider.workflows.filter { $0["id"] != workflow["id"] }
        list.append(workflow.replacing(["name"], with: .string(workflow["name"].string.trimmingCharacters(in: .whitespaces))))
        do { try await model.saveWorkflows(provider, list); store.notify("Saved \(workflow["name"].string)"); dismiss() }
        catch is CancellationError {} catch { problem = AMFailure.from(error).localizedDescription }
    }
}
