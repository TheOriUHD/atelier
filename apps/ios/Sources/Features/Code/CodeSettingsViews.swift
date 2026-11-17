import SwiftUI

// MARK: - Settings › Code (the person's own)

/// How code looks, which actions the person always allows, and who commits as: the desktop's Settings › Code.
struct CodeSettings: View {
    let store: AppStore
    @State private var prefs: CodePrefs

    init(store: AppStore) {
        self.store = store
        _prefs = State(initialValue: CodePrefs(store: store))
    }

    private func toggle(_ path: [String], default fallback: Bool = false) -> Binding<Bool> {
        Binding(get: { prefs.bool(path, default: fallback) }, set: { value in Task { await prefs.set(path, .bool(value)) } })
    }
    private func choice(_ path: [String], default fallback: String) -> Binding<String> {
        Binding(get: { prefs.string(path, default: fallback) }, set: { value in Task { await prefs.set(path, .string(value)) } })
    }
    private func themeOptions(dark: Bool, current: String) -> [(String, String)] {
        var options = CodeSyntaxTheme.themes(dark: dark).map { ($0.id, $0.label) }
        if !options.contains(where: { $0.0 == current }) { options.append((current, "\(CodeSyntaxTheme.label(forUnknown: current)) (desktop)")) }
        return options
    }

    var body: some View {
        CodeDebugScroll { SettingsPage(title: "Code") {
            if !prefs.loaded {
                CodeLoadingRows(failure: prefs.loadError) { Task { await prefs.load() } }
            } else {
                appearance
                SettingsSection(title: "Reading sessions") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Default transcript view").foregroundStyle(Theme.ink)
                        Picker("Default transcript view", selection: choice(["code", "transcriptView"], default: "normal")) {
                            Text("Normal").tag("normal"); Text("Thinking").tag("thinking"); Text("Verbose").tag("verbose")
                        }.pickerStyle(.segmented)
                        Text("How Code sessions open: tool calls as usual, with thinking expanded, or with every call's details expanded. Each session can switch in its header.")
                            .font(.footnote).foregroundStyle(Theme.inkMuted)
                    }.padding(.vertical, 4)
                    ToggleRow(title: "Suggested replies", subtitle: "After a reply, a short guess at your next message shows in the message box. Tap it to use it.", isOn: toggle(["code", "suggestions"], default: true))
                }
                SettingsSection(title: "Tasks") {
                    ToggleRow(title: "Permanent goal mode", subtitle: "Off by default. Remind the assistant about unfinished todos and carry on automatically while its task list makes progress, up to four times. This can use more tokens, and it stops when the assistant asks you a question.", isOn: toggle(["code", "permanentGoalMode"]))
                }
                permissions
                SettingsSection(title: "Git", footer: "Used for commits you make from a Code session. Empty uses the repository's own git configuration.") {
                    CodeCommitField(title: "Commit author name", placeholder: "From git config", value: prefs.string(["git", "authorName"])) { await prefs.set(["git", "authorName"], .string($0)) }
                    CodeCommitField(title: "Commit author email", placeholder: "From git config", value: prefs.string(["git", "authorEmail"]), keyboard: .emailAddress) { await prefs.set(["git", "authorEmail"], .string($0)) }.id("git")
                }
            }
        } }
        .task { await prefs.load() }
        .refreshable { await prefs.load() }
    }

    @ViewBuilder private var appearance: some View {
        let light = prefs.string(["code", "syntaxTheme", "light"], default: "atelier-light")
        let dark = prefs.string(["code", "syntaxTheme", "dark"], default: "atelier-dark")
        SettingsSection(title: "Code appearance", footer: "Syntax highlighting for code and changes: one theme for the light app theme, one for the dark.") {
            PickRow(title: "Light theme", selection: choice(["code", "syntaxTheme", "light"], default: "atelier-light"), options: themeOptions(dark: false, current: light))
            CodeThemePreview(theme: CodeSyntaxTheme.resolve(light, dark: false)).listRowSeparator(.hidden)
            PickRow(title: "Dark theme", selection: choice(["code", "syntaxTheme", "dark"], default: "atelier-dark"), options: themeOptions(dark: true, current: dark))
            CodeThemePreview(theme: CodeSyntaxTheme.resolve(dark, dark: true)).listRowSeparator(.hidden)
            CodeCommitField(title: "Code font", placeholder: "JetBrains Mono", value: prefs.string(["code", "font"]), mono: true) { await prefs.set(["code", "font"], .string($0)) }
            PickRow(title: "Interface font", subtitle: "For menus and panels in the desktop and web app. This app uses the system fonts.", selection: choice(["appearance", "interfaceFont"], default: "sans"), options: [("sans", "Atelier Sans"), ("system", "System"), ("dyslexic", "OpenDyslexic")])
        }
    }

    @ViewBuilder private var permissions: some View {
        SettingsSection(title: "Permissions") {
            ToggleRow(title: "Explain each change", subtitle: "Before each edit, Atelier says why in one short sentence, and a permission prompt shows it under the title. Every edit uses a few more tokens. New sessions pick this up; a running one keeps what it started with.", isOn: toggle(["code", "explainChanges"])).id("permissions")
        }
        CodeRulesSection(
            title: "Always-allowed actions",
            footer: "What you approved with “Always allow” in a permission prompt. These rules apply in your Code sessions and chats, on top of the rules your admin set. Rules use Claude Code's syntax, like \(CodeRules.example).",
            rules: prefs.list(["permissions", "allow"]), placeholder: CodeRules.example,
            emptyText: "None yet. Choosing “Always allow” on a permission prompt adds one here, or add a rule yourself.",
            fieldTitle: "New always-allowed rule", validate: CodeRules.error,
            save: { await prefs.set(["permissions", "allow"], .array($0.map(JSON.string))) },
            removalNote: "Matching actions will ask you again."
        )
    }
}

