import SwiftUI

/// Connectors (MCP servers): tools from other services. `admin == true` is the server-wide page, shared by everyone on the
/// server; `admin == false` is the person's own connectors, plus (for an ordinary user) a read-only look at the admin's.
struct ConnectorsSettings: View {
    let store: AppStore
    var admin: Bool
    @State private var model: CustomizeConnectorsModel
    @State private var adding = false
    @State private var pushed: String?
    @State private var removing: CustomizeConnector?
    @State private var launched = false

    init(store: AppStore, admin: Bool) {
        self.store = store
        self.admin = admin
        _model = State(initialValue: CustomizeConnectorsModel(store: store, scope: admin ? .admin : .personal))
    }

    private var title: String { admin ? "Connectors" : "Your connectors" }

    var body: some View {
        SettingsPage(title: title) {
            CustomizeStateRows(phase: model.phase) { Task { await model.load() } }
            if model.phase == .ready { content }
        }
        .refreshable { await model.load() }
        .toolbar {
            if model.phase == .ready {
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel(admin ? "Add connector" : "Add your own connector")
                }
            }
        }
        .task { await model.load(); openLaunchRoute() }
        .task(id: model.watchToken) { await model.keepFresh() }
        .sheet(isPresented: $adding) { ConnectorAddFlow(model: model) { id in pushed = id } }
        .navigationDestination(item: $pushed) { id in ConnectorDetailView(model: model, id: id) }
        .confirmationDialog(removing.map { "Remove \($0.name)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { connector in
            Button("Remove", role: .destructive) { Task { _ = await model.remove(connector) } }
        } message: { connector in Text(CustomizeConnectorCopy.removal(connector, admin: admin)) }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if model.connectors.isEmpty {
            Section {
                EmptyState(
                    title: admin ? "No connectors yet" : "None of your own yet", symbol: "powerplug",
                    message: admin ? "Add one to give conversations tools from other services, like GitHub, Notion or your own server." : "Add one to use tools from a service only you connect to.",
                    actionTitle: admin ? "Add connector" : "Add your own") { adding = true }
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } footer: { Text(CustomizeConnectorCopy.listFooter(admin: admin)) }
        } else {
            Section {
                ForEach(model.connectors) { connector in
                    NavigationLink { ConnectorDetailView(model: model, id: connector.id) } label: { ConnectorRow(model: model, connector: connector) }
                        .swipeActions(edge: .leading) {
                            Button(connector.enabled ? "Turn off" : "Turn on") { Task { await model.setEnabled(connector, !connector.enabled) } }.tint(Theme.inkSecondary)
                        }
                        .swipeActions(edge: .trailing) { Button("Remove", role: .destructive) { removing = connector } }
                        .contextMenu {
                            Button(connector.enabled ? "Turn off" : "Turn on", systemImage: connector.enabled ? "poweroff" : "power") { Task { await model.setEnabled(connector, !connector.enabled) } }
                            Button("Remove", systemImage: "trash", role: .destructive) { removing = connector }
                        }
                }
            } footer: { Text(CustomizeConnectorCopy.listFooter(admin: admin)) }
        }
        if !admin && !store.isAdmin { shared }
    }

    /// What the admin set up, as an ordinary user sees it: their state and tools, nothing to change.
    @ViewBuilder private var shared: some View {
        if !model.sharedStatuses.isEmpty {
            Section {
                ForEach(model.sharedStatuses, id: \.name) { status in
                    NavigationLink { ConnectorSharedDetail(status: status) } label: {
                        CustomizeItemRow(symbol: "powerplug", tint: Theme.inkSecondary, title: status.name, subtitle: toolNames(status))
                            .accessibilityElement(children: .combine)
                    }
                }
            } header: { Text("Set up by your admin") } footer: { Text("Choose which of these a conversation uses under + › Connectors in the conversation.") }
        }
    }

    private func toolNames(_ status: CustomizeStatus) -> String {
        let presentation = CustomizeStatusPresentation.of(status: status)
        let tools = status.tools.map(\.name)
        return tools.isEmpty ? presentation.label : "\(presentation.label) · \(CustomizeText.plural(tools.count, "tool")): \(tools.prefix(3).joined(separator: ", "))\(tools.count > 3 ? "…" : "")"
    }

    // MARK: Debug routes for looking at pages

