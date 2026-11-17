import SwiftUI

// MARK: - Memory: what Atelier remembers, how it searches past chats, and the person's own entries

@MainActor @Observable final class PersonalMemoryModel {
    let entries: Resource<[JSON]>
    /// Whether the administrator lets people edit entries by hand (`settings.memory.manualEditing`).
    private(set) var manualEditing = false
    private let call: PersonalCall

    init(call: @escaping PersonalCall) {
        self.call = call
        entries = .personal { try await call("memory.list", [:])["entries"].array }
    }

    func load() async {
        await entries.reload()
        manualEditing = (try? await call("settings.get", [:]))?["effective"]["memory"]["manualEditing"].bool ?? manualEditing
    }

    func entry(id: String) -> JSON? {
        let list = entries.value ?? []
        return list.first { $0["id"].string == id } ?? (PersonalMemoryText.isFixed(id) ? list.first { $0["section"].string == id } : nil)
    }

    func instruct(_ text: String, entryID: String?, section: String?, model: String?) async throws -> [JSON] {
        var params: [String: JSON] = ["text": .string(text)]
        if let entryID { params["entryId"] = .string(entryID) } else if let section { params["section"] = .string(section) }
        if let model, !model.isEmpty { params["model"] = .string(model) }
        let result = try await call("memory.instruct", params)
        await entries.reload()
        return result["changes"].array
    }

    func delete(id: String) async throws {
        _ = try await call("memory.delete", ["id": .string(id)])
        await entries.reload()
    }

    func update(id: String?, section: String?, title: String?, summary: String?, details: String) async throws {
        var params: [String: JSON] = ["details": .string(details)]
        if let id { params["id"] = .string(id) } else if let section { params["section"] = .string(section) }
        if let title { params["title"] = .string(title) }
        if let summary { params["summary"] = .string(summary) }
        _ = try await call("memory.update", params)
        await entries.reload()
    }

    /// Adds an export a part at a time, so no model reply has to hold all of it. Reports the part it is on.
    func importExport(_ text: String, model: String?, progress: (Int, Int) -> Void) async throws -> [JSON] {
        let parts = PersonalMemoryText.splitExport(text)
        var changes: [JSON] = []
        for (index, part) in parts.enumerated() {
            progress(index + 1, parts.count)
            var params: [String: JSON] = ["text": .string(part)]
            if let model, !model.isEmpty { params["model"] = .string(model) }
            do { changes += try await call("memory.import", params)["changes"].array }
            catch { throw PersonalImportError(base: error, before: changes) }
            await entries.reload()
        }
        return changes
    }
}

struct PersonalImportError: LocalizedError {
    let base: Error
    let before: [JSON]
    var errorDescription: String? {
        let text = PersonalFailure.text(base)
        return before.isEmpty ? text : "\(text) Before that: \(PersonalMemoryText.describeImport(before).lowercased())."
    }
}

private enum MemoryRoute: Hashable { case entry(String), importer }

