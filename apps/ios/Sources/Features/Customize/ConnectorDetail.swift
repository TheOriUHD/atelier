import SwiftUI

/// One connector: how it is doing, the sign-in, its tools, its log, and changing or removing it.
struct ConnectorDetailView: View {
    let model: CustomizeConnectorsModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var removing = false
    @State private var signingOut = false
    @State private var editing = false
    @State private var knownTools: [CustomizeTool] = []
    @State private var openedTool: String?
    @State private var openedLogs = false
    @State private var launched = false

    var body: some View {
        if let connector = model.connector(id) { page(connector) } else { SettingsPage(title: "Connector") { EmptyState(title: "This connector is gone", symbol: "powerplug", message: "It was removed.") } }
    }

    private func page(_ connector: CustomizeConnector) -> some View {
        let status = model.status(for: connector)
        let presentation = model.presentation(connector)
        let needsSignIn = status?.signIn == .needed && connector.enabled
        let waiting = status?.signIn == .waiting && connector.enabled
        let tools = (status?.tools.isEmpty == false ? status?.tools : nil) ?? (presentation.busy ? knownTools : [])
        let busy = model.working.contains(connector.id)
        return SettingsPage(title: connector.name) {
            header(connector, status, presentation)
            problem(connector, status, presentation)
            if needsSignIn || waiting { signIn(connector, status, waiting: waiting, busy: busy) }
            Section {
                ToggleRow(
                    title: "Use this connector",
                    subtitle: connector.personal ? "Off keeps its tools out of all your conversations." : "Off keeps its tools out of every conversation, for everyone on this server.",
                    isOn: Binding(get: { connector.enabled }, set: { value in Task { await model.setEnabled(connector, value) } }))
                if !needsSignIn && !waiting {
                    ActionRow(title: "Test connection", symbol: "bolt.horizontal", busy: busy) { Task { _ = await model.test(connector) } }
                        .disabled(!connector.enabled)
                }
            } footer: {
                if !needsSignIn && !waiting { Text(connector.enabled ? "Test connects it again now and shows what it offers." : "Turn it on to test it.") }
            }
            toolsSection(connector, tools: tools, status: status, presentation: presentation)
            Section {
                NavigationLink { ConnectorLogsView(model: model, connector: connector) } label: { NavRow(symbol: "text.alignleft", title: "Log", subtitle: "What it printed, and its connections and failures") }
                NavigationLink { CustomizeConnectorEditor(model: model, existing: connector) } label: { NavRow(symbol: "pencil", title: "Edit") }
            }
            Section {
                if !connector.personal, connector.oauth, connector.enabled, status?.signIn == nil {
                    ActionRow(title: "Sign out", symbol: "rectangle.portrait.and.arrow.right", busy: busy) { signingOut = true }
                }
                ActionRow(title: "Remove connector", symbol: "trash", destructive: true) { removing = true }
            } footer: { Text(CustomizeConnectorCopy.removal(connector, admin: !connector.personal)) }
        }
        .task(id: tools.map(\.name)) { if !tools.isEmpty, status?.tools.isEmpty == false { knownTools = tools } }
        .task { openLaunchRoute(connector) }
        .navigationDestination(item: $openedTool) { name in ConnectorToolView(model: model, connectorID: id, toolName: name) }
        .navigationDestination(isPresented: $openedLogs) { ConnectorLogsView(model: model, connector: connector) }
        .navigationDestination(isPresented: $editing) { CustomizeConnectorEditor(model: model, existing: connector) }
        .confirmationDialog("Remove \(connector.name)?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { if await model.remove(connector) { dismiss() } } }
        } message: { Text(CustomizeConnectorCopy.removal(connector, admin: !connector.personal)) }
        .confirmationDialog("Sign out of \(connector.name)?", isPresented: $signingOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut(connector) } }
        } message: { Text("Atelier forgets what the sign-in gave it. Its tools stop working in every conversation until an admin signs in again.") }
    }

    // MARK: Sections

    private func header(_ connector: CustomizeConnector, _ status: CustomizeStatus?, _ presentation: CustomizeStatusPresentation) -> some View {
        let preset = CustomizePreset.named(connector.preset)
        return Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    IconTile(symbol: CustomizePreset.symbol(for: connector.preset), tint: connector.enabled ? Theme.clay : Theme.inkMuted, size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(CustomizeText.breakable(connector.name)).font(.system(.title3, design: .serif, weight: .medium)).lineLimit(3).textSelection(.enabled)
                        HStack(spacing: 6) {
                            StatusBadge(text: connector.type.label)
                            if connector.oauth { StatusBadge(text: "Signs in") }
                            if connector.personal { StatusBadge(text: "Yours", tone: .clay) }
                        }
                    }
                }
                if let preset { Text(preset.description).font(.subheadline).foregroundStyle(Theme.inkSecondary) }
                Text(connector.target).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).lineLimit(3).truncationMode(.middle).textSelection(.enabled)
                CustomizeStatusLine(presentation: presentation, extra: [CustomizeStatusPresentation.toolSummary(connector, status), status?.protocolText].compactMap { $0 }.joined(separator: " · "))
            }.padding(.vertical, 4)
        }
    }

    @ViewBuilder private func problem(_ connector: CustomizeConnector, _ status: CustomizeStatus?, _ presentation: CustomizeStatusPresentation) -> some View {
        if connector.clash {
            Section { Label("An admin's connector is also called \(connector.name), so theirs is used. Rename yours to use it.", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Theme.danger) }
        } else if connector.enabled, let status, status.state == .error, status.signIn == nil, let raw = status.error {
            let friendly = CustomizeErrors.connector(raw)
            Section {
                Label(friendly, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Theme.danger).textSelection(.enabled)
                if friendly != raw {
                    DisclosureGroup("Details") { Text(raw).font(.mono(.footnote)).foregroundStyle(Theme.inkSecondary).textSelection(.enabled) }.font(.subheadline)
                }
            } footer: { Text("Atelier tries again by itself. Test connection tries right now.") }
        }
    }

    private func signIn(_ connector: CustomizeConnector, _ status: CustomizeStatus?, waiting: Bool, busy: Bool) -> some View {
        Section {
            if waiting {
                HStack(spacing: 10) { ProgressView(); Text("Waiting for you to sign in…").foregroundStyle(Theme.ink) }
                ActionRow(title: "Open it again", symbol: "arrow.up.forward.app", busy: busy) { Task { await model.signIn(connector) } }
                if !connector.personal { ActionRow(title: "Cancel sign-in", symbol: "xmark", tint: Theme.inkSecondary) { Task { await model.cancelSignIn(connector) } } }
            } else {
                Button("Sign in") { Task { await model.signIn(connector) } }
                    .buttonStyle(ClayButtonStyle(busy: busy)).disabled(busy)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0)).listRowBackground(Color.clear)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let issue = model.signInIssue[connector.id] { Text(CustomizeErrors.connector(issue)).foregroundStyle(Theme.danger) }
                Text(waiting
                    ? "Finish in the sign-in sheet. It closes by itself once you are signed in."
                    : connector.personal ? "Sign in to connect it. Only you use this sign-in." : "Sign in to connect it. Every conversation then uses this sign-in.")
            }
        }
    }

    @ViewBuilder private func toolsSection(_ connector: CustomizeConnector, tools: [CustomizeTool], status: CustomizeStatus?, presentation: CustomizeStatusPresentation) -> some View {
        Section {
            if tools.isEmpty {
                Text(emptyTools(connector, status, presentation)).font(.subheadline).foregroundStyle(Theme.inkMuted)
            } else {
                ForEach(tools) { tool in
                    NavigationLink { ConnectorToolView(model: model, connectorID: connector.id, toolName: tool.name) } label: {
                        let off = connector.disabledTools.contains(tool.name)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(tool.name).font(.mono(.subheadline)).foregroundStyle(off ? Theme.inkMuted : Theme.ink).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 6)
                                Text(toolValue(connector, tool, off: off)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
                            }
                            if !tool.description.isEmpty { Text(tool.description).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
                        }
                        .opacity(off ? 0.7 : 1)
                    }
                }
            }
        } header: {
            Text("Tools")
        } footer: {
            if !tools.isEmpty { Text(connector.personal ? "Switch a tool off to keep it from models." : "Switch a tool off to keep it from models. Tools ask before they run unless you always allow or block them.") }
        }
    }

    private func toolValue(_ connector: CustomizeConnector, _ tool: CustomizeTool, off: Bool) -> String {
        if off { return "Off" }
        return connector.personal ? "" : model.policy(connector, tool: tool.name).title
    }

    private func emptyTools(_ connector: CustomizeConnector, _ status: CustomizeStatus?, _ presentation: CustomizeStatusPresentation) -> String {
        if !connector.enabled { return "Switch the connector on to see its tools." }
        if status?.signIn != nil { return "Its tools show up once it is signed in." }
        if presentation.busy { return "Connecting…" }
        if status?.state == .error { return "Its tools show up once it connects." }
        return "This server has no tools."
    }

    private func openLaunchRoute(_ connector: CustomizeConnector) {
        #if DEBUG
        guard !launched, let route = CustomizeLaunch.route, route.count > 2, route[0] == "connector", route[1] == connector.name else { return }
        launched = true
        switch route[2] {
        case "tool": if route.count > 3 { openedTool = route[3] }
        case "logs": openedLogs = true
        case "edit": editing = true
        default: break
        }
        #endif
    }
}

