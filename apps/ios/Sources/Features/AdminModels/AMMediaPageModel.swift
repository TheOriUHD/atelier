import SwiftUI

// The media page's data and what can be done with it: providers, their status, the models they list, and the defaults.

struct AMMediaSnapshot {
    var providers: [AMMediaProvider]
    var statuses: [String: AMProviderStatus]
    var models: [AMMediaModel]
    /// Text providers: a key can be copied from one, and a local one can share its GPU with an image server.
    var textProviders: [AMProvider]
    var secrets: [AMSecret]

    var providerNames: [String: String] { Dictionary(providers.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }) }
}

@MainActor @Observable final class AMMediaPageModel {
    enum Scan: Equatable { case scanning, found([AMDetectedMedia]), failed(String) }

    let store: AppStore
    let api: AMAPI
    let settings: AMSettings
    let resource: Resource<AMMediaSnapshot>
    var scan: Scan = .scanning
    var checking: Set<String> = []
    var adding: Set<String> = []
    /// A switch that was just flipped shows its new position at once, until the server's list confirms it.
    var pendingEnabled: [String: Bool] = [:]

    init(store: AppStore) {
        self.store = store
        let api = AMAPI(store: store)
        let settings = AMSettings(store: store)
        self.api = api
        self.settings = settings
        resource = Resource { try await AMMediaPageModel.fetch(api, settings) }
    }

    static func fetch(_ api: AMAPI, _ settings: AMSettings) async throws -> AMMediaSnapshot {
        async let statuses = api.call("imageProviders.status")
        async let models = api.call("imageModels.list")
        async let secrets = api.call("secrets.list")
        try await settings.load()
        let status = try await statuses.array.map(AMProviderStatus.init)
        return AMMediaSnapshot(
            providers: settings.value(["imageProviders"]).array.map(AMMediaProvider.init),
            statuses: Dictionary(status.map { ($0.providerID, $0) }, uniquingKeysWith: { _, last in last }),
            models: try await models.array.map(AMMediaModel.init).filter { $0.providerID != "" },
            textProviders: settings.value(["providers"]).array.map(AMProvider.init),
            secrets: try await secrets.array.map(AMSecret.init)
        )
    }

    // MARK: Scanning

    func rescan() async {
        scan = .scanning
        do { scan = .found(try await api.call("imageProviders.detect").array.map(AMDetectedMedia.init)) }
        catch is CancellationError {} catch {
            // An older server has no detection; that is not a problem worth showing.
            scan = AMFailure.from(error) == .unsupported ? .found([]) : .failed(AMFailure.from(error).localizedDescription)
        }
    }

    func addDetected(_ found: AMDetectedMedia) async {
        adding.insert(found.id)
        defer { adding.remove(found.id) }
        let taken = Set((resource.value?.providers.map(\.id) ?? []) + (resource.value?.textProviders.map(\.id) ?? []))
        let ok = await store.attempt { _ = try await self.api.call("imageProviders.save", AMMediaForm.detectedDraft(found, taken: taken)) }
        if ok { store.notify("Added \(found.label)") }
        await resource.reload()
        await rescan()
    }

    // MARK: Providers

    func check(_ id: String) async {
        checking.insert(id)
        defer { checking.remove(id) }
        await store.attempt { _ = try await self.api.call("imageProviders.refresh", ["id": .string(id)]) }
        await resource.reload()
    }

    func setEnabled(_ provider: AMMediaProvider, _ on: Bool) async {
        pendingEnabled[provider.id] = on
        defer { pendingEnabled.removeValue(forKey: provider.id) }
        let ok = await store.attempt {
            let current = try await self.api.call("settings.get")["effective"]["imageProviders"].array
            guard let index = current.firstIndex(where: { $0["id"].string == provider.id }) else { throw AMFailure.message("\(provider.name) isn't in the list any more. Pull down to refresh.") }
            _ = try await self.api.call("settings.set", ["layer": "global", "path": ["imageProviders", .number(Double(index)), "enabled"], "value": .bool(on)])
        }
        await resource.reload()
        if ok, on { await check(provider.id) }
    }

    func remove(_ provider: AMMediaProvider) async -> Bool {
        let ok = await store.attempt { _ = try await self.api.call("imageProviders.remove", ["id": .string(provider.id)]) }
        await resource.reload()
        if ok { store.notify("Removed \(provider.name)") }
        await rescan()
        return ok
    }

    /// Writes the provider's workflows (ComfyUI), keeping everything else about it.
    func saveWorkflows(_ provider: AMMediaProvider, _ workflows: [JSON]) async throws {
        var draft = provider.draft()
        draft["workflows"] = .array(workflows)
        _ = try await api.call("imageProviders.save", draft)
        await resource.reload()
    }

    // MARK: Models

    func overrides(_ ref: String) -> JSON { settings.value(["imageModels", "overrides", .string(ref)]) }

    private func update(_ ref: String, _ change: (inout AMMediaModel) -> Void) {
        guard var snapshot = resource.value, let index = snapshot.models.firstIndex(where: { $0.ref == ref }) else { return }
        change(&snapshot.models[index])
        resource.set(snapshot)
    }

