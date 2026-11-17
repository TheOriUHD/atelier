import SwiftUI

/// Choose the model, and how hard it thinks. In a conversation a change applies from the next message; on a new page it
/// is what the conversation starts with. A person's pick becomes their model for the next conversations too, as on the desktop.
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
                if let current, query.isEmpty { effortSection(current) }
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

    @ViewBuilder private func effortSection(_ model: JSON) -> some View {
        let levels = ChatEffort.choices(model, mode: mode, ultracode: hub.ultracodeOn)
        if levels.count > 1 {
            Section {
                ChatEffortControl(model: model, mode: mode, effort: store.selectedEffort.isEmpty ? nil : store.selectedEffort, ultracode: hub.ultracodeOn) { level in
                    store.selectedEffort = level
                    if store.selected != nil { Task { do { try await store.updateModel() } catch { store.error = ChatError.text(error) } } }
                }
                if model["capabilities"]["reasoning"].string == "toggle" {
                    ThinkingToggle(store: store, model: model)
                }
            } header: { Text("How hard it thinks") } footer: { Text(store.selected == nil ? "Applies to this conversation." : "Applies from your next message.") }
        }
    }
}

/// The level of effort: a row of stops from fast to thorough, what the chosen one means, and what it costs.
struct ChatEffortControl: View {
    let model: JSON
    let mode: String
    let effort: String?
    var ultracode = true
    let onChange: (String) -> Void

    var body: some View {
        let levels = ChatEffort.choices(model, mode: mode, ultracode: ultracode)
        let shown = ChatEffort.shown(effort, model: model, mode: mode, ultracode: ultracode) ?? levels.first ?? ""
        let recommended = ChatEffort.recommended(model, mode: mode)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Faster").font(.footnote).foregroundStyle(Theme.inkMuted)
                Spacer()
                Text("Smarter").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(levels, id: \.self) { level in
                        let selected = level == shown
                        Button { UISelectionFeedbackGenerator().selectionChanged(); onChange(level) } label: {
                            VStack(spacing: 2) {
                                Text(ChatEffort.name(level, model: model)).font(.subheadline.weight(.medium))
                                if level == recommended { Text("Recommended").font(.system(size: 9, weight: .semibold)).textCase(.uppercase).opacity(0.8) }
                            }
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .foregroundStyle(selected ? .white : Theme.ink)
                            .background(selected ? AnyShapeStyle(Theme.clay) : AnyShapeStyle(Theme.fill), in: Capsule())
                        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
            }
            Text(ChatEffort.explanation(shown, model: model, mode: mode)).font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
            if let warning = ChatEffort.warning(shown, model: model) {
                Label(warning, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Color(hex: 0xB77800))
            }
        }
        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
    }
}

/// Thinking on or off, for a model that has only a switch (the levels above Medium always think).
struct ThinkingToggle: View {
    let store: AppStore
    let model: JSON
    @State private var on = true
    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { store.sessions.first { $0.id == store.selected } }

    var body: some View {
        let always = ["xhigh", "max", "ultracode"].contains(ChatEffort.shown(store.selectedEffort.isEmpty ? nil : store.selectedEffort, model: model, mode: session?.mode ?? "chat", ultracode: hub.ultracodeOn) ?? "")
        Toggle(isOn: Binding(get: { always || on }, set: { set($0) })) {
            VStack(alignment: .leading, spacing: 2) { Text("Thinking"); Text(always ? "Always on at this level" : "Recommended").font(.footnote).foregroundStyle(Theme.inkMuted) }
        }.tint(Theme.clay).disabled(always)
        .onAppear { on = session?.thinking ?? hub.thinkingDefault }
    }

    private func set(_ value: Bool) {
        on = value
        if let id = store.selected { Task { do { try await ChatActions.update(store, id, ["thinking": .bool(value)]) } catch { store.error = ChatError.text(error) } } }
        else { Task { await hub.setPref(["thinking"], .bool(value)) } }
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