/// One tool of a connector: what it does, whether models may use it, and when it may run.
struct ConnectorToolView: View {
    let model: CustomizeConnectorsModel
    let connectorID: String
    let toolName: String

    var body: some View {
        if let connector = model.connector(connectorID) {
            let tool = model.status(for: connector)?.tools.first { $0.name == toolName } ?? CustomizeTool(name: toolName)
            let enabled = !connector.disabledTools.contains(toolName)
            SettingsPage(title: "Tool") {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(toolName).font(.mono(.headline)).foregroundStyle(Theme.ink).textSelection(.enabled)
                        if tool.readOnly { StatusBadge(text: "Read-only", tone: .good) }
                        if tool.description.isEmpty { Text("This tool has no description.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                        else { CustomizeProse(text: tool.description) }
                    }.padding(.vertical, 4)
                } footer: {
                    if tool.readOnly { Text("The server says this tool doesn't change anything. Atelier never relies on that when it decides what may run.") }
                }
                Section {
                    ToggleRow(title: "Use this tool", subtitle: "Off keeps it from models in every conversation.",
                              isOn: Binding(get: { enabled }, set: { value in Task { await model.setTool(connector, tool: toolName, enabled: value) } }))
                }
                if !connector.personal {
                    Section {
                        ForEach(CustomizePolicy.allCases) { policy in
                            let selected = model.policy(connector, tool: toolName) == policy
                            Button { Task { await model.setPolicy(connector, tool: toolName, policy) } } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(policy.title).foregroundStyle(Theme.ink)
                                        Text(policy.detail).font(.footnote).foregroundStyle(Theme.inkMuted)
                                    }
                                    Spacer(minLength: 8)
                                    if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.clay) }
                                }.contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!enabled)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    } header: { Text("When it runs") } footer: { Text(enabled ? "A connector's rules apply in every mode, in chat as well as in code." : "Turn the tool on to choose when it runs.") }
                }
            }
        } else {
            SettingsPage(title: "Tool") { EmptyState(title: "This connector is gone", symbol: "powerplug") }
        }
    }
}

