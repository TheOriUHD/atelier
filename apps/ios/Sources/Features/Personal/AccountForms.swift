import SwiftUI

// MARK: - Account: change password, approve another device's sign-in, text editors, personality

/// Why a new password can't be used yet, or nil. The server needs 8 to 256 characters.
enum PersonalPassword {
    static func problem(current: String, next: String, confirm: String, needsCurrent: Bool) -> String? {
        if needsCurrent && current.isEmpty { return "Enter your current password." }
        if next.count < 8 { return "Use at least 8 characters." }
        if next.count > 256 { return "Use at most 256 characters." }
        if confirm != next { return "The two passwords don't match." }
        return nil
    }
}

struct PersonalChangePasswordPage: View {
    let store: AppStore
    let account: JSON
    var done: () async -> Void = {}
    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var tried = false
    @Environment(\.dismiss) private var dismiss
    private var hasPassword: Bool { account["hasPassword"].boolOrNil ?? true }
    private var problem: String? { PersonalPassword.problem(current: current, next: next, confirm: confirm, needsCurrent: hasPassword) }

    var body: some View {
        PersonalPage(title: hasPassword ? "Change password" : "Set a password") {
            Section {
                if hasPassword { FieldRow(title: account["mustChangePassword"].bool ? "Temporary password" : "Current password", placeholder: "Current password", text: $current, secure: true).textContentType(.password) }
                FieldRow(title: "New password", placeholder: "At least 8 characters", text: $next, secure: true).textContentType(.newPassword)
                FieldRow(title: "New password again", placeholder: "Repeat the new password", text: $confirm, secure: true).textContentType(.newPassword)
                if tried, let message = failure ?? problem { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
            } footer: {
                Text(hasPassword ? "You stay signed in here. Everywhere else you are signed out." : "The desktop app signs in with it. You stay signed in here.")
            }
            Section {
                Button(hasPassword ? "Change password" : "Set password") { submit() }
                    .buttonStyle(ClayButtonStyle(busy: busy)).disabled(busy || (tried && problem != nil)).personalButtonRow()
            }
        }
    }

    private func submit() {
        tried = true; failure = nil
        guard problem == nil else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await store.rpc.call("account.changePassword", ["current": .string(current), "next": .string(next)])
                store.notify(hasPassword ? "Password changed" : "Password set")
                await done()
                dismiss()
            } catch is CancellationError { return } catch { failure = PersonalFailure.text(error) }
        }
    }
}

/// The 8-symbol code a terminal or another app shows: typed in any case, with or without the dash.
enum PersonalTerminalCode {
    static func normalize(_ input: String) -> String? {
        let dashes = CharacterSet(charactersIn: "-\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}")
        let code = String(input.uppercased().unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && !dashes.contains($0) }.map { Character($0) })
            .replacingOccurrences(of: "O", with: "0").replacingOccurrences(of: "I", with: "1").replacingOccurrences(of: "L", with: "1")
        return code.range(of: "^[0-9A-HJKMNP-TV-Z]{8}$", options: .regularExpression) != nil ? code : nil
    }

    /// "K7QF3MZD" as "K7QF-3MZD".
    static func display(_ code: String) -> String { code.count == 8 ? "\(code.prefix(4))-\(code.suffix(4))" : code }

    /// "2 minutes ago", "just now".
    static func ago(_ at: Date, now: Date = .now) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(at)))
        if seconds < 60 { return seconds <= 1 ? "just now" : "\(seconds) seconds ago" }
        let minutes = Int((Double(seconds) / 60).rounded())
        return minutes == 1 ? "a minute ago" : "\(minutes) minutes ago"
    }
}

