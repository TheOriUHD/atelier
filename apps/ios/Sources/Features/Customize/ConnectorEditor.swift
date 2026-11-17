import SwiftUI

/// The sheet that adds a connector: a ready-made one or a custom one (admin), a custom one (your own), or an import from Claude Code.
struct ConnectorAddFlow: View {
    let model: CustomizeConnectorsModel
    /// Called with the new connector's id once it is saved, after the sheet closed.
    var onAdded: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var launched = false
    @State private var presetID: String?
    @State private var custom = false
    @State private var importing = false

    private func finish(_ id: String) { dismiss(); onAdded(id) }

    var body: some View {
        NavigationStack {
            Group {
                if model.admin { catalog } else { CustomizeConnectorEditor(model: model, existing: nil, onFinish: finish) }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDragIndicator(.visible)
    }

    private var catalog: some View {
        SettingsPage(title: "Add connector") {
            Section {
                ForEach(CustomizePreset.all) { preset in
                    let unavailable = preset.desktopOnly && !model.runsPrograms && preset.oauthURL == nil
                    NavigationLink { ConnectorPresetForm(model: model, preset: preset, onFinish: finish) } label: {
                        CustomizeItemRow(symbol: preset.symbol, title: preset.name, subtitle: unavailable ? "Only in the desktop app: it runs a program on your computer." : preset.description)
                    }
                    .disabled(unavailable).opacity(unavailable ? 0.6 : 1)
                }
            } header: { Text("Ready-made") } footer: { Text("A ready-made entry asks for a token, or lets you sign in to the service.") }
            Section {
                NavigationLink { CustomizeConnectorEditor(model: model, existing: nil, onFinish: finish) } label: {
                    CustomizeItemRow(symbol: "square.grid.2x2", title: "Custom", subtitle: "Any MCP server, by its URL or the command that starts it.")
                }
            } header: { Text("Anything else") }
            if model.runsPrograms {
                Section {
                    NavigationLink { ConnectorImportView(model: model, onFinish: { dismiss() }) } label: {
                        CustomizeItemRow(symbol: "square.and.arrow.down", title: "Import from Claude Code", subtitle: "The connectors Claude Code already has on this computer.")
                    }
                } header: { Text("From other tools") }
            }
        }
        .navigationDestination(item: $presetID) { id in
            if let preset = CustomizePreset.named(id) { ConnectorPresetForm(model: model, preset: preset, onFinish: finish) }
        }
        .navigationDestination(isPresented: $custom) { CustomizeConnectorEditor(model: model, existing: nil, onFinish: finish) }
        .navigationDestination(isPresented: $importing) { ConnectorImportView(model: model, onFinish: { dismiss() }) }
        .task {
            #if DEBUG
            guard !launched, let route = CustomizeLaunch.route, route.first == "add", route.count > 1 else { return }
            launched = true
            if route[1] == "custom" { custom = true } else if route[1] == "import" { importing = true } else { presetID = route[1] }
            #endif
        }
    }
}

// MARK: - A ready-made connector

/// A token, or signing in to the preset's hosted server.
struct ConnectorPresetForm: View {
    let model: CustomizeConnectorsModel
    let preset: CustomizePreset
    var onFinish: (String) -> Void
    @State private var name: String
    @State private var token = ""
    @State private var fields: [String: String] = [:]
    @State private var viaSignIn = false
    @State private var touched: Set<String> = []
    @State private var saving = false
    @State private var error: String?

    init(model: CustomizeConnectorsModel, preset: CustomizePreset, onFinish: @escaping (String) -> Void) {
        self.model = model; self.preset = preset; self.onFinish = onFinish
        _name = State(initialValue: CustomizePresetEntry.freeName(preset.id, taken: model.takenNames()))
    }

    private var tokenSetup: Bool { !preset.desktopOnly || model.runsPrograms }
    private var oauth: Bool { preset.oauthURL != nil && (viaSignIn || !tokenSetup) }
    private var nameError: String? { CustomizeConnectorForm.nameError(name, taken: model.takenNames()) }
    private var valueErrors: (token: String?, fields: [String: String]) { CustomizePresetEntry.errors(preset, token: token, fields: fields, oauth: oauth) }
    private var valid: Bool { nameError == nil && valueErrors.token == nil && valueErrors.fields.isEmpty }

    var body: some View {
        SettingsPage(title: "Add \(preset.name)") {
            Section {
                FieldRow(placeholder: preset.id, text: $name, mono: true)
            } header: { Text("Name") } footer: {
                CustomizeFooter(text: "Its tools appear to models as mcp__\(name.trimmingCharacters(in: .whitespaces).isEmpty ? "name" : name.trimmingCharacters(in: .whitespaces))__tool.", error: touched.contains("name") ? nameError : nil)
            }
            if preset.oauthURL != nil && tokenSetup {
                Section {
                    Picker("How to connect", selection: $viaSignIn) {
                        Text(preset.tokenLabel).tag(false)
                        Text("Sign in").tag(true)
                    }.pickerStyle(.segmented).labelsHidden()
                } header: { Text("How to connect") }
            }
            if oauth {
                Section {
                    Text("Once it is added, \(preset.name) opens in a sign-in sheet for you to sign in and allow access. Atelier keeps what it gets encrypted and uses it for everyone's conversations.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                }
            } else {
                Section {
                    FieldRow(placeholder: "Paste it here", text: $token, secure: true)
                    if let url = URL(string: preset.tokenURL) { Link(destination: url) { Label("Create one", systemImage: "arrow.up.right.square") }.foregroundStyle(Theme.clay) }
                } header: { Text(preset.tokenLabel) } footer: {
                    CustomizeFooter(text: [preset.tokenHelp, "Stored encrypted by Atelier, never in settings files.", preset.note].compactMap { $0 }.joined(separator: " "), error: touched.contains("token") ? valueErrors.token : nil)
                }
                ForEach(preset.fields, id: \.id) { field in
                    Section {
                        FieldRow(placeholder: field.placeholder, text: Binding(get: { fields[field.id] ?? "" }, set: { fields[field.id] = $0 }), keyboard: .URL, mono: true)
                    } header: { Text(field.label) } footer: { CustomizeFooter(error: touched.contains(field.id) ? valueErrors.fields[field.id] : nil) }
                }
            }
            CustomizeSubmitRow(title: oauth ? "Add and sign in" : "Add connector", busy: saving, enabled: valid, error: error) { Task { await save() } }
        }
        .onChange(of: name) { touched.insert("name") }
        .onChange(of: token) { touched.insert("token") }
        .onChange(of: fields) { old, new in for key in new.keys where old[key] != new[key] { touched.insert(key) } }
    }

    private func save() async {
        guard valid else { touched.formUnion(["name", "token"] + preset.fields.map(\.id)); return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let id = try await model.addPreset(preset, name: name, token: token, fields: fields, signIn: oauth)
            token = ""
            onFinish(id)
        } catch is CancellationError {
        } catch { self.error = CustomizeErrors.message(for: error) }
    }
}

// MARK: - A custom connector, new or edited

/// The custom form: an admin's connector (written to the settings) or a person's own (kept on the server, values hidden).
struct CustomizeConnectorEditor: View {
    let model: CustomizeConnectorsModel
    let existing: CustomizeConnector?
    var onFinish: ((String) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var form: CustomizeConnectorForm
    @State private var touched: Set<CustomizeConnectorForm.Field> = []
    @State private var saving = false
    @State private var error: String?

    init(model: CustomizeConnectorsModel, existing: CustomizeConnector?, onFinish: ((String) -> Void)? = nil) {
        self.model = model; self.existing = existing; self.onFinish = onFinish
        _form = State(initialValue: existing.map(CustomizeConnectorForm.from) ?? CustomizeConnectorForm())
    }

    private var personal: Bool { !model.admin }
    private var errors: [CustomizeConnectorForm.Field: String] { form.errors(taken: model.takenNames(except: existing?.name), personal: personal) }
    private var stdio: Bool { form.type == .stdio }
    private var types: [CustomizeTransport] { personal || model.runsPrograms ? CustomizeTransport.allCases : [.http, .sse] }
    private var noun: String { stdio ? "variable" : "header" }

    var body: some View {
        SettingsPage(title: existing.map { "Edit \($0.name)" } ?? (personal ? "Add your own" : "Custom connector")) {
            Section {
                FieldRow(placeholder: "my-service", text: $form.name, mono: true)
                    .disabled(existing != nil && !personal).opacity(existing != nil && !personal ? 0.6 : 1)
            } header: { Text("Name") } footer: {
                CustomizeFooter(text: "Its tools appear to models as mcp__\(form.name.trimmingCharacters(in: .whitespaces).isEmpty ? "name" : form.name.trimmingCharacters(in: .whitespaces))__tool.", error: touched.contains(.name) ? errors[.name] : nil)
            }
            Section {
                Picker("Connects over", selection: $form.type) { ForEach(types) { Text($0.choice).tag($0) } }.pickerStyle(.segmented).labelsHidden()
            } header: { Text("Connects over") } footer: { Text(typeHelp) }
            if stdio { programFields } else { webFields }
            pairsSection
            CustomizeSubmitRow(title: existing == nil ? "Add connector" : "Save", busy: saving, enabled: errors.isEmpty, error: error) { Task { await save() } }
        }
        .onChange(of: form) { old, new in
            if old.name != new.name { touched.insert(.name) }
            if old.url != new.url { touched.insert(.url) }
            if old.command != new.command { touched.insert(.command) }
            if old.pairs != new.pairs || old.type != new.type { touched.insert(.pairs) }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var typeHelp: String {
        if personal { return "HTTP is the current standard; SSE is the older streaming one. A program (stdio) runs on your computer, in the Atelier desktop app signed in to this server. An address on your computer or its network is reached through it too." }
        return model.runsPrograms
            ? "HTTP is the current standard; SSE is the older streaming one. A program (stdio) starts as a program on this computer."
            : "HTTP is the current standard; SSE is the older streaming one. Servers that run as a program (stdio) can only be added in the desktop app."
    }

    @ViewBuilder private var programFields: some View {
        Section {
            FieldRow(placeholder: "npx", text: $form.command, mono: true)
        } header: { Text("Command") } footer: { CustomizeFooter(text: "The program that starts the server.", error: touched.contains(.command) ? errors[.command] : nil) }
        Section {
            CustomizeTextBox(title: "Arguments", placeholder: "-y", text: $form.args, mono: true)
        } footer: { Text("One per line: for example -y on one line and @scope/mcp-server on the next.") }
    }

    @ViewBuilder private var webFields: some View {
        Section {
            FieldRow(placeholder: "https://example.com/mcp", text: $form.url, keyboard: .URL, mono: true)
        } header: { Text("URL") } footer: { CustomizeFooter(text: urlHelp, error: touched.contains(.url) ? errors[.url] : nil) }
        Section {
            ToggleRow(title: "Sign in with OAuth", subtitle: "For servers you sign in to instead of giving them a token. \(existing == nil ? "Signing in starts once it is added." : "Sign in on its page.")", isOn: $form.oauth)
        }
    }

    private var urlHelp: String {
        let host = URL(string: form.url.trimmingCharacters(in: .whitespaces))?.host?.lowercased() ?? ""
        let loopback = host == "localhost" || host.hasPrefix("127.") || host == "::1"
        if loopback && !personal { return "\(host) is the Atelier server itself: this connector runs there. One on your own computer is added in the desktop app, where \(host) means that computer." }
        return "The address of the MCP server, like https://example.com/mcp."
    }

    @ViewBuilder private var pairsSection: some View {
        Section {
            ForEach($form.pairs) { $pair in pairRow($pair) }
            ActionRow(title: "Add \(noun)", symbol: "plus") { form.pairs.append(CustomizePair(secret: personal ? true : nil)) }
        } header: {
            Text(stdio ? "Environment variables" : "Headers")
        } footer: {
            CustomizeFooter(text: pairsHelp, error: touched.contains(.pairs) ? errors[.pairs] : nil)
        }
    }

    private var pairsHelp: String {
        if personal { return "Kept encrypted on the server, for you only, and never shown again. Leave a value empty to keep the one saved before.\(stdio ? " ${VAR} is filled in from your computer's environment when it starts." : "")" }
        if form.pairs.contains(where: { $0.wantsSecret && !$0.isReference && !$0.value.isEmpty }) { return "Locked values are stored encrypted under Keys and secrets; the connector only refers to them." }
        return stdio ? "A value is plain text, a stored secret like ${secret:id}, or a variable of the server like ${NAME}." : "For example Authorization with the value Bearer ${secret:id}. A value is plain text or a stored secret."
    }

    private func pairRow(_ pair: Binding<CustomizePair>) -> some View {
        let value = pair.wrappedValue
        let index = (form.pairs.firstIndex { $0.id == value.id } ?? 0) + 1
        let hidden = personal || (value.wantsSecret && !value.isReference)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField(stdio ? "NAME" : "Name, like Authorization", text: pair.name)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().font(.mono(.body)).disabled(value.saved)
                Button { form.pairs.removeAll { $0.id == value.id } } label: { Image(systemName: "minus.circle.fill").foregroundStyle(Theme.inkMuted) }
                    .buttonStyle(.borderless).accessibilityLabel("Remove \(noun) \(index)")
            }
            Divider().overlay(Theme.hairline)
            Group {
                if hidden { SecureField(value.saved ? "Unchanged" : "Value", text: pair.value) }
                else { TextField(stdio ? "Value, or ${NAME}" : "Value, or ${secret:id}", text: pair.value) }
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
            if !personal {
                Toggle(isOn: Binding(get: { pair.wrappedValue.wantsSecret }, set: { pair.wrappedValue.secret = $0 })) {
                    Text("Keep as a secret").font(.subheadline)
                }.disabled(value.isReference).tint(Theme.clay)
            }
        }
        .padding(.vertical, 2)
    }

    private func save() async {
        guard errors.isEmpty else { touched.formUnion([.name, .url, .command, .pairs]); return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let id = try await model.save(form, existing: existing)
            for i in form.pairs.indices { form.pairs[i].value = "" }
            if let onFinish { onFinish(id) } else { dismiss() }
        } catch is CancellationError {
        } catch { self.error = CustomizeErrors.message(for: error) }
    }
}

// MARK: - Import from Claude Code

/// The connectors Claude Code already has on the computer behind this server (a desktop app's own backend), chosen one by one.
struct ConnectorImportView: View {
    let model: CustomizeConnectorsModel
    var onFinish: () -> Void
    @State private var phase: CustomizePhase = .loading
    @State private var entries: [CustomizeImportEntry] = []
    @State private var skipped: Set<String> = []
    @State private var importing = false
    @State private var error: String?

    private var taken: Set<String> { model.takenNames() }
    private var chosen: [CustomizeImportEntry] { entries.filter { !taken.contains($0.name) && !skipped.contains($0.name) } }

    var body: some View {
        SettingsPage(title: "Import from Claude Code") {
            CustomizeStateRows(phase: phase) { Task { await load() } }
            if phase == .ready {
                if entries.isEmpty {
                    Section { EmptyState(title: "Nothing to import", symbol: "square.and.arrow.down", message: "No Claude Code connectors were found on this computer.").listRowBackground(Color.clear).listRowSeparator(.hidden) }
                } else {
                    Section {
                        ForEach(entries) { entry in
                            let added = taken.contains(entry.name)
                            Toggle(isOn: Binding(get: { !added && !skipped.contains(entry.name) }, set: { on in if on { skipped.remove(entry.name) } else { skipped.insert(entry.name) } })) {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 8) { Text(entry.name).foregroundStyle(Theme.ink).lineLimit(1); StatusBadge(text: entry.config.type.label) }
                                    Text("From \(entry.source)").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                                    Text(entry.config.target).font(.mono(.caption)).foregroundStyle(Theme.inkSecondary).lineLimit(3).truncationMode(.middle)
                                    if added { Text("Already added").font(.footnote).foregroundStyle(Theme.inkMuted) }
                                    else if !entry.secretPaths.isEmpty { Text("\(CustomizeText.plural(entry.secretPaths.count, "credential")) will move to Keys and secrets").font(.footnote).foregroundStyle(Theme.inkMuted) }
                                }
                            }.tint(Theme.clay).disabled(added)
                        }
                    } footer: { Text("Credentials written into these settings move into the secret store. HTTP, SSE and program connectors are imported; other kinds have no counterpart here.") }
                    CustomizeSubmitRow(title: chosen.count > 1 ? "Import \(chosen.count) connectors" : "Import", busy: importing, enabled: !chosen.isEmpty, error: error) { Task { await run() } }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { entries = try await model.importable(); phase = .ready }
        catch is CancellationError {}
        catch { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
    }

    private func run() async {
        importing = true; error = nil
        defer { importing = false }
        do { try await model.runImport(chosen); onFinish() }
        catch is CancellationError {}
        catch { self.error = CustomizeErrors.message(for: error) }
    }
}