/// A connector's recent log lines (its own output, connections, failures), with the credentials already masked by the server.
struct ConnectorLogsView: View {
    let model: CustomizeConnectorsModel
    let connector: CustomizeConnector
    @State private var phase: CustomizePhase = .loading
    @State private var lines: [String] = []

    var body: some View {
        SettingsPage(title: "Log") {
            CustomizeStateRows(phase: phase) { Task { await load() } }
            if phase == .ready {
                if lines.isEmpty {
                    Section { EmptyState(title: "Nothing logged yet", symbol: "text.alignleft", message: "Its output, connections and failures show up here.").listRowBackground(Color.clear).listRowSeparator(.hidden) }
                } else {
                    Section {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            let parts = CustomizeText.logLine(line)
                            VStack(alignment: .leading, spacing: 2) {
                                if let time = parts.time { Text(time).font(.mono(.caption2)).foregroundStyle(Theme.inkMuted) }
                                Text(parts.text).font(.mono(.caption)).foregroundStyle(Theme.ink).textSelection(.enabled)
                            }.padding(.vertical, 2)
                        }
                    } header: { Text(connector.name) } footer: { Text("The last lines it wrote. Keys and tokens are hidden.") }
                }
            }
        }
        .refreshable { await load() }
        .toolbar {
            if phase == .ready && !lines.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button { UIPasteboard.general.string = lines.joined(separator: "\n"); model.store.notify("Copied") } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy the log")
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { lines = try await model.logs(connector); phase = .ready }
        catch is CancellationError {}
        catch { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
    }
}