// MARK: - Settings › Admin › Code defaults

/// What every Code session on this server may do, and the instructions all of them follow.
struct AdminCodeSettings: View {
    let store: AppStore
    @State private var settings: CodeSystemSettings
    @State private var retention = ""
    @State private var retentionProblem: String?

    init(store: AppStore) {
        self.store = store
        _settings = State(initialValue: CodeSystemSettings(store: store))
    }

    private var modes: [(String, String)] { CodeMode.offered(code: true, planAuto: CodeCapabilities(store: store).planAuto).map { ($0.rawValue, $0.title) } }

    private func toggle(_ path: [String], default fallback: Bool) -> Binding<Bool> {
        Binding(get: { settings.bool(path, default: fallback) }, set: { value in Task { await settings.set(path, .bool(value)) } })
    }
    private func rules(_ kind: String, title: String, footer: String, placeholder: String, validate: @escaping (String) -> String? = CodeRules.error, removalNote: String) -> some View {
        CodeRulesSection(
            title: title, footer: footer, rules: settings.list(["permissions", kind]), placeholder: placeholder,
            emptyText: "No rules.", fieldTitle: "New \(kind) rule", validate: validate,
            save: { await settings.set(["permissions", kind], .array($0.map(JSON.string))) }, removalNote: removalNote
        )
    }

