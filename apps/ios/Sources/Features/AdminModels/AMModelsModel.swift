import SwiftUI

// Models: the combined list from every provider, what an admin changed about each one, and the defaults.

struct AMModel: Identifiable, Equatable, Sendable {
    let ref: String
    let providerID: String
    let modelID: String
    var displayName: String
    var contextLength: Int
    var calculatedContext: Int?
    var maxOutput: Int
    let tools: String
    let vision: Bool
    let reasoning: String
    var hidden: Bool
    var favorite: Bool
    let manual: Bool
    let free: Bool
    let source: String
    let effortLevels: [String]
    let recommended: [String: String]
    let temperature: Double?
    let personal: Bool
    var id: String { ref }

    init(json: JSON) {
        ref = json["ref"].string
        providerID = json["providerId"].string
        modelID = json["modelId"].string
        displayName = json["displayName"].string
        contextLength = json["contextLength"].int
        calculatedContext = json["calculatedContextLength"].intOrNil
        maxOutput = json["maxOutput"].int
        tools = json["capabilities"]["tools"].string
        vision = json["capabilities"]["vision"].bool
        reasoning = json["capabilities"]["reasoning"].string
        hidden = json["hidden"].bool
        favorite = json["favorite"].bool
        manual = json["manual"].bool
        free = json["free"].bool
        source = json["source"].string
        effortLevels = json["effortLevels"].strings
        var recommended: [String: String] = [:]
        for (mode, level) in json["recommendedEffort"].entries { if let text = level.stringOrNil { recommended[mode] = text } }
        self.recommended = recommended
        temperature = json["temperature"].doubleOrNil
        personal = json["personal"] != .null
    }

    var toolsLabel: String { tools == "prompted" ? "Prompted tools" : tools == "none" ? "No tools" : "Tools" }

    /// The words under a model's name: "200K context, vision, reasoning".
    var summary: String {
        var parts = ["\(AMFormat.tokens(calculatedContext ?? contextLength)) context"]
        if vision { parts.append("vision") }
        if reasoning != "none" { parts.append("reasoning") }
        if tools == "prompted" { parts.append("prompted tools") } else if tools == "none" { parts.append("no tools") }
        if free { parts.append("free") }
        return parts.joined(separator: ", ")
    }

    var sourceText: String {
        switch source {
        case "detected": "Read from the provider"
        case "catalog": "From Atelier's catalog of known models"
        case "override": "Includes changes made here"
        default: "Atelier's defaults: the provider didn't say"
        }
    }
}

struct AMModelsSnapshot {
    var models: [AMModel]
    var providerNames: [String: String]
    /// Providers that are on but list no model, so a model can be added to them by name.
    var providerOrder: [String]
}

enum AMModelScope: String, CaseIterable, Identifiable {
    case all = "All", visible = "In the picker", hidden = "Hidden"
    var id: String { rawValue }
}

struct AMModelFilter: Equatable {
    var scope: AMModelScope = .all
    var favoritesOnly = false
    var tools = false
    var vision = false
    var reasoning = false
    var free = false
    var search = ""

    var active: Bool { favoritesOnly || tools || vision || reasoning || free }

    func matches(_ model: AMModel, providerName: String) -> Bool {
        switch scope {
        case .all: break
        case .visible: if model.hidden { return false }
        case .hidden: if !model.hidden { return false }
        }
        if favoritesOnly, !model.favorite { return false }
        if tools, model.tools == "none" { return false }
        if vision, !model.vision { return false }
        if reasoning, model.reasoning == "none" { return false }
        if free, !model.free { return false }
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        if query.isEmpty { return true }
        return "\(model.displayName) \(model.modelID) \(providerName)".lowercased().contains(query)
    }
}

/// What the override form holds while it is edited; every field is text so an empty one means "what was detected".
struct AMOverrideForm: Equatable {
    var displayName = ""
    var contextLength = ""
    var maxOutput = ""
    var temperature = ""
    var toolCalling = "auto"
    var vision = "auto"
    var promptTier = "auto"

