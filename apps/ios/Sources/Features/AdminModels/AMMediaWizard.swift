import SwiftUI
import AVFoundation

// Adding and editing a media provider: choose the service, fill in what it needs, test it (even with a real picture or
// sound), save. One sheet with its own navigation.

struct AMMediaWizardRequest: Identifiable {
    enum Start { case choose, edit(AMMediaProvider) }
    let id = UUID()
    let start: Start
}

/// One page pushed in the wizard: the form of the service with that id. The route carries the id itself, not a place in
/// some state: a destination that read state kept next to the stack came up empty (a blank page with only a back button).
enum AMMediaWizardRoute: Hashable { case form(String) }

struct AMMediaWizard: View {
    let store: AppStore
    let request: AMMediaWizardRequest
    let snapshot: AMMediaSnapshot
    let onSaved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: [AMMediaWizardRoute] = []
    @State private var search = ""

    private var taken: Set<String> { Set(snapshot.providers.map(\.id) + snapshot.textProviders.map(\.id)) }

    var body: some View {
        NavigationStack(path: $path) {
            root.navigationDestination(for: AMMediaWizardRoute.self) { route in
                switch route {
                case .form(let id):
                    if let preset = AMMediaPreset.find(id) {
                        AMMediaFormView(store: store, form: .new(preset, taken: taken), existing: nil, snapshot: snapshot, taken: taken, onSaved: finish)
                    }
                }
            }
        }
        .tint(Theme.clay)
        .toasts(store)
        .presentationDragIndicator(.visible)
        .presentationSizing(.page)
        .task { openLaunchRoute() }
    }

    private func finish(_ message: String) { onSaved(message); dismiss() }

    @ViewBuilder private var root: some View {
        switch request.start {
        case .edit(let provider):
            AMMediaFormView(store: store, form: AMMediaForm(config: provider), existing: provider, snapshot: snapshot, taken: taken, onSaved: finish, onCancel: { dismiss() })
        case .choose:
            chooser
        }
    }

    private func open(_ preset: AMMediaPreset) { path.append(.form(preset.id)) }

    /// Debug builds: `--am add/form-<preset id>` opens the form of that service.
    private func openLaunchRoute() {
        guard case .choose = request.start, let route = AMLaunch.parts, route.head == "add", route.tail.hasPrefix("form-"),
              let preset = AMMediaPreset.find(String(route.tail.dropFirst(5))) else { return }
        open(preset)
    }