struct PersonalApproveSignInPage: View {
    let store: AppStore
    private enum Step: Equatable { case code, looking, ask(JSON), deciding(JSON, Bool), approved(JSON), denied }
    @State private var step: Step = .code
    @State private var code = ""
    @State private var failure: String?
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PersonalPage(title: "Approve a sign-in") {
            switch step {
            case .code, .looking: codeSection
            case .ask(let request): askSections(request, deciding: nil)
            case .deciding(let request, let approve): askSections(request, deciding: approve)
            case .approved(let request): resultSection(symbol: "checkmark.circle", tint: Theme.success, title: "\(request["deviceName"].string) is signed in", text: "It is signed in as you. It shows under Account › Active sessions, where you can sign it out.")
            case .denied: resultSection(symbol: "xmark.circle", tint: Theme.inkSecondary, title: "Sign-in denied", text: "That device is not signed in. If it was yours, start the sign-in there again.")
            }
        }
        #if DEBUG
        .task { if let value = Launch.value("--code"), step == .code { code = value; lookUp() } }
        #endif
    }

    private var codeSection: some View {
        Group {
            Section {
                TextField("K7QF-3MZD", text: $code)
                    .font(.mono(.title3)).textInputAutocapitalization(.characters).autocorrectionDisabled().focused($focused)
                    .submitLabel(.go).onSubmit { lookUp() }
                    .accessibilityLabel("Code")
                if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
                PasteButton(payloadType: String.self) { strings in
                    if let text = strings.first { code = text; lookUp() }
                }.labelStyle(.titleAndIcon).tint(Theme.clay)
            } header: { Text("Code") } footer: {
                Text("Enter the code a terminal shows after `atelier login`, or another Atelier app that asks to be signed in as you.")
            }
            Section {
                Button("Continue") { lookUp() }.buttonStyle(ClayButtonStyle(busy: step == .looking)).disabled(step == .looking || code.trimmingCharacters(in: .whitespaces).isEmpty).personalButtonRow()
            }
        }
    }

    @ViewBuilder private func askSections(_ request: JSON, deciding: Bool?) -> some View {
        Section {
            ValueRow(title: "Code", value: request["code"].string, mono: true)
            ValueRow(title: "Device", value: [request["deviceName"].string, request["platform"].string].filter { !$0.isEmpty }.joined(separator: " · "))
            ValueRow(title: "From", value: request["ip"].string.isEmpty ? "Unknown address" : request["ip"].string, mono: true)
            ValueRow(title: "Asked", value: request["createdAt"].date.map { PersonalTerminalCode.ago($0) } ?? "")
        } header: { Text("Sign in “\(request["deviceName"].string)”?") } footer: {
            Text("It will work as you: your sessions, your models and the folders you open in it.")
        }
        Section {
            Label { Text("Only approve a device you just started yourself, showing this same code. Someone who sends you a code is asking for your account.").font(.subheadline).foregroundStyle(Theme.ink) }
                icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.waiting) }
        }.listRowBackground(Theme.waiting.opacity(0.14))
        if let failure { Section { Text(failure).font(.footnote).foregroundStyle(Theme.danger) } }
        Section {
            Button("Approve") { decide(request, approve: true) }.buttonStyle(ClayButtonStyle(busy: deciding == true)).disabled(deciding != nil).personalButtonRow()
            Button("Deny") { decide(request, approve: false) }.buttonStyle(QuietButtonStyle()).disabled(deciding != nil).personalButtonRow()
        }
    }

    private func resultSection(symbol: String, tint: Color, title: String, text: String) -> some View {
        Group {
            Section {
                VStack(spacing: 14) {
                    Image(systemName: symbol).font(.system(size: 40, weight: .light)).foregroundStyle(tint)
                    Text(title).font(.system(.title3, design: .serif, weight: .medium)).multilineTextAlignment(.center)
                    Text(text).font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.vertical, 12)
            }.personalButtonRow()
            Section { Button("Done") { dismiss() }.buttonStyle(QuietButtonStyle()).personalButtonRow() }
        }
    }

    private func lookUp() {
        failure = nil
        guard let normalized = PersonalTerminalCode.normalize(code) else { failure = "A code has 8 letters and digits, like K7QF-3MZD."; return }
        step = .looking
        Task {
            do { step = .ask(try await store.rpc.call("auth.terminalRequest", ["code": .string(PersonalTerminalCode.display(normalized))])) }
            catch is CancellationError { step = .code } catch { step = .code; failure = PersonalFailure.text(error) }
        }
    }

    private func decide(_ request: JSON, approve: Bool) {
        failure = nil
        step = .deciding(request, approve)
        Task {
            do {
                _ = try await store.rpc.call("auth.terminalDecide", ["code": request["code"], "approve": .bool(approve)])
                step = approve ? .approved(request) : .denied
            } catch is CancellationError { step = .ask(request) } catch { step = .ask(request); failure = PersonalFailure.text(error) }
        }
    }
}

