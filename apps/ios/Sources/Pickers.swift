import SwiftUI

/// Choose the model. In a conversation a change applies from the next message; on a new page it is what the conversation
/// starts with. A person's pick becomes their model for the next conversations too, as on the desktop. (How hard it thinks has its own menu.)
struct ModelPicker: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var saving = false
    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { store.sessions.first { $0.id == store.selected } }
    private var mode: String { session?.mode ?? "chat" }
    private var current: JSON? { store.models.first { $0["ref"].string == store.selectedModel } }
    private var groups: [ChatModelGroup] { ChatModels.groups(store.models, providerNames: hub.providerNames, matching: query) }
    private var usable: Int { store.models.filter { !$0["hidden"].bool }.count }

    var body: some View {
        NavigationStack {
            List {
                if usable == 0 { noModels }
                else if groups.isEmpty { Section { Text("No model matches \"\(query)\".").foregroundStyle(Theme.inkMuted) } }
                ForEach(groups) { group in
                    Section {
                        ForEach(group.models, id: \.self) { model in row(model) }
                    } header: { Text(group.offline ? "\(group.label), not connected" : group.label) }
                }
                if store.isAdmin, usable > 0, query.isEmpty {
                    Section { Button { dismiss(); openSettings(.providers) } label: { Label("Add a provider", systemImage: "plus.circle").foregroundStyle(Theme.clay) } } footer: { Text("Connect Ollama, llama.cpp, Anthropic, OpenAI or any compatible endpoint.") }
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: usable > 6 ? .always : .automatic), prompt: "Search models")
            .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    @ViewBuilder private var noModels: some View {
        Section {
            if store.isAdmin {
                VStack(alignment: .leading, spacing: 12) {
                    Text("No models yet").font(.system(.title3, design: .serif, weight: .medium))
                    Text("Connect a provider to start. Atelier works with Ollama, llama.cpp, Anthropic, OpenAI and compatible endpoints.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    Button("Add a provider") { dismiss(); openSettings(.providers) }.buttonStyle(ClayButtonStyle())
                }.padding(.vertical, 8)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No models available").font(.system(.title3, design: .serif, weight: .medium))
                    Text("Ask an admin of this server to connect a provider.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                }.padding(.vertical, 8)
            }
        }
    }

    private func row(_ model: JSON) -> some View {
        let selected = model["ref"].string == store.selectedModel
        let unavailable = model["available"] == .bool(false)
        return Button { choose(model) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model["displayName"].string).font(.system(.body, weight: .medium)).foregroundStyle(unavailable && !selected ? Theme.inkMuted : Theme.ink)
                    Text(ChatModels.subtitle(model)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                }
                Spacer()
                if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.clay) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(unavailable && !selected)
        .accessibilityLabel("\(model["displayName"].string), \(ChatModels.subtitle(model))").accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func choose(_ model: JSON) {
        let ref = model["ref"].string
        guard ref != store.selectedModel else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        store.selectedModel = ref
        store.selectedEffort = ""
        persist(ref)
    }

    private func persist(_ ref: String) {
        if store.selected != nil {
            Task { do { try await store.updateModel() } catch { store.error = ChatError.text(error) } }
        }
        if hub.rememberLastModel { Task { await hub.setPref(["models", mode == "code" ? "code" : "chat"], .string(ref)) } }
    }
}

/// The effort chip's own small menu: how hard the model thinks, apart from the model list. In a conversation a change
/// applies from the next message; on a new page it is what the conversation starts with.
struct EffortMenu: View {
    @Bindable var store: AppStore
    let model: JSON
    let mode: String
    let label: String
    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { store.sessions.first { $0.id == store.selected } }

    var body: some View {
        let levels = ChatEffort.choices(model, mode: mode, ultracode: hub.ultracodeOn)
        let stored = session.map { $0.effort.isEmpty ? nil : $0.effort } ?? (store.selectedEffort.isEmpty ? nil : store.selectedEffort)
        let shown = ChatEffort.shown(stored, model: model, mode: mode, ultracode: hub.ultracodeOn) ?? levels.first ?? ""
        let recommended = ChatEffort.recommended(model, mode: mode)
        Menu {
            Picker("Effort", selection: Binding(get: { shown }, set: { choose($0) })) {
                ForEach(levels, id: \.self) { level in
                    Label {
                        Text(ChatEffort.name(level, model: model) + (level == recommended ? ", recommended" : ""))
                        Text(Self.firstSentence(ChatEffort.explanation(level, model: model, mode: mode)))
                    } icon: { Image(systemName: Self.symbol(level)) }.tag(level)
                }
            }
            if model["capabilities"]["reasoning"].string == "toggle" {
                let always = ["xhigh", "max", "ultracode"].contains(shown)
                Divider()
                Toggle(isOn: Binding(get: { always || (session?.thinking ?? hub.thinkingDefault) }, set: { setThinking($0) })) {
                    Label { Text("Thinking"); Text(always ? "Always on at this level" : "Recommended") } icon: { Image(systemName: "brain") }
                }.disabled(always)
            }
        } label: {
            HStack(spacing: 5) {
                Text(label).font(.subheadline)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.fill, in: Capsule())
        }
        .hoverEffect(.highlight).accessibilityLabel("Effort: \(label)").accessibilityHint("Choose how hard it thinks")
    }

    private func choose(_ level: String) {
        UISelectionFeedbackGenerator().selectionChanged()
        store.selectedEffort = level
        if store.selected != nil { Task { do { try await store.updateModel() } catch { store.error = ChatError.text(error) } } }
    }

    private func setThinking(_ value: Bool) {
        if let id = store.selected { Task { do { try await ChatActions.update(store, id, ["thinking": .bool(value)]) } catch { store.error = ChatError.text(error) } } }
        else { Task { await hub.setPref(["thinking"], .bool(value)) } }
    }

    static func firstSentence(_ text: String) -> String {
        guard let end = text.range(of: ". ") else { return text }
        return String(text[..<end.lowerBound]) + "."
    }

    static func symbol(_ level: String) -> String {
        switch level {
        case "low": "hare"
        case "medium": "gauge.with.dots.needle.33percent"
        case "high": "gauge.with.dots.needle.50percent"
        case "xhigh": "gauge.with.dots.needle.67percent"
        case "max": "gauge.with.dots.needle.100percent"
        case "ultracode": "sparkles"
        default: "gauge.with.dots.needle.50percent"
        }
    }
}

/// The image model for this conversation, by provider, with "Default" first.
struct ImageModelMenu: View {
    let store: AppStore
    let hub: ChatHub
    let current: String
    let onChange: (String?) -> Void

    var body: some View {
        let groups = ChatModels.groups(hub.pictureModels, providerNames: Dictionary(hub.settings["imageProviders"].array.map { ($0["id"].string, $0["name"].string) }, uniquingKeysWith: { first, _ in first }))
        let fallback = hub.pictureModels.first { $0["ref"].string == hub.prefs["models"]["image"].string } ?? hub.pictureModels.first
        Menu {
            Picker("Image model", selection: Binding(get: { hub.pictureModels.contains { $0["ref"].string == current } ? current : "" }, set: { onChange($0.isEmpty ? nil : $0) })) {
                Text(fallback.map { "Default, \($0["displayName"].string)" } ?? "Default").tag("")
                ForEach(groups) { group in
                    Section(group.label) { ForEach(group.models, id: \.self) { model in Text(model["displayName"].string).tag(model["ref"].string).disabled(model["available"] == .bool(false)) } }
                }
            }
        } label: { Label("Image model", systemImage: "photo") }
    }
}