struct MemorySettings: View {
    let store: AppStore
    @State private var model: PersonalMemoryModel
    @State private var prefs: PersonalPrefs
    @State private var query = ""
    @State private var route: MemoryRoute?
    @AppStorage("personal.memoryModel") private var memoryModel = ""

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: PersonalMemoryModel(call: store.personalCall))
        _prefs = State(initialValue: PersonalPrefs(store: store))
        #if DEBUG
        if let sub = Launch.value("--sub") { _route = State(initialValue: sub == "import" ? .importer : .entry(sub)) }
        #endif
    }

    private var personName: String {
        let called = prefs.string(["callMe"]).trimmingCharacters(in: .whitespaces)
        return called.isEmpty ? (store.userName.split(separator: " ").first.map(String.init) ?? "you") : called
    }

    var body: some View {
        PersonalPage(title: "Memory") {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                controls
                PersonalLoad(resource: model.entries, emptyMessage: nil) { entries in listSections(entries) }
            } else {
                PersonalLoad(resource: model.entries) { entries in searchResults(entries) }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search memory")
        .task { await model.load(); await prefs.load() }
        .refreshable { await model.load(); await prefs.load() }
        .navigationDestination(item: $route) { route in
            switch route {
            case .entry(let id): PersonalMemoryEntryPage(store: store, model: model, id: id, name: personName)
            case .importer: PersonalMemoryImportPage(model: model, choice: memoryModel)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PersonalMemoryBar(label: "Tell Atelier something to remember", placeholders: PersonalMemoryText.examples) { text in
                try await model.instruct(text, entryID: nil, section: nil, model: memoryModel)
            }
        }
    }

    // MARK: Switches and import

    @ViewBuilder private var controls: some View {
        Section {
            PrefToggleRow(prefs: prefs, path: ["memory", "searchChats"], title: "Search and reference chats", subtitle: "Let Atelier search for relevant details in your past chats.", defaultValue: true)
            PrefToggleRow(prefs: prefs, path: ["memory", "generate"], title: "Generate memory from chats", subtitle: "Let Atelier remember details from your chats.", defaultValue: true)
            PrefToggleRow(prefs: prefs, path: ["memory", "sensitive"], title: "Include sensitive topics in memory", subtitle: "Let Atelier remember details about sensitive topics like health or religious beliefs.", defaultValue: false)
        } header: { Text("Memory") } footer: {
            Text("Memory works in Chat. Code works from your project's instructions and doesn't use it.")
        }
        Section {
            NavigationLink { PersonalMemoryImportPage(model: model, choice: memoryModel) } label: {
                NavRow(symbol: "square.and.arrow.down", title: "Import memory from other AI providers", subtitle: "Bring what another assistant remembers about you into Atelier.")
            }
            NavigationLink {
                PersonalModelChoicePage(title: "Model for memory", footer: "Used for the bar below and for imports. Default uses the small model your admin chose, else the model of the conversation, your default model, the server's default and finally the first model available.",
                                        options: PersonalModelOption.options(from: store.models, providerNames: [:]), unsetLabel: "Default", selection: memoryModel) { ref in memoryModel = ref ?? "" }
            } label: {
                PersonalChoiceLabel(title: "Model for memory", subtitle: "Which model turns your words into changes.", value: store.models.first { $0["ref"].string == memoryModel }?["displayName"].stringOrNil ?? "Default")
            }
            PersonalLinkRow(title: "How memory works", symbol: "book", url: PersonalMemoryText.docs)
        }
    }

    // MARK: Entries

    @ViewBuilder private func listSections(_ entries: [JSON]) -> some View {
        Section {
            ForEach(PersonalMemoryText.fixed, id: \.section) { item in
                let entry = entries.first { $0["section"].string == item.section }
                let filled = entry.map { !$0["details"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !$0["summary"].string.isEmpty } ?? false
                row(id: entry?["id"].string ?? item.section, title: item.title, summary: PersonalMemoryText.fixedSummary(section: item.section, name: personName), updated: filled ? entry?["updatedAt"].date : nil)
            }
        } header: { Text("You") }
        ForEach(PersonalMemoryText.listSections, id: \.section) { item in
            let list = entries.filter { $0["section"].string == item.section }
            if !list.isEmpty {
                Section(item.title) {
                    if item.section == "project" { projectGroups(list) } else { ForEach(list, id: \.self) { entryRow($0) } }
                }
            }
        }
        if !entries.contains(where: { !PersonalMemoryText.isFixed($0["section"].string) }) {
            Section {
                Text("Topics, areas, people and project notes show up here as Atelier learns about them from your chats, or tell it something below.")
                    .font(.subheadline).foregroundStyle(Theme.inkMuted)
            }.personalPlainRow()
        }
    }

    private func projectName(_ id: JSON) -> String { store.projects.first { $0["id"] == id }?["name"].stringOrNil ?? "Project" }

    @ViewBuilder private func projectGroups(_ list: [JSON]) -> some View {
        let ids = list.reduce(into: [JSON]()) { if !$0.contains($1["projectId"]) { $0.append($1["projectId"]) } }
        let groups = ids.map { id in (id: id, name: projectName(id), entries: list.filter { $0["projectId"] == id }) }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        ForEach(groups, id: \.name) { group in
            DisclosureGroup {
                ForEach(group.entries, id: \.self) { entryRow($0) }
            } label: {
                HStack {
                    Text(group.name).foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    Text(group.entries.count == 1 ? "1 entry" : "\(group.entries.count) entries").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }
            .tint(Theme.inkMuted)
        }
    }

    private func entryRow(_ entry: JSON) -> some View {
        row(id: entry["id"].string, title: entry["title"].string, summary: entry["summary"].string, updated: entry["updatedAt"].date)
    }

    private func row(id: String, title: String, summary: String, updated: Date?) -> some View {
        Button { route = .entry(id) } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(Theme.ink).lineLimit(2)
                    if !summary.isEmpty { Text(summary).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(2) }
                    Text(updated.map { "Updated \($0.relative)" } ?? "Empty").font(.caption).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color(uiColor: .tertiaryLabel))
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func searchResults(_ entries: [JSON]) -> some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let hits = entries.filter { [$0["title"].string, $0["summary"].string, $0["details"].string].contains { $0.lowercased().contains(q) } }
        if hits.isEmpty {
            EmptyState(title: "Nothing found", symbol: "magnifyingglass", message: "No memory mentions “\(query)”.").personalPlainRow()
        } else {
            Section("Results") {
                ForEach(hits, id: \.self) { entry in
                    row(id: entry["id"].string, title: PersonalMemoryText.isFixed(entry["section"].string) ? (PersonalMemoryText.fixed.first { $0.section == entry["section"].string }?.title ?? entry["title"].string) : entry["title"].string,
                        summary: entry["summary"].string, updated: entry["updatedAt"].date)
                }
            }
        }
    }
}

// MARK: - One entry

struct PersonalMemoryEntryPage: View {
    let store: AppStore
    let model: PersonalMemoryModel
    let id: String
    let name: String
    @State private var editing = false
    @State private var confirmDelete = false
    @AppStorage("personal.memoryModel") private var memoryModel = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let entry = model.entry(id: id)
        let section = entry?["section"].string ?? (PersonalMemoryText.isFixed(id) ? id : "")
        let fixed = PersonalMemoryText.isFixed(section)
        let title = fixed ? (PersonalMemoryText.fixed.first { $0.section == section }?.title ?? "") : entry?["title"].string
        let details = entry?["details"].string ?? ""
        let empty = entry == nil || (details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (entry?["summary"].string ?? "").isEmpty)
        PersonalPage(title: title ?? "Memory") {
            if model.entries.isLoading && entry == nil {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200).personalPlainRow()
            } else if title == nil {
                EmptyState(title: "This memory no longer exists", symbol: "brain").personalPlainRow()
            } else {
                Section {
                    if let projectID = entry?["projectId"], projectID != .null { ValueRow(title: "Project", value: store.projects.first { $0["id"] == projectID }?["name"].stringOrNil ?? "Project") }
                    ValueRow(title: "Last updated", value: entry.flatMap { empty ? nil : $0["updatedAt"].date?.personalShort } ?? "Not yet")
                }
                Section("Summary") {
                    Text(fixed ? PersonalMemoryText.fixedSummary(section: section, name: name) : (entry?["summary"].string.isEmpty == false ? entry?["summary"].string ?? "" : "No summary"))
                        .foregroundStyle(Theme.ink).textSelection(.enabled)
                }
                Section("Details") {
                    let facts = PersonalMemoryText.lines(details)
                    if facts.isEmpty {
                        Text("Nothing yet. Tell Atelier below.").foregroundStyle(Theme.inkMuted)
                    } else {
                        ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text("•").foregroundStyle(Theme.inkMuted)
                                Text(fact).foregroundStyle(Theme.ink).textSelection(.enabled)
                            }
                        }
                    }
                }
                Section {
                    if model.manualEditing { ActionRow(title: "Edit", symbol: "pencil") { editing = true } }
                    if entry != nil, !(fixed && empty) {
                        ActionRow(title: fixed ? "Clear" : "Delete", symbol: fixed ? "eraser" : "trash", destructive: true) { confirmDelete = true }
                    }
                } footer: { if !model.manualEditing { Text("Memory changes through Atelier: tell it below what to change.") } }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let title {
                PersonalMemoryBar(label: "Tell Atelier what to change in \(title)", placeholders: ["Tell Atelier what to change"]) { text in
                    let changes = try await model.instruct(text, entryID: entry?["id"].string, section: entry == nil && fixed ? section : nil, model: memoryModel)
                    if let entry, !fixed, changes.contains(where: { $0["op"].string == "deleted" && $0["id"] == entry["id"] }) { dismiss() }
                    return changes
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let title { PersonalMemoryEditor(model: model, entry: entry, section: fixed ? section : nil, title: title) }
        }
        .confirmationDialog(fixed ? "Clear \(title ?? "")?" : "Delete this memory?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(fixed ? "Clear" : "Delete", role: .destructive) {
                guard let entry else { return }
                personalAction(store) { try await model.delete(id: entry["id"].string); if !fixed { dismiss() } else { store.notify("Cleared") } }
            }
        } message: {
            Text(fixed ? "Atelier forgets everything in \(title ?? ""). You can tell it again any time." : "Atelier forgets “\(title ?? "")”. This can't be undone.")
        }
        .task { if model.entries.value == nil { await model.load() } }
    }
}

