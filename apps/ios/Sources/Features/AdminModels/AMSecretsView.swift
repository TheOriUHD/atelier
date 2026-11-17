import SwiftUI

// Settings › Admin › Keys and secrets: the keys the server keeps for providers, web search and connectors.
// A value is typed in once and never shown again: the server answers with the last four characters only.

struct AMSecretsSnapshot {
    var secrets: [AMSecret]
    var providerNames: [String: String]
}

@MainActor @Observable final class AMSecretsModel {
    let store: AppStore
    let api: AMAPI
    let resource: Resource<AMSecretsSnapshot>

    init(store: AppStore) {
        self.store = store
        let api = AMAPI(store: store)
        self.api = api
        resource = Resource {
            async let secrets = api.call("secrets.list")
            async let settings = api.call("settings.get")
            let effective = try await settings["effective"]
            var names: [String: String] = [:]
            for provider in effective["providers"].array + effective["imageProviders"].array { names[provider["id"].string] = provider["name"].string }
            return AMSecretsSnapshot(secrets: try await secrets.array.map(AMSecret.init), providerNames: names)
        }
    }

    /// The id for a new secret: its label as a slug, made unique among the ones that exist.
    static func newID(label: String, taken: Set<String>) -> String {
        let base = String(AMForm.slugify(label).prefix(64))
        return AMForm.uniqueID(base.isEmpty ? "secret" : base, taken: taken)
    }

    /// Stores a value (new, or a replacement). The value is sent once and is not kept here.
    func save(id: String, label: String, kind: String, value: String) async throws {
        _ = try await api.call("secrets.set", ["id": .string(id), "label": .string(label), "kind": .string(kind), "value": .string(value)])
        await resource.reload()
    }

    func delete(_ id: String) async throws {
        _ = try await api.call("secrets.delete", ["id": .string(id)])
        await resource.reload()
    }
}

struct SecretsSettings: View {
    let store: AppStore
    @State private var model: AMSecretsModel
    @State private var adding = false
    @State private var launched: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AMSecretsModel(store: store))
    }

    var body: some View {
        AMResourcePage(title: "Keys and secrets", resource: model.resource) { snapshot in
            if snapshot.secrets.isEmpty {
                Section {
                    EmptyState(title: "No secrets yet", symbol: "key", message: "Keys you enter for providers, web search and connectors are kept here.",
                               actionTitle: "Add a secret") { adding = true }
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(snapshot.secrets) { secret in
                        NavigationLink { AMSecretDetail(store: store, model: model, id: secret.id) } label: {
                            AMSecretRow(secret: secret, usedBy: secret.usedByLabels(providers: snapshot.providerNames))
                        }
                    }
                } footer: { Text("Values are stored encrypted and are never shown again. Only the last four characters are listed so you can tell keys apart.") }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add a secret")
            }
        }
        .sheet(isPresented: $adding) { AMAddSecretSheet(store: store, model: model) }
        .navigationDestination(item: $launched) { id in AMSecretDetail(store: store, model: model, id: id) }
        .task {
            guard let route = AMLaunch.parts else { return }
            await model.resource.reload()
            switch route.head {
            case "secret": launched = route.tail
            case "secret-add": adding = true
            default: break
            }
        }
    }
}

struct AMSecretRow: View {
    let secret: AMSecret
    let usedBy: [String]
    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: "key", size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(secret.label).font(.body.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
                Text("\(secret.kindLabel) · \(secret.masked)").font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).lineLimit(1)
                Text(usedBy.isEmpty ? "Not used" : "Used by " + usedBy.joined(separator: ", ")).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One secret

struct AMSecretDetail: View {
    let store: AppStore
    let model: AMSecretsModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var rotating = false
    @State private var confirmDelete = false
    @State private var deleting = false

    private var snapshot: AMSecretsSnapshot? { model.resource.value }
    private var secret: AMSecret? { snapshot?.secrets.first { $0.id == id } }

