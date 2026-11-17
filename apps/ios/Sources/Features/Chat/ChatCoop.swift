import SwiftUI

/// Co-op: up to four people working in one conversation. The host turns it on, adds teammates (on a server) or shares an
/// invite link (from a desktop) and lets each person in; everyone chooses whose models answer them.
@MainActor enum ChatCoopActions {
    private static func call(_ store: AppStore, _ method: String, _ params: [String: JSON]) async throws -> JSON {
        var all = params
        all["sessionId"] = .string(store.selected ?? "")
        return try await store.rpc.call(method, all)
    }

    @discardableResult
    static func start(_ store: AppStore) async throws -> JSON { try await remember(store, try await call(store, "coop.start", [:])) }
    static func invite(_ store: AppStore) async throws -> JSON { try await call(store, "coop.invite", [:]) }
    static func directory(_ store: AppStore) async throws -> [JSON] { try await store.rpc.call("coop.directory").array }
    @discardableResult
    static func add(_ store: AppStore, userIDs: [String], role: String) async throws -> JSON { try await remember(store, try await call(store, "coop.add", ["userIds": .array(userIDs.map(JSON.string)), "role": .string(role)])) }
    static func admit(_ store: AppStore, knock: String, allow: Bool) async throws { _ = try await call(store, "coop.admit", ["knockId": .string(knock), "allow": .bool(allow)]) }
    @discardableResult
    static func settings(_ store: AppStore, _ patch: [String: JSON]) async throws -> JSON { try await remember(store, try await call(store, "coop.settings", ["settings": .object(patch)])) }
    @discardableResult
    static func participant(_ store: AppStore, id: String, role: String? = nil, trusted: Bool? = nil) async throws -> JSON {
        var params: [String: JSON] = ["participantId": .string(id)]
        if let role { params["role"] = .string(role) }
        if let trusted { params["trusted"] = .bool(trusted) }
        return try await remember(store, try await call(store, "coop.participant", params))
    }
    static func remove(_ store: AppStore, id: String) async throws { _ = try await call(store, "coop.remove", ["participantId": .string(id)]); await ChatHub.of(store).loadCoop(store.selected ?? "") }
    @discardableResult
    static func models(_ store: AppStore, choice: String, model: String?) async throws -> JSON { try await remember(store, try await call(store, "coop.models", ["models": .string(choice), "model": model.map(JSON.string) ?? .null])) }
    static func leave(_ store: AppStore) async throws { _ = try await call(store, "coop.leave", [:]) }
    static func end(_ store: AppStore) async throws { _ = try await call(store, "coop.end", [:]); await ChatHub.of(store).loadCoop(store.selected ?? "") }
    static func join(_ store: AppStore, invite: String, models: String) async throws -> JSON { try await store.rpc.call("coop.join", ["invite": .string(invite), "models": .string(models)]) }

    private static func remember(_ store: AppStore, _ state: JSON) async throws -> JSON {
        if let id = store.selected { ChatHub.of(store).coop[id] = state == .null ? nil : state }
        return state
    }

    static let roleNames = ["host": "Host", "editor": "Can chat", "viewer": "Can watch"]
}

struct ChatCoopSheet: View {
    let store: AppStore
    @State private var directory: [JSON]?
    @State private var picking = false
    @State private var picked: Set<String> = []
    @State private var role = "editor"
    @State private var busy = false
    @State private var invite: JSON?
    @State private var ending = false
    @State private var leaving = false
    @State private var requestsText = ""
    @State private var spendText = ""
    @Environment(\.dismiss) private var dismiss
    private var hub: ChatHub { ChatHub.of(store) }
    private var session: Conversation? { ChatNav.session(store) }
    private var state: JSON { hub.coop[store.selected ?? ""] ?? .null }
    private var isHost: Bool { state == .null || state["role"].string == "host" }
    private var onServer: Bool { store.info["surface"].string == "web" && !store.offers("sharedComputer") }
    private var people: [JSON] { state["participants"].array }
    private var others: [JSON] { people.filter { $0["role"].string != "host" } }
    private var room: Int { 3 - others.count }