    func setFlag(_ ref: String, key: String, on: Bool) async {
        let path: [JSON] = ["imageModels", "overrides", .string(ref), .string(key)]
        update(ref) { if key == "hidden" { $0.hidden = on } else { $0.favorite = on } }
        let ok = await store.attempt {
            if key == "hidden" || on { try await self.settings.set(path, .bool(on)) } else { try await self.settings.reset(path) }
        }
        if !ok { await resource.reload() }
    }

    /// The model a default points at, if it is still visible.
    func defaultChoice(_ kind: AMMediaDefault) -> (ref: String?, model: AMMediaModel?) {
        guard let ref = settings.value(kind.path).stringOrNil, !ref.isEmpty else { return (nil, nil) }
        return (ref, resource.value?.models.first { $0.ref == ref && !$0.hidden && kind.fits($0) })
    }

    func setDefault(_ kind: AMMediaDefault, ref: String?) async -> Bool {
        let ok = await store.attempt {
            if let ref { try await self.settings.set(kind.path, .string(ref)) } else { try await self.settings.reset(kind.path) }
        }
        if !ok { await resource.reload() }
        return ok
    }

    /// Writes the override fields that changed, each to its own path (empty ones are removed).
    func saveOverrides(_ ref: String, form: AMMediaOverrideForm) async -> Bool {
        let stored = overrides(ref)
        let ok = await store.attempt {
            for change in form.changes(from: stored) {
                let path: [JSON] = ["imageModels", "overrides", .string(ref), .string(change.key)]
                if let value = change.value { try await self.settings.set(path, value) } else { try await self.settings.reset(path) }
            }
        }
        await resource.reload()
        return ok
    }
}

// MARK: - A model's override form

/// What an admin says about a picture, video or sound model. Every field is text, so an empty one means "what was detected".
struct AMMediaOverrideForm: Equatable {
    enum Field: Hashable { case seconds, fps, steps, guidance, soundSeconds }

    var displayName = ""
    var description = ""
    var steps = ""
    var guidance = ""
    var sampler = "auto"
    var scheduler = "auto"
    var seconds = ""
    var fps = ""
    var resolution = "auto"
    var voice = "auto"
    var soundSeconds = ""

    init() {}
    init(overrides o: JSON) {
        displayName = o["displayName"].string
        description = o["description"].string
        steps = o["tuning"]["steps"].intOrNil.map(String.init) ?? ""
        guidance = o["tuning"]["guidance"].doubleOrNil.map { AMMediaOverrideForm.number($0) } ?? ""
        sampler = o["tuning"]["sampler"].stringOrNil ?? "auto"
        scheduler = o["tuning"]["scheduler"].stringOrNil ?? "auto"
        seconds = o["video"]["seconds"].doubleOrNil.map { AMMediaOverrideForm.number($0) } ?? ""
        fps = o["video"]["fps"].intOrNil.map(String.init) ?? ""
        resolution = o["video"]["resolution"].stringOrNil ?? "auto"
        voice = o["audio"]["voice"].stringOrNil ?? "auto"
        soundSeconds = o["audio"]["seconds"].doubleOrNil.map { AMMediaOverrideForm.number($0) } ?? ""
    }

    static func number(_ value: Double) -> String { value == value.rounded() ? String(Int(value)) : String(value) }
    private static func parse(_ text: String) -> Double? { Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")) }
    private func blank(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespaces).isEmpty }

    func errors() -> [Field: String] {
        var errors: [Field: String] = [:]
        if !blank(steps), !(Int(steps.trimmingCharacters(in: .whitespaces)).map { (1...200).contains($0) } ?? false) { errors[.steps] = "Enter a whole number from 1 to 200." }
        if !blank(guidance), !(Self.parse(guidance).map { (0...50).contains($0) } ?? false) { errors[.guidance] = "Enter a number from 0 to 50." }
        if !blank(seconds), !(Self.parse(seconds).map { $0 > 0 && $0 <= 600 } ?? false) { errors[.seconds] = "Enter a number of seconds from 1 to 600." }
        if !blank(fps), !(Int(fps.trimmingCharacters(in: .whitespaces)).map { (1...240).contains($0) } ?? false) { errors[.fps] = "Enter a whole number from 1 to 240." }
        if !blank(soundSeconds), !(Self.parse(soundSeconds).map { $0 > 0 && $0 <= 3600 } ?? false) { errors[.soundSeconds] = "Enter a number of seconds from 1 to 3600." }
        return errors
    }

