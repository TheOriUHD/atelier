import SwiftUI

// Settings › Admin › Capabilities: what every model on this server may do, and what it is told.

struct CapabilitiesSettings: View {
    let store: AppStore
    @State private var model: AMCapabilitiesModel
    @State private var launchedInstructions = false

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AMCapabilitiesModel(store: store))
    }

    private var settings: AMSettings { model.settings }
    private func on(_ path: [JSON], _ fallback: Bool) -> Binding<Bool> { settings.toggle(store, path, default: fallback) }

    var body: some View {
        AMResourcePage(title: "Capabilities", resource: model.resource) { snapshot in
            // Debug builds can put one section first (`--am dictation`, `--am safeguards`), to look at it without scrolling.
            if AMLaunch.route == "dictation", let dictation = snapshot.dictation { dictationSection(dictation) }
            if AMLaunch.route == "safeguards" { safeguardsSection }
            webSection(snapshot)
            instructionsSection
            memorySection
            generationSection
            if let dictation = snapshot.dictation { dictationSection(dictation) }
            safeguardsSection
        }
        .task(id: model.resource.value?.dictation?.builtin?.state) { await model.watchDownload() }
        .navigationDestination(isPresented: $launchedInstructions) { AMInstructionsPage(store: store, model: model) }
        .task { if AMLaunch.route == "instructions" { await model.resource.reload(); launchedInstructions = true } }
    }

    // MARK: Web

    @ViewBuilder private func webSection(_ snapshot: AMCapabilitiesSnapshot) -> some View {
        let searchOn = settings.value(["capabilities", "webSearch", "enabled"]).boolOrNil ?? true
        Section {
            ToggleRow(title: "Web search", subtitle: "Let chats look things up on the web. Nothing to set up: Atelier searches by itself.", isOn: on(["capabilities", "webSearch", "enabled"], true))
            ToggleRow(title: "Web fetch", subtitle: "Let chats read web pages and documents by address.", isOn: on(["capabilities", "webFetch"], true))
        } header: { Text("Web") }

        if searchOn {
            Section {
                Picker("Search engine", selection: Binding(
                    get: { model.searchEngine },
                    set: { engine in Task { await store.attempt { try await settings.set(["capabilities", "webSearch", "provider"], .string(engine.rawValue)) } } }
                )) { ForEach(AMSearchEngine.allCases) { Text($0.label).tag($0) } }
                if model.searchEngine == .searxng { AMSearxngRow(model: model) }
                if model.searchEngine == .brave || model.searchEngine == .tavily { AMSearchKeyRow(store: store, model: model, engine: model.searchEngine) }
            } header: { Text("Search") } footer: {
                Text(model.searchEngine == .auto
                    ? "Built-in search needs no account or key. Use your own SearXNG, Brave Search or Tavily to keep searches on a service you choose."
                    : "Without its address or key, Atelier uses the built-in search instead.")
            }
            searchStatusSection(snapshot)
        }
    }

    private func searchStatusSection(_ snapshot: AMCapabilitiesSnapshot) -> some View {
        Section {
            if let status = snapshot.search {
                VStack(alignment: .leading, spacing: 6) {
                    Text(status.summary()).font(.subheadline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    ForEach(status.groupLines(), id: \.self) { AMNote(text: $0) }
                }
            }
            ActionRow(title: "Test search", symbol: "magnifyingglass", busy: model.searchTest == .running) { Task { await model.testSearch() } }
            switch model.searchTest {
            case .done(let text): AMOutcome(kind: .good, text: text)
            case .failed(let text): AMOutcome(kind: .bad, text: text)
            default: EmptyView()
            }
        } header: { Text("How search is doing") } footer: {
            Text("Searches are sent to the engine that answers, as a browser would send them. Your own SearXNG keeps searches off third parties.")
        }
    }

    // MARK: Instructions, memory

    private var instructionsSection: some View {
        let text = settings.value(["prompts", "organizationInstructions"]).string
        return Section {
            NavigationLink { AMInstructionsPage(store: store, model: model) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Instructions for every conversation").foregroundStyle(Theme.ink)
                    Text(text.isEmpty ? "None yet" : text).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                }
            }
        } header: { Text("Instructions") } footer: {
            Text("What models are told in every chat and Code session, for every account, ahead of anything a person or project asks. Applies to new conversations.")
        }
    }

    private var memorySection: some View {
        Section {
            ToggleRow(title: "Let people edit memory by hand", subtitle: "Adds Edit to every memory entry, for changing its title, summary and details directly. Without it, memory changes only through Atelier.", isOn: on(["memory", "manualEditing"], false))
        } header: { Text("Memory") }
    }

    // MARK: Making pictures and sound

    @ViewBuilder private var generationSection: some View {
        if store.offers("imageGeneration") {
            Section {
                ToggleRow(title: "Let models make images", subtitle: "Off: conversations don't get the tool, whichever providers are set up.", isOn: on(["imageGeneration", "enabled"], true))
                if store.offers("videoGeneration") {
                    ToggleRow(title: "Let models make videos", subtitle: "Off: no video tool. Images are not affected.", isOn: on(["imageGeneration", "videoEnabled"], true))
                }
                if store.offers("audioGeneration") {
                    ToggleRow(title: "Let models make sounds", subtitle: "Speech, music and sound effects. Off: no sound tool. Images and videos are not affected.", isOn: on(["imageGeneration", "audioEnabled"], true))
                }
                NavigationLink { MediaSettings(store: store) } label: { NavRow(title: "Providers, models and limits", subtitle: "Where they are made, and how many each person may make") }
            } header: { Text("Images, video and sound") }
        }
    }

    // MARK: Dictation

    private func dictationSection(_ status: AMDictationStatus) -> some View {
        Section {
            ToggleRow(title: "Dictation", subtitle: "The microphone in the message box: speech turns into text as people speak.", isOn: on(["dictation", "enabled"], true))
            if status.enabled {
                if status.sources.isEmpty {
                    AMNote(text: "None of the providers here offers speech-to-text yet. Add Mistral (live words as you speak), OpenAI, Groq, ElevenLabs or Deepgram under Providers or Media, or a local Whisper server with a speech-to-text model typed in.")
                } else {
                    let gone = status.chosen.map { chosen in !status.sources.contains { $0.id == chosen } } ?? false
                    Picker("Service", selection: Binding(
                        get: { gone ? "auto" : (status.chosen ?? "auto") },
                        set: { value in Task { await model.setDictationSource(value == "auto" ? nil : value) } }
                    )) {
                        Text("Automatic (\(status.sources[0].label))").tag("auto")
                        ForEach(status.sources) { Text("\($0.label), \($0.provider)\($0.live ? ", live" : "")").tag($0.id) }
                    }
                    // Short on screen so the chosen service fits beside it; the full name is for VoiceOver.
                    .accessibilityLabel("Speech-to-text service")
                    if gone { AMOutcome(kind: .warn, text: "The service chosen is no longer set up. Dictation uses the automatic choice until you choose another.") }
                }
                if let speech = status.builtin, speech.state != .unsupported { AMSpeechModelRows(model: model, speech: speech) }
            }
        } header: { Text("Dictation") } footer: {
            Text("Automatic uses Atelier's own speech model. A provider can take its place. People choose their language in their own settings.")
        }
    }

    // MARK: Safeguards

    private var safeguardsSection: some View {
        let selfHarm = settings.value(["safeguards", "categories", "selfHarm"]).boolOrNil ?? false
        return Group {
            Section {
                ToggleRow(title: "Extra safeguards for everyone", subtitle: "Off by default: models then follow only their own and their provider's rules. When on, the categories below apply to every conversation, except for people whose account says otherwise.", isOn: on(["safeguards", "enabled"], false))
            } header: { Text("Content safeguards") } footer: {
                Text("Safeguards are instructions to the model, not a filter. A determined person, or a model that follows instructions poorly, can get around them. Only the model provider's own filters are a hard limit.")
            }
            Section {
                ToggleRow(title: "Explicit sexual content", subtitle: "Erotica and graphic sexual material. Sex education and health questions are still answered.", isOn: on(["safeguards", "categories", "sexual"], true))
                ToggleRow(title: "Hate and violent extremism", subtitle: "Content that demeans people for who they are, and extremist propaganda. Every political view can still be discussed.", isOn: on(["safeguards", "categories", "hate"], true))
                ToggleRow(title: "Harassment of private people", subtitle: "Threats and insults aimed at real private people, and help finding where they live or work.", isOn: on(["safeguards", "categories", "harassment"], false))
                ToggleRow(title: "Self-harm", subtitle: "No methods or doses for someone who seems at risk. The model answers with care and points to help.", isOn: on(["safeguards", "categories", "selfHarm"], false))
                ToggleRow(title: "Younger people", subtitle: "For accounts that may belong to someone under 18: no romantic role-play, and no instructions for alcohol, drugs or risky stunts.",
                          isOn: Binding(get: { settings.value(["safeguards", "profile"]).string == "younger" }, set: { younger in Task { await store.attempt { try await settings.set(["safeguards", "profile"], .string(younger ? "younger" : "adult")) } } }))
                if selfHarm { AMCrisisRow(store: store, model: model) }
            } header: { Text("What they cover") }
        }
    }
}