    private var chooser: some View {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        return SettingsPage(title: "Add a provider") {
            Section {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.inkMuted)
                    TextField("Search services", text: $search).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.inkMuted) }.buttonStyle(.plain).accessibilityLabel("Clear search") }
                }
            }
            ForEach(AMMediaPreset.Group.allCases, id: \.self) { group in
                let presets = AMMediaPreset.all.filter { $0.group == group && (query.isEmpty || $0.label.lowercased().contains(query)) }
                if !presets.isEmpty {
                    Section {
                        ForEach(presets) { preset in
                            Button { open(preset) } label: {
                                HStack(spacing: 12) {
                                    IconTile(symbol: preset.symbol, size: 32)
                                    Text(preset.label).foregroundStyle(Theme.ink)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted.opacity(0.6))
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } header: { Text(group.title) }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
}

// MARK: - The form

struct AMMediaFormView: View {
    let store: AppStore
    let existing: AMMediaProvider?
    let snapshot: AMMediaSnapshot
    let taken: Set<String>
    let onSaved: (String) -> Void
    var onCancel: (() -> Void)?

    @State private var form: AMMediaForm
    @State private var touched: Set<AMMediaForm.Field> = []
    @State private var test: TestState = .idle
    @State private var tested: [AMMediaModel] = []
    /// Models the admin hid here, applied once the provider is saved.
    @State private var hidden: [String: Bool] = [:]
    @State private var saving = false
    @State private var saveError: String?
    @State private var replacingKey = false
    @State private var showID = false
    @State private var newModel = ""
    @State private var run = 0
    @FocusState private var focus: AMMediaForm.Field?

    enum TestState: Equatable { case idle, testing, done(AMTestOutcome), failed(String) }

    init(store: AppStore, form: AMMediaForm, existing: AMMediaProvider?, snapshot: AMMediaSnapshot, taken: Set<String>, onSaved: @escaping (String) -> Void, onCancel: (() -> Void)? = nil) {
        self.store = store; self.existing = existing; self.snapshot = snapshot; self.taken = taken; self.onSaved = onSaved; self.onCancel = onCancel
        _form = State(initialValue: form)
    }

    private var storedKey: String? { AMForm.keyHint(existing?.apiKey, secrets: snapshot.secrets) }
    private var errors: [AMMediaForm.Field: String] { form.errors(taken: taken, editing: existing != nil, hasStoredKey: storedKey != nil) }
    private var valid: Bool { errors.isEmpty }
    private func shown(_ field: AMMediaForm.Field) -> String? { touched.contains(field) ? errors[field] : nil }
    private var keySources: [AMProvider] { AMMediaKeys.sources(for: form.preset, providers: snapshot.textProviders) }
    private var partners: [(provider: AMProvider, sameHost: Bool)] { AMMediaKeys.gpuPartners(baseURL: form.baseURL, providers: snapshot.textProviders) }
    private var foundModels: [AMMediaModel] { if case .done(let outcome) = test, outcome.ok { tested } else { [] } }

    var body: some View {
        ScrollViewReader { proxy in page.task { await scrollToEndWhenAsked(proxy) } }
    }

    /// Debug builds: `--am-flags tail` scrolls to the end once a test ran, so its result can be looked at.
    private func scrollToEndWhenAsked(_ proxy: ScrollViewProxy) async {
        guard AMLaunch.has("tail") else { return }
        try? await Task.sleep(for: .seconds(AMLaunch.has("test") ? 3 : 1))
        proxy.scrollTo("am-end", anchor: .bottom)
    }

    private var page: some View {
        SettingsPage(title: existing != nil ? "Edit \(existing?.name ?? "provider")" : "Add \(form.preset.label)") {
            if let help = form.preset.help { Section { AMNote(text: help).foregroundStyle(Theme.ink) } }
            aboutSection
            if form.preset.key != .none { keySection }
            if form.preset.hasTypedModels { typedModelsSection }
            limitsSection
            if form.preset.runsLocally { gpuSection }
            checkSection
            if !foundModels.isEmpty, !store.offers("sharedComputer") { foundSection }
            if foundModels.contains(where: { $0.kind == .image }) {
                Section { AMMediaTestImage(store: store, draft: form.draft(), preset: form.preset, models: foundModels.filter { $0.kind == .image }) } header: { Text("Try it") }
            }
            if foundModels.contains(where: { $0.kind == .audio }) {
                Section { AMMediaTestSound(store: store, draft: form.draft(), preset: form.preset, models: foundModels.filter { $0.kind == .audio }) } header: { Text("Try a sound") }
            }
            if !foundModels.isEmpty, foundModels.allSatisfy({ $0.kind == .video }) {
                Section { AMNote(text: "There is no test clip: a video takes minutes and costs real money, so the check above, which lists the models with your key, is all this does. The first video is made when someone asks for one in a chat.") }
            }
            actionSection
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar { if let onCancel { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } } }
        .onChange(of: focus) { old, _ in if let old { touched.insert(old) } }
        .task {
            if AMLaunch.has("touch") { touched = Set(errors.keys) }
            if AMLaunch.has("test") { await runTest() }
        }
    }

    // MARK: Sections

    private var aboutSection: some View {
        SettingsSection(title: "About it") {
            field("Name", error: shown(.name)) { TextField("Name", text: nameBinding).focused($focus, equals: .name).textInputAutocapitalization(.words) }
            field("Address", error: shown(.baseURL)) {
                TextField("https://", text: binding(\.baseURL)).focused($focus, equals: .baseURL)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if existing == nil {
                DisclosureGroup(isExpanded: $showID) {
                    VStack(alignment: .leading, spacing: 4) {
                        TextField("short-name", text: Binding(get: { form.id }, set: { form.id = $0; form.idEdited = true; changed() }))
                            .font(.mono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .id)
                        AMNote(text: "Models are referenced as \(form.id.isEmpty ? "short-name" : form.id)/model-name. You can't change it later.")
                        AMFieldError(text: shown(.id))
                    }.padding(.top, 4)
                } label: { HStack { Text("Short name").foregroundStyle(Theme.ink); Spacer(); Text(form.id).font(.mono(.subheadline)).foregroundStyle(Theme.inkMuted).lineLimit(1) } }
            } else {
                ValueRow(title: "Short name", value: form.id, mono: true)
            }
        }
    }

    private var keySection: some View {
        SettingsSection(title: "API key", footer: form.preset.key == .optional ? "Optional. Only needed if the server asks for one." : "Stored encrypted by Atelier, never in settings files, and never shown again.") {
            if let source = form.keyFrom {
                HStack {
                    Text("The key from \(snapshot.textProviders.first { $0.id == source }?.name ?? source)").font(.subheadline).foregroundStyle(Theme.ink)
                    Spacer()
                    Button("Enter a key") { form.keyFrom = nil; changed() }.font(.subheadline)
                }
            } else if let stored = storedKey, !replacingKey {
                HStack {
                    Text(stored).font(.mono(.body)).foregroundStyle(Theme.inkSecondary)
                    Spacer()
                    Button("Replace") { replacingKey = true }.font(.subheadline)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    SecureField(storedKey != nil ? "New key" : form.preset.key == .required ? "Paste your API key" : "Optional", text: binding(\.apiKey))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .apiKey)
                    AMFieldError(text: shown(.apiKey))
                }
                ForEach(keySources) { source in
                    Button("Use the key from \(source.name)") { form.keyFrom = source.id; form.apiKey = ""; changed() }.font(.subheadline)
                }
            }
            if let url = form.preset.keyURL { AMLinkRow(title: "Get a key", url: url) }
        }
    }

    private var typedModelsSection: some View {
        let azure = form.preset.id == "azure"
        return SettingsSection(title: azure ? "Deployments" : "Models", footer: azure ? "Add each deployment by name." : "This service lists no models itself: add the ones you want by their id.") {
            ForEach(form.models, id: \.self) { id in
                Text(id).font(.mono(.subheadline)).foregroundStyle(Theme.ink).lineLimit(2)
                    .swipeActions { Button("Remove", role: .destructive) { form.models.removeAll { $0 == id }; changed() } }
            }
            HStack(spacing: 8) {
                TextField(azure ? "Deployment name" : "Model id", text: $newModel).font(.mono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focus, equals: .models).onSubmit(addModel)
                Button("Add", action: addModel).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(Theme.clay)
                    .disabled(newModel.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            AMFieldError(text: shown(.models) ?? (touched.contains(.models) ? errors[.models] : nil))
        }
    }

    private func addModel() {
        let id = newModel.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty else { return }
        if !form.models.contains(id) { form.models.append(id); changed() }
        newModel = ""
    }

    private var limitsSection: some View {
        SettingsSection(title: "What the server can take", footer: "What the server can handle at once. Atelier queues the rest. Automatic: one at a time on a computer you run.") {
            field("Requests at once", error: shown(.parallel)) { TextField("Automatic", text: binding(\.parallelRequests)).keyboardType(.numberPad).focused($focus, equals: .parallel) }
        }
    }

    private var gpuSection: some View {
        SettingsSection(title: "GPU", footer: form.sharesGpuWith != nil
            ? "The text model unloads for each image and loads again afterwards, so the next reply starts later."
            : "Unloading frees the GPU for other work, and the next image loads its model again.") {
            if !partners.isEmpty || form.sharesGpuWith != nil {
                Picker("Shares a GPU with", selection: Binding(get: { form.sharesGpuWith ?? "none" }, set: { form.sharesGpuWith = $0 == "none" ? nil : $0; changed() })) {
                    Text("Nothing else").tag("none")
                    ForEach(partners, id: \.provider.id) { Text($0.sameHost ? "\($0.provider.name), same computer" : $0.provider.name).tag($0.provider.id) }
                    if let current = form.sharesGpuWith, !partners.contains(where: { $0.provider.id == current }) { Text("\(current) (unavailable)").tag(current) }
                }
            }
            Toggle("Unload after each image", isOn: Binding(get: { form.freeAfterRun }, set: { form.freeAfterRun = $0; changed() })).tint(Theme.clay)
        }
    }

    private var checkSection: some View {
        Section {
            ActionRow(title: "Test connection", symbol: "arrow.clockwise", busy: test == .testing) { Task { await runTest() } }
            switch test {
            case .idle, .testing: EmptyView()
            case .failed(let message): AMOutcome(kind: .bad, text: message)
            case .done(let outcome):
                AMOutcome(kind: outcome.ok ? .good : .bad, text: outcome.summary)
                ForEach(outcome.warnings, id: \.self) { AMOutcome(kind: .warn, text: $0) }
            }
        } footer: { Text("Checks the address and key, and lists the models it finds. Nothing is saved.") }
    }

    private var foundSection: some View {
        Section {
            ForEach(foundModels) { item in
                Toggle(isOn: Binding(get: { !(hidden[item.ref] ?? item.hidden) }, set: { on in hidden[item.ref] = !on })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.displayName).foregroundStyle(Theme.ink)
                        Text(item.summary).font(.footnote).foregroundStyle(Theme.inkMuted)
                    }
                }.tint(Theme.clay)
            }
        } header: { Text("Models found") } footer: { Text("Turn off a model to keep it from other accounts. Admins can still use it.") }
    }

    private var actionSection: some View {
        Group {
            if let saveError { Section { AMOutcome(kind: .bad, text: saveError) } }
            AMButtonRow {
                Button(existing != nil ? "Save" : "Add provider") { Task { await save() } }
                    .buttonStyle(ClayButtonStyle(busy: saving)).disabled(!valid || saving)
            }
            .id("am-end")
        }
    }

    // MARK: Pieces

    private func field<Content: View>(_ title: String, error: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote).foregroundStyle(Theme.inkMuted)
            content()
            AMFieldError(text: error)
        }
    }

    private func binding(_ keyPath: WritableKeyPath<AMMediaForm, String>) -> Binding<String> {
        Binding(get: { form[keyPath: keyPath] }, set: { form[keyPath: keyPath] = $0; changed() })
    }
    private var nameBinding: Binding<String> { Binding(get: { form.name }, set: { form.rename($0, taken: taken); changed() }) }
    private func changed() { run += 1; test = .idle; tested = []; saveError = nil }

    // MARK: Actions

    private func runTest() async {
        touched.formUnion(errors.keys)
        guard valid else { return }
        run += 1
        let mine = run
        test = .testing; tested = []; hidden = [:]
        do {
            let result = try await AMAPI(store: store).call("imageProviders.test", form.draft())
            guard mine == run else { return }
            test = .done(AMTestOutcome(status: AMProviderStatus(json: result["status"])))
            tested = result["models"].array.map(AMMediaModel.init)
        } catch is CancellationError {} catch { if mine == run { test = .failed(AMFailure.from(error).localizedDescription) } }
    }

    private func save() async {
        touched.formUnion(errors.keys)
        guard valid else { return }
        saving = true; saveError = nil
        defer { saving = false }
        do {
            let api = AMAPI(store: store)
            let saved = try await api.call("imageProviders.save", form.draft())
            for (ref, value) in hidden {
                _ = try await api.call("settings.set", ["layer": "global", "path": ["imageModels", "overrides", .string(ref), "hidden"], "value": .bool(value)])
            }
            let name = saved["name"].stringOrNil ?? form.name
            onSaved(existing != nil ? "Saved \(name)" : "Added \(name)")
        } catch is CancellationError {} catch { saveError = AMFailure.from(error).localizedDescription }
    }
}

// MARK: - Trying it for real

/// A picture the server made, downloaded with the sign-in. In the demo there is no server, so a stand-in is drawn.
struct AMBlobImage: View {
    let store: AppStore
    let sha: String
    let mime: String
    @State private var image: UIImage?
    @State private var failed: String?

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)).accessibilityLabel("What the test made") }
            else if let failed { AMOutcome(kind: .bad, text: failed) }
            else { ProgressView().frame(maxWidth: .infinity, minHeight: 120) }
        }
        .task(id: sha) {
            #if DEBUG
            if Launch.value("--demo") != nil { image = AMDemoArt.picture(); return }
            #endif
            do {
                let url = try await AMBlob.download(sha, mime: mime, store: store)
                defer { try? FileManager.default.removeItem(at: url) }
                image = UIImage(contentsOfFile: url.path)
                if image == nil { failed = "The server made a picture this app can't show." }
            } catch is CancellationError {} catch { failed = AMFailure.from(error).localizedDescription }
        }
    }
}