    /// The five override keys as they would be stored; nil where nothing is set.
    func values() -> [String: JSON?] {
        func object(_ pairs: [(String, JSON?)]) -> JSON? {
            let kept = pairs.compactMap { key, value in value.map { (key, $0) } }
            return kept.isEmpty ? nil : .object(Dictionary(kept, uniquingKeysWith: { _, last in last }))
        }
        let tuning = object([
            ("steps", blank(steps) ? nil : Int(steps.trimmingCharacters(in: .whitespaces)).map { .number(Double($0)) }),
            ("guidance", blank(guidance) ? nil : Self.parse(guidance).map { .number($0) }),
            ("sampler", sampler == "auto" || blank(sampler) ? nil : .string(sampler.trimmingCharacters(in: .whitespaces))),
            ("scheduler", scheduler == "auto" || blank(scheduler) ? nil : .string(scheduler.trimmingCharacters(in: .whitespaces))),
        ])
        let video = object([
            ("seconds", blank(seconds) ? nil : Self.parse(seconds).map { .number($0) }),
            ("fps", blank(fps) ? nil : Int(fps.trimmingCharacters(in: .whitespaces)).map { .number(Double($0)) }),
            ("resolution", resolution == "auto" || blank(resolution) ? nil : .string(resolution.trimmingCharacters(in: .whitespaces))),
        ])
        let audio = object([
            ("voice", voice == "auto" || blank(voice) ? nil : .string(voice.trimmingCharacters(in: .whitespaces))),
            ("seconds", blank(soundSeconds) ? nil : Self.parse(soundSeconds).map { .number($0) }),
        ])
        return [
            "displayName": blank(displayName) ? nil : .string(displayName.trimmingCharacters(in: .whitespaces)),
            "description": blank(description) ? nil : .string(description.trimmingCharacters(in: .whitespaces)),
            "tuning": tuning, "video": video, "audio": audio,
        ]
    }

    func changes(from stored: JSON) -> [(key: String, value: JSON?)] {
        values().compactMap { key, value in
            let current = stored[key]
            if let value { return current == value ? nil : (key, value) }
            return current == .null ? nil : (key, nil)
        }.sorted { $0.key < $1.key }
    }
}

// MARK: - Generation limits

/// One of the numbers under "Limits": what it accepts and what is shown while it is empty.
struct AMLimitSpec: Identifiable {
    enum Kind { case whole(max: Int), dollars }
    let key: String
    let title: String
    let subtitle: String
    let kind: Kind
    var required = false
    var unit: String
    /// What applies while it is empty, shown in the field.
    var fallback: String?
    var id: String { key }

    /// A value the field accepts, or nil. The text is trimmed first.
    func parse(_ text: String) -> JSON? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .whole(let max):
            guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber), let n = Int(trimmed), n >= 1, n <= max else { return nil }
            return .number(Double(n))
        case .dollars:
            let normal = trimmed.replacingOccurrences(of: ",", with: ".")
            guard !normal.isEmpty, normal.allSatisfy({ $0.isNumber || $0 == "." }), normal.filter({ $0 == "." }).count <= 1, let n = Double(normal), n > 0 else { return nil }
            return .number(n)
        }
    }

    var problem: String {
        switch kind {
        case .whole(let max): required ? "Enter a whole number from 1 to \(max)." : "Enter a whole number, or leave it empty for no limit."
        case .dollars: "Enter dollars, or leave it empty for no limit."
        }
    }

    static let images: [AMLimitSpec] = [
        AMLimitSpec(key: "maxImagesPerTurn", title: "Images per reply", subtitle: "How many images one reply can make, so text on a web page can't run up a bill.", kind: .whole(max: 100), required: true, unit: "images"),
        AMLimitSpec(key: "maxImagesPerUserPerDay", title: "Images per person per day", subtitle: "Counted across all of a person's conversations, including deleted ones.", kind: .whole(max: Int.max), unit: "images"),
        AMLimitSpec(key: "maxSpendPerUserPerDayUsd", title: "Spend per person per day", subtitle: "Counts images with a known or estimated cost. Local servers cost nothing here.", kind: .dollars, unit: "dollars"),
    ]
    static let videos: [AMLimitSpec] = [
        AMLimitSpec(key: "maxVideosPerTurn", title: "Videos per reply", subtitle: "A video takes minutes and costs far more than an image, so the default is 2.", kind: .whole(max: 20), unit: "videos", fallback: "2"),
        AMLimitSpec(key: "maxVideosPerUserPerDay", title: "Videos per person per day", subtitle: "Counted across all of a person's conversations, including deleted ones.", kind: .whole(max: Int.max), unit: "videos"),
        AMLimitSpec(key: "maxVideoSpendPerUserPerDayUsd", title: "Video spend per person per day", subtitle: "Counts videos with a known or estimated cost. Local servers cost nothing here.", kind: .dollars, unit: "dollars"),
    ]
    static let sounds: [AMLimitSpec] = [
        AMLimitSpec(key: "maxAudioPerTurn", title: "Sounds per reply", subtitle: "Speech, music and effects together. The default is 6, enough for a short dialogue made line by line.", kind: .whole(max: 50), unit: "sounds", fallback: "6"),
        AMLimitSpec(key: "maxAudioPerUserPerDay", title: "Sounds per person per day", subtitle: "Counted across all of a person's conversations, including deleted ones.", kind: .whole(max: Int.max), unit: "sounds"),
        AMLimitSpec(key: "maxAudioSpendPerUserPerDayUsd", title: "Sound spend per person per day", subtitle: "Counts sounds with a known or estimated cost. Local servers cost nothing here.", kind: .dollars, unit: "dollars"),
    ]
}