/// Editing by hand, when the administrator allows it: the title and summary of a list entry, details one fact per line.
struct PersonalMemoryEditor: View {
    let model: PersonalMemoryModel
    let entry: JSON?
    let section: String?
    let title: String
    @State private var draftTitle: String
    @State private var summary: String
    @State private var details: String
    @State private var saving = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(model: PersonalMemoryModel, entry: JSON?, section: String?, title: String) {
        self.model = model; self.entry = entry; self.section = section; self.title = title
        _draftTitle = State(initialValue: entry?["title"].string ?? "")
        _summary = State(initialValue: entry?["summary"].string ?? "")
        _details = State(initialValue: PersonalMemoryText.lines(entry?["details"].string ?? "").joined(separator: "\n"))
    }
    private var fixed: Bool { section != nil }
    private var valid: Bool { fixed || !draftTitle.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            PersonalPage(title: "Edit \(title)") {
                if !fixed {
                    Section {
                        FieldRow(title: "Title", placeholder: "Title", text: $draftTitle, autocapitalize: true)
                        FieldRow(title: "Summary", placeholder: "One line", text: $summary, autocapitalize: true)
                    }
                }
                Section {
                    PersonalTextBox(title: "Details", text: $details, minHeight: 240)
                } header: { Text("Details, one fact per line") } footer: {
                    if let failure { Text(failure).foregroundStyle(Theme.danger) } else if !valid { Text("Give it a title.").foregroundStyle(Theme.danger) }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(saving || !valid) }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }

    private func save() {
        saving = true; failure = nil
        Task {
            defer { saving = false }
            do {
                try await model.update(id: entry?["id"].string, section: entry == nil ? section : nil, title: fixed ? nil : draftTitle.trimmingCharacters(in: .whitespaces), summary: fixed ? nil : summary, details: details)
                dismiss()
            } catch is CancellationError { return } catch { failure = PersonalFailure.text(error) }
        }
    }
}

// MARK: - Import from another assistant

struct PersonalMemoryImportPage: View {
    let model: PersonalMemoryModel
    let choice: String
    @State private var text = ""
    @State private var copied = false
    @State private var adding = false
    @State private var progress: (part: Int, total: Int)?
    @State private var result: String?
    @State private var failure: String?
    @State private var finished = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PersonalPage(title: "Import memory") {
            Section {
                Text(PersonalMemoryText.importPrompt).font(.footnote).foregroundStyle(Theme.inkSecondary).textSelection(.enabled)
                    .frame(maxHeight: 150).clipped()
                    .overlay(alignment: .bottom) { LinearGradient(colors: [Theme.surface.opacity(0), Theme.surface], startPoint: .top, endPoint: .bottom).frame(height: 36).allowsHitTesting(false) }
                HStack(spacing: 10) {
                    Button { UIPasteboard.general.string = PersonalMemoryText.importPrompt; copied = true; Task { try? await Task.sleep(for: .seconds(1.5)); copied = false } } label: {
                        Label(copied ? "Copied" : "Copy the prompt", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(.borderless).foregroundStyle(Theme.clay)
                    Spacer()
                    ShareLink(item: PersonalMemoryText.importPrompt) { Label("Share", systemImage: "square.and.arrow.up") }.buttonStyle(.borderless).foregroundStyle(Theme.clay)
                }
            } header: { Text("1. Copy this prompt into a chat with your other AI provider") } footer: {
                Text("It asks that assistant for everything it has stored about you, word for word, in sections.")
            }
            Section {
                PersonalTextBox(title: "The export", text: $text, placeholder: "Paste the export here", minHeight: 150)
                    .disabled(adding || finished)
                PasteButton(payloadType: String.self) { strings in if let pasted = strings.first { text = pasted } }.labelStyle(.titleAndIcon).tint(Theme.clay).disabled(adding || finished)
                if let progress {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(progress.total > 1 ? "Adding \(progress.part) of \(progress.total)… This can take a few minutes." : "Adding to memory… This can take a minute.").font(.footnote).foregroundStyle(Theme.inkMuted)
                        if progress.total > 1 { ProgressView(value: Double(progress.part - 1), total: Double(progress.total)).tint(Theme.clay) }
                    }
                }
                if let result { Text(result).font(.subheadline).foregroundStyle(finished ? Theme.ink : Theme.inkMuted) }
                if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
            } header: { Text("2. Paste the result below to add it to Atelier's memory") }
            Section {
                if finished { Button("Done") { dismiss() }.buttonStyle(ClayButtonStyle()).personalButtonRow() }
                else { Button("Add to memory") { add() }.buttonStyle(ClayButtonStyle(busy: adding)).disabled(adding || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).personalButtonRow() }
            } footer: { Text("Instructions and preferences go into Preferences, identity and career into Profile, interests into Topics, larger endeavours into Areas, people into People, and projects that match one of yours by name into that project's notes.") }
        }
    }