    var body: some View {
        NavigationStack {
            List {
                if state == .null { startSection }
                else if state["ended"].bool { Section { Label("Co-op ended. This conversation is read only for guests.", systemImage: "person.2.slash").foregroundStyle(Theme.inkSecondary) } }
                if state != .null {
                    knockingSection
                    if isHost { inviteSection }
                    peopleSection
                    answerSection
                    if isHost { settingsSection }
                    endSection
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Co-op").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if let id = store.selected { await hub.loadCoop(id) } }
            .alert("End co-op?", isPresented: $ending) {
                Button("Cancel", role: .cancel) {}
                Button("End co-op", role: .destructive) { run { try await ChatCoopActions.end(store) } }
            } message: { Text(others.isEmpty ? "The invite link stops working and the conversation is yours alone again." : "Everyone else leaves this conversation\(state["settings"]["guestsKeepCopy"].bool ? " and keeps a copy of it" : ""). It stays yours.") }
            .alert("Leave this conversation?", isPresented: $leaving) {
                Button("Cancel", role: .cancel) {}
                Button("Leave", role: .destructive) { run { try await ChatCoopActions.leave(store); dismiss(); ChatNav.newConversation(store) } }
            } message: { Text(state["settings"]["guestsKeepCopy"].bool ? "You keep a copy of the conversation in your list." : "It goes from your list. You need a new invite to come back.") }
        }
        .tint(Theme.clay).presentationDetents([.medium, .large])
    }

    // MARK: not started

    @ViewBuilder private var startSection: some View {
        Section {
            Text(onServer ? "Work on this conversation with up to three teammates on this server. It stays yours, and anything risky asks you." : "Work on this conversation with up to three friends. It keeps running on the computer that hosts it, and anything risky asks you.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            if picking { teammatePicker } else {
                Button { if onServer { picking = true; loadDirectory() } else { run { try await ChatCoopActions.start(store) } } } label: { Label("Start co-op", systemImage: "person.2").foregroundStyle(Theme.clay) }.disabled(busy)
            }
        }
    }

    @ViewBuilder private var teammatePicker: some View {
        if let directory {
            if directory.isEmpty { Text("Nobody else on this server can join yet.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
            ForEach(directory, id: \.self) { person in
                let id = person["userId"].string
                Button { if picked.contains(id) { picked.remove(id) } else if picked.count < max(room, 0) { picked.insert(id) } } label: {
                    HStack(spacing: 12) {
                        Avatar(name: person["name"].string, size: 30)
                        Text(person["name"].string).foregroundStyle(Theme.ink)
                        Spacer()
                        Image(systemName: picked.contains(id) ? "checkmark.circle.fill" : "circle").foregroundStyle(picked.contains(id) ? Theme.clay : Theme.inkMuted)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Picker("What they can do", selection: $role) { Text("Can chat").tag("editor"); Text("Can watch").tag("viewer") }
            HStack {
                Button("Cancel") { picking = false; picked = [] }
                Spacer()
                Button("Add") { add() }.buttonStyle(.borderedProminent).disabled(picked.isEmpty || busy)
            }
            if picked.count >= 3 { Text("A co-op conversation has room for four people in all.").font(.footnote).foregroundStyle(Theme.inkMuted) }
        } else { HStack(spacing: 10) { ProgressView(); Text("Loading teammates").foregroundStyle(Theme.inkMuted) } }
    }

    private func loadDirectory() {
        Task { do { directory = try await ChatCoopActions.directory(store) } catch { store.error = ChatError.text(error); picking = false } }
    }

    private func add() {
        let ids = Array(picked)
        run {
            try await ChatCoopActions.start(store)
            try await ChatCoopActions.add(store, userIDs: ids, role: role)
            picked = []; picking = false
        }
    }

    // MARK: running

    @ViewBuilder private var knockingSection: some View {
        let knocks = state["knocking"].array
        if !knocks.isEmpty && isHost {
            Section {
                ForEach(knocks, id: \.self) { knock in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(knock["name"].string) wants to join").font(.body.weight(.medium))
                        Text(knock["fingerprint"].array.map(\.string).joined(separator: " ")).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted)
                        HStack(spacing: 10) {
                            Button("Let in") { run { try await ChatCoopActions.admit(store, knock: knock["id"].string, allow: true) } }.buttonStyle(.borderedProminent)
                            Button("Decline") { run { try await ChatCoopActions.admit(store, knock: knock["id"].string, allow: false) } }.buttonStyle(.bordered)
                        }.tint(Theme.clay)
                    }.padding(.vertical, 4)
                }
            } header: { Text("Asking to join") } footer: { Text("Compare these words with what they see before you let them in.") }
        }
    }

    @ViewBuilder private var inviteSection: some View {
        if state["via"].string != "server" {
            Section {
                if room <= 0 { Text("The conversation is full: four people at most.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                else {
                    if let url = (invite ?? state["invite"]).stringURL { ShareLink(item: url) { Label("Share invite link", systemImage: "square.and.arrow.up") } }
                    Button { run { invite = try await ChatCoopActions.invite(store) } } label: { Label(state["invite"] == .null && invite == nil ? "Make an invite link" : "Make a new link", systemImage: "link") }
                }
            } footer: { Text(state["invite"] == .null && invite == nil ? "Anyone with the link can ask to join for 24 hours. You let each one in." : "The old link stops working when you make a new one.") }
        } else if room > 0 {
            Section { if picking { teammatePicker } else { Button { picking = true; loadDirectory() } label: { Label("Invite a teammate", systemImage: "person.badge.plus") } } }
        }
    }

    private var peopleSection: some View {
        Section {
            ForEach(people, id: \.self) { person in
                let me = person["id"].string == state["me"].string
                HStack(spacing: 12) {
                    ZStack(alignment: .bottomTrailing) {
                        Avatar(name: person["name"].string, size: 34)
                        Circle().fill(person["online"].bool ? Theme.success : Theme.inkMuted).frame(width: 10, height: 10).overlay(Circle().stroke(Theme.sunken, lineWidth: 2))
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(me ? "\(person["name"].string) (you)" : person["name"].string).font(.body)
                        Text([ChatCoopActions.roleNames[person["role"].string] ?? person["role"].string, person["trusted"].bool ? "Trusted with approvals" : nil, person["online"].bool ? nil : "Offline"].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.inkMuted)
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)
                .contextMenu {
                    if isHost, person["role"].string != "host" {
                        Button(person["role"].string == "editor" ? "Make a watcher" : "Let them chat", systemImage: person["role"].string == "editor" ? "eye" : "bubble.left") { run { try await ChatCoopActions.participant(store, id: person["id"].string, role: person["role"].string == "editor" ? "viewer" : "editor") } }
                        Button(person["trusted"].bool ? "Stop trusting with approvals" : "Trust with approvals", systemImage: "checkmark.shield") { run { try await ChatCoopActions.participant(store, id: person["id"].string, trusted: !person["trusted"].bool) } }
                        Button("Remove", systemImage: "person.badge.minus", role: .destructive) { run { try await ChatCoopActions.remove(store, id: person["id"].string) } }
                    }
                }
                .swipeActions { if isHost, person["role"].string != "host" { Button(role: .destructive) { run { try await ChatCoopActions.remove(store, id: person["id"].string) } } label: { Label("Remove", systemImage: "person.badge.minus") } } }
            }
        } header: { Text("People") } footer: {
            if others.isEmpty { Text(state["via"].string == "server" ? "Nobody else is here yet." : "Nobody has joined yet. Send the link to whoever you want to work with.") }
            else if isHost { Text("Touch and hold a person to change what they can do.") }
        }
    }

    @ViewBuilder private var answerSection: some View {
        let mine = people.first { $0["id"].string == state["me"].string }
        let hostModels = state["hostModels"].array
        if let mine, !state["ended"].bool {
            Section {
                Picker("Answer my messages with", selection: Binding(get: { mine["models"].string }, set: { choice in run { try await ChatCoopActions.models(store, choice: choice, model: nil) } })) {
                    if isHost || state["settings"]["shareModels"].bool { Text(isHost ? "My models" : "The host's models").tag("host") }
                    if !isHost { Text("My models").tag("own") }
                }
                if mine["models"].string == "host" {
                    let models = isHost ? store.models.filter { !$0["hidden"].bool }.map { ($0["ref"].string, $0["displayName"].string) } : hostModels.map { ($0["ref"].string, $0["displayName"].string) }
                    Picker("Model", selection: Binding(get: { mine["model"].string }, set: { ref in run { try await ChatCoopActions.models(store, choice: "host", model: ref.isEmpty ? nil : ref) } })) {
                        Text("Choose a model").tag("")
                        ForEach(models, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                let use = state["sharedUse"]
                if use != .null { ValueRow(title: "Used today", value: "\(use["requests"].int) requests") }
            } header: { Text("Your answers") }
        }
    }

    @ViewBuilder private var settingsSection: some View {
        let settings = state["settings"]
        Section {
            ToggleRow(title: "Guests can use my models", isOn: Binding(get: { settings["shareModels"].bool }, set: { value in run { try await ChatCoopActions.settings(store, ["shareModels": .bool(value)]) } }))
            if settings["shareModels"].bool {
                FieldRow(title: "Requests a day per guest", placeholder: settings["sharedRequestsPerDay"] == .null ? "No cap" : String(settings["sharedRequestsPerDay"].int), text: $requestsText, keyboard: .numberPad)
                    .onSubmit { saveCaps() }
                FieldRow(title: "Dollars a day per guest", placeholder: settings["sharedSpendPerDayUsd"] == .null ? "No cap" : String(settings["sharedSpendPerDayUsd"].double), text: $spendText, keyboard: .decimalPad)
                    .onSubmit { saveCaps() }
            }
            ToggleRow(title: "Guests keep a copy when co-op ends", isOn: Binding(get: { settings["guestsKeepCopy"].bool }, set: { value in run { try await ChatCoopActions.settings(store, ["guestsKeepCopy": .bool(value)]) } }))
            ToggleRow(title: "Guests' own models read what the session reads", subtitle: "A guest who answers with their own model sends it the conversation and the files Atelier reads here.", isOn: Binding(get: { settings["allowGuestModels"].bool }, set: { value in run { try await ChatCoopActions.settings(store, ["allowGuestModels": .bool(value)]) } }))
        } header: { Text("What guests can use") } footer: { if settings["shareModels"].bool { Text("Leave a field empty for no cap. Press return to save it.") } }
    }

    private func saveCaps() {
        var patch: [String: JSON] = [:]
        if !requestsText.isEmpty { if let n = Int(requestsText), n > 0 { patch["sharedRequestsPerDay"] = .number(Double(n)) } else { store.error = "Enter a whole number of requests, or leave it empty."; return } }
        if !spendText.isEmpty { if let d = Double(spendText), d > 0 { patch["sharedSpendPerDayUsd"] = .number(d) } else { store.error = "Enter an amount in dollars, or leave it empty."; return } }
        guard !patch.isEmpty else { return }
        run { try await ChatCoopActions.settings(store, patch) }
    }

    private var endSection: some View {
        Section {
            if isHost { Button("End co-op", role: .destructive) { ending = true } }
            else { Button("Leave conversation", role: .destructive) { leaving = true } }
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await operation() } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
        }
    }
}

private extension JSON {
    /// An invite link from `coop.invite` (`{url, expiresAt}`) as a URL.
    var stringURL: URL? { self["url"].stringOrNil.flatMap(URL.init(string:)) }
}

/// "Join a co-op session": paste the link someone sent; the host lets you in.
struct ChatJoinCoopSheet: View {
    let store: AppStore
    var open: (String) -> Void
    @State private var link = ""
    @State private var choice = "host"
    @State private var busy = false
    @State private var waiting: JSON?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Paste the invite link", text: $link, axis: .vertical).lineLimit(1...4).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                } header: { Text("Invite") } footer: { Text("It looks like https://atelierhq.dev/join#v1.… You see whose session it is before anything connects.") }
                Section {
                    Picker("Answer my messages with", selection: $choice) { Text("The host's models").tag("host"); Text("My models").tag("own") }
                } footer: { Text(choice == "own" ? "You choose which of your models once you're in. Your keys stay on your computer." : "The host's models answer you, within what the host allows.") }
                if let waiting {
                    Section {
                        Label(waiting["waiting"].bool ? "Waiting for the host to let you in" : "You are in", systemImage: waiting["waiting"].bool ? "hourglass" : "checkmark.circle").foregroundStyle(Theme.inkSecondary)
                        if !waiting["fingerprint"].array.isEmpty { Text(waiting["fingerprint"].array.map(\.string).joined(separator: " ")).font(.mono(.body)).textSelection(.enabled) }
                    } footer: { Text("The host sees the same words. They show it is you.") }
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Join co-op").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Join") { join() }.disabled(busy || link.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }.tint(Theme.clay).presentationDetents([.medium, .large])
    }

    private func join() {
        busy = true
        Task {
            defer { busy = false }
            do {
                let result = try await ChatCoopActions.join(store, invite: link.trimmingCharacters(in: .whitespacesAndNewlines), models: choice)
                try? await store.refresh()
                if result["waiting"].bool { waiting = result } else { dismiss(); open(result["sessionId"].string) }
            } catch { store.error = ChatError.text(error) }
        }
    }
}
