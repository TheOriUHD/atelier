import SwiftUI

// Adding and editing a provider: choose where the models run, fill in what that needs, test, save.
// One sheet with its own navigation: the list of choices, then the form or the sign-in.

/// A page pushed in the wizard. The route carries what the page needs (the kind of service), not a place in some state:
/// a destination that read state kept next to the stack came up empty.
enum AMWizardRoute: Hashable {
    case form(String)
    case preset(String)
    case signIn(String)
}

/// What opens the wizard.
struct AMWizardRequest: Identifiable {
    enum Start { case choose, edit(AMProvider), detected(AMDetected) }
    let id = UUID()
    let start: Start
}

struct AMProviderWizard: View {
    let store: AppStore
    let request: AMWizardRequest
    let taken: Set<String>
    let secrets: [AMSecret]
    let providers: [AMProvider]
    /// Called after a provider was saved or signed in, with the words to show.
    let onSaved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: [AMWizardRoute] = []
    @State private var chatgptAvailable = false

    var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: AMWizardRoute.self) { route in
                    switch route {
                    case .form(let raw):
                        if let type = AMProviderType(rawValue: raw) { AMProviderFormView(store: store, form: .new(type, taken: taken), existing: nil, taken: taken, secrets: secrets, onSaved: finish) }
                    case .preset(let id):
                        if let preset = AMTextPreset.all.first(where: { $0.id == id }) { AMProviderFormView(store: store, form: .preset(preset, taken: taken), existing: nil, taken: taken, secrets: secrets, onSaved: finish) }
                    case .signIn(let kind):
                        AMSignInView(store: store, kind: kind == "chatgpt" ? .chatgpt : .copilot, onAdded: { finish("Added \(kind == "chatgpt" ? "ChatGPT Plan" : "GitHub Copilot")") })
                    }
                }
        }
        .tint(Theme.clay)
        .toasts(store)
        .presentationDragIndicator(.visible)
        .presentationSizing(.page)
        .task { await probeSignIns() }
        .task { openLaunchRoute() }
    }

    /// Debug builds: `--am add/form-ollama`, `add/signin-copilot`, `add/preset-openrouter` open the wizard on that step.
    private func openLaunchRoute() {
        guard case .choose = request.start, let route = AMLaunch.parts, route.head == "add", route.tail.contains("-") else { return }
        let pieces = route.tail.split(separator: "-", maxSplits: 1).map(String.init)
        switch pieces[0] {
        case "form": if let type = AMProviderType(rawValue: pieces[1]) { open(type) }
        case "preset": if let preset = AMTextPreset.all.first(where: { $0.id == pieces[1] }) { open(preset) }
        case "signin": path.append(.signIn(pieces[1]))
        default: break
        }
    }

    private func finish(_ message: String) {
        onSaved(message)
        dismiss()
    }

    @ViewBuilder private var root: some View {
        switch request.start {
        case .edit(let provider):
            AMProviderFormView(store: store, form: AMProviderForm(config: provider), existing: provider, taken: taken, secrets: secrets, onSaved: finish, onCancel: { dismiss() })
        case .detected(let found):
            AMProviderFormView(store: store, form: .detected(found, taken: taken), existing: nil, taken: taken, secrets: secrets, onSaved: finish, onCancel: { dismiss() })
        case .choose:
            chooser
        }
    }

    private func has(_ type: AMProviderType) -> Bool { providers.contains { $0.typeID == type.rawValue } }

    private var chooser: some View {
        SettingsPage(title: "Add provider") {
            SettingsSection(title: "Where your models run", footer: "A provider is where models come from: a server you run, a hosted service with a key, or a subscription you already have.") {
                ForEach(AMProviderType.choosable) { type in
                    choice(type.label, type.summary, symbol: type.symbol) { open(type) }
                }
            }
            if (chatgptAvailable && !has(.chatgpt)) || !has(.copilot) {
                SettingsSection(title: "With your account", footer: "Signing in uses your plan's own limits. These are unofficial and can stop working when the service changes.") {
                    if chatgptAvailable && !has(.chatgpt) {
                        choice(AMProviderType.chatgpt.label, AMProviderType.chatgpt.summary, symbol: "person.badge.key") { path.append(.signIn("chatgpt")) }
                    }
                    if !has(.copilot) {
                        choice(AMProviderType.copilot.label, AMProviderType.copilot.summary, symbol: "person.badge.key") { path.append(.signIn("copilot")) }
                    }
                }
            }
            SettingsSection(title: "Hosted by name") {
                ForEach(AMTextPreset.all) { preset in
                    choice(preset.name, preset.summary, symbol: "cloud") { open(preset) }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }

    private func choice(_ title: String, _ subtitle: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                IconTile(symbol: symbol, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Theme.ink)
                    Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted.opacity(0.6))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func open(_ type: AMProviderType) { path.append(.form(type.rawValue)) }
    private func open(_ preset: AMTextPreset) { path.append(.preset(preset.id)) }

    /// ChatGPT's sign-in is offered where the server can do it; asking is quiet, and an older server just doesn't list it.
    private func probeSignIns() async {
        guard case .choose = request.start else { return }
        if let status = await AMAPI(store: store).optional("chatgpt.status") { chatgptAvailable = status["available"].bool }
    }
}

// MARK: - The form

struct AMProviderFormView: View {
    let store: AppStore
    let existing: AMProvider?
    let taken: Set<String>
    let secrets: [AMSecret]
    let onSaved: (String) -> Void
    var onCancel: (() -> Void)?

    @State private var form: AMProviderForm
    @State private var touched: Set<AMProviderForm.Field> = []
    @State private var test: TestState = .idle
    @State private var saving = false
    @State private var saveError: String?
    @State private var replacingKey = false
    @State private var showID = false
    @State private var run = 0
    @FocusState private var focus: AMProviderForm.Field?
    @Environment(\.openURL) private var openURL

    enum TestState: Equatable { case idle, testing, done(AMTestOutcome), failed(String) }

    init(store: AppStore, form: AMProviderForm, existing: AMProvider?, taken: Set<String>, secrets: [AMSecret], onSaved: @escaping (String) -> Void, onCancel: (() -> Void)? = nil) {
        self.store = store; self.existing = existing; self.taken = taken; self.secrets = secrets; self.onSaved = onSaved; self.onCancel = onCancel
        _form = State(initialValue: form)
    }

    private var storedKey: String? { AMForm.keyHint(existing?.apiKey, secrets: secrets) }
    private var errors: [AMProviderForm.Field: String] { form.errors(taken: taken, editing: existing != nil, hasStoredKey: storedKey != nil) }
    private var valid: Bool { errors.isEmpty }
    /// Problems show under a field once it has been used, so a fresh form doesn't open in red.
    private func shown(_ field: AMProviderForm.Field) -> String? { touched.contains(field) ? errors[field] : nil }
    private func touch(_ field: AMProviderForm.Field) { touched.insert(field) }

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
        SettingsPage(title: existing != nil ? "Edit \(existing?.name ?? "provider")" : "Add \(form.label)") {
            intro
            SettingsSection(title: "About it") {
                field("Name", error: shown(.name)) { TextField("Name", text: nameBinding).focused($focus, equals: .name).textInputAutocapitalization(.words) }
                field("Address", error: shown(.baseURL)) {
                    TextField("https://", text: binding(\.baseURL)).focused($focus, equals: .baseURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if existing == nil {
                    DisclosureGroup(isExpanded: $showID) {
                        VStack(alignment: .leading, spacing: 4) {
                            TextField("short-name", text: idBinding).font(.mono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .id)
                            AMNote(text: "Models are referenced as \(form.id.isEmpty ? "short-name" : form.id)/model-name. You can't change it later.")
                            AMFieldError(text: shown(.id))
                        }.padding(.top, 4)
                    } label: { HStack { Text("Short name").foregroundStyle(Theme.ink); Spacer(); Text(form.id).font(.mono(.subheadline)).foregroundStyle(Theme.inkMuted).lineLimit(1) } }
                } else {
                    ValueRow(title: "Short name", value: form.id, mono: true)
                }
            }
            keySection
            headersSection
            if form.showsMemoryBudget { memorySection }
            limitsSection
            checkSection
            actionSection
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar { if let onCancel { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } } }
        .onChange(of: focus) { old, _ in if let old { touch(old) } }
        .task {
            if AMLaunch.has("touch") { touched = Set(errors.keys) }
            if AMLaunch.has("test") { await runTest() }
        }
    }

    // MARK: Sections

    @ViewBuilder private var intro: some View {
        switch form.type {
        case .mistral, .mistralVibe:
            let vibe = form.type == .mistralVibe
            Section {
                AMNote(text: vibe
                    ? "Uses the Vibe allowance of your Le Chat Pro or Team plan instead of paying per token. In Le Chat, open Code, then Vibe CLI, create a key and paste it below. Past the allowance, requests wait for the next billing period unless pay-as-you-go is on in Mistral's console. Everyone who can use this provider spends your plan."
                    : "Needs a key from Mistral's console. Requests are priced per token. Mistral's free plan gives a key with low limits, and Mistral may train on what is sent with it. For EU-only processing, change the address to https://api.eu.mistral.ai.")
                    .foregroundStyle(Theme.ink)
                AMLinkRow(title: vibe ? "Open Vibe keys in Le Chat" : "Open Mistral's console", url: vibe ? amMistralVibeKeyURL : amMistralKeyURL)
            }
        default:
            if let preset = form.preset {
                Section {
                    if preset.id == "openrouter" && existing == nil {
                        AMNote(text: "Connect your OpenRouter account and it creates a key for Atelier, or paste a key from openrouter.ai/keys below. Models marked free cost nothing but are limited to 50 requests a day (1,000 once you have bought at least 10 credits).").foregroundStyle(Theme.ink)
                        AMOpenRouterConnect(store: store, draft: errors.keys.allSatisfy { $0 == .apiKey } ? form.connectDraft() : nil, onInvalid: { touched.formUnion(errors.keys) }, onConnected: { onSaved("Added \(form.name)") })
                    } else {
                        AMNote(text: "Needs an OpenCode Console key from opencode.ai, where billing may be required. Its free models may only work inside OpenCode itself.").foregroundStyle(Theme.ink)
                    }
                    AMLinkRow(title: "Get a key", url: preset.keyURL)
                }
            }
        }
    }

    private var keySection: some View {
        SettingsSection(title: "API key", footer: form.needsKey ? "Stored encrypted by Atelier, never in settings files, and never shown again." : "Optional. Only needed if the server asks for one.") {
            if let env = form.apiKeyFromEnv {
                HStack {
                    Text("From \(env) on the server").font(.subheadline).foregroundStyle(Theme.ink)
                    Spacer()
                    Button("Enter a key") { form.apiKeyFromEnv = nil; run += 1; test = .idle }.font(.subheadline)
                }
            } else if let stored = storedKey, !replacingKey {
                HStack {
                    Text(stored).font(.mono(.body)).foregroundStyle(Theme.inkSecondary)
                    Spacer()
                    Button("Replace") { replacingKey = true }.font(.subheadline)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    SecureField(storedKey != nil ? "New key" : form.needsKey ? "Paste your API key" : "Optional", text: binding(\.apiKey))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .apiKey)
                    AMFieldError(text: shown(.apiKey))
                }
            }
        }
    }

    private var headersSection: some View {
        SettingsSection(title: "Custom headers", footer: "Sent with every request. Use \"${secret:name}\" as a value to refer to a stored key.") {
            ForEach($form.headers) { $header in
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Name", text: $header.name).font(.mono(.subheadline)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Value", text: $header.value).font(.mono(.subheadline)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .swipeActions { Button("Remove", role: .destructive) { form.headers.removeAll { $0.id == header.id } } }
            }
            if let error = shown(.headers) ?? (touched.contains(.headers) ? errors[.headers] : nil) { AMFieldError(text: error) }
            Button { form.headers.append(.init()); touch(.headers) } label: { Label("Add a header", systemImage: "plus") }
        }
    }

    private var memorySection: some View {
        SettingsSection(title: "Memory budget", footer: form.type == .ollama
            ? "Atelier balances each model's context against the memory you say is free. On Apple Silicon, use the available unified memory."
            : "Automatic memory-based context works with Ollama only. Other servers keep the limits they report; set context and GPU memory on the server itself.") {
            field("Available memory (GB)", error: shown(.vram)) {
                TextField("Optional, for example 24", text: binding(\.vramGB)).keyboardType(.decimalPad).focused($focus, equals: .vram)
            }
        }
    }

    private var limitsSection: some View {
        SettingsSection(title: "What the server can take", footer: "What the server's GPU can handle at once. Atelier queues the rest. Automatic uses what the server reports, else one of each on a computer you run.") {
            field("Requests at once", error: shown(.parallel)) { TextField("Automatic", text: binding(\.parallelRequests)).keyboardType(.numberPad).focused($focus, equals: .parallel) }
            field("Models at once", error: shown(.modelsAtOnce)) { TextField("Automatic", text: binding(\.modelsAtOnce)).keyboardType(.numberPad).focused($focus, equals: .modelsAtOnce) }
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
        } footer: { Text("Checks the address and key without saving anything.") }
    }

    private var actionSection: some View {
        Group {
            if let saveError { Section { AMOutcome(kind: .bad, text: saveError) } }
            AMButtonRow {
                Button(existing != nil ? "Save" : "Add provider") { Task { await save() } }
                    .buttonStyle(ClayButtonStyle(busy: saving))
                    .disabled(!valid || saving)
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

    /// A binding that also forgets an old test result: it described a different form.
    private func binding(_ keyPath: WritableKeyPath<AMProviderForm, String>) -> Binding<String> {
        Binding(get: { form[keyPath: keyPath] }, set: { form[keyPath: keyPath] = $0; changed() })
    }
    private var nameBinding: Binding<String> {
        Binding(get: { form.name }, set: { form.rename($0, taken: taken); changed() })
    }
    private var idBinding: Binding<String> {
        Binding(get: { form.id }, set: { form.id = $0; form.idEdited = true; changed() })
    }
    private func changed() { run += 1; test = .idle; saveError = nil }

    // MARK: Actions

    private func runTest() async {
        touched.formUnion(errors.keys)
        guard valid else { return }
        if form.needsKey, form.apiKey.trimmingCharacters(in: .whitespaces).isEmpty, form.apiKeyFromEnv == nil {
            test = .failed("Enter the key again to test it. Saving checks the connection with the stored key.")
            return
        }
        run += 1
        let mine = run
        test = .testing
        do {
            let result = try await AMAPI(store: store).call("providers.test", form.draft())
            if mine == run { test = .done(AMTestOutcome(status: AMProviderStatus(json: result["status"]))) }
        } catch is CancellationError {} catch { if mine == run { test = .failed(AMFailure.from(error).localizedDescription) } }
    }

    private func save() async {
        touched.formUnion(errors.keys)
        guard valid else { return }
        saving = true; saveError = nil
        defer { saving = false }
        do {
            let saved = try await AMAPI(store: store).call("providers.save", form.draft())
            let name = saved["name"].stringOrNil ?? form.name
            onSaved(existing != nil ? "Saved \(name)" : "Added \(name)")
        } catch is CancellationError {} catch { saveError = AMFailure.from(error).localizedDescription }
    }
}
