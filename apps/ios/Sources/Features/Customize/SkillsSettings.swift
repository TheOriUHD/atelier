import SwiftUI

// MARK: - Model

/// The skills the server sees (and a folder's project skills on request), installing and uninstalling them, and the commands they sit beside.
@MainActor @Observable final class CustomizeSkillsModel {
    struct Folder: Identifiable, Equatable, Sendable { let id: String; let name: String }

    let store: AppStore
    var phase: CustomizePhase = .loading
    var skills: [CustomizeSkill] = []
    var commands: [CustomizeCommand] = []
    var folders: [Folder] = []
    /// The folder whose project skills are included, if one is chosen.
    var folder: String?
    var source = ""
    var installing = false
    var installError: String?
    /// A skill of that name exists that Atelier didn't install: the person is asked before it is overwritten.
    var replacing: (name: String, source: String)?

    init(store: AppStore) { self.store = store }

    var admin: Bool { store.isAdmin }

    private func call(_ method: String, _ params: [String: JSON] = [:]) async throws -> JSON {
        do { return try await store.rpc.call(method, params) } catch { throw CustomizeErrors.translated(error) }
    }

    private var scope: [String: JSON] { folder.map { ["workspaceId": .string($0)] } ?? [:] }

    func load() async {
        if phase != .ready { phase = .loading }
        do {
            skills = try await call("skills.list", scope).array.map(CustomizeSkill.init).sorted(by: CustomizeSkill.precedes)
            // Not every server lists these, and a missing list must not hide the skills.
            commands = []
            if let slash = try? await call("slash.list", scope) { commands = slash.array.filter { $0["kind"].string == "command" }.map(CustomizeCommand.init) }
            if let list = try? await call("workspaces.list") {
                folders = list.array.filter { $0["available"].bool && !$0["scratch"].bool }.map { Folder(id: $0["id"].string, name: $0["name"].string) }
                if let folder, !folders.contains(where: { $0.id == folder }) { self.folder = nil }
            }
            phase = .ready
        } catch is CancellationError {
        } catch {
            if phase == .ready { store.error = CustomizeErrors.message(for: error) }
            else { phase = CustomizeErrors.isUnsupported(error) ? .unsupported : .failed(CustomizeErrors.message(for: error)) }
        }
    }

    func skill(_ name: String) -> CustomizeSkill? { skills.first { $0.name == name } }

    var sourceLooksValid: Bool { CustomizeMarketplace.looksValid(source) }

    func install(_ from: String, replace: Bool) async {
        installing = true; installError = nil
        defer { installing = false }
        do {
            var params: [String: JSON] = ["source": .string(from)]
            if replace { params["replace"] = true }
            let names = try await call("skills.install", params)["installed"].array.compactMap { $0.stringOrNil }
            store.notify(names.count == 1 ? "Installed \(names[0])" : "Installed \(CustomizeText.plural(names.count, "skill"))")
            source = ""
            await load()
        } catch is CancellationError {
        } catch {
            let message = CustomizeErrors.message(for: error)
            if !replace, let name = CustomizeErrors.existingSkill(in: message) { replacing = (name, from) } else { installError = message }
            await load()
        }
    }

    func uninstall(_ skill: CustomizeSkill) async -> Bool {
        let ok = await store.attempt { [self] in _ = try await call("skills.uninstall", ["name": .string(skill.name)]) }
        if ok { store.notify("Uninstalled \(skill.name)") }
        await load()
        return ok
    }
}

// MARK: - Skills

