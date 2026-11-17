import SwiftUI

/// A question or request the assistant is waiting on: a permission to allow, a choice to make, a plan to approve, a
/// folder to move to or a form to fill. At the end of the conversation, and the one thing on screen that needs you.
struct InteractionView: View {
    let store: AppStore
    let pending: JSON
    @State private var sending = false
    @State private var preview: JSON?
    @State private var previewing = false
    private var hub: ChatHub { ChatHub.of(store) }
    private var payload: JSON { pending["payload"] }
    private var session: Conversation? { store.sessions.first { $0.id == store.selected } }
    private var tool: String { payload["toolName"].string }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !mayAnswer { waiting }
            else if pending["kind"].string == "question" { ChatQuestionCard(payload: payload, sending: sending, respond: respond) }
            else if pending["kind"].string == "elicitation" {
                header("\(payload["server"].string.isEmpty ? "A connector" : payload["server"].string) asks for information", "questionmark.bubble")
                ElicitationForm(payload: payload, submit: respond, busy: sending)
            }
            else if tool == "ExitPlanMode" { ChatPlanCard(store: store, payload: payload, sending: sending, respond: respond) }
            else if tool == "ChangeDirectory" { ChatFolderCard(payload: payload, sending: sending, respond: respond) }
            else if tool == "AddConnector" { ChatConnectorCard(payload: payload, sending: sending, respond: respond) }
            else if tool == "ComputerAccess" || tool == "FullControl" || tool == "ComputerAction" || tool == "OpenApp" { ChatComputerCard(payload: payload, tool: tool, sending: sending, respond: respond) }
            else { ChatPermissionCard(store: store, pending: pending, session: session, sending: sending, respond: respond) }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.clay.opacity(0.45), lineWidth: 1))
        .shadow(color: Theme.clay.opacity(0.10), radius: 14, y: 4)
        .disabled(!store.connected)
        .accessibilityElement(children: .contain)
    }

    private func header(_ title: String, _ icon: String) -> some View {
        Label { Text(title).font(.system(.headline)).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: icon).foregroundStyle(Theme.clay) }
    }

    // MARK: co-op

    private var coopState: JSON { hub.coop[store.selected ?? ""] ?? .null }
    /// Whoever owns what is at risk approves it; a trusted guest may answer the host's.
    private var mayAnswer: Bool {
        guard coopState != .null, session?.isShared == true else { return true }
        let approver = pending["approver"].string.isEmpty ? coopState["participants"].array.first { $0["role"].string == "host" }?["id"].string ?? "" : pending["approver"].string
        let me = coopState["me"].string
        if approver.isEmpty || approver == me { return true }
        let mine = coopState["participants"].array.first { $0["id"].string == me }
        return mine?["trusted"].bool == true && coopState["role"].string != "viewer" && approver == (coopState["participants"].array.first { $0["role"].string == "host" }?["id"].string ?? "")
    }

    @ViewBuilder private var waiting: some View {
        let approverID = pending["approver"].string.isEmpty ? (coopState["participants"].array.first { $0["role"].string == "host" }?["id"].string ?? "") : pending["approver"].string
        let name = coopState["participants"].array.first { $0["id"].string == approverID }?["name"].string ?? "the host"
        header("Waiting for \(name) to approve", "hourglass")
        Text(ChatPermissionCard.title(payload, kind: pending["kind"].string)).font(.subheadline).foregroundStyle(Theme.inkSecondary)
        if pending["expiresAt"].double > 0 {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = max(0, pending["expiresAt"].double / 1000 - context.date.timeIntervalSince1970)
                Text(left > 0 ? "It is declined in \(ChatText.elapsed(left * 1000)) unless \(name) answers." : "No answer from \(name): it is declined.").font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
            }
        }
    }

    private func respond(_ answer: JSON) {
        guard !sending else { return }
        sending = true
        Task {
            defer { sending = false }
            do { _ = try await store.rpc.call("chat.respond", ["sessionId": .string(store.selected ?? ""), "interactionId": pending["id"], "answer": answer]) }
            catch is CancellationError { return }
            catch {
                // Answered from another device, or the run stopped: the card goes with the next event.
                if error.localizedDescription.contains("already answered") { return }
                store.error = ChatError.text(error)
            }
        }
    }
}

