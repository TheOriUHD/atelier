import SwiftUI

// Settings › Admin › Models: which models people see, what each one is called and can do, and the defaults.

struct ModelsSettings: View {
    let store: AppStore
    @State private var model: AMModelsModel
    @State private var filter = AMModelFilter()
    @State private var adding = false
    @State private var calculating = false
    /// A model's page opened by a launch argument (debug builds).
    @State private var launched: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AMModelsModel(store: store))
    }

    var body: some View {
        AMResourcePage(title: "Models", resource: model.resource) { snapshot in
            if snapshot.models.isEmpty && snapshot.providerOrder.isEmpty {
                Section { emptyState }
            } else {
                defaultsSection
                scopeSection
                listSections(snapshot)
            }
        }
        .searchable(text: $filter.search, prompt: "Search models")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { menu } }
        .sheet(isPresented: $adding) { AMAddModelSheet(model: model) }
        .navigationDestination(item: $launched) { ref in
            if ref == "aliases" { AMAliasesPage(model: model) }
            else if ref == "choice" { AMModelChoicePage(model: model, title: "Default model", path: ["models", "defaults", "chat"], unsetLabel: "First available model", footer: "New chats and Code sessions start with this model unless people choose their own.") }
            else { AMModelDetail(model: model, ref: ref) }
        }
        .task {
            guard let route = AMLaunch.parts else { return }
            await model.resource.reload()
            switch route.head {
            case "model": launched = route.tail
            case "add-model": adding = true
            case "aliases": launched = "aliases"
            case "choice": launched = "choice"
            default: break
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            EmptyState(title: "No models yet", symbol: "square.stack.3d.up", message: "Models appear here once a provider is connected.")
            NavigationLink { ProvidersSettings(store: store) } label: { Text("Go to Providers") }
                .buttonStyle(ClayButtonStyle()).frame(maxWidth: 260)
        }
        .listRowBackground(Color.clear)
    }

    // MARK: Menu

    private var menu: some View {
        Menu {
            Section("Show only") {
                Toggle("Favorites", systemImage: "star", isOn: $filter.favoritesOnly)
                Toggle("With tools", systemImage: "wrench.and.screwdriver", isOn: $filter.tools)
                Toggle("With vision", systemImage: "eye", isOn: $filter.vision)
                Toggle("With reasoning", systemImage: "brain", isOn: $filter.reasoning)
                Toggle("Free", systemImage: "gift", isOn: $filter.free)
            }
            Section {
                Button("Add a model by name", systemImage: "plus") { adding = true }
                Button("Recalculate all", systemImage: "arrow.clockwise") {
                    Task {
                        calculating = true
                        if let message = await model.calculateAll() { store.notify(message) }
                        calculating = false
                    }
                }
                .disabled(calculating)
            }
        } label: {
            Image(systemName: filter.active ? "line.3.horizontal.decrease.circle.fill" : "ellipsis.circle")
        }
        .accessibilityLabel("Filters and actions")
    }

    // MARK: Defaults

    private var defaultsSection: some View {
        Section {
            NavigationLink {
                AMModelChoicePage(model: model, title: "Default model", path: ["models", "defaults", "chat"], unsetLabel: "First available model",
                                  footer: "New chats and Code sessions start with this model unless people choose their own.")
            } label: { choiceRow("Default model", path: ["models", "defaults", "chat"], unset: "First available") }
            NavigationLink {
                AMModelChoicePage(model: model, title: "Small model", path: ["models", "defaults", "small"], unsetLabel: "Same as the chat",
                                  footer: "Writes titles, summaries and memory. \"Same as the chat\" uses each chat's own model.")
            } label: { choiceRow("Small model", path: ["models", "defaults", "small"], unset: "Same as the chat", subtitle: "Titles, summaries and memory") }
            NavigationLink { AMAliasesPage(model: model) } label: { NavRow(title: "Claude Code names", subtitle: "Which model answers to opus, sonnet, haiku and fable") }
        } header: { Text("Defaults for everyone") }
    }

    private func choiceRow(_ title: String, path: [JSON], unset: String, subtitle: String? = nil) -> some View {
        let current = model.choice(path)
        let name = current.model?.displayName ?? (current.ref == nil ? unset : "Not available")
        return NavRow(title: title, subtitle: subtitle, value: name)
    }

    // MARK: List

    private var scopeSection: some View {
        Section {
            Picker("Show", selection: $filter.scope) { ForEach(AMModelScope.allCases) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
        }
    }

    @ViewBuilder private func listSections(_ snapshot: AMModelsSnapshot) -> some View {
        let groups = grouped(snapshot)
        if groups.allSatisfy({ $0.models.isEmpty }) {
            Section {
                if snapshot.models.isEmpty { AMNote(text: "Your providers list no models yet. Turn one on in Providers, or add a model by its name from the menu above.") }
                else { AMNote(text: "No models match. Change the search or the filters.") }
            }
        }
        ForEach(groups, id: \.id) { group in
            if !group.models.isEmpty {
                Section {
                    ForEach(group.models) { item in
                        NavigationLink { AMModelDetail(model: model, ref: item.ref) } label: { AMModelRow(model: item) }
                            .swipeActions(edge: .leading) {
                                Button { Task { await model.setFlag(item.ref, key: "favorite", on: !item.favorite) } } label: { Label(item.favorite ? "Unfavorite" : "Favorite", systemImage: item.favorite ? "star.slash" : "star") }.tint(Color(hex: 0xB77800))
                            }
                            .swipeActions(edge: .trailing) {
                                Button { Task { await model.setFlag(item.ref, key: "hidden", on: !item.hidden) } } label: { Label(item.hidden ? "Show" : "Hide", systemImage: item.hidden ? "eye" : "eye.slash") }.tint(Theme.inkMuted)
                            }
                    }
                } header: {
                    HStack {
                        Text(group.name)
                        Spacer()
                        Text("\(group.models.filter { !$0.hidden }.count) of \(group.all) in the picker").font(.footnote).textCase(nil)
                    }
                }
            }
        }
    }

    private struct AMModelGroup { let id: String; let name: String; let models: [AMModel]; let all: Int }

    private func grouped(_ snapshot: AMModelsSnapshot) -> [AMModelGroup] {
        var order = snapshot.providerOrder
        for model in snapshot.models where !order.contains(model.providerID) { order.append(model.providerID) }
        return order.map { id in
            let name = snapshot.providerNames[id] ?? id
            let all = snapshot.models.filter { $0.providerID == id }
            return AMModelGroup(id: id, name: name, models: all.filter { filter.matches($0, providerName: name) }, all: all.count)
        }
    }
}

