import SwiftUI

// MARK: - Model

/// Installed plugins, switching them on and off, and installing more from a marketplace (a GitHub repository).
@MainActor @Observable final class CustomizePluginsModel {
    struct Listing: Equatable, Sendable { let name: String; let plugins: [CustomizeMarketPlugin] }

    let store: AppStore
    var phase: CustomizePhase = .loading
    var plugins: [CustomizePlugin] = []
    /// Marketplaces plugins were installed from before, as `owner/repo`.
    var known: [String] = []
    var installing: String?

    init(store: AppStore) { self.store = store }

    var admin: Bool { store.isAdmin }

    private func call(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        do { return try await store.rpc.call(method, params) } catch { throw CustomizeErrors.translated(error) }
    }

    func load() async {
        if phase != .ready { phase = .loading }
        do {
            plugins = try await call("plugins.list").array.map(CustomizePlugin.init)
            if admin, let settings = try? await call("settings.get") { known = CustomizeMarketplace.known(from: settings) }
            phase = .ready
        } catch is CancellationError {
        } catch {
            if phase == .ready { store.error = CustomizeErrors.message(for: error) }
            else { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
        }
    }

    func plugin(_ id: String) -> CustomizePlugin? { plugins.first { $0.id == id } }

    /// Whether this person may switch the plugin: an admin switches the server's, anyone their own computer's.
    func canSwitch(_ plugin: CustomizePlugin) -> Bool { admin || plugin.own }

    func setEnabled(_ plugin: CustomizePlugin, _ on: Bool) async {
        if let i = plugins.firstIndex(where: { $0.id == plugin.id }) { plugins[i].enabled = on }
        let ok = await store.attempt { [self] in
            if plugin.own { _ = try await call("prefs.set", ["path": ["plugins", "enabled", .string(plugin.id)], "value": .bool(on)]) }
            else { _ = try await call("plugins.setEnabled", ["id": .string(plugin.id), "enabled": .bool(on)]) }
        }
        if !ok { await load() }
    }

    func uninstall(_ plugin: CustomizePlugin) async -> Bool {
        let ok = await store.attempt { [self] in _ = try await call("plugins.uninstall", ["id": .string(plugin.id)]) }
        if ok { store.notify("Uninstalled \(plugin.name)") }
        await load()
        return ok
    }

    func browse(_ repo: String) async throws -> Listing {
        let json = try await call("plugins.browse", ["repo": .string(repo.trimmingCharacters(in: .whitespaces))])
        return Listing(name: json["name"].string, plugins: json["plugins"].array.map(CustomizeMarketPlugin.init))
    }

    @discardableResult
    func install(_ plugin: CustomizeMarketPlugin, from repo: String) async -> Bool {
        installing = plugin.name
        defer { installing = nil }
        let ok = await store.attempt { [self] in _ = try await call("plugins.install", ["repo": .string(repo.trimmingCharacters(in: .whitespaces)), "plugin": .string(plugin.name)]) }
        if ok { store.notify("Installed \(plugin.name)") }
        await load()
        return ok
    }
}

// MARK: - Plugins

/// Plugins: bundles of skills, commands and agents. An admin installs them for everyone; everyone else sees what is installed.
struct PluginsSettings: View {
    let store: AppStore
    @State private var model: CustomizePluginsModel
    @State private var repo = ""
    @State private var browsing: String?
    @State private var opened: String?
    @State private var launched = false

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: CustomizePluginsModel(store: store))
    }

    var body: some View {
        SettingsPage(title: "Plugins") {
            CustomizeStateRows(phase: model.phase) { Task { await model.load() } }
            if model.phase == .ready { content }
        }
        .refreshable { await model.load() }
        .task { await model.load(); openLaunchRoute() }
        .navigationDestination(item: $browsing) { repo in PluginMarketplaceView(model: model, repo: repo) }
        .navigationDestination(item: $opened) { id in PluginDetailView(model: model, id: id) }
    }

    @ViewBuilder private var content: some View {
        Section {
            Text(model.admin
                 ? "Bundles of skills, commands and agents. Turning one off takes what it brings out of every conversation. Plugins installed with Claude Code can only be turned on or off here."
                 : "Bundles of skills, commands and agents that an admin installed for everyone.")
                .font(.footnote).foregroundStyle(Theme.inkMuted)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
        }
        if model.plugins.isEmpty {
            Section {
                EmptyState(title: "No plugins yet", symbol: "puzzlepiece.extension", message: model.admin ? "Add one from a marketplace below." : "An admin can add some for everyone.")
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        } else {
            Section {
                ForEach(model.plugins) { plugin in
                    NavigationLink { PluginDetailView(model: model, id: plugin.id) } label: { PluginRow(plugin: plugin) }
                        .swipeActions(edge: .leading) {
                            if model.canSwitch(plugin) { Button(plugin.enabled ? "Turn off" : "Turn on") { Task { await model.setEnabled(plugin, !plugin.enabled) } }.tint(Theme.inkSecondary) }
                        }
                }
            } header: { Text("Installed") }
        }
        if model.admin { marketplace }
    }

    private var marketplace: some View {
        Group {
            Section {
                FieldRow(placeholder: "owner/repo", text: $repo, keyboard: .URL, mono: true)
                ForEach(model.known, id: \.self) { known in
                    NavigationLink { PluginMarketplaceView(model: model, repo: known) } label: { NavRow(symbol: "clock.arrow.circlepath", title: known, subtitle: "Added before") }
                }
            } header: { Text("Add from a marketplace") } footer: {
                Text("A GitHub repository with a .claude-plugin/marketplace.json, as Claude Code uses: owner/repo or a github.com address.")
            }
            CustomizeSubmitRow(title: "Browse", enabled: CustomizeMarketplace.looksValid(repo)) { browsing = repo.trimmingCharacters(in: .whitespaces) }
        }
    }

    private func openLaunchRoute() {
        #if DEBUG
        guard !launched, let route = CustomizeLaunch.route else { return }
        launched = true
        if route.first == "marketplace" { browsing = route.dropFirst().joined(separator: "/") }
        if route.first == "plugin", route.count > 1 { opened = model.plugins.first { $0.name == route[1] }?.id }
        #endif
    }
}