// MARK: - Permission

struct ChatPermissionCard: View {
    let store: AppStore
    let pending: JSON
    let session: Conversation?
    let sending: Bool
    let respond: (JSON) -> Void
    @State private var reasonOpen = false
    @State private var reason = ""
    @State private var whole: JSON?
    private var payload: JSON { pending["payload"] }
    private var tool: String { payload["toolName"].string }
    private var rule: String { payload["suggestedRule"].string }
    private var rememberable: Bool { payload["warning"].string.isEmpty && !rule.isEmpty }
    private var guest: Bool { session?.isGuest == true }
    private var inProject: Bool { session?.workspaceID != nil }
    private var changes: Bool { tool == "Edit" || tool == "Write" }

    static func title(_ payload: JSON, kind: String = "permission") -> String {
        if kind == "question" { return "Atelier asked a question." }
        if kind == "elicitation" { return "A connector asks for input." }
        let input = payload["input"]
        let who = payload["agent"].string.isEmpty ? "Atelier" : "sub-agent \"\(payload["agent"].string)\""
        func path() -> String { (input["file_path"].string as NSString).lastPathComponent }
        switch payload["toolName"].string {
        case "Bash":
            let what = input["description"].string.trimmingCharacters(in: .whitespaces)
            return "Allow \(who) to run \(!what.isEmpty && payload["agent"].string.isEmpty ? what : "this command")?"
        case "Edit": return "Allow \(who) to edit \(path())?"
        case "Write": return "Allow \(who) to write \(path())?"
        case "GenerateImage": return "Allow \(who) to make \(input["count"].int > 1 ? "\(input["count"].int) images" : "an image")?"
        case "GenerateVideo": return "Allow \(who) to make a video? It can take minutes and cost more than an image."
        case "GenerateAudio": return "Allow \(who) to make \(input["kind"].string == "music" ? "music" : input["kind"].string == "sound" ? "a sound effect" : "speech")?"
        case "SaveImage", "SaveVideo", "SaveAudio": return "Allow \(who) to save \(path())?"
        case "WebFetch": return "Allow \(who) to open \(URL(string: input["url"].string)?.host ?? "a web page")?"
        default:
            let name = payload["toolName"].string
            let lent = name.range(of: #"^coop_[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?__(.+)$"#, options: .regularExpression).map { String(name[$0]).components(separatedBy: "__").last ?? name }
            return "Allow \(who) to use \(lent ?? ToolInfo(.object(["name": .string(name)])).verb)?"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label { Text(Self.title(payload)).font(.system(.headline)).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "hand.raised").foregroundStyle(Theme.clay) }
            if !payload["warning"].string.isEmpty {
                Label(payload["warning"].string, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
            if changes, !changeReason.isEmpty { Text(changeReason).font(.subheadline).foregroundStyle(Theme.inkSecondary).lineLimit(4) }
            preview
            if !payload["reason"].string.isEmpty, !payload["reason"].string.hasSuffix("needs your approval.") { Text(payload["reason"].string).font(.footnote).foregroundStyle(Theme.inkMuted) }
            if changes { Button("See the whole file") { openWhole() }.font(.subheadline.weight(.medium)).tint(Theme.clay) }
            if reasonOpen {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Tell Atelier why, or what to do instead", text: $reason, axis: .vertical).lineLimit(1...4).padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    Button("Send") { respond(.object(["behavior": .string("deny"), "message": .string(String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000)))])) }
                        .buttonStyle(.borderedProminent).tint(Theme.clay).disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                }
            }
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    Button("Deny") { respond(.object(["behavior": .string("deny")])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
                    Button("Allow once") { respond(.object(["behavior": .string("allow")])) }.buttonStyle(ClayButtonStyle(busy: sending)).disabled(sending)
                }
                HStack(spacing: 18) {
                    if rememberable { rememberMenu }
                    Button(reasonOpen ? "Hide the reason" : "Say why…") { withAnimation(.snappy) { reasonOpen.toggle() } }.font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary).disabled(sending)
                    Spacer(minLength: 0)
                }
            }
        }
        .sheet(item: Binding(get: { whole.map { WholeFile(preview: $0) } }, set: { if $0 == nil { whole = nil } })) { ChatChangeSheet(preview: $0.preview, title: Self.title(payload), actions: nil) }
    }