/// Plays a sound the server made.
@MainActor @Observable final class AMSoundPlayer {
    var playing = false
    var progress = 0.0
    var failure: String?
    private var player: AVAudioPlayer?
    private var file: URL?

    func load(sha: String, mime: String, store: AppStore) async {
        do {
            #if DEBUG
            let url = Launch.value("--demo") != nil ? AMDemoArt.sound() : try await AMBlob.download(sha, mime: mime, store: store)
            #else
            let url = try await AMBlob.download(sha, mime: mime, store: store)
            #endif
            file = url
            player = try AVAudioPlayer(contentsOf: url)
            player?.prepareToPlay()
        } catch is CancellationError {} catch { failure = "The server made a sound this app can't play." }
    }

    func toggle() async {
        guard let player else { return }
        if player.isPlaying { player.pause(); playing = false; return }
        do { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true) } catch {}
        player.play(); playing = true
        while playing, !Task.isCancelled {
            progress = player.duration > 0 ? player.currentTime / player.duration : 0
            if !player.isPlaying { playing = false; progress = 0; player.currentTime = 0; break }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { break }
        }
    }

    func stop() {
        player?.stop(); playing = false
        if let file { try? FileManager.default.removeItem(at: file) }
    }
}

/// One small real picture from a model, so an admin sees it works. It can cost money, so only a tap asks for it.
struct AMMediaTestImage: View {
    let store: AppStore
    let draft: [String: JSON]
    let preset: AMMediaPreset
    let models: [AMMediaModel]
    @State private var modelID = ""
    @State private var state: Phase = .idle
    enum Phase: Equatable { case idle, running, done(blob: String, mime: String, width: Int, height: Int, ms: Double), failed(String) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if models.count > 1 {
                Picker("Model", selection: Binding(get: { modelID.isEmpty ? (models.first { !$0.hidden } ?? models[0]).modelID : modelID }, set: { modelID = $0 })) {
                    ForEach(models) { Text($0.displayName).tag($0.modelID) }
                }
            }
            Button { Task { await make() } } label: { Label("Make a test image", systemImage: "photo") }
                .buttonStyle(QuietButtonStyle()).disabled(state == .running)
            AMNote(text: preset.mayCostMoney ? "This is a real request to \(preset.label) and may cost money." : "Makes one small image. The first one takes longer while the model loads.")
            switch state {
            case .idle: EmptyView()
            case .running: HStack(spacing: 10) { ProgressView(); Text("Making an image…").font(.subheadline).foregroundStyle(Theme.inkSecondary) }
            case .failed(let message): AMOutcome(kind: .bad, text: message)
            case .done(let blob, let mime, let width, let height, let ms):
                AMBlobImage(store: store, sha: blob, mime: mime)
                Text("Made in \(ms < 10_000 ? String(format: "%.1f", ms / 1000) : String(Int(ms / 1000))) s, \(width) by \(height)").font(.footnote.monospacedDigit()).foregroundStyle(Theme.inkSecondary)
            }
        }
    }

    private func make() async {
        state = .running
        var params: [String: JSON] = ["draft": .object(draft)]
        let chosen = modelID.isEmpty ? (models.first { !$0.hidden } ?? models.first)?.modelID : modelID
        if let chosen { params["modelId"] = .string(chosen) }
        do {
            let result = try await AMAPI(store: store).call("imageProviders.tryImage", params)
            state = .done(blob: result["blob"].string, mime: result["mime"].string, width: result["width"].int, height: result["height"].int, ms: result["durationMs"].doubleOrNil ?? 0)
        } catch is CancellationError { state = .idle } catch { state = .failed(AMFailure.from(error).localizedDescription) }
    }
}

