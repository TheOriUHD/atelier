import SwiftUI

// MARK: - Pieces the Code settings pages share

/// A list of permission rules in Claude Code's syntax: the rules, a field to add one (checked as it is typed), and a
/// confirmation before one is removed.
struct CodeRulesSection: View {
    let title: String
    var footer: String?
    let rules: [String]
    let placeholder: String
    let emptyText: String
    var fieldTitle: String
    let validate: (String) -> String?
    let save: ([String]) async -> Bool
    /// What happens when a rule is removed, in the confirmation ("It will ask again").
    var removalNote = "It stops applying."

    @State private var draft = ""
    @State private var busy = false
    @State private var removing: Int?

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var problem: String? {
        guard !trimmed.isEmpty else { return nil }
        if let message = validate(trimmed) { return message }
        if rules.contains(trimmed) { return "That one is already in the list." }
        return nil
    }

    var body: some View {
        SettingsSection(title: title, footer: footer) {
            if rules.isEmpty {
                Text(emptyText).font(.subheadline).foregroundStyle(Theme.inkMuted)
            }
            ForEach(Array(rules.enumerated()), id: \.offset) { index, rule in
                HStack(spacing: 10) {
                    Text(rule).font(.mono(.subheadline)).foregroundStyle(Theme.ink).textSelection(.enabled)
                    Spacer(minLength: 0)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Remove", role: .destructive) { removing = index }
                }
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = rule }
                    Button("Remove", systemImage: "trash", role: .destructive) { removing = index }
                }
                .accessibilityAction(named: "Remove") { removing = index }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    TextField(placeholder, text: $draft)
                        .font(.mono(.body))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(add)
                        .accessibilityLabel(fieldTitle)
                    Button(action: add) {
                        if busy { ProgressView() } else { Text("Add").font(.body.weight(.semibold)) }
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.clay)
                    .disabled(trimmed.isEmpty || problem != nil || busy)
                    .opacity(trimmed.isEmpty || problem != nil ? 0.4 : 1)
                }
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
            }
            .id("rules-" + title.lowercased().replacingOccurrences(of: " ", with: "-"))
        }
        .confirmationDialog(removing.flatMap { rules.indices.contains($0) ? rules[$0] : nil } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove rule", role: .destructive) {
                guard let index = removing, rules.indices.contains(index) else { return }
                var next = rules; next.remove(at: index)
                removing = nil
                Task { busy = true; _ = await save(next); busy = false }
            }
        } message: { Text(removalNote) }
    }

    private func add() {
        guard !trimmed.isEmpty, problem == nil else { return }
        let rule = trimmed
        Task {
            busy = true
            if await save(rules + [rule]) { draft = "" }
            busy = false
        }
    }
}

/// A line of text saved when it is submitted or when the person leaves the page, with the empty value falling back to a default.
struct CodeCommitField: View {
    let title: String
    let placeholder: String
    let value: String
    var keyboard: UIKeyboardType = .default
    var mono = false
    let commit: (String) async -> Bool
    @State private var text = ""
    @State private var edited = false

    var body: some View {
        FieldRow(title: title, placeholder: placeholder, text: $text, keyboard: keyboard, mono: mono)
            .onSubmit { Task { await save() } }
            .onChange(of: text) { _, new in edited = new != value }
            .onChange(of: value) { _, new in if !edited { text = new } }
            .onAppear { text = value }
            .onDisappear { if edited { Task { await save() } } }
    }

    private func save() async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean != value else { edited = false; return }
        if await commit(clean) { text = clean; edited = false }
    }
}

/// A small edit drawn in one syntax theme, whatever the app theme is: line numbers, the +/- gutter, colored code.
struct CodeThemePreview: View {
    let theme: CodeSyntaxTheme
    private static let sample = ["function greet(name: string) {", "  return 'Hello, ' + name;", "  return `Hello, ${name}!`;", "}"]
    private static let marks: [(Int, Character)] = [(1, " "), (2, "-"), (2, "+"), (3, " ")]

    var body: some View {
        let lines = CodeSyntax.highlight(Self.sample, language: "typescript", theme: theme)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                let (number, mark) = Self.marks[index]
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("\(number)").frame(width: 30, alignment: .trailing).foregroundStyle(mark == "-" ? Theme.danger : mark == "+" ? Theme.success : theme.color(.comment))
                    Text(mark == " " ? "" : String(mark)).frame(width: 22).foregroundStyle(mark == "-" ? Theme.danger : Theme.success)
                    Text(line).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 12.5, design: .monospaced))
                .padding(.vertical, 1.5).padding(.trailing, 8)
                .background(mark == "-" ? Theme.removed : mark == "+" ? Theme.added : .clear)
            }
        }
        .padding(.vertical, 8)
        .background(theme.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of \(theme.label)")
    }
}

/// A long text kept on the server (the system AGENTS.md, the hooks): read, edited, saved explicitly.
struct CodeTextPage: View {
    let title: String
    var explanation: String
    var placeholder: String
    var maxCharacters: Int
    var mono = true
    let load: () async throws -> String
    /// Returns a problem in words when the text can't be saved yet, nil when it can.
    var check: (String) -> String? = { _ in nil }
    var notes: (String) -> [String] = { _ in [] }
    let save: (String) async throws -> Void