private struct PluginRow: View {
    let plugin: CustomizePlugin
    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: "puzzlepiece.extension", tint: plugin.enabled ? Theme.clay : Theme.inkMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin.name).font(.body).foregroundStyle(plugin.enabled ? Theme.ink : Theme.inkSecondary).lineLimit(1).truncationMode(.middle)
                let line = [plugin.version, plugin.description].filter { !$0.isEmpty }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
                Text(plugin.isEmpty ? "No skills, commands or agents" : plugin.contents).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            if !plugin.enabled { StatusBadge(text: "Off") }
        }
        .contentShape(Rectangle())
    }
}

/// One installed plugin: what it brings, and the switch and uninstall that this person may use.
struct PluginDetailView: View {
    let model: CustomizePluginsModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        if let plugin = model.plugin(id) {
            SettingsPage(title: plugin.name) {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(plugin.name).font(.system(.title3, design: .serif, weight: .medium)).lineLimit(3).truncationMode(.middle)
                        HStack(spacing: 6) {
                            if !plugin.version.isEmpty { StatusBadge(text: plugin.version) }
                            if plugin.fromClaudeCode { StatusBadge(text: "Claude Code") }
                            if let device = plugin.device { StatusBadge(text: "From \(device)") }
                        }
                        if !plugin.description.isEmpty { CustomizeProse(text: plugin.description) }
                    }.padding(.vertical, 4)
                }
                if model.canSwitch(plugin) {
                    Section {
                        ToggleRow(title: "Use this plugin", subtitle: plugin.own ? "Only for you, on your computer." : "Off takes what it brings out of every conversation, for everyone.",
                                  isOn: Binding(get: { plugin.enabled }, set: { value in Task { await model.setEnabled(plugin, value) } }))
                    }
                } else if !plugin.enabled {
                    Section { Label("An admin turned it off", systemImage: "poweroff").foregroundStyle(Theme.inkSecondary) }
                }
                contents(plugin.skills, title: "Skills", symbol: "text.book.closed", footer: "The model loads a skill when a task matches; you can also type /name.")
                contents(plugin.commands, title: "Commands", symbol: "slash.circle", footer: "Start one by typing / at the start of a message.")
                contents(plugin.agents, title: "Agents", symbol: "person.crop.square", footer: "Helpers the model can hand work to.")
                if plugin.isEmpty { Section { Text("This plugin brings no skills, commands or agents.").foregroundStyle(Theme.inkMuted) } }
                if model.admin && plugin.canUninstall {
                    Section {
                        ActionRow(title: "Uninstall plugin", symbol: "trash", destructive: true) { confirming = true }
                    } footer: { Text("Its skills, commands and agents leave every conversation, and its files are deleted. You can install it again from its marketplace.") }
                } else if plugin.fromClaudeCode {
                    Section {
                        ValueRow(title: "Installed by", value: "Claude Code")
                    } footer: { Text("Claude Code installed it, so it is removed there. Here it can only be turned on or off.") }
                }
            }
            .confirmationDialog("Uninstall \(plugin.name)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Uninstall", role: .destructive) { Task { if await model.uninstall(plugin) { dismiss() } } }
            } message: { Text("Its skills, commands and agents leave every conversation, and its files are deleted.") }
        } else {
            SettingsPage(title: "Plugin") { EmptyState(title: "This plugin is gone", symbol: "puzzlepiece.extension", message: "It was uninstalled.") }
        }
    }

    @ViewBuilder private func contents(_ names: [String], title: String, symbol: String, footer: String) -> some View {
        if !names.isEmpty {
            Section {
                ForEach(names, id: \.self) { name in
                    Label { Text(name).font(.mono(.subheadline)).foregroundStyle(Theme.ink).lineLimit(2).truncationMode(.middle) } icon: { Image(systemName: symbol).foregroundStyle(Theme.inkMuted) }
                }
            } header: { Text("\(title) (\(names.count))") } footer: { Text(footer) }
        }
    }
}