// MARK: - Rows with their own text

/// The address of the person's own SearXNG: saved when the field is left, with a problem shown under it.
struct AMSearxngRow: View {
    let model: AMCapabilitiesModel
    @State private var text = ""
    @State private var error: String?
    @State private var loaded = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SearXNG address").font(.footnote).foregroundStyle(Theme.inkMuted)
            TextField("https://searx.example.lan", text: $text).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                .onSubmit { Task { await save() } }
            AMFieldError(text: error)
            if error == nil { AMNote(text: "The address of your instance. JSON output must be on in its settings.yml.") }
        }
        .onAppear { if !loaded { text = model.settings.value(["capabilities", "webSearch", "url"]).string; loaded = true } }
        .onChange(of: focused) { _, now in if !now { Task { await save() } } }
    }

    private func save() async {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty, !AMForm.isHTTPURL(trimmed) { error = "Enter an address starting with http:// or https://."; return }
        guard trimmed != model.settings.value(["capabilities", "webSearch", "url"]).string else { error = nil; return }
        error = nil
        await model.store.attempt { try await model.saveSearxngURL(trimmed) }
    }
}

/// The key for Brave or Tavily: stored on the server, shown only as its last four characters.
struct AMSearchKeyRow: View {
    let store: AppStore
    let model: AMCapabilitiesModel
    let engine: AMSearchEngine
    @State private var value = ""
    @State private var replacing = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        let stored = model.keyHint(for: engine)
        VStack(alignment: .leading, spacing: 6) {
            Text("API key").font(.footnote).foregroundStyle(Theme.inkMuted)
            if let stored, !replacing {
                HStack {
                    Text(stored).font(.mono(.body)).foregroundStyle(Theme.inkSecondary)
                    Spacer()
                    Button("Replace") { replacing = true }.font(.subheadline)
                }
            } else {
                SecureField(stored == nil ? "Paste your API key" : "New key", text: $value).textInputAutocapitalization(.never).autocorrectionDisabled()
                if !value.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Save key") { Task { await save() } }.buttonStyle(ClayButtonStyle(busy: saving)).disabled(saving)
                }
                AMFieldError(text: error)
                AMNote(text: "Stored encrypted by Atelier, never in settings files.")
            }
        }
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        do {
            try await model.saveSearchKey(engine, value: value.trimmingCharacters(in: .whitespaces))
            value = ""; replacing = false
            store.notify("Key saved")
        } catch is CancellationError {} catch { self.error = AMFailure.from(error).localizedDescription }
    }
}