    private struct WholeFile: Identifiable { let preview: JSON; var id = UUID() }
    private var changeReason: String { payload["input"]["reason"].string.trimmingCharacters(in: .whitespacesAndNewlines) }

    @ViewBuilder private var rememberMenu: some View {
        if guest {
            Button("Allow for this session") { respond(.object(["behavior": .string("allow"), "remember": .string("session")])) }.font(.subheadline.weight(.medium)).tint(Theme.clay).disabled(sending)
        } else {
            Menu {
                Button(inProject ? "Allow for this session" : "Allow in this conversation") { respond(.object(["behavior": .string("allow"), "remember": .string("session")])) }
                if inProject { Button { respond(.object(["behavior": .string("allow"), "remember": .string("project")])) } label: { Text("Always allow in this project"); Text(rule) } }
                Button { respond(.object(["behavior": .string("allow"), "remember": .string("always")])) } label: { Text("Always allow everywhere"); Text(rule) }
            } label: { Label("Always allow", systemImage: "checkmark.shield").font(.subheadline.weight(.medium)) }.tint(Theme.clay).disabled(sending)
        }
    }

    @ViewBuilder private var preview: some View {
        let input = payload["input"]
        switch tool {
        case "Bash": ChatCodeBox(text: "$ " + input["command"].string)
        case "Edit", "MultiEdit": VStack(alignment: .leading, spacing: 6) { Text((input["file_path"].string as NSString).lastPathComponent).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted); DiffLines(old: input["old_string"].string, new: input["new_string"].string) }
        case "Write": VStack(alignment: .leading, spacing: 6) { Text(input["file_path"].string).font(.mono(.footnote)).foregroundStyle(Theme.inkMuted); ChatCodeBox(text: String(input["content"].string.prefix(900)) + (input["content"].string.count > 900 ? "\n…" : "")) }
        case "GenerateImage", "GenerateVideo":
            VStack(alignment: .leading, spacing: 6) { Text(input["prompt"].string).font(.subheadline).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous)); if !input["model"].string.isEmpty { Text("With \(input["model"].string)").font(.footnote).foregroundStyle(Theme.inkMuted) } }
        case "GenerateAudio":
            let speech = input["kind"].string != "music" && input["kind"].string != "sound"
            Text(speech ? input["text"].string : input["prompt"].string).font(.subheadline).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        default:
            if input != .null { DisclosureGroup { ChatCodeBox(text: input.pretty) } label: { Text("Details").font(.subheadline).foregroundStyle(Theme.inkMuted) }.tint(Theme.inkMuted) }
        }
    }

    private func openWhole() {
        Task {
            do { whole = try await store.rpc.call("chat.changePreview", ["sessionId": .string(store.selected ?? ""), "interactionId": pending["id"]]) }
            catch { store.error = ChatError.text(error) }
        }
    }
}

struct ChatCodeBox: View {
    let text: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text).font(.system(size: 12.5, design: .monospaced)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(12).environment(\.layoutDirection, .leftToRight)
        }.background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The file behind a card or an Edit, with the change in place.
struct ChatChangeSheet: View {
    let preview: JSON
    let title: String
    let actions: AnyView?
    @Environment(\.dismiss) private var dismiss