    private func add() {
        adding = true; failure = nil; result = nil
        Task {
            defer { adding = false; progress = nil }
            do {
                let changes = try await model.importExport(text, model: choice) { part, total in progress = (part, total) }
                if changes.isEmpty { result = "Nothing in it could be added to memory. Check that you pasted the whole answer." }
                else { result = PersonalMemoryText.describeImport(changes) + "."; finished = true }
            } catch is CancellationError { return } catch { failure = error.localizedDescription }
        }
    }
}

// MARK: - The bar at the bottom: "Tell Atelier something to remember"

struct PersonalMemoryBar: View {
    let label: String
    let placeholders: [String]
    let send: (String) async throws -> [JSON]
    @State private var text = ""
    @State private var pending = false
    @State private var status: (text: String, failed: Bool)?
    @State private var example = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholders[example % placeholders.count], text: $text, axis: .vertical)
                    .lineLimit(1...4).focused($focused).disabled(pending)
                    .padding(.leading, 6).padding(.vertical, 8)
                    .accessibilityLabel(label)
                Button { submit() } label: {
                    Group { if pending { ProgressView().tint(.white) } else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)) } }
                        .foregroundStyle(.white).frame(width: 36, height: 36)
                        .background(Theme.clay.opacity(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pending ? 0.35 : 1), in: Circle())
                }
                .buttonStyle(.plain).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pending).accessibilityLabel("Send")
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Theme.surface.opacity(0.94), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
            if let status {
                Text(status.text).font(.footnote).foregroundStyle(status.failed ? Theme.danger : Theme.inkMuted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .task(id: text.isEmpty) {
            guard placeholders.count > 1, text.isEmpty else { return }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(4)); if Task.isCancelled { break }; example += 1 }
        }
    }

    private func submit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !pending else { return }
        pending = true
        status = ("Updating memory…", false)
        Task {
            defer { pending = false }
            do {
                let changes = try await send(value)
                text = ""
                status = (changes.isEmpty ? "Nothing to change in memory" : PersonalMemoryText.describe(changes), false)
            } catch is CancellationError { status = nil } catch { status = (PersonalFailure.text(error), true) }
        }
    }
}
