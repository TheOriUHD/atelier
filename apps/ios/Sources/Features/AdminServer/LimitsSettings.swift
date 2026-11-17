import SwiftUI

// MARK: - Model

/// The Limits page's data: everyone's usage against their limits and the limits for everyone.
@MainActor @Observable final class AdminLimitsModel {
    private let rpc: Connection
    let resource: Resource<AdminLimitsSnapshot>

    init(rpc: Connection) {
        self.rpc = rpc
        resource = Resource { try await Self.load(rpc) }
    }

    static func load(_ rpc: Connection) async throws -> AdminLimitsSnapshot {
        if Launch.value("--state") == "loading" { try await Task.sleep(for: .seconds(3600)) }
        async let people = rpc.adminCall("limits.everyone")
        async let settings = rpc.adminCall("settings.get")
        return AdminLimitsSnapshot(people: try await people.array.map(AdminPersonLimits.init), system: AdminLimitsSnapshot.system(from: try await settings))
    }

    var snapshot: AdminLimitsSnapshot? { resource.value }
    func reload() async { await resource.reload() }

    /// Sets one limit for everyone, or lifts it (nil). Throws the server's words.
    func setSystem(_ key: AdminLimitKey, to value: Double?) async throws {
        if let value {
            _ = try await rpc.adminCall("settings.set", ["layer": "global", "path": .array([.string("limits"), .string(key.rawValue)]), "value": .number(value)])
        } else {
            _ = try await rpc.adminCall("settings.reset", ["layer": "global", "path": .array([.string("limits"), .string(key.rawValue)])])
        }
        await resource.reload()
    }
}

// MARK: - Page

/// Settings › Admin › Limits: what each person may use of the text models, and where everyone stands.
struct LimitsSettings: View {
    let store: AppStore
    @State private var model: AdminLimitsModel
    @State private var pushedLimit: AdminLimitKey?
    @State private var pushedPerson: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AdminLimitsModel(rpc: store.rpc))
    }

    var body: some View {
        AdminList(resource: model.resource) { snapshot in
            everyone(snapshot)
            people(snapshot)
        }
        .navigationTitle("Limits").navigationBarTitleDisplayMode(.inline)
        .adminToast(store)
        .onChange(of: model.resource.value) { old, new in
            guard old == nil, new != nil else { return }
            pushedLimit = AdminDebug.parts(after: "limit")?.first.flatMap(AdminLimitKey.init(rawValue:))
            pushedPerson = AdminDebug.parts(after: "person")?.first
        }
        .navigationDestination(isPresented: Binding(get: { pushedLimit != nil }, set: { if !$0 { pushedLimit = nil } })) {
            if let pushedLimit { AdminEditLimitView(model: model, store: store, key: pushedLimit, current: model.snapshot?.system[pushedLimit]) }
        }
        .navigationDestination(isPresented: Binding(get: { pushedPerson != nil }, set: { if !$0 { pushedPerson = nil } })) {
            if let pushedPerson { AdminPersonLimitsEditor(store: store, personID: pushedPerson, name: model.snapshot?.people.first { $0.id == pushedPerson }?.name ?? "") {} }
        }
    }

    @ViewBuilder private func everyone(_ snapshot: AdminLimitsSnapshot) -> some View {
        Section {
            ForEach(AdminLimitKey.allCases) { key in
                NavigationLink { AdminEditLimitView(model: model, store: store, key: key, current: snapshot.system[key]) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(key.title).foregroundStyle(Theme.ink)
                            Text(subtitle(key)).font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                        Spacer(minLength: 8)
                        Text(snapshot.system[key].map { AdminLimitAmount.limit(key, $0) } ?? "No limit").font(.subheadline).foregroundStyle(snapshot.system[key] == nil ? Theme.inkMuted : Theme.ink).multilineTextAlignment(.trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("Limits for everyone")
        } footer: {
            Text("Off until you set one. They apply to each person separately, to all their conversations together. A person who reaches one is told which, when it resets, and to ask an admin.")
        }
    }

    private func subtitle(_ key: AdminLimitKey) -> String {
        switch key.period {
        case .day: "Resets at 00:00 UTC"
        case .thirtyDays: "Today and the 29 days before"
        case .hour: "The last 60 minutes"
        }
    }

    @ViewBuilder private func people(_ snapshot: AdminLimitsSnapshot) -> some View {
        let ordered = AdminPersonLimits.ordered(snapshot.people)
        Section {
            ForEach(ordered) { person in
                NavigationLink {
                    AdminPersonLimitsEditor(store: store, personID: person.id, name: person.name) { Task { await model.reload() } }
                } label: { AdminPersonLimitRow(person: person) }
            }
        } header: {
            Text("People")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if !snapshot.anyLimitSet { Text("No limits are set, so everyone can use the models as much as they like.") }
                Text("Closest limit first. Tap a person to raise or lower a limit for them alone, lift one, or exempt them from all. Admins are not exempt unless you say so.")
            }
        }
    }
}

// MARK: - Rows and meters

struct AdminPersonLimitRow: View {
    let person: AdminPersonLimits

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(name: person.name, size: 38)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(person.name).lineLimit(2).foregroundStyle(Theme.ink)
                    if person.exempt { StatusBadge(text: "Exempt", tone: .clay) } else if person.hasOwn { StatusBadge(text: "Own limits") }
                    Spacer(minLength: 0)
                    if let closest = person.closest, !person.exempt {
                        if closest.reached { StatusBadge(text: "At limit", tone: .bad) } else if closest.near { StatusBadge(text: "Near limit", tone: .warn) }
                    }
                }
                if let closest = person.closest, !person.exempt {
                    AdminMeterBar(fraction: closest.fraction, reached: closest.reached, near: closest.near)
                    Text("\(closest.key.short) · \(closest.amounts)").font(.footnote).foregroundStyle(Theme.inkMuted).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(person.exempt ? "No limits" : "No limit set").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// How much of a limit is used: a bar that turns amber near it and red at it.
struct AdminMeterBar: View {
    let fraction: Double
    var reached = false
    var near = false

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.fillStrong)
                Capsule().fill(reached ? Theme.danger : (near ? Theme.waiting : Theme.clay))
                    .frame(width: fraction <= 0 ? 0 : max(8, proxy.size.width * min(1, fraction)))
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }
}

