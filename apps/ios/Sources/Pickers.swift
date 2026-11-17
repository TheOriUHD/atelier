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

/// The effort chip: it opens a small panel with a slider that clicks into place at each level, from fast to thorough.
/// In a conversation a change applies from the next message; on a new page it is what the conversation starts with.
struct EffortChip: View {
    @Bindable var store: AppStore
    let model: JSON
    let mode: String
    let label: String
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 5) {
                Text(label).font(.subheadline)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(Theme.inkSecondary).padding(.horizontal, 12).frame(minHeight: 36).background(Theme.fill, in: Capsule())
        }
        .buttonStyle(.plain).hoverEffect(.highlight)
        .accessibilityLabel("Effort: \(label)").accessibilityHint("Choose how hard it thinks")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            EffortPanel(store: store, model: model, mode: mode).presentationCompactAdaptation(.popover)
        }
        #if DEBUG
        .onAppear { if Launch.route("conversation") == "effort" { Task { try? await Task.sleep(for: .seconds(1)); open = true } } }
        #endif
    }
}

/// What the effort chip opens: the level's name, the slider, what the level means, and Thinking for models with only a switch.
struct EffortPanel: View {
    @Bindable var store: AppStore
    let model: JSON
    let mode: String
    @State private var index = 0
    @State private var loaded = false
    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { store.sessions.first { $0.id == store.selected } }
    private var levels: [String] { ChatEffort.choices(model, mode: mode, ultracode: hub.ultracodeOn) }
    private var level: String { levels.indices.contains(index) ? levels[index] : (levels.first ?? "") }

    private var storedEffort: String? {
        session.map { $0.effort.isEmpty ? nil : $0.effort } ?? (store.selectedEffort.isEmpty ? nil : store.selectedEffort)
    }

    var body: some View {
        let recommended = ChatEffort.recommended(model, mode: mode)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ChatEffort.name(level, model: model)).font(.system(.title3, design: .serif, weight: .medium)).foregroundStyle(Theme.ink)
                if level == recommended { Text("Recommended").font(.caption2.weight(.semibold)).foregroundStyle(Theme.clay).padding(.horizontal, 7).padding(.vertical, 2).background(Theme.clay.opacity(0.12), in: Capsule()) }
                Spacer(minLength: 0)
            }
            EffortSlider(names: levels.map { ChatEffort.name($0, model: model) }, index: $index, onCommit: commit)
            HStack {
                Text("Faster")
                Spacer()
                Text("Smarter")
            }.font(.caption).foregroundStyle(Theme.inkMuted)
            Text(ChatEffort.explanation(level, model: model, mode: mode))
                .font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 52, alignment: .topLeading)
            if let warning = ChatEffort.warning(level, model: model) {
                Label(warning, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Color(hex: 0xB77800)).fixedSize(horizontal: false, vertical: true)
            }
            if model["capabilities"]["reasoning"].string == "toggle" {
                let always = ["xhigh", "max", "ultracode"].contains(level)
                Divider()
                Toggle(isOn: Binding(get: { always || (session?.thinking ?? hub.thinkingDefault) }, set: { setThinking($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Thinking").foregroundStyle(Theme.ink)
                        Text(always ? "Always on at this level" : "Recommended").font(.footnote).foregroundStyle(Theme.inkMuted)
                    }
                }.tint(Theme.clay).disabled(always)
            }
        }
        .padding(18).frame(width: 300)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            let shown = ChatEffort.shown(storedEffort, model: model, mode: mode, ultracode: hub.ultracodeOn) ?? levels.first ?? ""
            index = levels.firstIndex(of: shown) ?? 0
        }
    }

    private func commit(_ chosen: Int) {
        guard levels.indices.contains(chosen) else { return }
        store.selectedEffort = levels[chosen]
        if store.selected != nil { Task { do { try await store.updateModel() } catch { store.error = ChatError.text(error) } } }
    }

    private func setThinking(_ value: Bool) {
        if let id = store.selected { Task { do { try await ChatActions.update(store, id, ["thinking": .bool(value)]) } catch { store.error = ChatError.text(error) } } }
        else { Task { await hub.setPref(["thinking"], .bool(value)) } }
    }
}

/// A slider whose thumb clicks into place at each level, with a tick of feedback as it crosses from one to the next.
struct EffortSlider: View {
    let names: [String]
    @Binding var index: Int
    let onCommit: (Int) -> Void
    @State private var dragX: CGFloat?
    @State private var feedback = UISelectionFeedbackGenerator()
    private let height: CGFloat = 44
    private let thumb: CGFloat = 34

    /// The level whose stop is nearest to a touch at `x`, on a track `width` wide whose stops start `inset` from each end.
    static func nearest(_ x: CGFloat, width: CGFloat, inset: CGFloat, count: Int) -> Int {
        guard count > 1, width > 2 * inset else { return 0 }
        let fraction = (min(max(x, inset), width - inset) - inset) / (width - 2 * inset)
        return min(max(Int((fraction * CGFloat(count - 1)).rounded()), 0), count - 1)
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let inset = height / 2
            let span = max(width - 2 * inset, 1)
            let stops = max(names.count - 1, 1)
            let resting = inset + span * CGFloat(index) / CGFloat(stops)
            let x = dragX.map { min(max($0, inset), width - inset) } ?? resting
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.fill)
                Capsule().fill(Theme.clay.opacity(0.18)).frame(width: x + inset)
                ForEach(names.indices, id: \.self) { stop in
                    Circle().fill(Theme.inkMuted.opacity(0.55)).frame(width: 6, height: 6)
                        .position(x: inset + span * CGFloat(stop) / CGFloat(stops), y: height / 2)
                }
                Circle().fill(Theme.clay).frame(width: thumb, height: thumb)
                    .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
                    .position(x: x, y: height / 2)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if dragX == nil { feedback.prepare() }
                        dragX = value.location.x
                        let next = Self.nearest(value.location.x, width: width, inset: inset, count: names.count)
                        if next != index { index = next; feedback.selectionChanged(); feedback.prepare() }
                    }
                    .onEnded { value in
                        let next = Self.nearest(value.location.x, width: width, inset: inset, count: names.count)
                        withAnimation(.snappy(duration: 0.2)) { dragX = nil; index = next }
                        onCommit(next)
                    }
            )
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Effort")
        .accessibilityValue(names.indices.contains(index) ? names[index] : "")
        .accessibilityAdjustableAction { direction in
            let next = direction == .increment ? min(index + 1, names.count - 1) : max(index - 1, 0)
            guard next != index else { return }
            index = next
            onCommit(next)
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