    var body: some View {
        Group {
            if let secret, let snapshot {
                SettingsPage(title: secret.label) { content(secret, usedBy: secret.usedByLabels(providers: snapshot.providerNames)) }
            } else {
                SettingsPage(title: "Secret") { EmptyState(title: "This secret is gone", symbol: "key", message: "It was deleted. Go back to the list.") }
            }
        }
        .task {
            if AMLaunch.has("rotate") { rotating = true }
            if AMLaunch.has("delete") { confirmDelete = true }
        }
        .sheet(isPresented: $rotating) { if let secret { AMRotateSecretSheet(store: store, model: model, secret: secret) } }
        .confirmationDialog("Delete \(secret?.label ?? "this secret")?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    deleting = true
                    if await store.attempt({ try await model.delete(id) }) { store.notify("Deleted"); dismiss() }
                    deleting = false
                }
            }
        } message: { Text("The value is erased and can't be recovered. Nothing in settings refers to it.") }
    }

    @ViewBuilder private func content(_ secret: AMSecret, usedBy: [String]) -> some View {
        Section {
            ValueRow(title: "Name", value: secret.label)
            ValueRow(title: "Kind", value: secret.kindLabel)
            ValueRow(title: "Value", value: secret.masked, subtitle: "The rest is kept secret.", mono: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Reference").foregroundStyle(Theme.ink)
                Text("${secret:\(secret.id)}").font(.mono(.subheadline)).foregroundStyle(Theme.inkSecondary).textSelection(.enabled)
                Text("How settings and connector headers refer to it.").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = "${secret:\(secret.id)}" } }
        }
        Section {
            if usedBy.isEmpty { Text("Not used by anything.").foregroundStyle(Theme.inkMuted) }
            ForEach(usedBy, id: \.self) { Text($0).foregroundStyle(Theme.ink) }
        } header: { Text("Used by") }
        Section {
            ValueRow(title: "Added", value: AMFormat.ago(secret.createdAt))
            ValueRow(title: "Last used", value: AMFormat.ago(secret.lastUsedAt))
            ValueRow(title: "Replaced", value: secret.rotatedAt == nil ? "Never" : AMFormat.ago(secret.rotatedAt))
        }
        Section {
            ActionRow(title: "Replace the value", symbol: "arrow.triangle.2.circlepath") { rotating = true }
        } footer: { Text("The new value takes the old one's place everywhere it is used, from the next connection on.") }
        Section {
            ActionRow(title: "Delete", symbol: "trash", destructive: true, busy: deleting) { confirmDelete = true }
                .disabled(!usedBy.isEmpty)
        } footer: { if !usedBy.isEmpty { Text("Used by \(usedBy.joined(separator: ", ")). Remove that first.") } }
    }
}

// MARK: - Entering a value

/// A masked field that never keeps its text longer than it has to.
struct AMSecretEntry: View {
    let title: String
    @Binding var value: String
    var placeholder = "Paste it here"
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote).foregroundStyle(Theme.inkMuted)
            SecureField(placeholder, text: $value)
                .textInputAutocapitalization(.never).autocorrectionDisabled().font(.mono(.body))
        }
    }
}

struct AMAddSecretSheet: View {
    let store: AppStore
    let model: AMSecretsModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var kind = "api_key"
    @State private var value = ""
    @State private var saving = false
    @State private var error: String?

    private var taken: Set<String> { Set(model.resource.value?.secrets.map(\.id) ?? []) }
    private var id: String { AMSecretsModel.newID(label: label, taken: taken) }
    private var valid: Bool { !label.trimmingCharacters(in: .whitespaces).isEmpty && !value.trimmingCharacters(in: .whitespaces).isEmpty && value.count <= 10_000 }

    var body: some View {
        NavigationStack {
            SettingsPage(title: "Add a secret") {
                SettingsSection(footer: "For settings that refer to a key by name, such as a custom connector's header.") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Name").font(.footnote).foregroundStyle(Theme.inkMuted)
                        TextField("For example Docs connector token", text: $label).onChange(of: label) { _, new in if new.count > 120 { label = String(new.prefix(120)) } }
                        if !label.trimmingCharacters(in: .whitespaces).isEmpty { AMNote(text: "Refer to it in settings as ${secret:\(id)}.") }
                    }
                    Picker("Kind", selection: $kind) { Text("API key").tag("api_key"); Text("Token").tag("token") }
                    AMSecretEntry(title: "Value", value: $value)
                }
                if let error { Section { AMOutcome(kind: .bad, text: error) } }
                AMButtonRow {
                    Button("Add secret") {
                        Task {
                            saving = true; error = nil
                            do {
                                try await model.save(id: id, label: label.trimmingCharacters(in: .whitespaces), kind: kind, value: value.trimmingCharacters(in: .whitespaces))
                                value = ""
                                store.notify("Added \(label.trimmingCharacters(in: .whitespaces))")
                                dismiss()
                            } catch is CancellationError {} catch { self.error = AMFailure.from(error).localizedDescription }
                            saving = false
                        }
                    }
                    .buttonStyle(ClayButtonStyle(busy: saving)).disabled(!valid || saving)
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { value = ""; dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(saving)
    }
}

struct AMRotateSecretSheet: View {
    let store: AppStore
    let model: AMSecretsModel
    let secret: AMSecret
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            SettingsPage(title: "Replace \(secret.label)") {
                SettingsSection(footer: "The new value replaces the old one everywhere it is used, from the next connection on.") {
                    AMSecretEntry(title: "New value", value: $value, placeholder: "Paste the new value")
                }
                if let error { Section { AMOutcome(kind: .bad, text: error) } }
                AMButtonRow {
                    Button("Replace") {
                        Task {
                            saving = true; error = nil
                            do {
                                try await model.save(id: secret.id, label: secret.label, kind: secret.kind, value: value.trimmingCharacters(in: .whitespaces))
                                value = ""
                                store.notify("Replaced \(secret.label)")
                                dismiss()
                            } catch is CancellationError {} catch { self.error = AMFailure.from(error).localizedDescription }
                            saving = false
                        }
                    }
                    .buttonStyle(ClayButtonStyle(busy: saving)).disabled(value.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { value = ""; dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium])
        .interactiveDismissDisabled(saving)
    }
}