    enum Field: Hashable { case name, context, output, temperature }

    init() {}
    init(overrides: JSON) {
        displayName = overrides["displayName"].string
        contextLength = overrides["contextLength"].intOrNil.map(String.init) ?? ""
        maxOutput = overrides["maxOutputTokens"].intOrNil.map(String.init) ?? ""
        temperature = overrides["temperature"].doubleOrNil.map { String($0) } ?? ""
        toolCalling = overrides["toolCalling"].stringOrNil ?? "auto"
        vision = overrides["vision"].boolOrNil.map { $0 ? "yes" : "no" } ?? "auto"
        promptTier = overrides["promptTier"].stringOrNil ?? "auto"
    }

    func errors() -> [Field: String] {
        var errors: [Field: String] = [:]
        if !contextLength.trimmingCharacters(in: .whitespaces).isEmpty, (Int(contextLength.trimmingCharacters(in: .whitespaces)) ?? 0) < 1 { errors[.context] = "Enter a whole number of tokens." }
        if !maxOutput.trimmingCharacters(in: .whitespaces).isEmpty, (Int(maxOutput.trimmingCharacters(in: .whitespaces)) ?? 0) < 1 { errors[.output] = "Enter a whole number of tokens." }
        let text = temperature.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if !text.isEmpty { if let value = Double(text), (0...2).contains(value) {} else { errors[.temperature] = "Enter a number from 0 to 2." } }
        return errors
    }

    /// The value for each override key, nil where the field is empty (so the detected value applies).
    func values() -> [String: JSON?] {
        let temperatureText = temperature.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        return [
            "displayName": displayName.trimmingCharacters(in: .whitespaces).isEmpty ? nil : .string(displayName.trimmingCharacters(in: .whitespaces)),
            "contextLength": Int(contextLength.trimmingCharacters(in: .whitespaces)).map { .number(Double($0)) },
            "maxOutputTokens": Int(maxOutput.trimmingCharacters(in: .whitespaces)).map { .number(Double($0)) },
            "temperature": Double(temperatureText).map { .number($0) },
            "toolCalling": toolCalling == "auto" ? nil : .string(toolCalling),
            "vision": vision == "auto" ? nil : .bool(vision == "yes"),
            "promptTier": promptTier == "auto" ? nil : .string(promptTier),
        ]
    }

    /// The keys whose value differs from what is stored now.
    func changes(from stored: JSON) -> [(key: String, value: JSON?)] {
        values().compactMap { key, value in
            let current = stored[key]
            if let value { return current == value ? nil : (key, value) }
            return current == .null ? nil : (key, nil)
        }.sorted { $0.key < $1.key }
    }
}

// MARK: - The model

@MainActor @Observable final class AMModelsModel {
    let store: AppStore
    let api: AMAPI
    let settings: AMSettings
    let resource: Resource<AMModelsSnapshot>

    init(store: AppStore) {
        self.store = store
        let api = AMAPI(store: store)
        let settings = AMSettings(store: store)
        self.api = api
        self.settings = settings
        resource = Resource { try await AMModelsModel.fetch(api, settings) }
    }

    static func fetch(_ api: AMAPI, _ settings: AMSettings) async throws -> AMModelsSnapshot {
        async let list = api.call("models.list")
        try await settings.load()
        let models = try await list.array.map(AMModel.init).filter { !$0.personal }
        var names: [String: String] = [:]
        var order: [String] = []
        for provider in settings.value(["providers"]).array where provider["enabled"].boolOrNil ?? true {
            names[provider["id"].string] = provider["name"].string
            order.append(provider["id"].string)
        }
        return AMModelsSnapshot(models: models, providerNames: names, providerOrder: order)
    }

