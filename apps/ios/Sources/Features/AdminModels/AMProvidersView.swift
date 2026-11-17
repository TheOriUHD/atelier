import SwiftUI

// Settings › Admin › Providers: where the models come from, how each one is doing, and adding, changing and removing them.

struct AMProvidersSnapshot {
    var providers: [AMProvider]
    var statuses: [String: AMProviderStatus]
    var secrets: [AMSecret]
    /// `chatgpt.status` and `copilot.status`, read only when such a provider exists.
    var chatgpt: JSON = .null
    var copilot: JSON = .null
}

@MainActor @Observable final class AMProvidersModel {
    enum Scan: Equatable { case scanning, found([AMDetected]), failed(String) }

    let store: AppStore
    let api: AMAPI
    let resource: Resource<AMProvidersSnapshot>
    var scan: Scan = .scanning
    /// Providers being checked right now.
    var checking: Set<String> = []
    /// A switch that was just flipped shows its new position at once, until the server's list confirms it.
    var pendingEnabled: [String: Bool] = [:]

    init(store: AppStore) {
        self.store = store
        let api = AMAPI(store: store)
        self.api = api
        resource = Resource { try await AMProvidersModel.fetch(api) }
    }

    static func fetch(_ api: AMAPI) async throws -> AMProvidersSnapshot {
        async let settings = api.call("settings.get")
        async let statuses = api.call("providers.status")
        async let secrets = api.call("secrets.list")
        let configs = try await settings["effective"]["providers"].array.map(AMProvider.init)
        var snapshot = AMProvidersSnapshot(
            providers: configs,
            statuses: Dictionary(try await statuses.array.map { (AMProviderStatus(json: $0).providerID, AMProviderStatus(json: $0)) }, uniquingKeysWith: { _, last in last }),
            secrets: try await secrets.array.map(AMSecret.init)
        )
        if configs.contains(where: { $0.typeID == "chatgpt" }) { snapshot.chatgpt = await api.optional("chatgpt.status") ?? .null }
        if configs.contains(where: { $0.typeID == "copilot" }) { snapshot.copilot = await api.optional("copilot.status") ?? .null }
        return snapshot
    }

    func rescan() async {
        scan = .scanning
        do { scan = .found(try await api.call("providers.detect").array.compactMap(AMDetected.init)) }
        catch is CancellationError {} catch { scan = .failed(AMFailure.from(error).localizedDescription) }
    }

    /// Asks the provider again and shows what it says.
    func check(_ id: String) async {
        checking.insert(id)
        defer { checking.remove(id) }
        await store.attempt { _ = try await self.api.call("providers.refresh", ["id": .string(id)]) }
        await resource.reload()
    }

    /// Turns a provider on or off. The server's list is read again first, so the position written is the provider's own.
    func setEnabled(_ provider: AMProvider, _ on: Bool) async {
        pendingEnabled[provider.id] = on
        defer { pendingEnabled.removeValue(forKey: provider.id) }
        let ok = await store.attempt {
            let current = try await self.api.call("settings.get")["effective"]["providers"].array
            guard let index = current.firstIndex(where: { $0["id"].string == provider.id }) else { throw AMFailure.message("\(provider.name) isn't in the list any more. Pull down to refresh.") }
            _ = try await self.api.call("settings.set", ["layer": "global", "path": ["providers", .number(Double(index)), "enabled"], "value": .bool(on)])
        }
        await resource.reload()
        if ok, on { await check(provider.id) }
        await refreshAppModels()
    }

    func remove(_ provider: AMProvider) async -> Bool {
        let ok = await store.attempt {
            if provider.typeID == "chatgpt-chat" { _ = try? await self.api.call("chatgptChat.disconnect") }
            _ = try await self.api.call("providers.remove", ["id": .string(provider.id)])
        }
        await resource.reload()
        if ok { store.notify("Removed \(provider.name)") }
        await refreshAppModels()
        return ok
    }

    /// The model picker in conversations follows what was changed here.
    func refreshAppModels() async {
        if let models = await api.optional("models.list") { store.models = models.array }
    }
}

// MARK: - The page