// MARK: - A row

struct AMModelRow: View {
    let model: AMModel
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(model.displayName).font(.body.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
                    if model.favorite { Image(systemName: "star.fill").font(.caption).foregroundStyle(Color(hex: 0xB77800)).accessibilityLabel("Favorite") }
                }
                if model.displayName != model.modelID { Text(model.modelID).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
                Text(model.summary).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if model.hidden { StatusBadge(text: "Hidden", tone: .neutral) }
        }
        .opacity(model.hidden ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Choosing a model for a default or an alias

struct AMModelChoicePage: View {
    let model: AMModelsModel
    let title: String
    let path: [JSON]
    let unsetLabel: String
    var footer: String?
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        let snapshot = model.resource.value
        let current = model.choice(path)
        let visible = (snapshot?.models ?? []).filter { !$0.hidden }
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = visible.filter { query.isEmpty || "\($0.displayName) \($0.modelID)".lowercased().contains(query) }
        SettingsPage(title: title) {
            if let ref = current.ref, current.model == nil {
                Section { AMOutcome(kind: .warn, text: "\(ref) is not available any more. Until you choose another, the \(unsetLabel.lowercased()) is used.") }
            }
            Section {
                row(unsetLabel, subtitle: nil, selected: current.ref == nil) { choose(nil) }
            } footer: { if let footer { Text(footer) } }
            ForEach(providerIDs(shown), id: \.self) { providerID in
                Section(snapshot?.providerNames[providerID] ?? providerID) {
                    ForEach(shown.filter { $0.providerID == providerID }) { item in
                        row(item.displayName, subtitle: item.summary, selected: item.ref == current.ref) { choose(item.ref) }
                    }
                }
            }
        }
        .searchable(text: $search, prompt: "Search models")
    }

    private func providerIDs(_ models: [AMModel]) -> [String] {
        var seen: [String] = []
        for item in models where !seen.contains(item.providerID) { seen.append(item.providerID) }
        return seen
    }

    private func row(_ title: String, subtitle: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Theme.ink)
                    if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.clay).accessibilityLabel("Chosen") }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ ref: String?) {
        Task {
            if await model.setChoice(path, ref: ref) { dismiss() }
        }
    }
}

