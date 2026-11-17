import SwiftUI

// MARK: - Your models: the person's own model servers and ChatGPT Chat on their computers, and their image and sound servers

enum PersonalProviderKind: Equatable {
    case text, image
    var list: String { self == .text ? "personalProviders.list" : "personalImageProviders.list" }
    var save: String { self == .text ? "personalProviders.save" : "personalImageProviders.save" }
    var remove: String { self == .text ? "personalProviders.remove" : "personalImageProviders.remove" }
    var refresh: String { self == .text ? "personalProviders.refresh" : "personalImageProviders.refresh" }
}

/// Where a server on someone's computer stands.
enum PersonalHealth: Equatable {
    case off, notConnected, notChecked, connected, unreachable

    static func of(_ provider: JSON) -> PersonalHealth {
        if !provider["enabled"].bool { return .off }
        if !provider["online"].bool { return .notConnected }
        if provider["status"] == .null { return .notChecked }
        return provider["status"]["ok"].bool ? .connected : .unreachable
    }

    var label: String {
        switch self {
        case .off: "Turned off"
        case .notConnected: "Not connected"
        case .notChecked: "Not checked yet"
        case .connected: "Connected"
        case .unreachable: "Unreachable"
        }
    }
    var tone: StatusBadge.Tone {
        switch self {
        case .connected: .good
        case .unreachable: .bad
        default: .neutral
        }
    }
    var color: Color {
        switch self {
        case .connected: Theme.success
        case .unreachable: Theme.danger
        default: Theme.inkMuted.opacity(0.6)
        }
    }
}

enum PersonalProviderText {
    private static let typeLabels = ["ollama": "Ollama", "llamacpp": "llama.cpp", "openai-compatible": "OpenAI-compatible", "chatgpt-chat": "ChatGPT Chat",
                                     "comfyui": "ComfyUI", "a1111": "AUTOMATIC1111", "swarmui": "SwarmUI", "invokeai": "InvokeAI", "openai-images": "OpenAI-compatible images",
                                     "openai-speech": "OpenAI-compatible speech", "fish-audio": "Fish Speech", "acestep": "ACE-Step"]
    private static let presetLabels = ["comfyui": "ComfyUI", "forge": "Forge", "a1111": "AUTOMATIC1111", "sdnext": "SD.Next", "swarmui": "SwarmUI", "invokeai": "InvokeAI", "drawthings": "Draw Things",
                                       "koboldcpp": "KoboldCpp", "sd-server": "stable-diffusion.cpp", "localai": "LocalAI", "openai-compatible": "OpenAI-compatible images", "kokoro": "Kokoro-FastAPI",
                                       "speaches": "Speaches", "localai-speech": "LocalAI audio", "koboldcpp-speech": "KoboldCpp speech", "chatterbox": "Chatterbox TTS Server", "ollama-speech": "Ollama speech",
                                       "vllm-omni": "vLLM-Omni", "fish-speech": "Fish Speech", "acestep": "ACE-Step 1.5"]

    static func typeLabel(_ provider: JSON, kind: PersonalProviderKind) -> String {
        if kind == .image, let preset = provider["preset"].stringOrNil, let label = presetLabels[preset] { return label }
        return typeLabels[provider["type"].string] ?? provider["type"].string
    }