/// Skills: instructions and scripts that conversations load when a task needs them, or that you start with /name.
struct SkillsSettings: View {
    let store: AppStore
    @State private var model: CustomizeSkillsModel
    @State private var opened: String?
    @State private var showCommands = false
    @State private var launched = false
    @State private var query = ""

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: CustomizeSkillsModel(store: store))
    }

    private var grouped: [(CustomizeSkill.Scope, [CustomizeSkill])] {
        CustomizeSkill.Scope.allCases.compactMap { scope in
            let items = model.skills.filter { $0.scope == scope && CustomizeText.matches(query, in: [$0.name, $0.description]) }
            return items.isEmpty ? nil : (scope, items)
        }
    }

    var body: some View {
        SettingsPage(title: "Skills") {
            CustomizeStateRows(phase: model.phase) { Task { await model.load() } }
            if model.phase == .ready { content }
        }
        .searchable(text: $query, prompt: "Search skills")
        .refreshable { await model.load() }
        .task { await model.load(); openLaunchRoute() }
        .navigationDestination(item: $opened) { name in SkillDetailView(model: model, name: name) }
        .navigationDestination(isPresented: $showCommands) { SkillsCommandsView(model: model) }
        .confirmationDialog(model.replacing.map { "Replace \($0.name)?" } ?? "", isPresented: Binding(get: { model.replacing != nil }, set: { if !$0 { model.replacing = nil } }), titleVisibility: .visible, presenting: model.replacing) { taken in
            Button("Replace", role: .destructive) { Task { await model.install(taken.source, replace: true) } }
        } message: { taken in Text("A skill named \(taken.name) is already there, put in place by another tool or by hand. Replacing it overwrites that copy with the one from \(taken.source).") }
    }

    @ViewBuilder private var content: some View {
        if query.isEmpty { Section {
            Text("Instructions and scripts that conversations load when a task needs them, or that you start by typing /name. They come from the folder a conversation works in, from the skills installed for everyone, and from plugins.")
                .font(.footnote).foregroundStyle(Theme.inkMuted)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
        } }
        if !model.folders.isEmpty && query.isEmpty {
            Section {
                PickRow(title: "Project skills from", selection: Binding(get: { model.folder ?? "" }, set: { value in model.folder = value.isEmpty ? nil : value; Task { await model.load() } }),
                        options: [("", "No folder")] + model.folders.map { ($0.id, $0.name) })
            } footer: { Text("A folder's own skills win over the ones installed for everyone.") }
        }
        if !query.isEmpty && grouped.isEmpty {
            Section { EmptyState(title: "Nothing matches", symbol: "magnifyingglass", message: "Try another word.").listRowBackground(Color.clear).listRowSeparator(.hidden) }
        } else if model.skills.isEmpty {
            Section {
                EmptyState(title: "No skills yet", symbol: "text.book.closed", message: model.admin ? "Install some from GitHub below, or add a folder with a SKILL.md to the server." : "An admin can install skills for everyone, and a folder you open can bring its own.")
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        } else {
            ForEach(grouped, id: \.0) { scope, items in
                Section {
                    ForEach(items) { skill in
                        NavigationLink { SkillDetailView(model: model, name: skill.name) } label: { SkillRow(skill: skill) }
                    }
                } header: { Text(scope.sectionTitle) } footer: {
                    if scope == grouped.last?.0 { Text("When two skills share a name, a folder's wins over an installed one, and that over a plugin's.") }
                }
            }
        }
        if !model.commands.isEmpty && query.isEmpty {
            Section {
                Button { showCommands = true } label: { NavRow(symbol: "slash.circle", title: "Commands", subtitle: "Saved prompts you start with /name", value: "\(model.commands.count)") }.buttonStyle(.plain)
            }
        }
        if model.admin && query.isEmpty { installSection }
    }

    private var installSection: some View {
        Group {
            Section {
                FieldRow(placeholder: "owner/repo", text: Bindable(model).source, keyboard: .URL, mono: true)
            } header: { Text("Install from GitHub") } footer: {
                Text("A repository or a folder in one: owner/repo, owner/repo@ref/path or a github.com address. Skills installed with other tools, like npx skills, show up here by themselves; remove those with the tool that installed them.")
            }
            CustomizeSubmitRow(title: "Install", busy: model.installing, enabled: model.sourceLooksValid, error: model.installError) {
                Task { await model.install(model.source.trimmingCharacters(in: .whitespaces), replace: false) }
            }
        }
    }

    private func openLaunchRoute() {
        #if DEBUG
        guard !launched, let route = CustomizeLaunch.route else { return }
        launched = true
        if route.first == "skill", route.count > 1 { opened = route[1] }
        if route.first == "commands" { showCommands = true }
        if route.first == "replace" { model.replacing = (route.count > 1 ? route[1] : "pdf", "anthropics/skills") }
        #endif
    }
}