    private func openLaunchRoute() {
        #if DEBUG
        guard !launched, let route = CustomizeLaunch.route else { return }
        launched = true
        if route.first == "add" { adding = true }
        else if route.first == "connector", route.count > 1 { pushed = model.connectors.first { $0.name == route[1] }?.id }
        #endif
    }
}

/// One connector in the list: what it is, how it is doing and, if it failed, why in one line.
private struct ConnectorRow: View {
    let model: CustomizeConnectorsModel
    let connector: CustomizeConnector
    var body: some View {
        let status = model.status(for: connector)
        let presentation = model.presentation(connector)
        HStack(spacing: 12) {
            IconTile(symbol: CustomizePreset.symbol(for: connector.preset), tint: connector.enabled ? Theme.clay : Theme.inkMuted)
            VStack(alignment: .leading, spacing: 3) {
                Text(CustomizeText.breakable(connector.name)).font(.body).foregroundStyle(connector.enabled ? Theme.ink : Theme.inkSecondary).lineLimit(2)
                CustomizeStatusLine(presentation: presentation, extra: CustomizeStatusPresentation.toolSummary(connector, status))
                if let line = problem(status) { Text(line).font(.footnote).foregroundStyle(Theme.danger).lineLimit(2) }
            }
            Spacer(minLength: 8)
            StatusBadge(text: connector.type.label)
        }
        .contentShape(Rectangle())
    }

    private func problem(_ status: CustomizeStatus?) -> String? {
        if connector.clash { return "An admin's connector is also called \(connector.name). Rename yours." }
        guard connector.enabled, let status, status.state == .error, status.signIn == nil, let error = status.error else { return nil }
        return CustomizeErrors.connectorSummary(error)
    }
}

/// An admin's connector as an ordinary user sees it: its state and its tools.
struct ConnectorSharedDetail: View {
    let status: CustomizeStatus
    var body: some View {
        let presentation = CustomizeStatusPresentation.of(status: status)
        SettingsPage(title: status.name) {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text(status.name).font(.system(.title3, design: .serif, weight: .medium)).lineLimit(2)
                        StatusBadge(text: status.type.label)
                    }
                    CustomizeStatusLine(presentation: presentation, extra: status.protocolText)
                    if status.state == .error, status.signIn == nil, let error = status.error { Text(CustomizeErrors.connector(error)).font(.footnote).foregroundStyle(Theme.danger) }
                }.padding(.vertical, 4)
            } footer: { Text("An admin set this connector up for everyone on the server. Choose whether a conversation uses it under + › Connectors in the conversation.") }
            Section {
                if status.tools.isEmpty {
                    Text(presentation.label == "Ready" ? "This connector has no tools." : "Its tools show up once it is connected.").foregroundStyle(Theme.inkMuted)
                } else {
                    ForEach(status.tools) { tool in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(tool.name).font(.mono(.subheadline)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                                if tool.readOnly { StatusBadge(text: "Read-only") }
                            }
                            if !tool.description.isEmpty { Text(tool.description).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(4) }
                        }
                    }
                }
            } header: { Text("Tools") }
        }
    }
}

/// The words around connectors, in one place.
enum CustomizeConnectorCopy {
    static func listFooter(admin: Bool) -> String {
        admin
            ? "Everyone on this server shares these. A connector acts as the account that signed in or whose token was pasted, so give it only the access it needs."
            : "Only you use these, with your own keys, kept encrypted on the server. A program runs on your computer, in the Atelier desktop app signed in to this server. To import connectors from Claude Code, use the desktop app on the computer that has them."
    }

    static func removal(_ connector: CustomizeConnector, admin: Bool) -> String {
        if !admin { return "Its tools leave your conversations, and the server forgets its keys and sign-in." }
        return connector.oauth
            ? "Its tools leave every conversation, its tool permissions are removed and Atelier forgets its sign-in."
            : "Its tools leave every conversation and its tool permissions are removed. Its stored keys stay under Keys and secrets, where you can delete them once nothing uses them."
    }
}

#if DEBUG
/// `--customize connector/<name>/tool/<tool>` and the like: opens a page on launch, for looking at it and for tests.
enum CustomizeLaunch {
    static var route: [String]? { Launch.value("--customize").map { $0.split(separator: "/").map(String.init) } }
    static var state: String { Launch.value("--state") ?? "" }
}
#else
enum CustomizeLaunch {
    static var route: [String]? { nil }
    static var state: String { "" }
}
#endif