    @State private var saved: String?
    @State private var text = ""
    @State private var failure: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var dirty: Bool { saved != nil && text != saved }
    private var problem: String? { dirty ? check(text) : nil }
    private var tooLong: Bool { text.count > maxCharacters }

    var body: some View {
        VStack(spacing: 0) {
            if let failure, saved == nil {
                InlineError(message: failure) { Task { await reload() } }.frame(maxHeight: .infinity)
            } else if saved == nil {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(explanation).font(.footnote).foregroundStyle(Theme.inkMuted)
                        ZStack(alignment: .topLeading) {
                            TextEditor(text: $text)
                                .font(mono ? .mono(.callout) : .body)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .scrollContentBackground(.hidden)
                                .focused($focused)
                                .frame(minHeight: 320)
                                .padding(10)
                            if text.isEmpty {
                                Text(placeholder).font(mono ? .mono(.callout) : .body).foregroundStyle(Theme.inkMuted.opacity(0.7)).padding(.horizontal, 15).padding(.vertical, 18).allowsHitTesting(false)
                            }
                        }
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(problem == nil && !tooLong ? Theme.hairline : Theme.danger.opacity(0.7), lineWidth: 0.8))
                        HStack {
                            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
                            else if tooLong { Text("This is \(text.count - maxCharacters) characters over the limit.").font(.footnote).foregroundStyle(Theme.danger) }
                            Spacer()
                            Text("\(text.count.formatted()) of \(maxCharacters.formatted())").font(.footnote.monospacedDigit()).foregroundStyle(tooLong ? Theme.danger : Theme.inkMuted)
                        }
                        ForEach(notes(text), id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.inkMuted) }
                        if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .background(Theme.sunken)
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .confirmationAction) {
                if dirty { Button("Discard") { text = saved ?? ""; failure = nil }.tint(Theme.inkSecondary) }
                Button {
                    Task { await commit() }
                } label: { if saving { ProgressView() } else { Text("Save").fontWeight(.semibold) } }
                    .disabled(!dirty || saving || problem != nil || tooLong)
            }
        }
        .task { if saved == nil { await reload() } }
    }

    private func reload() async {
        failure = nil
        do { let value = try await load(); saved = value; text = value }
        catch is CancellationError { return }
        catch { failure = error.localizedDescription }
    }

    private func commit() async {
        saving = true; failure = nil
        defer { saving = false }
        do { try await save(text); saved = text; focused = false }
        catch is CancellationError { return }
        catch { failure = error.localizedDescription }
    }
}

/// Hooks in Claude Code's settings format, read so a mistake is named before it is saved.
enum CodeHooks {
    static let events = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"]
    static let format = "This isn't Claude Code's hooks format: { \"PreToolUse\": [{ \"matcher\": \"Bash\", \"hooks\": [{ \"type\": \"command\", \"command\": \"…\" }] }] }"

    /// The parsed hooks, or why the text isn't hooks.
    static func parse(_ text: String) -> (value: JSON?, problem: String?) {
        guard let data = text.data(using: .utf8), let json = try? JSONDecoder().decode(JSON.self, from: data) else { return (nil, "This isn't valid JSON.") }
        guard case .object(let object) = json else { return (nil, format) }
        for (_, groups) in object {
            guard case .array(let list) = groups else { return (nil, format) }
            for group in list {
                guard case .object = group, case .array(let hooks) = group["hooks"] else { return (nil, format) }
                for hook in hooks { guard case .string = hook["type"] else { return (nil, format) } }
                if group["matcher"] != .null, group["matcher"].stringOrNil == nil { return (nil, format) }
            }
        }
        return (json, nil)
    }

    /// Events and handler types Atelier parses but doesn't run, named so nobody waits for them to fire.
    static func notes(_ text: String) -> [String] {
        guard case .object(let object)? = parse(text).value else { return [] }
        var notes: [String] = []
        for (event, groups) in object.sorted(by: { $0.key < $1.key }) {
            if !events.contains(event) { notes.append("\(event) hooks don't run in Atelier."); continue }
            let types = Set(groups.array.flatMap { $0["hooks"].array.map { $0["type"].string } })
            for type in types.sorted() where type != "command" { notes.append("“\(type)” hooks under \(event) don't run in Atelier; only “command” hooks do.") }
        }
        return notes
    }
}

/// Loads something and shows it as a section: a spinner row, the failure with Retry, or the content.
struct CodeLoadingRows: View {
    let failure: String?
    let retry: () -> Void
    var body: some View {
        if let failure {
            InlineError(message: failure, retry: retry).listRowBackground(Color.clear)
        } else {
            HStack { Spacer(); ProgressView().controlSize(.large); Spacer() }.frame(minHeight: 160).listRowBackground(Color.clear)
        }
    }
}

/// Debug builds opened with `--code-scroll <id>` scroll a settings page to the row with that id, to look at what is below the fold.
struct CodeDebugScroll<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        #if DEBUG
        ScrollViewReader { proxy in
            content.task {
                guard let id = Launch.value("--code-scroll") else { return }
                try? await Task.sleep(for: .milliseconds(1500))
                proxy.scrollTo(id, anchor: .center)
            }
        }
        #else
        content
        #endif
    }
}