    private static let states = [
        "binary": "This is a binary file, so there is nothing to show.",
        "tooLarge": "This file is too large to show.",
        "unreadable": "This file could not be read.",
        "stale": "The file changed since, so this edit no longer fits.",
        "missing": "This file is gone.",
        "new": "This file does not exist yet. This is what would be written.",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let note = Self.states[preview["state"].string] { Text(note).font(.subheadline).foregroundStyle(Theme.inkMuted).padding(.bottom, 12) }
                    ForEach(Array(preview["rows"].array.enumerated()), id: \.offset) { _, row in
                        let kind = row["kind"].string
                        if kind == "hunk" {
                            Text(row["text"].string.isEmpty ? "…" : row["text"].string).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).padding(.vertical, 6).padding(.horizontal, 8)
                        } else {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(row["line"] == .null ? "" : "\(row["line"].int)").foregroundStyle(Theme.inkMuted).frame(width: 34, alignment: .trailing)
                                Text(row["text"].string.isEmpty ? " " : row["text"].string)
                            }
                            .font(.system(size: 12.5, design: .monospaced)).padding(.vertical, 2).padding(.horizontal, 8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(kind == "remove" ? Theme.removed : kind == "add" ? Theme.added : .clear)
                        }
                    }
                }.padding().textSelection(.enabled)
            }
            .background(Theme.background)
            .navigationTitle("The file").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay).presentationDetents([.large])
    }
}

// MARK: - Questions