extension View {
    /// A clear row for a full-width button.
    func personalButtonRow() -> some View { listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0)).listRowSeparator(.hidden) }
}

// MARK: Text editor sheet

/// A sheet with a text box, Cancel and Save: for instructions and the person's ATELIER.md.
struct PersonalTextEditorSheet: View {
    let title: String
    let max: Int
    var mono = false
    var placeholder = ""
    var footer = ""
    let save: (String) async -> Bool
    @State private var draft: String
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(title: String, text: String, max: Int, mono: Bool = false, placeholder: String = "", footer: String = "", save: @escaping (String) async -> Bool) {
        self.title = title; self.max = max; self.mono = mono; self.placeholder = placeholder; self.footer = footer; self.save = save
        _draft = State(initialValue: text)
        self.original = text
    }
    private let original: String
    private var tooLong: Bool { draft.count > max }

    var body: some View {
        NavigationStack {
            PersonalPage(title: title) {
                Section {
                    PersonalTextBox(title: title, text: $draft, placeholder: placeholder, minHeight: 280, mono: mono)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if !footer.isEmpty { Text(footer) }
                        Text("\(PersonalUsage.number(draft.count)) of \(PersonalUsage.number(max)) characters").monospacedDigit().foregroundStyle(tooLong ? Theme.danger : Theme.inkMuted)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saving = true; Task { let ok = await save(draft); saving = false; if ok { dismiss() } } }
                        .disabled(saving || tooLong || draft == original)
                }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }
}

// MARK: Personality

enum PersonalPersonality {
    static let presets: [(id: String, name: String, detail: String)] = [
        ("atelier", "Atelier", "Helpful and pragmatic"), ("technical", "Technical", "Precise and earnest"), ("relaxed", "Relaxed", "Casual, more emoji"),
    ]
    static let limit = 20
    static let nameMax = 80
    static let instructionsMax = 4_000

    static func modes(in value: JSON) -> [JSON] { value["customModes"].array }

    static func selected(in value: JSON) -> String { value["selected"].stringOrNil ?? "atelier" }

    static func name(of value: JSON) -> String {
        let id = selected(in: value)
        if let preset = presets.first(where: { $0.id == id }) { return preset.name }
        return modes(in: value).first { "custom:\($0["id"].string)" == id }?["name"].stringOrNil ?? "Atelier"
    }

    static func value(selected: String, modes: [JSON]) -> JSON { .object(["selected": .string(selected), "customModes": .array(modes)]) }

    static func problem(name: String, instructions: String) -> String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name the mode." }
        if name.count > nameMax { return "Use at most \(nameMax) characters for the name." }
        if instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Describe the style." }
        if instructions.count > instructionsMax { return "Use at most \(PersonalUsage.number(instructionsMax)) characters." }
        return nil
    }
}

struct PersonalPersonalityPage: View {
    let prefs: PersonalPrefs
    @State private var editing: JSON?
    @State private var removing: JSON?
    private var value: JSON { prefs.value(["personalization", "personality"]) }
    private var selected: String { PersonalPersonality.selected(in: value) }