struct AMCrisisRow: View {
    let store: AppStore
    let model: AMCapabilitiesModel
    @State private var text = ""
    @State private var loaded = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Crisis resource").font(.footnote).foregroundStyle(Theme.inkMuted)
            TextField("A helpline and its number", text: $text, axis: .vertical).lineLimit(1...3).focused($focused)
            AMNote(text: "A helpline or service the self-harm safeguard can point to, such as a national number.")
        }
        .onAppear { if !loaded { text = model.settings.value(["safeguards", "crisisResources"]).string; loaded = true } }
        .onChange(of: focused) { _, now in
            if !now, text != model.settings.value(["safeguards", "crisisResources"]).string {
                Task { await store.attempt { try await model.settings.set(["safeguards", "crisisResources"], .string(String(text.prefix(500)))) } }
            }
        }
    }
}

/// Atelier's own speech model: its state, a download button, and the progress while it downloads.
struct AMSpeechModelRows: View {
    let model: AMCapabilitiesModel
    let speech: AMSpeechModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Atelier's speech model").foregroundStyle(Theme.ink)
            Text("Nemotron 3.5 from NVIDIA, run by Atelier itself: live words in about 30 languages, with nothing to set up.").font(.footnote).foregroundStyle(Theme.inkMuted)
            if speech.state == .downloading {
                ProgressView(value: speech.fraction) { EmptyView() } currentValueLabel: { Text("\(Int(speech.fraction * 100))%").font(.footnote.monospacedDigit()) }
                    .tint(Theme.clay).accessibilityLabel("Download progress")
            }
            if speech.state == .failed { AMOutcome(kind: .bad, text: speech.detail) } else { Text(speech.detail).font(.footnote).foregroundStyle(Theme.inkSecondary) }
            if speech.state == .missing || speech.state == .failed {
                Button(speech.state == .failed ? "Try again" : "Download now") { Task { await model.prepareSpeechModel() } }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(Theme.clay).disabled(model.preparing)
            }
            if let error = model.prepareError { AMOutcome(kind: .bad, text: error) }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - The instructions

struct AMInstructionsPage: View {
    let store: AppStore
    let model: AMCapabilitiesModel
    private static let limit = 20_000
    @State private var draft = ""
    @State private var loaded = false
    @State private var saving = false
    @FocusState private var focused: Bool

