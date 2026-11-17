import SwiftUI

// Capabilities: what every model on this server may do (look things up, read pages, remember, make pictures and sound,
// take dictation) and the instructions it is given. All of it is settings the server keeps; this file is the logic.

enum AMSearchEngine: String, CaseIterable, Identifiable {
    case auto, searxng, brave, tavily
    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: "Built-in (automatic)"
        case .searxng: "SearXNG (your own)"
        case .brave: "Brave Search API"
        case .tavily: "Tavily API"
        }
    }
    var keyLabel: String { self == .brave ? "Brave Search API key" : "Tavily API key" }
    var secretID: String { "web-search-\(rawValue)" }
}

/// How search is doing, in the desktop's words.
struct AMSearchStatus: Equatable {
    struct Engine: Equatable { let id: String; let name: String; let kind: String; let state: String; let retryAt: Double? }
    let mode: String
    let engines: [Engine]

    init(json: JSON) {
        mode = json["mode"].string
        engines = json["engines"].array.map { Engine(id: $0["id"].string, name: $0["name"].string, kind: $0["kind"].string, state: $0["state"].string, retryAt: $0["retryAt"].doubleOrNil) }
    }

    private static func ago(_ ms: Double) -> String { AMFormat.minutes(ms) }
    private var general: [Engine] { engines.filter { $0.kind != "news" && $0.kind != "dev" } }

    func summary(now: Date = .now) -> String {
        let nowMs = now.timeIntervalSince1970 * 1000
        if mode != "auto" && !mode.isEmpty { return "Using the search service you set up. Atelier does not fall back to other engines." }
        let limited = general.filter { $0.state == "limited" }
        let working = general.filter { $0.state == "ok" }
        if !general.isEmpty, limited.count == general.count {
            let retry = limited.compactMap(\.retryAt).min().map { $0 - nowMs }
            return "Search engines are limiting requests from this server. Atelier tries again\(retry.map { $0 > 0 ? " in about \(Self.ago($0))" : " shortly" } ?? " shortly")."
        }
        if !working.isEmpty {
            let names = working.map(\.name).joined(separator: " and ")
            let catching = limited.isEmpty ? "" : "; \(limited.map(\.name).joined(separator: " and ")) is catching its breath"
            return "Working. Answered by \(names)\(catching)."
        }
        return "Ready. Atelier picks an engine on the first search."
    }

    /// "News: Bing News working, Google News not used yet."
    func groupLines(now: Date = .now) -> [String] {
        guard mode == "auto" else { return [] }
        let nowMs = now.timeIntervalSince1970 * 1000
        return [("news", "News"), ("dev", "Programming")].compactMap { kind, label in
            let group = engines.filter { $0.kind == kind }
            guard !group.isEmpty else { return nil }
            return "\(label): " + group.map { "\($0.name) \(Self.state($0, nowMs))" }.joined(separator: ", ") + "."
        }
    }

    private static func state(_ engine: Engine, _ nowMs: Double) -> String {
        switch engine.state {
        case "ok": "working"
        case "unknown": "not used yet"
        default: engine.retryAt.map { $0 > nowMs ? "limited for about \(ago($0 - nowMs))" : "limited" } ?? "limited"
        }
    }
}

/// Atelier's own speech model on the server, as `dictation.status` reports it.
struct AMSpeechModel: Equatable {
    enum State: String { case unsupported, missing, downloading, ready, failed }
    let state: State
    let received: Double
    let total: Double
    let bytes: Double
    let error: String?

    init?(json: JSON) {
        guard json != .null, let state = State(rawValue: json["state"].string) else { return nil }
        self.state = state
        received = json["received"].doubleOrNil ?? 0
        total = json["total"].doubleOrNil ?? 0
        bytes = json["bytes"].doubleOrNil ?? 0
        error = json["error"].stringOrNil
    }

    var fraction: Double { total > 0 ? min(1, received / total) : 0 }

    var detail: String {
        switch state {
        case .ready: "Downloaded. It runs on the server, for everyone who dictates."
        case .downloading: "Downloading: \(AMFormat.bytes(received)) of \(AMFormat.bytes(total))."
        case .failed:
            // A reason that already says it ("The download was interrupted.") is not wrapped in the same words again.
            if let error, error.lowercased().hasPrefix("the download") { error } else { "The download failed: \(error ?? "unknown error")" }
        case .missing: "Not downloaded yet (\(AMFormat.bytes(bytes))). The first dictation downloads it, or download it now."
        case .unsupported: "This server can't run it."
        }
    }
}