    /// "On Studio Mac · localhost:11434 · 5 models".
    static func meta(_ provider: JSON, kind: PersonalProviderKind) -> String {
        let status = provider["status"]
        let models = provider["online"].bool && status["ok"].bool ? PersonalUsage.count(status["modelCount"].int, "model", "models") : nil
        let address = provider["type"].string == "chatgpt-chat" ? nil : provider["baseUrl"].string.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
        return ["On \(provider["deviceName"].string)", address, models, provider["enabled"].bool && !provider["online"].bool ? "Not connected" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    /// The draft the server takes back to change a provider that exists: what the list says, with the changes on top.
    static func draft(from provider: JSON, kind: PersonalProviderKind, changes: [String: JSON] = [:]) -> [String: JSON] {
        let keys = kind == .text ? ["id", "type", "name", "baseUrl", "parallelRequests", "modelsAtOnce", "vramGiB"] : ["id", "type", "name", "baseUrl", "preset", "parallelRequests", "freeAfterRun", "models", "workflows"]
        var draft: [String: JSON] = [:]
        for key in keys where provider[key] != .null { draft[key] = provider[key] }
        for (key, value) in changes { if value == .null { draft.removeValue(forKey: key) } else { draft[key] = value } }
        return draft
    }
}

@MainActor @Observable final class PersonalProvidersModel {
    let providers: Resource<[JSON]>
    let images: Resource<[JSON]>
    let imageOffered: Bool
    private let call: PersonalCall

    init(call: @escaping PersonalCall, imageOffered: Bool) {
        self.call = call
        self.imageOffered = imageOffered
        providers = .personal { try await call("personalProviders.list", [:]).array }
        images = .personal { imageOffered ? try await call("personalImageProviders.list", [:]).array : [] }
    }

    func reload() async {
        async let a: Void = providers.reload()
        async let b: Void = images.reload()
        _ = await (a, b)
    }

    func resource(_ kind: PersonalProviderKind) -> Resource<[JSON]> { kind == .text ? providers : images }

    func find(_ id: String, kind: PersonalProviderKind) -> JSON? { resource(kind).value?.first { $0["id"].string == id } }

    func check(_ id: String, kind: PersonalProviderKind) async throws {
        _ = try await call(kind.refresh, ["id": .string(id)])
        await resource(kind).reload()
    }

    func save(_ provider: JSON, kind: PersonalProviderKind, changes: [String: JSON]) async throws {
        _ = try await call(kind.save, PersonalProviderText.draft(from: provider, kind: kind, changes: changes))
        await resource(kind).reload()
    }

    func remove(_ id: String, kind: PersonalProviderKind) async throws {
        _ = try await call(kind.remove, ["id": .string(id)])
        await resource(kind).reload()
    }
}

private struct PersonalProviderRoute: Hashable { let id: String; let image: Bool }

struct PersonalModelsSettings: View {
    let store: AppStore
    @State private var model: PersonalProvidersModel
    @State private var route: PersonalProviderRoute?

    init(store: AppStore) {
        self.store = store
        let imageOffered = store.offers("imageGeneration") && (store.info["deviceLink"]["services"].array.contains(.string("ws")) || store.info["deviceLink"] == .null)
        _model = State(initialValue: PersonalProvidersModel(call: store.personalCall, imageOffered: imageOffered))
        #if DEBUG
        if let sub = Launch.value("--sub") { _route = State(initialValue: PersonalProviderRoute(id: sub, image: sub.hasPrefix("u-img"))) }
        #endif
    }

    var body: some View {
        PersonalPage(title: "Your models") {
            switch (model.providers.state, model.images.state) {
            case (.failed(let message), _):
                InlineError(message: message) { Task { await model.reload() } }.personalPlainRow()
            case (.idle, _), (.loading, _):
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240).personalPlainRow().accessibilityLabel("Loading")
                    .task { if case .idle = model.providers.state { await model.reload() } }
            case (.loaded(let text), _):
                let images = model.images.value ?? []
                if text.isEmpty && images.isEmpty {
                    EmptyState(title: "Nothing on your computers yet", symbol: "desktopcomputer", message: "Model servers such as Ollama, llama.cpp or LM Studio, ChatGPT Chat, and image or sound servers on your own computers show up here. Only you see their models, and only while that computer is connected.").personalPlainRow()
                } else {
                    if !text.isEmpty { providerSection("Models on your computers", footer: "Only you see their models, and only while that computer is connected.", list: text, kind: .text) }
                    if !images.isEmpty { providerSection("Image and sound servers", footer: "ComfyUI, Forge, Kokoro and other servers on your own computers. Only you see their models, and only while that computer is connected.", list: images, kind: .image) }
                }
                Section {
                    Text("A model server is added from the Atelier desktop app on the computer that runs it, signed in to this server. It then shows here, where you can turn it on or off, test it and remove it.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    PersonalLinkRow(title: "Using local models", symbol: "book", url: "https://docs.atelierhq.dev/local-models/")
                } header: { Text("Add a server") }
            }
        }
        .task { await model.reload() }
        .refreshable { await model.reload() }
        .navigationDestination(item: $route) { route in PersonalProviderPage(store: store, model: model, id: route.id, kind: route.image ? .image : .text) }
    }

    private func providerSection(_ title: String, footer: String, list: [JSON], kind: PersonalProviderKind) -> some View {
        Section {
            ForEach(list, id: \.self) { provider in
                NavigationLink { PersonalProviderPage(store: store, model: model, id: provider["id"].string, kind: kind) } label: { row(provider, kind: kind) }
            }
        } header: { Text(title) } footer: { Text(footer) }
    }

    private func row(_ provider: JSON, kind: PersonalProviderKind) -> some View {
        let health = PersonalHealth.of(provider)
        return HStack(spacing: 12) {
            IconTile(symbol: provider["type"].string == "chatgpt-chat" ? "bubble.left.and.text.bubble.right" : kind == .image ? "photo" : "server.rack", tint: health == .connected ? Theme.clay : Theme.inkSecondary)
                .overlay(alignment: .bottomTrailing) { Circle().fill(health.color).frame(width: 9, height: 9).overlay(Circle().stroke(Theme.surface, lineWidth: 1.5)).offset(x: 3, y: 3) }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(provider["name"].string).foregroundStyle(Theme.ink).lineLimit(1)
                    StatusBadge(text: PersonalProviderText.typeLabel(provider, kind: kind), tone: .neutral)
                }
                Text(PersonalProviderText.meta(provider, kind: kind)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                if provider["enabled"].bool, provider["online"].bool, let error = provider["status"]["error"].stringOrNil { Text(error).font(.footnote).foregroundStyle(Theme.danger).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }
        .opacity(provider["enabled"].bool && provider["online"].bool ? 1 : 0.7)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider["name"].string), \(health.label)")
    }
}

// MARK: - One server

struct PersonalProviderPage: View {
    let store: AppStore
    let model: PersonalProvidersModel
    let id: String
    let kind: PersonalProviderKind
    @State private var checking = false
    @State private var confirmRemove = false
    @State private var editing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let provider = model.find(id, kind: kind)
        PersonalPage(title: provider?["name"].string ?? "Server") {
            if let provider {
                let health = PersonalHealth.of(provider)
                Section {
                    HStack(spacing: 12) {
                        IconTile(symbol: provider["type"].string == "chatgpt-chat" ? "bubble.left.and.text.bubble.right" : kind == .image ? "photo" : "server.rack", size: 40)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(provider["name"].string).font(.system(.title3, design: .serif, weight: .medium)).foregroundStyle(Theme.ink)
                            HStack(spacing: 6) { StatusBadge(text: PersonalProviderText.typeLabel(provider, kind: kind)); StatusBadge(text: health.label, tone: health.tone) }
                        }
                    }.padding(.vertical, 4)
                    ToggleRow(title: "Use \(provider["name"].string)", subtitle: kind == .image ? "Its models are offered when you make pictures or sound." : "Its models are offered in your model picker.",
                              isOn: Binding(get: { provider["enabled"].bool }, set: { on in personalAction(store) { try await model.save(provider, kind: kind, changes: ["enabled": .bool(on)]) } }))
                } footer: { Text("Only you see this server, and only while that computer is connected.") }
                Section("Details") {
                    ValueRow(title: "Computer", value: provider["deviceName"].string, subtitle: provider["online"].bool ? "Connected" : "Not connected")
                    if provider["type"].string != "chatgpt-chat" { ValueRow(title: "Address", value: provider["baseUrl"].string.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression), mono: true, copyable: true) }
                    ValueRow(title: "API key", value: provider["hasKey"].bool ? "Set" : "None")
                    if provider["online"].bool, provider["status"]["ok"].bool {
                        ValueRow(title: "Models", value: "\(provider["status"]["modelCount"].int)")
                        if case .number(let latency) = provider["status"]["latencyMs"] { ValueRow(title: "Answered in", value: "\(Int(latency)) ms") }
                        if let version = provider["status"]["version"].stringOrNil { ValueRow(title: "Version", value: version) }
                    }
                    if let checked = provider["status"]["checkedAt"].date { ValueRow(title: "Checked", value: checked.relative) }
                    if provider["enabled"].bool, provider["online"].bool, let error = provider["status"]["error"].stringOrNil { Text(error).font(.subheadline).foregroundStyle(Theme.danger) }
                    ForEach(provider["status"]["warnings"].array.map(\.string), id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
                if kind == .text { modelsSection(provider) }
                Section {
                    ActionRow(title: "Test connection", symbol: "arrow.triangle.2.circlepath", busy: checking) { check() }.disabled(!provider["enabled"].bool || !provider["online"].bool)
                    if provider["type"].string != "chatgpt-chat" { ActionRow(title: "Change settings", symbol: "slider.horizontal.3") { editing = true } }
                } footer: {
                    if !provider["online"].bool { Text("Open the Atelier desktop app on \(provider["deviceName"].string), signed in to this server, to test it.") }
                }
                Section {
                    ActionRow(title: "Remove \(provider["name"].string)", symbol: "trash", destructive: true) { confirmRemove = true }
                }
            } else if model.resource(kind).isLoading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200).personalPlainRow()
            } else {
                EmptyState(title: "This server is gone", symbol: "server.rack", message: "It was removed, here or from another device.").personalPlainRow()
            }
        }
        .task { if model.resource(kind).value == nil { await model.reload() } }
        .sheet(isPresented: $editing) { if let provider { PersonalProviderEditor(store: store, model: model, provider: provider, kind: kind) } }
        .confirmationDialog(provider.map { "Remove \($0["name"].string)?" } ?? "Remove?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { personalAction(store) { try await model.remove(id, kind: kind); store.notify("Removed"); dismiss() } }
        } message: {
            Text(kind == .image ? "Its models leave your image model list. Images you made with it stay in your chats."
                 : provider?["type"].string == "chatgpt-chat" ? "The private ChatGPT browser session on that computer is cleared and its model leaves your model picker. Your conversations stay in your history."
                 : "Its models leave your model picker. Chats that used it stay in your history.")
        }
    }

    @ViewBuilder private func modelsSection(_ provider: JSON) -> some View {
        let models = store.models.filter { $0["providerId"].string == id }
        if !models.isEmpty {
            Section {
                ForEach(models, id: \.self) { model in
                    HStack {
                        Text(model["displayName"].string).foregroundStyle(model["available"].boolOrNil == false ? Theme.inkSecondary : Theme.ink)
                        Spacer(minLength: 8)
                        if model["available"].boolOrNil == false { Text("Not connected").font(.footnote).foregroundStyle(Theme.inkMuted) }
                    }
                }
            } header: { Text("Models") } footer: { Text("They show in your model picker while \(provider["deviceName"].string) is connected.") }
        }
    }

    private func check() {
        checking = true
        personalAction(store) {
            defer { checking = false }
            try await model.check(id, kind: kind)
            store.notify("Checked")
        }
    }
}

