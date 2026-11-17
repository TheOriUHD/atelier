import SwiftUI

// Settings › Admin › Media: where pictures, videos and sounds are made, which models people get, and how much they may make.

struct MediaSettings: View {
    let store: AppStore
    @State private var model: AMMediaPageModel
    @State private var wizard: AMMediaWizardRequest?
    @State private var launched: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AMMediaPageModel(store: store))
    }

    var body: some View {
        AMResourcePage(title: "Media", resource: model.resource) { snapshot in
            foundSection
            providersSection(snapshot)
            if !snapshot.providers.isEmpty || !snapshot.models.isEmpty { defaultsSection(snapshot) }
            Section {
                NavigationLink { AMMediaModelsPage(store: store, model: model) } label: {
                    NavRow(title: "Models", subtitle: "Hide, favorite and describe them", value: "\(snapshot.models.count)")
                }
                NavigationLink { AMMediaLimitsPage(store: store, model: model) } label: {
                    NavRow(title: "Switches and limits", subtitle: "What models may make, and how much each person may")
                }
            } header: { Text("Models and limits") }
        }
        .task { await model.rescan() }
        .task { await openLaunchRoute() }
        .navigationDestination(item: $launched) { id in destination(id) }
        .sheet(item: $wizard) { request in
            if let snapshot = model.resource.value {
                AMMediaWizard(store: store, request: request, snapshot: snapshot) { message in
                    store.notify(message)
                    Task { await model.resource.reload(); await model.rescan() }
                }
            }
        }
    }

    @ViewBuilder private func destination(_ id: String) -> some View {
        if id == "models" { AMMediaModelsPage(store: store, model: model) }
        else if id == "limits" { AMMediaLimitsPage(store: store, model: model) }
        else if id.hasPrefix("model:") { AMMediaModelDetail(store: store, model: model, ref: String(id.dropFirst(6))) }
        else if id.hasPrefix("form:"), let preset = AMMediaPreset.find(String(id.dropFirst(5))), let snapshot = model.resource.value {
            AMMediaFormView(store: store, form: .new(preset, taken: []), existing: nil, snapshot: snapshot, taken: [], onSaved: { _ in })
        }
        else if id.hasPrefix("wfmap:"), let workflow = model.resource.value?.providers.first(where: { $0.id == String(id.dropFirst(6)) })?.workflows.first {
            AMWorkflowMapping(store: store, model: model, providerID: String(id.dropFirst(6)), draft: AMWorkflowDraft(workflow: workflow))
        }
        else if id.hasPrefix("workflows:") { AMWorkflowsPage(store: store, model: model, providerID: String(id.dropFirst(10))) }
        else if id.hasPrefix("default:"), let kind = AMMediaDefault(rawValue: String(id.dropFirst(8))) { AMMediaChoicePage(model: model, kind: kind) }
        else { AMMediaProviderDetail(store: store, model: model, providerID: id, onEdit: { wizard = AMMediaWizardRequest(start: .edit($0)) }) }
    }

    /// Debug builds: `--am provider/<id>`, `add`, `add/form-<preset>` (inside the wizard), `form/<preset>` (the form on its own),
    /// `edit/<id>`, `models`, `limits`, `model/<ref>`, `workflows/<id>`, `wfmap/<id>`, `default/<kind>`.
    private func openLaunchRoute() async {
        guard let route = AMLaunch.parts else { return }
        await model.resource.reload()
        switch route.head {
        case "provider": launched = route.tail
        case "add": wizard = AMMediaWizardRequest(start: .choose)
        case "edit": if let provider = model.resource.value?.providers.first(where: { $0.id == route.tail }) { wizard = AMMediaWizardRequest(start: .edit(provider)) }
        case "models", "limits": launched = route.head
        case "model": launched = "model:" + route.tail
        case "workflows": launched = "workflows:" + route.tail
        case "wfmap": launched = "wfmap:" + route.tail
        case "form": launched = "form:" + route.tail
        case "default": launched = "default:" + route.tail
        default: break
        }
    }

    // MARK: Found

    private var foundSection: some View {
        Section {
            switch model.scan {
            case .scanning:
                HStack(spacing: 10) { ProgressView(); Text("Looking for servers…").font(.subheadline).foregroundStyle(Theme.inkMuted) }
            case .failed(let message):
                AMOutcome(kind: .bad, text: message)
            case .found(let found):
                if found.isEmpty { Text("Nothing new found.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                ForEach(found) { item in
                    HStack(spacing: 12) {
                        IconTile(symbol: "server.rack", size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label).foregroundStyle(Theme.ink)
                            Text("Running at \(AMFormat.address(item.baseURL))").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Button { Task { await model.addDetected(item) } } label: {
                            if model.adding.contains(item.id) { ProgressView() } else { Text("Add") }
                        }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(Theme.clay)
                        .disabled(model.adding.contains(item.id))
                        .accessibilityLabel("Add \(item.label)")
                    }
                }
            }
        } header: {
            HStack {
                Text("Found on this server")
                Spacer()
                Button { Task { await model.rescan() } } label: { Label("Scan again", systemImage: "arrow.clockwise").labelStyle(.titleOnly) }
                    .font(.footnote).disabled(model.scan == .scanning)
            }
        } footer: { Text("Image and sound servers answering on their default ports on the server's computer.") }
    }

    // MARK: Providers

    private func providersSection(_ snapshot: AMMediaSnapshot) -> some View {
        Section {
            ForEach(snapshot.providers) { provider in
                NavigationLink { AMMediaProviderDetail(store: store, model: model, providerID: provider.id, onEdit: { wizard = AMMediaWizardRequest(start: .edit($0)) }) } label: {
                    AMMediaProviderRow(provider: provider, status: snapshot.statuses[provider.id], checking: model.checking.contains(provider.id))
                }
            }
            Button { wizard = AMMediaWizardRequest(start: .choose) } label: { Label("Add a provider", systemImage: "plus").foregroundStyle(Theme.clay) }
        } header: { Text("Image, video and sound providers") } footer: {
            Text(snapshot.providers.isEmpty
                 ? "None yet. Add a local server such as ComfyUI or Kokoro, or a cloud service such as OpenAI, Google Gemini or ElevenLabs. They are separate from the providers of text models."
                 : "Where pictures, videos and sounds are made, separate from the providers of text models.")
        }
    }

    // MARK: Defaults

    private func defaultsSection(_ snapshot: AMMediaSnapshot) -> some View {
        Section {
            ForEach(AMMediaDefault.allCases.filter { $0.offered(store) }) { kind in
                // A row only once there is something to choose: most servers will never have a model for sound effects.
                if kind == .image || snapshot.models.contains(where: kind.fits) || model.defaultChoice(kind).ref != nil {
                    NavigationLink { AMMediaChoicePage(model: model, kind: kind) } label: {
                        let current = model.defaultChoice(kind)
                        NavRow(title: kind.shortTitle, value: current.model?.displayName ?? (current.ref == nil ? "First available" : "Not available"))
                    }
                }
            }
        } header: { Text("Defaults for everyone") } footer: { Text("What makes each kind of media unless a person or a conversation chooses another.") }
    }
}