/// A marketplace's plugins, searchable, with Install on each. The ones this server can't install are listed apart, with why.
struct PluginMarketplaceView: View {
    let model: CustomizePluginsModel
    let repo: String
    @State private var phase: CustomizePhase = .loading
    @State private var listing: CustomizePluginsModel.Listing?
    @State private var query = ""

    private var matches: [CustomizeMarketPlugin] { (listing?.plugins ?? []).filter { CustomizeText.matches(query, in: [$0.name, $0.description]) } }

    var body: some View {
        SettingsPage(title: listing?.name ?? repo) {
            CustomizeStateRows(phase: phase) { Task { await load() } }
            if phase == .ready, let listing {
                let available = matches.filter { $0.unsupported == nil }
                let blocked = matches.filter { $0.unsupported != nil }
                if matches.isEmpty {
                    Section { EmptyState(title: query.isEmpty ? "No plugins here" : "Nothing matches", symbol: "magnifyingglass", message: query.isEmpty ? "This marketplace lists no plugins." : "Try another word.").listRowBackground(Color.clear).listRowSeparator(.hidden) }
                }
                if !available.isEmpty {
                    Section {
                        ForEach(available) { plugin in MarketRow(model: model, repo: repo, marketplace: listing.name, plugin: plugin) }
                    } header: { Text("\(CustomizeText.plural(available.count, "plugin")) in \(listing.name)") } footer: {
                        Text("A plugin can bring commands and hooks that run on this server. Install only ones you trust.")
                    }
                }
                if !blocked.isEmpty {
                    Section {
                        ForEach(blocked) { plugin in MarketRow(model: model, repo: repo, marketplace: listing.name, plugin: plugin) }
                    } header: { Text("Not available here (\(blocked.count))") }
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search plugins")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        if listing == nil { phase = .loading }
        do { listing = try await model.browse(repo); phase = .ready }
        catch is CancellationError {}
        catch { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
    }
}

private struct MarketRow: View {
    let model: CustomizePluginsModel
    let repo: String
    let marketplace: String
    let plugin: CustomizeMarketPlugin
    var body: some View {
        let installed = CustomizeMarketplace.isInstalled(plugin, marketplace: marketplace, in: model.plugins)
        HStack(spacing: 12) {
            IconTile(symbol: "puzzlepiece.extension", tint: plugin.unsupported == nil ? Theme.clay : Theme.inkMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin.name).font(.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                let line = [plugin.version, plugin.description].filter { !$0.isEmpty }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(3) }
                if let reason = plugin.unsupported { Text(reason).font(.footnote).foregroundStyle(Theme.inkSecondary) }
            }
            Spacer(minLength: 8)
            if installed { StatusBadge(text: "Installed", tone: .good) }
            else if plugin.unsupported == nil {
                if model.installing == plugin.name { ProgressView() }
                else {
                    Button("Install") { Task { await model.install(plugin, from: repo) } }
                        .buttonStyle(.bordered).tint(Theme.clay).controlSize(.small)
                        .disabled(model.installing != nil)
                        .accessibilityLabel("Install \(plugin.name)")
                }
            }
        }
    }
}