/// One limit of one person: what is used, the bar, and when it resets.
struct AdminLimitMeter: View {
    let row: AdminLimitRow

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.key.title).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(row.amounts).font(.subheadline).foregroundStyle(Theme.inkSecondary).monospacedDigit().multilineTextAlignment(.trailing)
            }
            AdminMeterBar(fraction: row.fraction, reached: row.reached, near: row.near)
            Text(row.note()).font(.footnote).foregroundStyle(row.reached ? Theme.danger : Theme.inkMuted)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(row.percent) percent used")
    }
}

// MARK: - One limit for everyone

struct AdminEditLimitView: View {
    let model: AdminLimitsModel
    let store: AppStore
    let key: AdminLimitKey
    let current: Double?
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var seeded = false
    @State private var saving = false
    @State private var problem: String?
    @State private var confirmRemove = false

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var parsed: Double? { AdminLimitAmount.parse(key, trimmed) }
    private var invalid: Bool { !trimmed.isEmpty && parsed == nil }
    private var changed: Bool { trimmed.isEmpty ? current != nil : parsed != current }

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    TextField("No limit", text: $text)
                        .keyboardType(key.unit == .usd ? .decimalPad : .asciiCapable)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.body).monospacedDigit().submitLabel(.done).onSubmit { save() }
                        .accessibilityLabel(key.title)
                    Text(key.unitWord).foregroundStyle(Theme.inkMuted)
                }
                if invalid { Text(key.problem).font(.footnote).foregroundStyle(Theme.danger) }
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
            } header: { Text(key.title) } footer: { Text(key.explanation + (key.unit == .tokens ? " Type 500k or 2M if you like." : "") + " Leave it empty for no limit.") }
            Section {
                Button(trimmed.isEmpty && current != nil ? "Remove limit" : "Save") { save() }
                    .buttonStyle(ClayButtonStyle(busy: saving)).disabled(!changed || invalid || saving)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
            if current != nil {
                Section {
                    ActionRow(title: "Remove this limit", symbol: "minus.circle", destructive: true) { confirmRemove = true }
                        .confirmationDialog("Remove the \(key.title.lowercased()) limit?", isPresented: $confirmRemove, titleVisibility: .visible) {
                            Button("Remove limit", role: .destructive) { text = ""; save() }
                        } message: { Text("People are no longer stopped by it.") }
                } footer: { Text("Everyone can use as much as they like again, unless a person has a limit of their own.") }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken).tint(Theme.clay)
        .navigationTitle(key.title).navigationBarTitleDisplayMode(.inline)
        .adminToast(store)
        .onAppear { if !seeded { text = current.map(AdminLimitAmount.text) ?? ""; seeded = true } }
    }

    private func save() {
        guard changed, !invalid, !saving else { return }
        saving = true; problem = nil
        let value = trimmed.isEmpty ? nil : parsed
        Task {
            defer { saving = false }
            do { try await model.setSystem(key, to: value); store.notify(value == nil ? "Limit removed" : "Saved"); dismiss() }
            catch is CancellationError { return }
            catch { problem = AdminFailure.message(for: error) }
        }
    }
}