// MARK: - A row

struct AMMediaProviderRow: View {
    let provider: AMMediaProvider
    let status: AMProviderStatus?
    let checking: Bool
    private var health: AMHealth { AMHealth(enabled: provider.enabled, status: status) }

    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: provider.preset.symbol, size: 38)
                .overlay(alignment: .bottomTrailing) {
                    Group {
                        if checking { ProgressView().controlSize(.mini) } else { Circle().fill(health.color).frame(width: 9, height: 9) }
                    }
                    .padding(2.5).background(Theme.surface, in: Circle()).offset(x: 4, y: 4)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name).font(.body.weight(.medium)).foregroundStyle(provider.enabled ? Theme.ink : Theme.inkMuted).lineLimit(2)
                line
                if provider.enabled, let error = status?.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).lineLimit(4) }
                else if provider.enabled, let warning = status?.warnings.first { Text(warning).font(.footnote).foregroundStyle(Color(hex: 0xB77800)).lineLimit(4) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.name), \(provider.preset.label), \(health.label)")
    }

    private var line: some View {
        var parts: [String] = []
        if provider.enabled, let status, status.checkedAt > 0, status.ok {
            parts.append(AMFormat.plural(status.modelCount, "model"))
            if let latency = status.latencyMs { parts.append(AMFormat.duration(ms: latency)) }
        }
        let first = Text(health.label).foregroundStyle(health == .connected ? Theme.success : health == .unreachable ? Theme.danger : Theme.inkMuted)
        let rest = Text(parts.isEmpty ? "" : " · " + parts.joined(separator: " · ")).foregroundStyle(Theme.inkMuted)
        return Text("\(first)\(rest)").font(.footnote).lineLimit(2)
    }
}