struct AMDictationStatus: Equatable {
    struct Source: Equatable, Identifiable { let id: String; let label: String; let provider: String; let live: Bool }
    let enabled: Bool
    let sources: [Source]
    let chosen: String?
    let builtin: AMSpeechModel?

    init(json: JSON) {
        enabled = json["enabled"].bool
        sources = json["sources"].array.map { Source(id: $0["id"].string, label: $0["label"].string, provider: $0["provider"].string, live: $0["live"].bool) }
        chosen = json["chosen"].stringOrNil
        builtin = AMSpeechModel(json: json["builtin"])
    }
}

struct AMCapabilitiesSnapshot {
    var secrets: [AMSecret]
    var search: AMSearchStatus?
    var dictation: AMDictationStatus?
}

@MainActor @Observable final class AMCapabilitiesModel {
    enum SearchTest: Equatable { case idle, running, done(String), failed(String) }

    let store: AppStore
    let api: AMAPI
    let settings: AMSettings
    let resource: Resource<AMCapabilitiesSnapshot>
    var searchTest: SearchTest = .idle
    var preparing = false
    var prepareError: String?

    init(store: AppStore) {
        self.store = store
        let api = AMAPI(store: store)
        let settings = AMSettings(store: store)
        self.api = api
        self.settings = settings
        resource = Resource {
            try await settings.load()
            // Both of these are only on servers that have the feature: an older one just doesn't show the section.
            async let secrets = api.call("secrets.list")
            async let search = api.optional("search.status")
            async let dictation = api.optional("dictation.status")
            return AMCapabilitiesSnapshot(
                secrets: try await secrets.array.map(AMSecret.init),
                search: await search.map(AMSearchStatus.init),
                dictation: await dictation.map(AMDictationStatus.init)
            )
        }
    }

    // MARK: Search

    var searchEngine: AMSearchEngine { AMSearchEngine(rawValue: settings.value(["capabilities", "webSearch", "provider"]).string) ?? .auto }

    /// The masked tail of the key kept for this engine, if the setting points at it.
    func keyHint(for engine: AMSearchEngine) -> String? {
        guard settings.value(["capabilities", "webSearch", "apiKey"]).string == "${secret:\(engine.secretID)}" else { return nil }
        return resource.value?.secrets.first { $0.id == engine.secretID }?.masked ?? "••••"
    }

    func saveSearchKey(_ engine: AMSearchEngine, value: String) async throws {
        _ = try await api.call("secrets.set", ["id": .string(engine.secretID), "label": .string(engine.keyLabel), "kind": "api_key", "value": .string(value)])
        try await settings.set(["capabilities", "webSearch", "apiKey"], .string("${secret:\(engine.secretID)}"))
        await resource.reload()
    }

    func saveSearxngURL(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { try await settings.reset(["capabilities", "webSearch", "url"]) }
        else { try await settings.set(["capabilities", "webSearch", "url"], .string(trimmed)) }
    }

    func testSearch() async {
        searchTest = .running
        do {
            let result = try await api.call("search.test")
            let count = result["results"].array.count
            searchTest = .done("\(result["engine"].string) answered in \(String(format: "%.1f", (result["ms"].doubleOrNil ?? 0) / 1000)) s with \(AMFormat.plural(count, "result")).")
        } catch is CancellationError { searchTest = .idle } catch { searchTest = .failed(AMFailure.from(error).localizedDescription) }
        if let fresh = await api.optional("search.status"), var snapshot = resource.value { snapshot.search = AMSearchStatus(json: fresh); resource.set(snapshot) }
    }

    // MARK: Dictation

    func setDictationSource(_ id: String?) async {
        await store.attempt {
            if let id { try await self.settings.set(["dictation", "source"], .string(id)) } else { try await self.settings.reset(["dictation", "source"]) }
        }
        await refreshDictation()
    }

    func refreshDictation() async {
        guard let fresh = await api.optional("dictation.status"), var snapshot = resource.value else { return }
        snapshot.dictation = AMDictationStatus(json: fresh)
        resource.set(snapshot)
    }

    func prepareSpeechModel() async {
        preparing = true; prepareError = nil
        defer { preparing = false }
        do {
            let status = AMDictationStatus(json: try await api.call("dictation.prepare"))
            if var snapshot = resource.value { snapshot.dictation = status; resource.set(snapshot) }
        } catch is CancellationError {} catch { prepareError = AMFailure.from(error).localizedDescription }
    }

    /// Watches the model's download until it is ready, failed, or the page goes away.
    func watchDownload() async {
        while !Task.isCancelled, resource.value?.dictation?.builtin?.state == .downloading {
            do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
            await refreshDictation()
        }
    }
}