struct AMAliasesPage: View {
    let model: AMModelsModel
    private static let names = ["opus", "sonnet", "haiku", "fable"]
    var body: some View {
        SettingsPage(title: "Claude Code names") {
            SettingsSection(footer: "Agent files written for Claude Code ask for opus, sonnet, haiku or fable. Choose which of your models answers to each name.") {
                ForEach(Self.names, id: \.self) { name in
                    let path: [JSON] = ["models", "aliases", .string(name)]
                    NavigationLink {
                        AMModelChoicePage(model: model, title: name, path: path, unsetLabel: "Not set")
                    } label: {
                        NavRow(title: name, value: model.choice(path).model?.displayName ?? (model.choice(path).ref == nil ? "Not set" : "Not available"))
                    }
                }
            }
        }
    }
}

// MARK: - Adding a model by its name

struct AMAddModelSheet: View {
    let model: AMModelsModel
    @Environment(\.dismiss) private var dismiss
    @State private var providerID = ""
    @State private var modelID = ""
    @State private var touched = false
    @State private var saving = false

    private var snapshot: AMModelsSnapshot? { model.resource.value }
    private var providers: [(id: String, name: String)] { (snapshot?.providerOrder ?? []).map { ($0, snapshot?.providerNames[$0] ?? $0) } }
    private var trimmed: String { modelID.trimmingCharacters(in: .whitespaces) }
    private var problem: String? {
        if trimmed.isEmpty { return "Enter the name the provider uses." }
        if trimmed.contains(where: { $0.isWhitespace }) { return "A model name has no spaces." }
        if snapshot?.models.contains(where: { $0.providerID == effectiveProvider && $0.modelID == trimmed }) == true { return "\(trimmed) is in the list already." }
        return nil
    }
    private var effectiveProvider: String { providerID.isEmpty ? (providers.first?.id ?? "") : providerID }