struct ProvidersSettings: View {
    let store: AppStore
    @State private var model: AMProvidersModel
    @State private var wizard: AMWizardRequest?
    /// A provider's page opened by a launch argument (debug builds), as if it had been tapped.
    @State private var launched: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AMProvidersModel(store: store))
    }

    var body: some View {
        AMResourcePage(title: "Providers", resource: model.resource) { snapshot in
            detectedSection(snapshot)
            providersSection(snapshot)
        }
        .task { await model.rescan() }
        .task { await openLaunchRoute() }
        .navigationDestination(item: $launched) { id in
            AMProviderDetail(store: store, model: model, providerID: id, onEdit: { wizard = AMWizardRequest(start: .edit($0)) })
        }
        .sheet(item: $wizard) { request in
            if let snapshot = model.resource.value {
                AMProviderWizard(store: store, request: request, taken: Set(snapshot.providers.map(\.id)), secrets: snapshot.secrets, providers: snapshot.providers) { message in
                    store.notify(message)
                    Task {
                        await model.resource.reload()
                        await model.rescan()
                        await model.refreshAppModels()
                    }
                }
            }
        }
    }

    private func openLaunchRoute() async {
        guard let route = AMLaunch.parts else { return }
        await model.resource.reload()
        guard let snapshot = model.resource.value else { return }
        switch route.head {
        case "provider": launched = route.tail
        case "add": wizard = AMWizardRequest(start: .choose)
        case "edit": if let provider = snapshot.providers.first(where: { $0.id == route.tail }) { wizard = AMWizardRequest(start: .edit(provider)) }
        case "detected": await model.rescan(); if case .found(let found) = model.scan, let first = found.first { wizard = AMWizardRequest(start: .detected(first)) }
        default: break
        }
    }

    // MARK: Detected

    private func detectedSection(_ snapshot: AMProvidersSnapshot) -> some View {
        Section {
            switch model.scan {
            case .scanning:
                HStack(spacing: 10) { ProgressView(); Text("Looking for servers and keys…").font(.subheadline).foregroundStyle(Theme.inkMuted) }
            case .failed(let message):
                AMOutcome(kind: .bad, text: message)
            case .found(let found):
                if found.isEmpty { Text("Nothing new found.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                ForEach(found) { item in
                    HStack(spacing: 12) {
                        IconTile(symbol: item.type.symbol, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label).foregroundStyle(Theme.ink)
                            Text(item.whereFound).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Button("Set up") { wizard = AMWizardRequest(start: .detected(item)) }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(Theme.clay)
                            .accessibilityLabel("Set up \(item.label)")
                    }
                }
            }
        } header: {
            HStack {
                Text("Detected on this server")
                Spacer()
                Button { Task { await model.rescan() } } label: { Label("Scan again", systemImage: "arrow.clockwise").labelStyle(.titleOnly) }
                    .font(.footnote).textCase(nil).disabled(model.scan == .scanning)
            }
        } footer: { Text("Local servers on their default ports and API keys in the server's environment.") }
    }

    // MARK: Providers

    private func providersSection(_ snapshot: AMProvidersSnapshot) -> some View {
        Section {
            ForEach(snapshot.providers) { provider in
                NavigationLink {
                    AMProviderDetail(store: store, model: model, providerID: provider.id, onEdit: { wizard = AMWizardRequest(start: .edit($0)) })
                } label: {
                    AMProviderRow(provider: provider, status: snapshot.statuses[provider.id], checking: model.checking.contains(provider.id))
                }
            }
            Button { wizard = AMWizardRequest(start: .choose) } label: {
                Label("Add provider", systemImage: "plus").foregroundStyle(Theme.clay)
            }
        } header: { Text("Providers") } footer: {
            if snapshot.providers.isEmpty { Text("No providers yet. Add one, and its models appear in the model picker for everyone on this server.") }
        }
    }
}

// MARK: - A row

struct AMProviderRow: View {
    let provider: AMProvider
    let status: AMProviderStatus?
    let checking: Bool

    private var health: AMHealth { AMHealth(enabled: provider.enabled, status: status) }

    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: provider.symbol, size: 38)
                .overlay(alignment: .bottomTrailing) {
                    Group {
                        if checking { ProgressView().controlSize(.mini) }
                        else { Circle().fill(health.color).frame(width: 9, height: 9) }
                    }
                    .padding(2.5).background(Theme.surface, in: Circle()).offset(x: 4, y: 4)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name).font(.body.weight(.medium)).foregroundStyle(provider.enabled ? Theme.ink : Theme.inkMuted).lineLimit(2)
                statusLine
                if provider.enabled, let error = status?.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).lineLimit(4) }
                else if provider.enabled, let warning = status?.warnings.first { Text(warning).font(.footnote).foregroundStyle(Color(hex: 0xB77800)).lineLimit(4) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.name), \(provider.typeLabel), \(health.label)")
    }

    private var statusLine: some View {
        var parts: [String] = [health.label]
        if provider.enabled, let status, status.checkedAt > 0, status.ok {
            parts.append(AMFormat.plural(status.modelCount, "model"))
            if let latency = status.latencyMs { parts.append(AMFormat.duration(ms: latency)) }
        }
        let first = Text(parts[0]).foregroundStyle(health == .connected ? Theme.success : health == .unreachable ? Theme.danger : Theme.inkMuted)
        let rest = Text(parts.count > 1 ? " · " + parts.dropFirst().joined(separator: " · ") : "").foregroundStyle(Theme.inkMuted)
        return Text("\(first)\(rest)").font(.footnote).lineLimit(2)
    }
}