    func overrides(_ ref: String) -> JSON { settings.value(["models", "overrides", .string(ref)]) }
    func hasOverrides(_ ref: String) -> Bool { overrides(ref) != .null && !overrides(ref).entries.isEmpty }

    /// A model's current state as the person sees it: the list, with what was just changed already in it.
    func model(_ ref: String) -> AMModel? { resource.value?.models.first { $0.ref == ref } }

    private func update(_ ref: String, _ change: (inout AMModel) -> Void) {
        guard var snapshot = resource.value, let index = snapshot.models.firstIndex(where: { $0.ref == ref }) else { return }
        change(&snapshot.models[index])
        resource.set(snapshot)
    }

    /// A switch on one model. It shows at once, and is undone with the shared alert if the server refuses.
    func setFlag(_ ref: String, key: String, on: Bool) async {
        let path: [JSON] = ["models", "overrides", .string(ref), .string(key)]
        update(ref) { if key == "hidden" { $0.hidden = on } else { $0.favorite = on } }
        let ok = await store.attempt {
            // Hidden is always written (a provider may hide its models by default); a favorite that is off is simply cleared.
            if key == "hidden" || on { try await self.settings.set(path, .bool(on)) } else { try await self.settings.reset(path) }
        }
        if !ok { await resource.reload() }
        await refreshAppModels()
    }

    /// Writes the changed fields of the override form, each to its own path.
    func save(_ ref: String, form: AMOverrideForm) async -> Bool {
        let stored = overrides(ref)
        let ok = await store.attempt {
            for change in form.changes(from: stored) {
                let path: [JSON] = ["models", "overrides", .string(ref), .string(change.key)]
                if let value = change.value { try await self.settings.set(path, value) } else { try await self.settings.reset(path) }
            }
        }
        await resource.reload()
        await refreshAppModels()
        return ok
    }

    func resetOverrides(_ ref: String) async -> Bool {
        let ok = await store.attempt { try await self.settings.reset(["models", "overrides", .string(ref)]) }
        await resource.reload()
        await refreshAppModels()
        return ok
    }

    /// Lists a model by its id when the provider's own list leaves it out.
    func addManual(providerID: String, modelID: String) async -> Bool {
        let ok = await store.attempt { try await self.settings.set(["models", "overrides", .string("\(providerID)/\(modelID)"), "manual"], true) }
        await resource.reload()
        await refreshAppModels()
        return ok
    }

    func calculateAll() async -> String? {
        do {
            let statuses = try await api.call("providers.refresh").array.map(AMProviderStatus.init)
            await resource.reload()
            await refreshAppModels()
            let down = statuses.filter { !$0.ok }.count
            return down > 0 ? "Recalculated. \(AMFormat.plural(down, "provider")) couldn't be reached, so their cached details were used." : "Recalculated all models."
        } catch is CancellationError { return nil } catch { store.error = AMFailure.from(error).localizedDescription; return nil }
    }

    func probe(_ ref: String) async throws -> (native: Bool, detail: String) {
        let result = try await api.call("models.probeTools", ["ref": .string(ref)])
        return (result["native"].bool, result["detail"].string)
    }

    /// Chat's model picker follows what was changed here.
    func refreshAppModels() async {
        if let models = await api.optional("models.list") { store.models = models.array }
    }

    /// The model a default or alias points at: found, missing, or unset.
    func choice(_ path: [JSON]) -> (ref: String?, model: AMModel?) {
        guard let ref = settings.value(path).stringOrNil, !ref.isEmpty else { return (nil, nil) }
        return (ref, resource.value?.models.first { $0.ref == ref && !$0.hidden })
    }

    func setChoice(_ path: [JSON], ref: String?) async -> Bool {
        let ok = await store.attempt {
            if let ref { try await self.settings.set(path, .string(ref)) } else { try await self.settings.reset(path) }
        }
        if !ok { await resource.reload() }
        return ok
    }
}