// MARK: - A provider's page

struct AMMediaProviderDetail: View {
    let store: AppStore
    let model: AMMediaPageModel
    let providerID: String
    let onEdit: (AMMediaProvider) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemove = false
    @State private var removing = false

    private var snapshot: AMMediaSnapshot? { model.resource.value }
    private var provider: AMMediaProvider? { snapshot?.providers.first { $0.id == providerID } }

    var body: some View {
        Group {
            if let provider, let snapshot {
                SettingsPage(title: provider.name) { content(provider, snapshot) }.refreshable { await model.resource.reload() }
            } else {
                SettingsPage(title: "Provider") { EmptyState(title: "This provider is gone", symbol: "photo.on.rectangle", message: "It was removed, or the list changed. Go back and pull down to refresh.") }
            }
        }
        .task { if AMLaunch.has("remove") { confirmRemove = true } }
        .confirmationDialog("Remove \(provider?.name ?? "this provider")?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let provider else { return }
                Task {
                    removing = true
                    if await model.remove(provider) { dismiss() }
                    removing = false
                }
            }
        } message: { Text("Its models leave the pickers and its stored API key is deleted. Pictures, videos and sounds it already made stay in their conversations.") }
    }

    @ViewBuilder private func content(_ provider: AMMediaProvider, _ snapshot: AMMediaSnapshot) -> some View {
        let status = snapshot.statuses[provider.id]
        let health = AMHealth(enabled: provider.enabled, status: status)
        Section {
            HStack(spacing: 14) {
                IconTile(symbol: provider.preset.symbol, size: 46)
                VStack(alignment: .leading, spacing: 4) {
                    Text(provider.name).font(.system(.title3, design: .serif, weight: .medium))
                    HStack(spacing: 6) {
                        StatusBadge(text: provider.preset.label, tone: .neutral)
                        StatusBadge(text: health.label, tone: health.tone)
                    }
                }
            }.padding(.vertical, 4)
        }

        Section {
            if provider.enabled, let status, status.checkedAt > 0 {
                if status.ok {
                    ValueRow(title: "Models found", value: "\(status.modelCount)")
                    if let latency = status.latencyMs { ValueRow(title: "Answered in", value: AMFormat.duration(ms: latency)) }
                } else if let error = status.error { AMOutcome(kind: .bad, text: error) }
                ForEach(status.warnings, id: \.self) { AMOutcome(kind: .warn, text: $0) }
                ValueRow(title: "Last checked", value: AMFormat.ago(status.checkedAt))
            } else if !provider.enabled { AMNote(text: "Turned off. Its models are not offered.") }
            else { AMNote(text: "Not checked yet.") }
            ActionRow(title: "Test connection", symbol: "arrow.clockwise", busy: model.checking.contains(provider.id)) { Task { await model.check(provider.id) } }
                .disabled(!provider.enabled)
        } header: { Text("Connection") }

        Section {
            Toggle(isOn: Binding(get: { model.pendingEnabled[provider.id] ?? provider.enabled }, set: { on in Task { await model.setEnabled(provider, on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Use this provider").foregroundStyle(Theme.ink)
                    Text("Off: its models are not offered. Nothing is deleted.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }.tint(Theme.clay)
        }

        if provider.isComfy {
            Section {
                NavigationLink { AMWorkflowsPage(store: store, model: model, providerID: provider.id) } label: {
                    NavRow(title: "Workflows", subtitle: "Your own ComfyUI workflows, each one a model", value: provider.workflows.isEmpty ? nil : "\(provider.workflows.count)")
                }
            }
        }

        Section {
            ValueRow(title: "Address", value: AMFormat.address(provider.baseURL), mono: true, copyable: true)
            if let key = AMForm.keyHint(provider.apiKey, secrets: snapshot.secrets) { ValueRow(title: "API key", value: key, mono: true) }
            ValueRow(title: "Short name", value: provider.id, subtitle: "Models are referenced as \(provider.id)/model-name.", mono: true)
            if let n = provider.parallelRequests { ValueRow(title: "Requests at once", value: "\(n)") }
            if let partner = provider.sharesGpuWith { ValueRow(title: "Shares a GPU with", value: snapshot.textProviders.first { $0.id == partner }?.name ?? partner) }
            if provider.freeAfterRun { ValueRow(title: "After each job", value: "Unloads the model") }
            if !provider.models.isEmpty { ValueRow(title: "Models typed in", value: "\(provider.models.count)") }
        } header: { Text("Details") }

        Section {
            Button { onEdit(provider) } label: { Label("Edit", systemImage: "pencil").foregroundStyle(Theme.clay) }
            ActionRow(title: "Remove provider", symbol: "trash", destructive: true, busy: removing) { confirmRemove = true }
        }
    }
}

// MARK: - Models

struct AMMediaModelsPage: View {
    let store: AppStore
    let model: AMMediaPageModel
    @State private var search = ""
    @State private var scope: AMModelScope = .all

    var body: some View {
        let snapshot = model.resource.value
        let names = snapshot?.providerNames ?? [:]
        let all = snapshot?.models ?? []
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = all.filter { item in
            (scope == .all || (scope == .hidden) == item.hidden) && (query.isEmpty || "\(item.displayName) \(item.modelID) \(names[item.providerID] ?? "")".lowercased().contains(query))
        }
        SettingsPage(title: "Models") {
            if all.isEmpty {
                Section { EmptyState(title: "No models yet", symbol: "photo.on.rectangle", message: "Models appear here once an image, video or sound provider is connected.") }.listRowBackground(Color.clear)
            } else {
                Section { Picker("Show", selection: $scope) { ForEach(AMModelScope.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented).listRowBackground(Color.clear) }
                if shown.isEmpty { Section { AMNote(text: "No models match.") } }
                ForEach(providerIDs(shown), id: \.self) { providerID in
                    Section {
                        ForEach(shown.filter { $0.providerID == providerID }) { item in
                            NavigationLink { AMMediaModelDetail(store: store, model: model, ref: item.ref) } label: { AMMediaModelRow(item: item, defaults: defaultKinds(item)) }
                                .swipeActions(edge: .leading) {
                                    Button { Task { await model.setFlag(item.ref, key: "favorite", on: !item.favorite) } } label: { Label(item.favorite ? "Unfavorite" : "Favorite", systemImage: item.favorite ? "star.slash" : "star") }.tint(Color(hex: 0xB77800))
                                }
                                .swipeActions(edge: .trailing) {
                                    Button { Task { await model.setFlag(item.ref, key: "hidden", on: !item.hidden) } } label: { Label(item.hidden ? "Show" : "Hide", systemImage: item.hidden ? "eye" : "eye.slash") }.tint(Theme.inkMuted)
                                }
                        }
                    } header: { Text(names[providerID] ?? providerID) }
                }
            }
        }
        .searchable(text: $search, prompt: "Search models")
    }

    private func providerIDs(_ items: [AMMediaModel]) -> [String] {
        var seen: [String] = []
        for item in items where !seen.contains(item.providerID) { seen.append(item.providerID) }
        return seen
    }

    private func defaultKinds(_ item: AMMediaModel) -> [AMMediaDefault] { AMMediaDefault.allCases.filter { $0.fits(item) && model.settings.value($0.path).string == item.ref } }
}

struct AMMediaModelRow: View {
    let item: AMMediaModel
    let defaults: [AMMediaDefault]
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.displayName).font(.body.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
                    if item.favorite { Image(systemName: "star.fill").font(.caption).foregroundStyle(Color(hex: 0xB77800)).accessibilityLabel("Favorite") }
                }
                if item.displayName != item.modelID { Text(item.modelID).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
                Text(item.summary).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(2)
                if let description = item.description { Text(description).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 4) {
                if !defaults.isEmpty { StatusBadge(text: "Default", tone: .clay) }
                if item.hidden { StatusBadge(text: "Hidden", tone: .neutral) }
            }
        }
        .opacity(item.hidden ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

struct AMMediaChoicePage: View {
    let model: AMMediaPageModel
    let kind: AMMediaDefault
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let snapshot = model.resource.value
        let names = snapshot?.providerNames ?? [:]
        let list = (snapshot?.models ?? []).filter { !$0.hidden && kind.fits($0) }
        let current = model.defaultChoice(kind)
        SettingsPage(title: kind.title) {
            if let ref = current.ref, current.model == nil {
                Section { AMOutcome(kind: .warn, text: "\(ref) is not available any more. \(kind.noun) use the first available model until you choose another.") }
            }
            Section {
                row("First available model", subtitle: nil, selected: current.ref == nil) { choose(nil) }
            } footer: { Text(kind.summary) }
            ForEach(Array(Set(list.map(\.providerID))).sorted(), id: \.self) { providerID in
                Section(names[providerID] ?? providerID) {
                    ForEach(list.filter { $0.providerID == providerID }) { item in
                        row(item.displayName, subtitle: item.summary, selected: item.ref == current.ref) { choose(item.ref) }
                    }
                }
            }
        }
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

    private func choose(_ ref: String?) { Task { if await model.setDefault(kind, ref: ref) { dismiss() } } }
}

// MARK: - One model

struct AMMediaModelDetail: View {
    let store: AppStore
    let model: AMMediaPageModel
    let ref: String
    @State private var form = AMMediaOverrideForm()
    @State private var loaded = AMMediaOverrideForm()
    @State private var touched: Set<AMMediaOverrideForm.Field> = []
    @State private var saving = false
    @FocusState private var focus: AMMediaOverrideForm.Field?

    private var item: AMMediaModel? { model.resource.value?.models.first { $0.ref == ref } }
    private var errors: [AMMediaOverrideForm.Field: String] { form.errors() }

    var body: some View {
        Group {
            if let item { SettingsPage(title: item.displayName) { content(item) } }
            else { SettingsPage(title: "Model") { EmptyState(title: "This model is gone", symbol: "photo.on.rectangle", message: "Its provider no longer lists it. Go back and pull down to refresh.") } }
        }
        .task(id: ref) { reload() }
        .onChange(of: focus) { old, _ in if let old { touched.insert(old) } }
    }

    private func reload() {
        let fresh = AMMediaOverrideForm(overrides: model.overrides(ref))
        form = fresh; loaded = fresh; touched = []
    }

    private func shown(_ field: AMMediaOverrideForm.Field) -> String? { touched.contains(field) ? errors[field] : nil }

    @ViewBuilder private func content(_ item: AMMediaModel) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayName).font(.system(.title3, design: .serif, weight: .medium))
                if item.displayName != item.modelID { Text(item.modelID).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).textSelection(.enabled) }
                Text(model.resource.value?.providerNames[item.providerID] ?? item.providerID).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                Text("\(item.kindLabel): \(item.summary)").font(.footnote).foregroundStyle(Theme.inkMuted)
            }.padding(.vertical, 4)
        }

        Section {
            Toggle(isOn: Binding(get: { !item.hidden }, set: { on in Task { await model.setFlag(ref, key: "hidden", on: !on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show in the model picker").foregroundStyle(Theme.ink)
                    Text("Off: people can't choose it. Admins can still use it.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }.tint(Theme.clay)
            Toggle("Favorite", isOn: Binding(get: { item.favorite }, set: { on in Task { await model.setFlag(ref, key: "favorite", on: on) } })).tint(Theme.clay)
            ForEach(AMMediaDefault.allCases.filter { $0.offered(store) && $0.fits(item) }) { kind in
                let isDefault = model.settings.value(kind.path).string == item.ref
                ActionRow(title: isDefault ? "Default for \(kind.rawValue == "sound" ? "sound effects" : kind.rawValue)" : "Make the default \(kind.rawValue == "sound" ? "sound effects" : kind.rawValue) model", symbol: isDefault ? "checkmark" : "star", tint: isDefault ? Theme.inkMuted : Theme.clay) {
                    Task { if await model.setDefault(kind, ref: item.ref) { store.notify("Default set") } }
                }
                .disabled(isDefault)
            }
        } header: { Text("In the picker") }

        Section {
            field("Name", error: nil) { TextField(item.modelID, text: $form.displayName).onChange(of: form.displayName) { _, new in if new.count > 100 { form.displayName = String(new.prefix(100)) } } }
            field("What it's good at", error: nil) { TextField(Self.goodAtExample(item.kind), text: $form.description, axis: .vertical).lineLimit(1...4) }
        } header: { Text("Name and description") } footer: {
            Text("The text model reads the description when it chooses a model. Empty fields keep what Atelier detected.")
        }

        if item.kind == .video { videoSection(item) }
        if item.kind == .audio { soundSection(item) }
        if item.tunable && item.kind == .image { tuningSection(item) }

        AMButtonRow {
            Button("Save changes") { Task { await save() } }
                .buttonStyle(ClayButtonStyle(busy: saving)).disabled(form == loaded || !errors.isEmpty || saving)
        }
    }

    private func videoSection(_ item: AMMediaModel) -> some View {
        Section {
            field("Length in seconds", error: shown(.seconds)) {
                TextField(item.fixedLength ? "This model chooses" : "\(item.defaultSeconds.map { AMMediaOverrideForm.number($0) } ?? "its usual") (its usual)", text: $form.seconds)
                    .keyboardType(.decimalPad).focused($focus, equals: .seconds).disabled(item.fixedLength)
            }
            if !item.fps.isEmpty || item.defaultFPS != nil {
                field("Frames per second", error: shown(.fps)) { TextField(item.defaultFPS.map(String.init) ?? "Automatic", text: $form.fps).keyboardType(.numberPad).focused($focus, equals: .fps) }
            }
            if !item.resolutions.isEmpty {
                Picker("Resolution", selection: $form.resolution) {
                    Text("Automatic").tag("auto")
                    ForEach(item.resolutions, id: \.self) { Text($0).tag($0) }
                }
            }
        } header: { Text("Usual video settings") } footer: { Text(item.fixedLength ? "This model chooses how long its clips are." : "Used when a request names none.") }
    }

    private func soundSection(_ item: AMMediaModel) -> some View {
        Section {
            if item.audioKinds.contains("speech") {
                if item.voices.isEmpty {
                    field("Voice", error: nil) { TextField(item.defaultVoice ?? "Automatic", text: Binding(get: { form.voice == "auto" ? "" : form.voice }, set: { form.voice = $0.isEmpty ? "auto" : $0 })).textInputAutocapitalization(.never).autocorrectionDisabled() }
                } else {
                    Picker("Voice", selection: $form.voice) {
                        Text("Automatic").tag("auto")
                        ForEach(item.voices, id: \.id) { voice in Text(voice.detail.map { "\(voice.name), \($0)" } ?? voice.name).tag(voice.id) }
                        if form.voice != "auto", !item.voices.contains(where: { $0.id == form.voice }) { Text(form.voice).tag(form.voice) }
                    }
                }
            }
            if item.soundDurationText != nil {
                field("Length in seconds", error: shown(.soundSeconds)) {
                    TextField(item.soundDefaultSeconds.map { "\(AMMediaOverrideForm.number($0)) (its usual)" } ?? "Automatic", text: $form.soundSeconds).keyboardType(.decimalPad).focused($focus, equals: .soundSeconds)
                }
            }
        } header: { Text("Usual sound settings") } footer: { Text("Used when a request names none. Speech is as long as its words.") }
    }

    private func tuningSection(_ item: AMMediaModel) -> some View {
        Section {
            field("Steps", error: shown(.steps)) { TextField(item.defaultSteps.map(String.init) ?? "Automatic", text: $form.steps).keyboardType(.numberPad).focused($focus, equals: .steps) }
            field("Guidance", error: shown(.guidance)) { TextField(item.defaultGuidance.map { AMMediaOverrideForm.number($0) } ?? "Automatic", text: $form.guidance).keyboardType(.decimalPad).focused($focus, equals: .guidance) }
            choice("Sampler", options: item.samplers, usual: item.defaultSampler, selection: $form.sampler)
            choice("Scheduler", options: item.schedulers, usual: item.defaultScheduler, selection: $form.scheduler)
        } header: { Text("Tuning") } footer: { Text("How the model draws. Empty fields keep the model's own settings.") }
    }

    @ViewBuilder private func choice(_ title: String, options: [String], usual: String?, selection: Binding<String>) -> some View {
        if options.isEmpty {
            field(title, error: nil) { TextField(usual ?? "Automatic", text: Binding(get: { selection.wrappedValue == "auto" ? "" : selection.wrappedValue }, set: { selection.wrappedValue = $0.isEmpty ? "auto" : $0 })).textInputAutocapitalization(.never).autocorrectionDisabled() }
        } else {
            Picker(title, selection: selection) {
                Text(usual.map { "Automatic (\($0))" } ?? "Automatic").tag("auto")
                ForEach(options, id: \.self) { Text($0).tag($0) }
                if selection.wrappedValue != "auto", !options.contains(selection.wrappedValue) { Text(selection.wrappedValue).tag(selection.wrappedValue) }
            }
        }
    }

    /// An example of what to write, in the words of the kind of model it is for.
    static func goodAtExample(_ kind: AMMediaModel.Kind) -> String {
        switch kind {
        case .image: "Photos of people, fast drafts, text…"
        case .video: "Short clips, smooth camera moves…"
        case .audio: "Natural speech, many languages…"
        }
    }

    private func field<Content: View>(_ title: String, error: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote).foregroundStyle(Theme.inkMuted)
            content()
            AMFieldError(text: error)
        }
    }

    private func save() async {
        touched = Set(errors.keys)
        guard errors.isEmpty else { return }
        saving = true
        if await model.saveOverrides(ref, form: form) { store.notify("Saved"); reload() }
        saving = false
    }
}

// MARK: - Switches and limits

struct AMMediaLimitsPage: View {
    let store: AppStore
    let model: AMMediaPageModel

    var body: some View {
        SettingsPage(title: "Switches and limits") {
            Section {
                ToggleRow(title: "Let models make images", subtitle: "Off: conversations don't get the tool, whichever providers are set up.", isOn: model.settings.toggle(store, ["imageGeneration", "enabled"], default: true))
                ForEach(AMLimitSpec.images) { AMLimitRow(store: store, model: model, spec: $0) }
            } header: { Text("Images") }
            if store.offers("videoGeneration") {
                Section {
                    ToggleRow(title: "Let models make videos", subtitle: "Off: no video tool. Images are not affected.", isOn: model.settings.toggle(store, ["imageGeneration", "videoEnabled"], default: true))
                    ForEach(AMLimitSpec.videos) { AMLimitRow(store: store, model: model, spec: $0) }
                } header: { Text("Videos") }
            }
            if store.offers("audioGeneration") {
                Section {
                    ToggleRow(title: "Let models make sounds", subtitle: "Speech, music and sound effects. Off: no sound tool. Images and videos are not affected.", isOn: model.settings.toggle(store, ["imageGeneration", "audioEnabled"], default: true))
                    ForEach(AMLimitSpec.sounds) { AMLimitRow(store: store, model: model, spec: $0) }
                } header: { Text("Sounds") }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

/// A number that is saved when the field is left. Left empty, an optional limit goes away and a required one keeps its value.
struct AMLimitRow: View {
    let store: AppStore
    let model: AMMediaPageModel
    let spec: AMLimitSpec
    @State private var text = ""
    @State private var loaded = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var path: [JSON] { ["imageGeneration", .string(spec.key)] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(spec.title).foregroundStyle(Theme.ink)
            HStack(spacing: 8) {
                TextField(spec.required ? "" : (spec.fallback ?? "No limit"), text: $text)
                    .keyboardType(spec.kind.isDollars ? .decimalPad : .numberPad).multilineTextAlignment(.trailing)
                    .focused($focused).frame(maxWidth: 120)
                    .padding(.horizontal, 10).padding(.vertical, 7).background(Theme.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text(spec.unit).font(.subheadline).foregroundStyle(Theme.inkMuted)
                Spacer()
            }
            AMFieldError(text: problem)
            Text(spec.subtitle).font(.footnote).foregroundStyle(Theme.inkMuted)
        }
        .onAppear {
            if !loaded {
                let value = model.settings.value(path)
                text = value.doubleOrNil.map { AMMediaOverrideForm.number($0) } ?? ""
                loaded = true
            }
        }
        .onChange(of: focused) { _, now in if !now { Task { await save() } } }
        .onSubmit { Task { await save() } }
    }

    private func save() async {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let stored = model.settings.value(path).doubleOrNil.map { AMMediaOverrideForm.number($0) } ?? ""
        if trimmed == stored { problem = nil; return }
        if trimmed.isEmpty {
            if spec.required { problem = spec.problem; text = stored; return }
            problem = nil
            await store.attempt { try await model.settings.reset(path) }
            return
        }
        guard let value = spec.parse(trimmed) else { problem = spec.problem; return }
        problem = nil
        await store.attempt { try await model.settings.set(path, value) }
    }
}

extension AMLimitSpec.Kind {
    var isDollars: Bool { if case .dollars = self { true } else { false } }
}