    var body: some View {
        CodeDebugScroll { SettingsPage(title: "Code defaults") {
            if !settings.loaded {
                CodeLoadingRows(failure: settings.loadError) { Task { await settings.load() } }
            } else {
                SettingsSection(title: "Permissions", footer: "The mode new Code sessions and chats start in (a chat that would start in Plan asks instead). People can switch it in each conversation.") {
                    PickRow(title: "Default permission mode", selection: Binding(
                        get: { settings.defaultMode.rawValue },
                        set: { value in Task { await settings.set(["permissions", "defaultMode"], .string(value)) } }), options: modes)
                }
                rules("allow", title: "Allow rules", footer: "Tool calls that match run without asking. Everyone on this server gets these.", placeholder: "Bash(npm test *)", removalNote: "Matching tool calls will ask again.")
                rules("ask", title: "Ask rules", footer: "Tool calls that match always ask first, in every mode.", placeholder: "Bash(git push *)", removalNote: "Matching tool calls stop asking first.")
                rules("deny", title: "Deny rules", footer: "Tool calls that match are blocked, in every mode.", placeholder: "Read(./.env)", removalNote: "Matching tool calls are no longer blocked.")
                rules("additionalDirectories", title: "Additional directories", footer: "Folders sessions may use besides their own folder. Reaching anywhere else asks first.", placeholder: "/srv/shared", validate: CodeRules.directoryError, removalNote: "Reaching it will ask first again.")
                SettingsSection(title: "Instructions", footer: "Instructions every Code session and chat working in a folder follows, for every account. Projects add their own CLAUDE.md and AGENTS.md.") {
                    NavigationLink {
                        CodeTextPage(
                            title: "System AGENTS.md",
                            explanation: "Every Code session on this server follows these instructions, ahead of the ones a project brings.",
                            placeholder: "# Conventions\n\n- Use pnpm, not npm.\n- Run the tests before you commit.",
                            maxCharacters: 60_000,
                            load: { try await codeCall(store, "instructions.get")["content"].string },
                            save: { _ = try await codeCall(store, "instructions.set", ["content": .string($0)]); store.notify("Saved") }
                        )
                    } label: { NavRow(symbol: "doc.text", title: "System AGENTS.md", subtitle: "Instructions for every session") }.id("instructions")
                }
                SettingsSection(title: "Automation") {
                    NavigationLink {
                        CodeTextPage(
                            title: "Hooks",
                            explanation: "Commands that run at points of every Code session and chat task on this computer, in Claude Code's settings format. Projects bring their own in .atelier or .claude settings.",
                            placeholder: "{\n  \"PreToolUse\": [{\n    \"matcher\": \"Bash\",\n    \"hooks\": [{ \"type\": \"command\", \"command\": \"…\" }]\n  }]\n}",
                            maxCharacters: 100_000,
                            load: {
                                let json = settings.value(["hooks"])
                                return json == .null ? "{}" : json.pretty
                            },
                            check: { CodeHooks.parse($0).problem },
                            notes: CodeHooks.notes,
                            save: { text in
                                guard let value = CodeHooks.parse(text).value else { throw MobileError.message(CodeHooks.format) }
                                guard await settings.set(["hooks"], value) else { throw MobileError.message("The server did not accept these hooks.") }
                                store.notify("Saved")
                            }
                        )
                    } label: { NavRow(symbol: "bolt", title: "Hooks", subtitle: "Commands at points of a session") }
                    retentionRow.id("automation")
                }
                SettingsSection(title: "Effort", footer: "The last effort level in Code: the model plans, has sub-agents investigate and check its work, and uses far more tokens. Off, sessions that chose it run at Extra.") {
                    ToggleRow(title: "Ultracode", isOn: toggle(["ultracode", "enabled"], default: true))
                }
                SettingsSection(title: "Compatibility", footer: "Also read what projects and your home folder keep for Claude Code: CLAUDE.md and rules, .claude/settings.json permission rules and hooks, and the skills, commands, agents and plugins in .claude folders.") {
                    ToggleRow(title: "Claude Code compatibility", isOn: toggle(["compat", "claudeCode"], default: true)).id("compat")
                }
            }
        } }
        .task { await settings.load(); retention = String(settings.value(["checkpoints", "retentionDays"]).intOrNil ?? 30) }
        .refreshable { await settings.load() }
    }

    private var retentionRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keep checkpoints for").foregroundStyle(Theme.ink)
                    Text("How long file versions are kept for rewinding Code sessions.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 8)
                TextField("30", text: $retention)
                    .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 64)
                    .onSubmit { Task { await saveRetention() } }
                    .onChange(of: retention) { _, _ in retentionProblem = nil }
                Text("days").foregroundStyle(Theme.inkMuted)
            }
            if let retentionProblem { Text(retentionProblem).font(.footnote).foregroundStyle(Theme.danger) }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { Task { await saveRetention() } } }
        }
        .onDisappear { Task { await saveRetention() } }
    }

    private func saveRetention() async {
        let current = settings.value(["checkpoints", "retentionDays"]).intOrNil ?? 30
        guard retention != String(current) else { return }
        guard let days = Int(retention), (1...3650).contains(days) else { retentionProblem = "Enter whole days, 1 to 3650."; return }
        if await settings.set(["checkpoints", "retentionDays"], .number(Double(days))) { store.notify("Saved") }
        else { retention = String(current) }
    }
}