/// One short real sound: a sentence in the model's usual voice, or a few seconds of music or an effect.
struct AMMediaTestSound: View {
    let store: AppStore
    let draft: [String: JSON]
    let preset: AMMediaPreset
    let models: [AMMediaModel]
    @State private var modelID = ""
    @State private var state: Phase = .idle
    @State private var player = AMSoundPlayer()
    enum Phase: Equatable { case idle, running, done(text: String, kind: String, seconds: Double?, ms: Double), failed(String) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if models.count > 1 {
                Picker("Model", selection: Binding(get: { modelID.isEmpty ? (models.first { !$0.hidden } ?? models[0]).modelID : modelID }, set: { modelID = $0 })) {
                    ForEach(models) { Text($0.displayName).tag($0.modelID) }
                }
            }
            Button { Task { await make() } } label: { Label("Make a test sound", systemImage: "waveform") }
                .buttonStyle(QuietButtonStyle()).disabled(state == .running)
            AMNote(text: preset.mayCostMoney ? "This is a real request to \(preset.label) and may cost money: one sentence, or a few seconds of music." : "Makes one sentence, or a few seconds of music. The first one takes longer while the model loads.")
            switch state {
            case .idle: EmptyView()
            case .running: HStack(spacing: 10) { ProgressView(); Text("Making a sound…").font(.subheadline).foregroundStyle(Theme.inkSecondary) }
            case .failed(let message): AMOutcome(kind: .bad, text: message)
            case .done(let text, _, _, let ms):
                HStack(spacing: 12) {
                    Button { Task { await player.toggle() } } label: {
                        Image(systemName: player.playing ? "pause.fill" : "play.fill").frame(width: 44, height: 44).background(Theme.clay, in: Circle()).foregroundStyle(.white)
                    }
                    .buttonStyle(.plain).accessibilityLabel(player.playing ? "Pause" : "Play the test sound")
                    ProgressView(value: player.progress).tint(Theme.clay)
                }
                if let failure = player.failure { AMOutcome(kind: .bad, text: failure) }
                if !text.isEmpty { Text("\u{201C}\(text)\u{201D}").font(.footnote).foregroundStyle(Theme.inkSecondary) }
                Text("Made in \(ms < 10_000 ? String(format: "%.1f", ms / 1000) : String(Int(ms / 1000))) s").font(.footnote.monospacedDigit()).foregroundStyle(Theme.inkSecondary)
            }
        }
        .onDisappear { player.stop() }
    }

    private func make() async {
        state = .running
        player.stop(); player = AMSoundPlayer()
        var params: [String: JSON] = ["draft": .object(draft)]
        let chosen = modelID.isEmpty ? (models.first { !$0.hidden } ?? models.first)?.modelID : modelID
        if let chosen { params["modelId"] = .string(chosen) }
        do {
            let result = try await AMAPI(store: store).call("imageProviders.trySound", params)
            await player.load(sha: result["blob"].string, mime: result["mime"].string, store: store)
            state = .done(text: result["text"].string, kind: result["kind"].string, seconds: result["seconds"].doubleOrNil, ms: result["durationMs"].doubleOrNil ?? 0)
        } catch is CancellationError { state = .idle } catch { state = .failed(AMFailure.from(error).localizedDescription) }
    }
}

#if DEBUG
/// A stand-in picture and sound for `--demo`, where no server made them.
enum AMDemoArt {
    static func picture() -> UIImage {
        let size = CGSize(width: 512, height: 512)
        return UIGraphicsImageRenderer(size: size).image { context in
            let colors = [UIColor(red: 0.98, green: 0.78, blue: 0.62, alpha: 1).cgColor, UIColor(red: 0.78, green: 0.38, blue: 0.25, alpha: 1).cgColor]
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            UIColor.white.withAlphaComponent(0.85).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 150, y: 120, width: 212, height: 212))
        }
    }

    static func sound() -> URL {
        let rate = 22_050, count = rate * 2
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        data.append("RIFF".data(using: .ascii)!); put(UInt32(36 + count * 2)); data.append("WAVEfmt ".data(using: .ascii)!)
        put(UInt32(16)); put(UInt16(1)); put(UInt16(1)); put(UInt32(rate)); put(UInt32(rate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append("data".data(using: .ascii)!); put(UInt32(count * 2))
        for i in 0..<count { put(Int16(sin(Double(i) * 2 * .pi * 440 / Double(rate)) * 6000)) }
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".wav")
        try? data.write(to: url)
        return url
    }
}
#endif