struct ChatQuestionCard: View {
    let payload: JSON
    let sending: Bool
    let respond: (JSON) -> Void
    @State private var picked: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]
    private var questions: [JSON] { payload["questions"].array }

    private func answer(_ index: Int) -> String {
        let question = questions[index]
        let chosen = question["options"].array.map { $0["label"].string }.filter { picked[index]?.contains($0) == true }
        let own = (other[index] ?? "").trimmingCharacters(in: .whitespaces)
        return (chosen + (own.isEmpty ? [] : [own])).joined(separator: ", ")
    }
    private var complete: Bool { questions.indices.allSatisfy { !answer($0).isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label { Text(questions.count == 1 ? "A question for you" : "\(questions.count) questions for you").font(.headline) } icon: { Image(systemName: "questionmark.bubble").foregroundStyle(Theme.clay) }
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 10) {
                    if !question["header"].string.isEmpty { StatusBadge(text: question["header"].string, tone: .neutral) }
                    Text(question["question"].string).font(.reading(.body, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    let multi = question["multiSelect"].bool
                    ForEach(question["options"].array, id: \.self) { option in
                        let label = option["label"].string
                        let selected = picked[index]?.contains(label) == true
                        Button {
                            if multi { var set = picked[index] ?? []; if set.contains(label) { set.remove(label) } else { set.insert(label) }; picked[index] = set }
                            else { picked[index] = [label]; other[index] = "" }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: multi ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle")).foregroundStyle(selected ? Theme.clay : Theme.inkMuted).font(.system(size: 18))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(label).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                                    if !option["description"].string.isEmpty { Text(option["description"].string).font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.leading) }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(selected ? Theme.clay.opacity(0.10) : Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(selected ? Theme.clay.opacity(0.55) : .clear, lineWidth: 1))
                        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                    }
                    TextField("Or write your own answer", text: Binding(get: { other[index] ?? "" }, set: { new in other[index] = new; if !multi, !new.isEmpty { picked[index] = [] } }), axis: .vertical)
                        .font(.subheadline).padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            HStack(spacing: 10) {
                Button("Skip") { respond(.object(["answers": .object([:])])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
                Button("Send answers") {
                    var answers: [String: JSON] = [:]
                    for (index, question) in questions.enumerated() { answers[question["question"].string] = .string(answer(index)) }
                    respond(.object(["answers": .object(answers)]))
                }.buttonStyle(ClayButtonStyle(busy: sending)).disabled(!complete || sending)
            }
        }
    }
}

// MARK: - Plan

struct ChatPlanCard: View {
    let store: AppStore
    let payload: JSON
    let sending: Bool
    let respond: (JSON) -> Void
    @State private var revising = false
    @State private var feedback = ""
    @State private var reading = false
    private var sessionID: String { store.selected ?? "" }
    private var comments: [CodePlanComments.Comment] { CodePlanComments.shared.list(sessionID) }
    private var plan: String { payload["input"]["plan"].string }

    /// Comments on the plan are the Code panel's too: one list per conversation, until the plan is answered.
    private func clear() { CodePlanComments.shared.clear(sessionID) }
    private func revision() -> String? { CodePlanComments.shared.revision(sessionID, feedback: feedback) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label { Text("Atelier proposed a plan").font(.headline) } icon: { Image(systemName: "list.bullet.clipboard").foregroundStyle(Theme.clay) }
                Spacer()
                Button("Open plan") { reading = true }.font(.subheadline.weight(.medium)).tint(Theme.clay)
            }
            ScrollView { MarkdownView(text: plan, serif: false).padding(14) }
                .frame(maxHeight: 300).background(Theme.fill.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            if !comments.isEmpty { Text("\(ChatText.plural(comments.count, "comment")) on the plan will go with your revision.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            if revising {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("What should change?", text: $feedback, axis: .vertical).lineLimit(1...5).padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    Button("Send") { send() }.buttonStyle(.borderedProminent).tint(Theme.clay).disabled(sending || revision() == nil)
                }
            }
            VStack(spacing: 10) {
                Button("Accept and auto mode") { accept("auto") }.buttonStyle(ClayButtonStyle(busy: sending)).disabled(sending)
                HStack(spacing: 10) {
                    Button("Reject") { clear(); respond(.object(["behavior": .string("deny")])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
                    Button(revising ? "Hide revision" : "Revise…") { withAnimation(.snappy) { revising.toggle() } }.buttonStyle(QuietButtonStyle()).disabled(sending)
                }
                Menu {
                    Button { accept("acceptEdits") } label: { Text("Accept and auto-accept edits"); Text("Edits go ahead; other actions still ask") }
                    Button { accept("default") } label: { Text("Accept and approve each edit"); Text("Every edit asks first") }
                } label: { Label("Other ways to accept", systemImage: "chevron.down.circle").font(.subheadline.weight(.medium)) }.tint(Theme.clay).disabled(sending).frame(maxWidth: .infinity)
            }
        }
        .sheet(isPresented: $reading) { ChatPlanReader(store: store, plan: plan) }
    }

    private func accept(_ mode: String) { clear(); respond(.object(["behavior": .string("allow"), "mode": .string(mode)])) }
    private func send() {
        guard let message = revision() else { return }
        clear()
        respond(.object(["behavior": .string("deny"), "message": .string(message)]))
    }
}

/// The plan full screen: each paragraph can be commented on, and the comments go with a revision.
struct ChatPlanReader: View {
    let store: AppStore
    let plan: String
    @State private var commenting: String?
    @State private var draft = ""
    @Environment(\.dismiss) private var dismiss
    private var sessionID: String { store.selected ?? "" }
    private var comments: [CodePlanComments.Comment] { CodePlanComments.shared.list(sessionID) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(chunks.enumerated()), id: \.offset) { _, chunk in
                        VStack(alignment: .leading, spacing: 8) {
                            MarkdownView(text: chunk)
                            ForEach(comments.filter { $0.quote == chunk }) { comment in
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: "text.bubble").foregroundStyle(Theme.clay)
                                    Text(comment.text).font(.subheadline)
                                    Spacer()
                                    Button { CodePlanComments.shared.remove(sessionID, id: comment.id) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.inkMuted) }.buttonStyle(.plain).accessibilityLabel("Remove comment")
                                }.padding(10).background(Theme.clay.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            if commenting == chunk {
                                HStack(alignment: .bottom, spacing: 8) {
                                    TextField("Your comment", text: $draft, axis: .vertical).lineLimit(1...4).padding(10).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    Button("Add") { CodePlanComments.shared.add(sessionID, quote: chunk, text: draft.trimmingCharacters(in: .whitespacesAndNewlines)); draft = ""; commenting = nil }.buttonStyle(.borderedProminent).tint(Theme.clay).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                                }
                            } else {
                                Button { commenting = chunk; draft = "" } label: { Label("Comment", systemImage: "text.bubble").font(.footnote) }.foregroundStyle(Theme.inkMuted)
                            }
                            Divider().overlay(Theme.hairline)
                        }
                    }
                }.padding(20).frame(maxWidth: Theme.readingWidth).frame(maxWidth: .infinity)
            }
            .background(Theme.background)
            .navigationTitle("Plan").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
    }

    /// The plan in paragraphs and list blocks, so a comment belongs to a passage.
    private var chunks: [String] { plan.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
}

// MARK: - Folder, connector, computer

struct ChatFolderCard: View {
    let payload: JSON
    let sending: Bool
    let respond: (JSON) -> Void
    @State private var path: String
    @State private var reasonOpen = false
    @State private var reason = ""
    init(payload: JSON, sending: Bool, respond: @escaping (JSON) -> Void) {
        self.payload = payload; self.sending = sending; self.respond = respond
        _path = State(initialValue: payload["input"]["path"].string)
    }
    private var input: JSON { payload["input"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label { Text(path.isEmpty ? "Choose a folder to work in" : "Work in another folder?").font(.headline) } icon: { Image(systemName: "folder.badge.gearshape").foregroundStyle(Theme.clay) }
            if !input["reason"].string.isEmpty { Text(input["reason"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary) }
            VStack(alignment: .leading, spacing: 6) {
                Text(input["host"].string.isEmpty ? "Folder" : "Folder on \(input["host"].string)").font(.footnote).foregroundStyle(Theme.inkMuted)
                TextField("/path/to/folder", text: $path).font(.mono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled().padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                if input["noFolder"].bool { Text("It has no folder yet.").font(.footnote).foregroundStyle(Theme.inkMuted) }
                else if !input["from"].string.isEmpty { Text("Now in \(input["from"].string)").font(.footnote).foregroundStyle(Theme.inkMuted) }
            }
            if reasonOpen {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Tell Atelier why", text: $reason, axis: .vertical).lineLimit(1...3).padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    Button("Send") { respond(.object(["behavior": .string("deny"), "message": .string(reason)])) }.buttonStyle(.borderedProminent).tint(Theme.clay).disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            HStack(spacing: 10) {
                Button("Stay here") { respond(.object(["behavior": .string("deny")])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
                Button("Move here") { respond(.object(["behavior": .string("allow"), "path": .string(path.trimmingCharacters(in: .whitespaces))])) }.buttonStyle(ClayButtonStyle(busy: sending)).disabled(sending || path.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Button(reasonOpen ? "Hide the reason" : "Say why…") { withAnimation(.snappy) { reasonOpen.toggle() } }.font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
        }
    }
}

struct ChatConnectorCard: View {
    let payload: JSON
    let sending: Bool
    let respond: (JSON) -> Void
    private var input: JSON { payload["input"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label { Text("Add \(input["name"].string) to your connectors?").font(.headline).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "powerplug").foregroundStyle(Theme.clay) }
            if !input["reason"].string.isEmpty { Text(input["reason"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary) }
            ChatCodeBox(text: input["url"].string)
            Text("It joins your connectors, and its tools can be used in this conversation.").font(.footnote).foregroundStyle(Theme.inkMuted)
            HStack(spacing: 10) {
                Button("Don't add") { respond(.object(["behavior": .string("deny")])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
                Button("Add connector") { respond(.object(["behavior": .string("allow")])) }.buttonStyle(ClayButtonStyle(busy: sending)).disabled(sending)
            }
        }
    }
}

/// Using apps on a computer is allowed in the desktop app that runs the session: here it can only be declined.
struct ChatComputerCard: View {
    let payload: JSON
    let tool: String
    let sending: Bool
    let respond: (JSON) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label { Text(tool == "OpenApp" ? "Let Atelier open \(payload["input"]["app"].string.isEmpty ? "an app" : payload["input"]["app"].string)?" : "Let Atelier use apps on a computer?").font(.headline).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "macwindow").foregroundStyle(Theme.clay) }
            if !payload["input"]["reason"].string.isEmpty { Text(payload["input"]["reason"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary) }
            Text("Allow this in the Atelier desktop app on the computer that runs this session. From here you can only decline.").font(.footnote).foregroundStyle(Theme.inkMuted)
            Button("Don't allow") { respond(.object(["behavior": .string("deny")])) }.buttonStyle(QuietButtonStyle()).disabled(sending)
        }
    }
}