    private var saved: String { model.settings.value(["prompts", "organizationInstructions"]).string }
    private var dirty: Bool { draft != saved }
    private var tooLong: Bool { draft.count > Self.limit }

    var body: some View {
        SettingsPage(title: "Instructions") {
            Section {
                TextEditor(text: $draft)
                    .frame(minHeight: 220)
                    .focused($focused)
                    .overlay(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text("For example: We are Acme Gardens, a nursery in Leeds. Answer in British English and give prices in pounds.")
                                .foregroundStyle(Theme.inkMuted).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                        }
                    }
                HStack {
                    Text("\(draft.count.formatted()) of \(Self.limit.formatted()) characters\(dirty ? ", not saved" : "")")
                        .font(.footnote.monospacedDigit()).foregroundStyle(tooLong ? Theme.danger : Theme.inkMuted)
                    Spacer()
                }
            } footer: {
                Text("Every model reads this in every conversation, ahead of anything a person or project asks. It applies to new conversations. Code and chats working in a folder also follow the system AGENTS.md.")
            }
            AMButtonRow {
                Button("Save") { Task { await save() } }.buttonStyle(ClayButtonStyle(busy: saving)).disabled(!dirty || tooLong || saving)
            }
            if dirty {
                Section { ActionRow(title: "Discard changes", symbol: "arrow.uturn.backward", tint: Theme.inkSecondary) { draft = saved; focused = false } }
            }
        }
        .onAppear { if !loaded { draft = saved; loaded = true } }
        .scrollDismissesKeyboard(.interactively)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        if await store.attempt({ try await model.settings.set(["prompts", "organizationInstructions"], .string(draft)) }) {
            focused = false
            store.notify("Instructions saved")
        }
    }
}