private struct SkillRow: View {
    let skill: CustomizeSkill
    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: "text.book.closed")
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name).font(.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                if !skill.description.isEmpty { Text(skill.description).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
                if skill.manualOnly || skill.device != nil {
                    Text([skill.manualOnly ? "Only by /\(skill.name)" : nil, skill.device.map { "From \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.inkSecondary).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if !skill.warnings.isEmpty { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.waiting).accessibilityLabel("Has a problem") }
        }
        .contentShape(Rectangle())
    }
}

/// One skill: what it is for, how it starts, where it came from, and (for an admin) uninstalling it.
struct SkillDetailView: View {
    let model: CustomizeSkillsModel
    let name: String
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        if let skill = model.skill(name) {
            SettingsPage(title: skill.name) {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(skill.name).font(.system(.title3, design: .serif, weight: .medium)).lineLimit(3).truncationMode(.middle)
                        HStack(spacing: 6) {
                            StatusBadge(text: skill.scope.title)
                            if skill.manualOnly { StatusBadge(text: "Only by /\(skill.name)", tone: .clay) }
                            if let device = skill.device { StatusBadge(text: "From \(device)") }
                        }
                        if skill.description.isEmpty { Text("This skill has no description.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
                        else { CustomizeProse(text: skill.description) }
                    }.padding(.vertical, 4)
                } footer: {
                    Text(skill.manualOnly
                        ? "Conversations never start it on their own. Type /\(skill.name) at the start of a message to use it."
                        : "A conversation loads it when your request matches. You can also start it by typing /\(skill.name) at the start of a message.")
                }
                if !skill.warnings.isEmpty {
                    Section {
                        ForEach(skill.warnings, id: \.self) { warning in Label(warning, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Theme.ink) }
                    } header: { Text("Problems with its file") }
                }
                if let installed = skill.installed {
                    Section {
                        ValueRow(title: "From", value: installed.source)
                        ValueRow(title: "Version", value: skill.shortSha, mono: true, copyable: true)
                        if let date = CustomizeText.date(iso: installed.installedAt) { ValueRow(title: "Installed", value: date.formatted(date: .abbreviated, time: .omitted)) }
                    } header: { Text("Installed from GitHub") }
                    if model.admin {
                        Section {
                            ActionRow(title: "Uninstall skill", symbol: "trash", destructive: true) { confirming = true }
                        } footer: { Text("Its folder is deleted and conversations stop offering it. You can install it again from \(installed.source).") }
                    }
                } else {
                    Section {
                        ValueRow(title: "Added by", value: "Another tool, or by hand")
                    } footer: { Text("It is removed the same way: with that tool, or by deleting its folder.") }
                }
            }
            .confirmationDialog("Uninstall \(skill.name)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Uninstall", role: .destructive) { Task { if await model.uninstall(skill) { dismiss() } } }
            } message: { Text("Its folder is deleted and conversations stop offering it.") }
        } else {
            SettingsPage(title: "Skill") { EmptyState(title: "This skill is gone", symbol: "text.book.closed", message: "It was uninstalled or its folder is no longer there.") }
        }
    }
}

/// The saved prompts that `/` offers besides the skills: read-only, they live in `commands` folders and in plugins.
struct SkillsCommandsView: View {
    let model: CustomizeSkillsModel
    var body: some View {
        SettingsPage(title: "Commands") {
            Section {
                ForEach(model.commands) { command in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text("/\(command.name)").font(.mono(.subheadline)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                            if let hint = command.argumentHint { Text(hint).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).lineLimit(1) }
                        }
                        if !command.description.isEmpty { Text(command.description).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(3) }
                    }.padding(.vertical, 2)
                }
            } footer: { Text("Type / at the start of a message and pick one. Commands are Markdown files in a commands folder of a project, of the server, or of a plugin.") }
        }
    }
}