// MARK: - A provider's page

struct AMProviderDetail: View {
    let store: AppStore
    let model: AMProvidersModel
    let providerID: String
    let onEdit: (AMProvider) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemove = false
    @State private var removing = false
    @State private var usage: JSON?

    private var snapshot: AMProvidersSnapshot? { model.resource.value }
    private var provider: AMProvider? { snapshot?.providers.first { $0.id == providerID } }

    var body: some View {
        Group {
            if let provider, let snapshot {
                SettingsPage(title: provider.name) { content(provider, snapshot) }
                    .refreshable { await model.resource.reload() }
            } else {
                SettingsPage(title: "Provider") { EmptyState(title: "This provider is gone", symbol: "server.rack", message: "It was removed, or the list changed. Go back and pull down to refresh.") }
            }
        }
        .task(id: providerID) { await loadUsage() }
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
        } message: { Text(provider.map(removeWarning) ?? "") }
    }

    @ViewBuilder private func content(_ provider: AMProvider, _ snapshot: AMProvidersSnapshot) -> some View {
        let status = snapshot.statuses[provider.id]
        let health = AMHealth(enabled: provider.enabled, status: status)
        Section {
            HStack(spacing: 14) {
                IconTile(symbol: provider.symbol, size: 46)
                VStack(alignment: .leading, spacing: 4) {
                    Text(provider.name).font(.system(.title3, design: .serif, weight: .medium))
                    HStack(spacing: 6) {
                        StatusBadge(text: provider.preset?.name ?? provider.typeLabel, tone: .neutral)
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
                    if let version = status.version { ValueRow(title: "Version", value: version) }
                    if let parallel = status.parallel, status.modelsAtOnce != nil {
                        ValueRow(title: "Queue", value: parallel == 1 ? "One request at a time" : "\(parallel) requests at once")
                    }
                } else if let error = status.error { AMOutcome(kind: .bad, text: error) }
                ForEach(status.warnings, id: \.self) { AMOutcome(kind: .warn, text: $0) }
                ValueRow(title: "Last checked", value: AMFormat.ago(status.checkedAt))
            } else if !provider.enabled {
                AMNote(text: "Turned off. Its models are not in the model picker.")
            } else {
                AMNote(text: "Not checked yet.")
            }
            ActionRow(title: "Test connection", symbol: "arrow.clockwise", busy: model.checking.contains(provider.id)) {
                Task { await model.check(provider.id) }
            }
            .disabled(!provider.enabled)
        } header: { Text("Connection") }

        Section {
            Toggle(isOn: Binding(get: { model.pendingEnabled[provider.id] ?? provider.enabled }, set: { on in Task { await model.setEnabled(provider, on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Use this provider").foregroundStyle(Theme.ink)
                    Text("Off: its models leave the model picker. Nothing is deleted.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }.tint(Theme.clay)
        }

        account(provider, snapshot)
        planUsage(provider)

        Section {
            ValueRow(title: "Address", value: AMFormat.address(provider.baseURL), mono: true, copyable: true)
            if let key = AMForm.keyHint(provider.apiKey, secrets: snapshot.secrets) { ValueRow(title: "API key", value: key, mono: true) }
            ValueRow(title: "Short name", value: provider.id, subtitle: "Models are referenced as \(provider.id)/model-name.", mono: true)
            if !provider.headers.isEmpty { ValueRow(title: "Custom headers", value: AMFormat.plural(provider.headers.count, "header")) }
            if let n = provider.parallelRequests { ValueRow(title: "Requests at once", value: "\(n)") }
            if let n = provider.modelsAtOnce { ValueRow(title: "Models at once", value: "\(n)") }
            if let gb = provider.vramGiB { ValueRow(title: "Memory budget", value: "\(Int((gb * 1_073_741_824 / 1e9).rounded())) GB") }
        } header: { Text("Details") }

        Section {
            if provider.editable { Button { onEdit(provider) } label: { Label("Edit", systemImage: "pencil").foregroundStyle(Theme.clay) } }
            else if provider.typeID == "chatgpt-chat" { AMNote(text: "ChatGPT Chat runs in a browser window of the desktop app. It can be turned off or removed here, but only the desktop app can sign it in.") }
            else { AMNote(text: "Signed in with your account, so there is nothing to edit. Remove it and add it again to sign in as someone else.") }
            ActionRow(title: "Remove provider", symbol: "trash", destructive: true, busy: removing) { confirmRemove = true }
        }

    }

    private func removeWarning(_ provider: AMProvider) -> String {
        switch provider.typeID {
        case "chatgpt": "You are signed out of ChatGPT and its models leave the model picker. Chats that used it stay in your history."
        case "copilot": "You are signed out of GitHub Copilot and its models leave the model picker. Chats that used it stay in your history."
        case "chatgpt-chat": "The private ChatGPT browser session is cleared and its model leaves the picker. Conversations stay in your history."
        default: "Its models leave the model picker and its stored API key is deleted. Chats that used it stay in your history."
        }
    }

    // MARK: Account and plan

    @ViewBuilder private func account(_ provider: AMProvider, _ snapshot: AMProvidersSnapshot) -> some View {
        if provider.typeID == "chatgpt", snapshot.chatgpt != .null {
            let status = snapshot.chatgpt
            Section {
                if let email = status["email"].stringOrNil { ValueRow(title: "Account", value: email) }
                if let plan = status["plan"].stringOrNil { ValueRow(title: "Plan", value: AMChatGPT.planLabel(plan)) }
                if !status["signedIn"].bool { AMOutcome(kind: .warn, text: status["error"].stringOrNil ?? "Not signed in. Remove the provider and add it again.") }
                ForEach(AMChatGPT.limits(status["limits"]), id: \.title) { limit in
                    ValueRow(title: limit.title, value: limit.value, subtitle: limit.resets)
                }
            } header: { Text("ChatGPT account") } footer: { Text("Your plan's own limits apply. Everyone who can use this provider uses your plan.") }
        } else if provider.typeID == "copilot", snapshot.copilot != .null {
            Section {
                if let login = snapshot.copilot["login"].stringOrNil { ValueRow(title: "GitHub account", value: login) }
                if !snapshot.copilot["signedIn"].bool { AMOutcome(kind: .warn, text: snapshot.copilot["error"].stringOrNil ?? "Not signed in. Remove the provider and add it again.") }
            } header: { Text("GitHub account") }
        }
    }

    @ViewBuilder private func planUsage(_ provider: AMProvider) -> some View {
        if provider.typeID == "mistral-vibe", let usage, usage != .null {
            Section {
                ValueRow(title: "Used this period", value: "\(Int(usage["usedPercent"].doubleOrNil ?? 0))%")
                if let resets = usage["resetsAt"].doubleOrNil { ValueRow(title: "Starts again", value: AMFormat.ago(resets).replacingOccurrences(of: "Never", with: "Unknown"), subtitle: Date(timeIntervalSince1970: resets / 1000).formatted(date: .abbreviated, time: .omitted)) }
                if let plan = usage["plan"].stringOrNil { ValueRow(title: "Plan", value: plan.capitalized) }
            } header: { Text("Your plan's allowance") } footer: {
                Text(usage["overage"].bool ? "Use past the allowance is charged to your Mistral account." : "Past the allowance, requests wait for the next period.")
            }
        }
    }

    private func loadUsage() async {
        guard provider?.typeID == "mistral-vibe", let id = provider?.id else { return }
        usage = await model.api.optional("providers.planUsage", ["id": .string(id)])
    }
}

// MARK: - ChatGPT plan wording

enum AMChatGPT {
    /// "prolite" as "Pro 100".
    static func planLabel(_ plan: String) -> String {
        let key = plan.lowercased()
        if key == "prolite" || key == "pro_lite" { return "Pro 100" }
        if key == "pro" { return "Pro 200" }
        if key == "promax" || key == "pro_max" { return "Pro 500" }
        for tier in ["100", "200", "500"] where key == "pro\(tier)" || key == "pro_\(tier)" || key == "pro-\(tier)" { return "Pro \(tier)" }
        return plan.prefix(1).uppercased() + plan.dropFirst()
    }

    struct Limit { let title: String; let value: String; let resets: String? }

    /// The plan's usage windows: "5 hour window: 12% used".
    static func limits(_ json: JSON) -> [Limit] {
        ["primary", "secondary"].compactMap { key in
            let window = json[key]
            guard window != .null, let used = window["usedPercent"].doubleOrNil else { return nil }
            let minutes = window["windowMinutes"].doubleOrNil
            let title: String
            switch minutes {
            case .some(let m) where m >= 10_000: title = "Weekly limit"
            case .some(let m) where m >= 60: title = "\(Int(m / 60))-hour limit"
            case .some(let m): title = "\(Int(m))-minute limit"
            case .none: title = key == "primary" ? "Short-term limit" : "Long-term limit"
            }
            let resets = window["resetsAt"].doubleOrNil.map { "Resets \(Date(timeIntervalSince1970: $0 > 1e12 ? $0 / 1000 : $0).formatted(.relative(presentation: .named)))" }
            return Limit(title: title, value: "\(Int(used.rounded()))% used", resets: resets)
        }
    }
}