    var body: some View {
        NavigationStack {
            SettingsPage(title: "Add a model") {
                SettingsSection(footer: "For a model the provider's own list leaves out. Atelier fills in default limits for it, which you can change on its page.") {
                    Picker("Provider", selection: Binding(get: { effectiveProvider }, set: { providerID = $0 })) {
                        ForEach(providers, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Model name").font(.footnote).foregroundStyle(Theme.inkMuted)
                        TextField("For example glm-5.3-flash-free", text: $modelID).font(.mono(.body))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .onChange(of: modelID) { _, _ in touched = true }
                        if touched { AMFieldError(text: problem) }
                    }
                }
                AMButtonRow {
                    Button("Add model") {
                        Task {
                            saving = true
                            if await model.addManual(providerID: effectiveProvider, modelID: trimmed) { dismiss() }
                            saving = false
                        }
                    }
                    .buttonStyle(ClayButtonStyle(busy: saving)).disabled(problem != nil || saving)
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }
}

// MARK: - A model's page

struct AMModelDetail: View {
    let model: AMModelsModel
    let ref: String
    @Environment(\.dismiss) private var dismiss
    @State private var form = AMOverrideForm()
    @State private var loadedForm = AMOverrideForm()
    @State private var touched: Set<AMOverrideForm.Field> = []
    @State private var saving = false
    @State private var probing = false
    @State private var probe: (native: Bool, detail: String)?
    @State private var probeError: String?
    @State private var confirmReset = false
    @State private var confirmRemove = false
    @FocusState private var focus: AMOverrideForm.Field?

    var body: some View {
        Group {
            if let item = model.model(ref) {
                SettingsPage(title: item.displayName) { content(item) }
            } else {
                SettingsPage(title: "Model") { EmptyState(title: "This model is gone", symbol: "square.stack.3d.up", message: "Its provider no longer lists it. Go back and pull down to refresh.") }
            }
        }
        .task(id: ref) {
            load()
            if AMLaunch.has("probe") { await runProbe() }
            if AMLaunch.has("reset") { confirmReset = true }
        }
        .confirmationDialog("Reset \(model.model(ref)?.displayName ?? "this model")?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset changes", role: .destructive) { Task { if await model.resetOverrides(ref) { load() } } }
        } message: { Text("Its name, limits and abilities go back to what Atelier detected. It stays in the picker as it is now.") }
        .confirmationDialog("Remove this model from the list?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { if await model.resetOverrides(ref) { dismiss() } } }
        } message: { Text("You added it by its name. Conversations that used it keep their history.") }
    }

    private func load() {
        let loaded = AMOverrideForm(overrides: model.overrides(ref))
        form = loaded; loadedForm = loaded; touched = []
    }

    private var errors: [AMOverrideForm.Field: String] { form.errors() }
    private var dirty: Bool { form != loadedForm }

    @ViewBuilder private func content(_ item: AMModel) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayName).font(.system(.title3, design: .serif, weight: .medium))
                if item.displayName != item.modelID { Text(item.modelID).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).textSelection(.enabled) }
                Text(model.resource.value?.providerNames[item.providerID] ?? item.providerID).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                Text(item.sourceText).font(.footnote).foregroundStyle(Theme.inkMuted)
            }.padding(.vertical, 4)
        }

        Section {
            Toggle(isOn: Binding(get: { !item.hidden }, set: { on in Task { await model.setFlag(ref, key: "hidden", on: !on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show in the model picker").foregroundStyle(Theme.ink)
                    Text("Off: people can't choose it. Admins can still reach it from here.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }.tint(Theme.clay)
            Toggle(isOn: Binding(get: { item.favorite }, set: { on in Task { await model.setFlag(ref, key: "favorite", on: on) } })) {
                Text("Favorite").foregroundStyle(Theme.ink)
            }.tint(Theme.clay)
        } header: { Text("In the picker") }

        Section {
            fieldRow("Name", error: nil) { TextField(item.modelID, text: $form.displayName).focused($focus, equals: .name) }
            fieldRow("Context length", error: shown(.context)) {
                TextField("\(AMFormat.tokens(item.contextLength)) tokens", text: $form.contextLength).keyboardType(.numberPad).focused($focus, equals: .context)
            }
            fieldRow("Longest reply", error: shown(.output)) {
                TextField("\(AMFormat.tokens(item.maxOutput)) tokens", text: $form.maxOutput).keyboardType(.numberPad).focused($focus, equals: .output)
            }
            fieldRow("Temperature", error: shown(.temperature)) {
                TextField(item.temperature.map { String($0) } ?? "The provider's own", text: $form.temperature).keyboardType(.decimalPad).focused($focus, equals: .temperature)
            }
        } header: { Text("Name and limits") } footer: {
            Text("Empty fields keep what Atelier detected. A context length set here takes priority over the one calculated from your server's memory.")
        }

        Section {
            Picker("Tool calling", selection: $form.toolCalling) {
                Text("Automatic").tag("auto"); Text("Native").tag("native"); Text("Prompted").tag("prompted"); Text("None").tag("none")
            }
            Picker("Reads images", selection: $form.vision) {
                Text("Automatic").tag("auto"); Text("Yes").tag("yes"); Text("No").tag("no")
            }
            Picker("Prompt size", selection: $form.promptTier) {
                Text("Automatic").tag("auto"); Text("Full").tag("full"); Text("Compact").tag("compact")
            }
        } header: { Text("What it can do") } footer: {
            Text("Prompted tool calling describes the tools in the prompt, for models without native support. The compact prompt suits smaller local models.")
        }

        AMButtonRow {
            Button("Save changes") { Task { await save() } }
                .buttonStyle(ClayButtonStyle(busy: saving)).disabled(!dirty || !errors.isEmpty || saving)
        }

        if item.reasoning != "none" { thinking(item) }

        Section {
            ActionRow(title: "Test tool calling", symbol: "wrench.and.screwdriver", busy: probing) { Task { await runProbe() } }
            if let probe { AMOutcome(kind: probe.native ? .good : .warn, text: probe.detail) }
            if let probeError { AMOutcome(kind: .bad, text: probeError) }
        } footer: { Text("Sends the model a small request with a tool, to see whether it calls it by itself. What it finds is saved as the model's tool calling.") }

        if model.hasOverrides(ref) || item.manual {
            Section {
                if model.hasOverrides(ref) { ActionRow(title: "Reset to what was detected", symbol: "arrow.uturn.backward", destructive: true) { confirmReset = true } }
                if item.manual { ActionRow(title: "Remove this model", symbol: "trash", destructive: true) { confirmRemove = true } }
            }
        }
    }

    private func thinking(_ item: AMModel) -> some View {
        Section {
            ValueRow(title: "Thinking", value: item.reasoning == "toggle" ? "On or off" : item.reasoning == "budget" ? "With a budget" : "In levels")
            if !item.effortLevels.isEmpty { ValueRow(title: "Levels", value: item.effortLevels.map(AMModelDetail.effortName).joined(separator: ", ")) }
            if let code = item.recommended["code"] { ValueRow(title: "Starts at", value: AMModelDetail.effortName(code), subtitle: item.recommended["chat"].map { "In chat: \(AMModelDetail.effortName($0))" }) }
        } header: { Text("How hard it thinks") } footer: { Text("Set by the provider. People choose the level in each conversation.") }
    }

    static func effortName(_ level: String) -> String {
        switch level { case "xhigh": "Extra"; case "ultracode": "Ultracode"; default: level.prefix(1).uppercased() + level.dropFirst() }
    }

    private func shown(_ field: AMOverrideForm.Field) -> String? { touched.contains(field) ? errors[field] : nil }

    private func fieldRow<Content: View>(_ title: String, error: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote).foregroundStyle(Theme.inkMuted)
            content()
            AMFieldError(text: error)
        }
        .onChange(of: focus) { old, _ in if let old { touched.insert(old) } }
    }

    private func save() async {
        touched = Set(errors.keys)
        guard errors.isEmpty else { return }
        saving = true
        if await model.save(ref, form: form) { model.store.notify("Saved"); load() }
        saving = false
    }

    private func runProbe() async {
        probing = true; probe = nil; probeError = nil
        defer { probing = false }
        do {
            probe = try await model.probe(ref)
            // The test also records what it found (native or prompted tool calling) as this model's setting.
            await model.resource.reload()
            let stored = model.overrides(ref)["toolCalling"].stringOrNil ?? "auto"
            form.toolCalling = stored; loadedForm.toolCalling = stored
        } catch is CancellationError {} catch { probeError = AMFailure.from(error).localizedDescription }
    }
}