    var body: some View {
        PersonalPage(title: "Personality") {
            Section {
                ForEach(PersonalPersonality.presets, id: \.id) { preset in
                    choice(title: preset.name, detail: preset.detail, id: preset.id)
                }
            } header: { Text("Styles") } footer: { Text("Communication style only, not model identity. Applies to new conversations; response style stays independent.") }
            let modes = PersonalPersonality.modes(in: value)
            Section {
                ForEach(modes, id: \.self) { mode in
                    choice(title: mode["name"].string, detail: mode["instructions"].string, id: "custom:\(mode["id"].string)")
                        .swipeActions {
                            Button("Delete", role: .destructive) { removing = mode }
                            Button("Edit") { editing = mode }.tint(Theme.inkSecondary)
                        }
                        .contextMenu {
                            Button("Edit", systemImage: "pencil") { editing = mode }
                            Button("Delete", systemImage: "trash", role: .destructive) { removing = mode }
                        }
                }
                ActionRow(title: "Add a custom mode", symbol: "plus") { editing = .object(["id": .string(UUID().uuidString), "name": "", "instructions": ""]) }
                    .disabled(modes.count >= PersonalPersonality.limit)
            } header: { Text("Your own") } footer: {
                Text(modes.isEmpty ? "Write your own style, such as a patient tutor. Up to \(PersonalPersonality.limit) modes." : "Swipe a mode to edit or delete it.")
            }
        }
        .sheet(item: Binding(get: { editing.map { PersonalModeDraft(mode: $0) } }, set: { editing = $0?.mode })) { draft in
            PersonalModeEditor(mode: draft.mode, isNew: !PersonalPersonality.modes(in: value).contains { $0["id"] == draft.mode["id"] }) { saved in
                var modes = PersonalPersonality.modes(in: value)
                if let index = modes.firstIndex(where: { $0["id"] == saved["id"] }) { modes[index] = saved } else { modes.append(saved) }
                return await prefs.set(["personalization", "personality"], PersonalPersonality.value(selected: "custom:\(saved["id"].string)", modes: modes))
            }
        }
        .confirmationDialog(removing.map { "Delete “\($0["name"].string)”?" } ?? "Delete mode?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { mode in
            Button("Delete mode", role: .destructive) {
                let modes = PersonalPersonality.modes(in: value).filter { $0["id"] != mode["id"] }
                let keep = selected == "custom:\(mode["id"].string)" ? "atelier" : selected
                Task { await prefs.set(["personalization", "personality"], PersonalPersonality.value(selected: keep, modes: modes)) }
            }
        } message: { _ in Text("New conversations go back to the style you had before.") }
    }

    private func choice(title: String, detail: String, id: String) -> some View {
        Button { Task { await prefs.set(["personalization", "personality"], PersonalPersonality.value(selected: id, modes: PersonalPersonality.modes(in: value))) } } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(detail).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                }
                Spacer(minLength: 8)
                if selected == id { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.clay) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected == id ? .isSelected : [])
    }
}

private struct PersonalModeDraft: Identifiable { let mode: JSON; var id: String { mode["id"].string } }

private struct PersonalModeEditor: View {
    let mode: JSON
    let isNew: Bool
    let save: (JSON) async -> Bool
    @State private var name: String
    @State private var instructions: String
    @State private var saving = false
    @State private var tried = false
    @Environment(\.dismiss) private var dismiss

    init(mode: JSON, isNew: Bool, save: @escaping (JSON) async -> Bool) {
        self.mode = mode; self.isNew = isNew; self.save = save
        _name = State(initialValue: mode["name"].string)
        _instructions = State(initialValue: mode["instructions"].string)
    }
    private var problem: String? { PersonalPersonality.problem(name: name, instructions: instructions) }

    var body: some View {
        NavigationStack {
            PersonalPage(title: isNew ? "Add custom mode" : "Edit custom mode") {
                Section {
                    FieldRow(title: "Mode name", placeholder: "For example: Patient tutor", text: $name, autocapitalize: true)
                } header: { Text("Name") }
                Section {
                    PersonalTextBox(title: "Style instructions", text: $instructions, placeholder: "For example: Be a patient tutor. Ask one guiding question at a time.", minHeight: 160)
                } header: { Text("Style instructions") } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Communication style only, not a different model or identity. Up to \(PersonalUsage.number(PersonalPersonality.instructionsMax)) characters.")
                        if tried, let problem { Text(problem).foregroundStyle(Theme.danger) }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save mode") {
                        tried = true
                        guard problem == nil else { return }
                        saving = true
                        Task {
                            let saved = JSON.object(["id": mode["id"], "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "instructions": .string(instructions.trimmingCharacters(in: .whitespacesAndNewlines))])
                            let ok = await save(saved); saving = false; if ok { dismiss() }
                        }
                    }.disabled(saving)
                }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }
}