/// Changing what a server is called and how much it is asked at once: the one change a computer's own app isn't needed for.
struct PersonalProviderEditor: View {
    let store: AppStore
    let model: PersonalProvidersModel
    let provider: JSON
    let kind: PersonalProviderKind
    @State private var name: String
    @State private var parallel: Int
    @State private var modelsAtOnce: Int
    @State private var saving = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, model: PersonalProvidersModel, provider: JSON, kind: PersonalProviderKind) {
        self.store = store; self.model = model; self.provider = provider; self.kind = kind
        _name = State(initialValue: provider["name"].string)
        _parallel = State(initialValue: provider["parallelRequests"].intOrNil ?? 0)
        _modelsAtOnce = State(initialValue: provider["modelsAtOnce"].intOrNil ?? 0)
    }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 80 }

    var body: some View {
        NavigationStack {
            PersonalPage(title: "Server settings") {
                Section {
                    FieldRow(title: "Name", placeholder: "Name", text: $name, autocapitalize: true)
                    if !valid { Text(name.count > 80 ? "Use at most 80 characters." : "Give it a name.").font(.footnote).foregroundStyle(Theme.danger) }
                }
                Section {
                    stepper("Requests at once", value: $parallel, range: 1...64)
                    if kind == .text { stepper("Models loaded at once", value: $modelsAtOnce, range: 1...16) }
                } header: { Text("Limits") } footer: {
                    Text("Automatic uses what the server reports, else 1 for a server on a computer or your network. Raise it if the server can answer several requests at once.")
                }
                if let failure { Section { Text(failure).font(.footnote).foregroundStyle(Theme.danger) } }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(saving || !valid) }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }

    private func stepper(_ title: String, value: Binding<Int>, range: ClosedRange<Int>) -> some View {
        HStack {
            Text(title).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            Text(value.wrappedValue == 0 ? "Automatic" : "\(value.wrappedValue)").foregroundStyle(Theme.inkMuted).monospacedDigit()
            Stepper(title, value: Binding(get: { value.wrappedValue == 0 ? range.lowerBound - 1 : value.wrappedValue }, set: { value.wrappedValue = $0 < range.lowerBound ? 0 : $0 }), in: (range.lowerBound - 1)...range.upperBound).labelsHidden()
        }
    }

    private func save() {
        saving = true; failure = nil
        Task {
            defer { saving = false }
            do {
                var changes: [String: JSON] = ["name": .string(name.trimmingCharacters(in: .whitespaces)), "parallelRequests": parallel == 0 ? .null : .number(Double(parallel))]
                if kind == .text { changes["modelsAtOnce"] = modelsAtOnce == 0 ? .null : .number(Double(modelsAtOnce)) }
                try await model.save(provider, kind: kind, changes: changes)
                store.notify("Saved")
                dismiss()
            } catch is CancellationError { return } catch { failure = PersonalFailure.text(error) }
        }
    }
}