// MARK: - One person's limits

/// The editor for one person's own limits, from the Limits page and from the person's own page. It reads the person's usage
/// and the limits for everyone itself, and saves with `users.update`.
struct AdminPersonLimitsEditor: View {
    let store: AppStore
    let personID: String
    let name: String
    var onSaved: () -> Void = {}
    @State private var resource: Resource<AdminLimitsSnapshot>
    @State private var draft = AdminLimitDraft()
    @State private var initial = AdminLimitDraft()
    @State private var seeded = false
    @State private var saving = false
    @State private var problemKey: AdminLimitKey?
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, personID: String, name: String, onSaved: @escaping () -> Void = {}) {
        self.store = store; self.personID = personID; self.name = name; self.onSaved = onSaved
        let rpc = store.rpc
        _resource = State(initialValue: Resource { try await AdminLimitsModel.load(rpc) })
    }

    var body: some View {
        AdminList(resource: resource) { snapshot in
            if let person = snapshot.people.first(where: { $0.id == personID }) { editor(person, snapshot) }
            else { Section { Text("This person was not found. They may have been deleted.").foregroundStyle(Theme.inkMuted) } }
        }
        .navigationTitle("Limits for \(name)").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else { Button("Save") { save() }.disabled(draft == initial || !seeded) }
            }
        }
        .adminAlert($failure)
        .adminToast(store)
        .onChange(of: resource.value) { _, snapshot in
            guard !seeded, let snapshot, let person = snapshot.people.first(where: { $0.id == personID }) else { return }
            draft = AdminLimitDraft(own: person.own); initial = draft; seeded = true
        }
        .task { if let snapshot = resource.value, !seeded, let person = snapshot.people.first(where: { $0.id == personID }) { draft = AdminLimitDraft(own: person.own); initial = draft; seeded = true } }
    }

    @ViewBuilder private func editor(_ person: AdminPersonLimits, _ snapshot: AdminLimitsSnapshot) -> some View {
        if !person.rows.isEmpty {
            Section {
                ForEach(person.rows) { AdminLimitMeter(row: $0) }
            } header: { Text("Usage now") } footer: { if let note = person.unpricedNote { Text(note) } }
        }
        Section {
            ToggleRow(title: "No limits for this person", subtitle: "For an account that must not be stopped, such as a shared service account.", isOn: $draft.exempt)
        }
        if !draft.exempt {
            ForEach(AdminLimitKey.allCases) { key in
                Section {
                    PickRow(title: "Limit", selection: Binding(get: { draft.choice(key) }, set: { draft.choice[key] = $0; if problemKey == key { problemKey = nil } }), options: AdminLimitDraft.Choice.allCases.map { ($0, $0.title) })
                    if draft.choice(key) == .custom {
                        HStack(spacing: 10) {
                            TextField(key.keyboardExample, text: Binding(get: { draft.amount(key) }, set: { draft.amount[key] = $0 }))
                                .keyboardType(key.unit == .usd ? .decimalPad : .asciiCapable).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .monospacedDigit().accessibilityLabel("\(key.title) amount")
                            Text(key.unitWord).foregroundStyle(Theme.inkMuted)
                        }
                        if problemKey == key { Text(key.problem).font(.footnote).foregroundStyle(Theme.danger) }
                    }
                } header: { Text(key.title) } footer: {
                    switch draft.choice(key) {
                    case .inherit: Text("Like everyone: " + (snapshot.system[key].map { AdminLimitAmount.limit(key, $0) } ?? "no limit") + ".")
                    case .custom: Text(key.explanation)
                    case .off: Text("This person is not stopped by this limit, whatever the limit for everyone is.")
                    }
                }
            }
        }
    }

    private func save() {
        if let key = draft.problem { problemKey = key; return }
        guard !saving else { return }
        saving = true
        let json = draft.json
        Task {
            defer { saving = false }
            do {
                _ = try await store.rpc.adminCall("users.update", ["id": .string(personID), "limits": json])
                store.notify("Saved")
                onSaved()
                dismiss()
            } catch is CancellationError { return } catch { failure = AdminFailure.message(for: error) }
        }
    }
}
