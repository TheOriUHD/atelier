import SwiftUI

// MARK: - Plan: the plan the session presented, the comments on it, and its task list

/// Comments on a plan the session is waiting on: a passage and what the person wants changed. Kept per session until the
/// plan is answered, and sent with "Revise".
@MainActor @Observable final class CodePlanComments {
    static let shared = CodePlanComments()
    struct Comment: Identifiable, Equatable { let id = UUID(); let quote: String; let text: String }
    private(set) var items: [String: [Comment]] = [:]

    func list(_ session: String) -> [Comment] { items[session] ?? [] }
    func add(_ session: String, quote: String, text: String) { items[session, default: []].append(Comment(quote: quote, text: text)) }
    func remove(_ session: String, id: UUID) { items[session]?.removeAll { $0.id == id } }
    func clear(_ session: String) { items[session] = nil }
    func revision(_ session: String, feedback: String) -> String? {
        CodePlan.revisionMessage(feedback: feedback, comments: list(session).map { ($0.quote, $0.text) })
    }
}

struct CodePlanPanel: View {
    let store: AppStore
    @State private var commenting: String?
    @State private var comment = ""
    @State private var revising = false
    @State private var feedback = ""
    @State private var sending = false

    private var session: CodeSession { CodeSession(store: store) }
    private var latest: (plan: String, status: CodePlan.Status)? { CodePlan.latest(session.messages) }
    private var waiting: Bool { latest?.status == .waiting }
    /// The approval the session is waiting on, when it is the plan's.
    private var approval: Bool {
        let pending = store.transcript.pending
        #if DEBUG
        if Demo.requested != nil, CodeDemo.state == "plan" { return true }
        #endif
        return pending["kind"].string == "permission" && pending["payload"]["toolName"].string == "ExitPlanMode"
    }
    private var comments: [CodePlanComments.Comment] { session.id.map { CodePlanComments.shared.list($0) } ?? [] }

    var body: some View {
        CodePanelFrame(title: "Plan", store: store) {
            Group {
                if latest == nil && session.todos.isEmpty {
                    ScrollView { EmptyState(title: "No plan yet", symbol: "list.bullet.clipboard", message: "In plan mode the assistant presents its plan here before it changes anything, and its task list follows.").padding(.top, 60) }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            if let latest { planSection(latest) }
                            if waiting && !comments.isEmpty { commentsSection }
                            if !session.todos.isEmpty { tasksSection }
                        }
                        .padding(.horizontal, 20).padding(.vertical, 16)
                        .frame(maxWidth: Theme.readingWidth, alignment: .leading).frame(maxWidth: .infinity)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if waiting && approval { approvalBar } }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if let latest { Button("Copy plan", systemImage: "doc.on.doc") { UIPasteboard.general.string = latest.plan; store.notify("Copied") } }
                }
            }
        }
        .sheet(item: Binding(get: { commenting.map { CodeStringItem(value: $0) } }, set: { commenting = $0?.value })) { item in commentSheet(item.value) }
        .sheet(isPresented: $revising) { reviseSheet }
    }

    // MARK: Reading

    private func planSection(_ plan: (plan: String, status: CodePlan.Status)) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if plan.status == .writing { ProgressView().controlSize(.small) }
                Text(plan.status.words).font(.footnote.weight(.semibold))
                    .foregroundStyle(plan.status == .waiting ? Theme.clay : plan.status == .declined ? Theme.danger : Theme.inkMuted)
            }
            if waiting { Text("Tap Comment under a passage to tell the assistant what should change there.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            ForEach(Array(CodePlan.blocks(plan.plan).enumerated()), id: \.offset) { _, block in
                VStack(alignment: .leading, spacing: 6) {
                    MarkdownView(text: block, serif: false)
                    if waiting {
                        Button { comment = ""; commenting = block } label: { Label("Comment", systemImage: "text.bubble").font(.footnote.weight(.medium)) }
                            .buttonStyle(.plain).foregroundStyle(Theme.clay).padding(.vertical, 2)
                            .accessibilityLabel("Comment on: \(String(block.prefix(60)))")
                    }
                }
            }
        }
    }

    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Your comments").font(.headline)
            ForEach(comments) { item in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("“\(item.quote.split(whereSeparator: \.isWhitespace).joined(separator: " "))”").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2)
                        Text(item.text).font(.subheadline)
                    }
                    Spacer(minLength: 4)
                    Button { if let id = session.id { CodePlanComments.shared.remove(id, id: item.id) } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.inkMuted) }
                        .buttonStyle(.plain).accessibilityLabel("Remove comment")
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).card(radius: 14)
            }
        }
    }

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tasks").font(.headline)
            ForEach(Array(session.todos.enumerated()), id: \.offset) { _, todo in
                let status = todo["status"].string
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: status == "completed" ? "checkmark.circle.fill" : status == "in_progress" ? "circle.dotted" : "circle")
                        .foregroundStyle(status == "completed" ? Theme.clay : status == "in_progress" ? Theme.waiting : Theme.inkMuted)
                    Text(status == "in_progress" && !todo["activeForm"].string.isEmpty ? todo["activeForm"].string : todo["content"].string)
                        .font(.subheadline).foregroundStyle(status == "completed" ? Theme.inkMuted : Theme.ink).strikethrough(status == "completed", color: Theme.inkMuted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(status == "completed" ? "Done" : status == "in_progress" ? "In progress" : "To do")
            }
        }
    }

    // MARK: Answering

    private var approvalBar: some View {
        VStack(spacing: 8) {
            if !comments.isEmpty { Text("\(comments.count) comment\(comments.count == 1 ? "" : "s") on the plan will go with your revision.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            HStack(spacing: 8) {
                Button("Reject") { answer(["behavior": "deny"]) }.buttonStyle(QuietButtonStyle())
                Button("Revise…") { feedback = ""; revising = true }.buttonStyle(QuietButtonStyle())
                Menu {
                    Button("Accept and auto mode", systemImage: "checkmark.shield") { answer(["behavior": "allow", "mode": "auto"]) }
                    Button("Accept and auto-accept edits", systemImage: "pencil.line") { answer(["behavior": "allow", "mode": "acceptEdits"]) }
                    Button("Accept and approve each edit", systemImage: "hand.raised") { answer(["behavior": "allow", "mode": "default"]) }
                } label: {
                    Text("Accept").font(.system(.body, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 50).background(Theme.clay, in: Capsule())
                } primaryAction: { answer(["behavior": "allow", "mode": "auto"]) }
                .accessibilityHint("Accepts and starts in auto mode. Hold for other ways.")
            }
            .disabled(sending)
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
    }

    private func answer(_ body: JSON) {
        sending = true
        Task {
            defer { sending = false }
            if let id = session.id { CodePlanComments.shared.clear(id) }
            await store.attempt { try await store.respond(body) }
        }
    }

    private var reviseSheet: some View {
        NavigationStack {
            Form {
                Section { TextEditor(text: $feedback).frame(minHeight: 120) } header: { Text("What should change?") } footer: {
                    Text(comments.isEmpty ? "The assistant presents a new plan." : "Your \(comments.count) comment\(comments.count == 1 ? "" : "s") on the plan go with this.")
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Revise the plan").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { revising = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        guard let id = session.id, let message = CodePlanComments.shared.revision(id, feedback: feedback) else { return }
                        revising = false
                        answer(["behavior": "deny", "message": .string(message)])
                    }
                    .disabled(CodePlanComments.shared.revision(session.id ?? "", feedback: feedback) == nil)
                }
            }
        }
        .tint(Theme.clay).presentationDetents([.medium, .large])
    }

    private func commentSheet(_ quote: String) -> some View {
        NavigationStack {
            Form {
                Section { Text(quote.split(whereSeparator: \.isWhitespace).joined(separator: " ")).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(4) } header: { Text("Passage") }
                Section { TextField("What should change here?", text: $comment, axis: .vertical).lineLimit(3...8) } header: { Text("Your comment") }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Comment").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { commenting = nil } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        if let id = session.id { CodePlanComments.shared.add(id, quote: quote, text: comment.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        commenting = nil
                    }.disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .tint(Theme.clay).presentationDetents([.medium])
    }
}

// MARK: - Background tasks: commands, sub-agents and loops

struct CodeTasksPanel: View {
    let store: AppStore
    @State private var showFinished = false
    @State private var stopping: CodeTask?
    @State private var newLoop = false
    @State private var clearing = false
    @State private var stoppingLoops = false
    @State private var busy: Set<String> = []

    private var session: CodeSession { CodeSession(store: store) }
    private var tasks: [CodeTask] { session.tasks }

    var body: some View {
        CodePanelFrame(title: "Background tasks", store: store) {
            Group {
                if tasks.isEmpty {
                    ScrollView { EmptyState(title: "Nothing running", symbol: "square.stack.3d.up", message: "Commands started in the background, sub-agents and loops show here while they work.", actionTitle: "Start a loop") { newLoop = true }.padding(.top, 60) }
                } else {
                    List {
                        let running = tasks.filter(\.running)
                        let finished = tasks.filter { !$0.running }.reversed()
                        if !running.isEmpty {
                            Section("Running") { ForEach(running) { taskRow($0) } }
                        }
                        if !finished.isEmpty {
                            Section {
                                if showFinished { ForEach(Array(finished)) { taskRow($0) } }
                            } header: {
                                Button { withAnimation(.snappy) { showFinished.toggle() } } label: {
                                    HStack(spacing: 6) { Text("Finished \(finished.count)"); Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(showFinished ? 90 : 0)) }
                                }.buttonStyle(.plain).textCase(nil)
                            }
                        }
                    }
                    .listStyle(.insetGrouped).scrollContentBackground(.hidden)
                }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Start a loop…", systemImage: "repeat") { newLoop = true }
                        if tasks.contains(where: { $0.kind == "loop" && $0.running }) {
                            Button("Stop all loops", systemImage: "stop.circle", role: .destructive) { stoppingLoops = true }
                        }
                        Button("Clear finished", systemImage: "trash", role: .destructive) { clearing = true }.disabled(!tasks.contains { !$0.running })
                    } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Task actions")
                }
            }
        }
        .sheet(isPresented: $newLoop) { CodeNewLoopSheet(store: store) }
        .confirmationDialog("Stop all loops?", isPresented: $stoppingLoops, titleVisibility: .visible) {
            Button("Stop all loops", role: .destructive) { stopLoops() }
        } message: { Text("They stop sending their prompts. Nothing a loop already started is undone.") }
        .confirmationDialog("Clear finished tasks?", isPresented: $clearing, titleVisibility: .visible) {
            Button("Clear finished", role: .destructive) { Task { await store.attempt { _ = try await codeCall(store, "tasks.clear", ["sessionId": .string(session.id ?? "")]) } } }
        } message: { Text("They leave this list, and their output is no longer kept.") }
        .confirmationDialog(stopping.map { "Stop \($0.title)?" } ?? "", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { task in
            Button(task.kind == "loop" ? "Stop loop" : "Stop", role: .destructive) { stop(task) }
        } message: { task in
            Text(task.kind == "command" ? "The command stops where it is. Its output so far stays here." : task.kind == "agent" ? "The sub-agent stops. What it has done so far stays." : "The loop stops sending its prompt.")
        }
    }

    private func taskRow(_ task: CodeTask) -> some View {
        NavigationLink { CodeTaskDetail(store: store, taskId: task.id) } label: {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: task.symbol, tint: task.running ? Theme.clay : Theme.inkSecondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title).font(.system(.body, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(2)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let now = Int(context.date.timeIntervalSince1970 * 1000)
                        HStack(spacing: 5) {
                            Text(task.kindLabel)
                            if task.background { Text("· Background") }
                            Text(task.running ? "· \(task.duration(now: now))" : "· \(task.outcome) · \(task.duration(now: now))")
                                .foregroundStyle(task.status == "failed" ? Theme.danger : Theme.inkMuted)
                        }.font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
                    }
                    if task.kind == "loop" {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(task.schedule(now: Int(context.date.timeIntervalSince1970 * 1000))).font(.footnote).foregroundStyle(Theme.inkMuted)
                        }
                    }
                }
                Spacer(minLength: 4)
                if task.running {
                    if busy.contains(task.id) { ProgressView() }
                    else {
                        Button { stopping = task } label: {
                            RoundedRectangle(cornerRadius: 3).fill(Theme.inkSecondary).frame(width: 10, height: 10).frame(width: 34, height: 34)
                                .overlay(Circle().stroke(Theme.fillStrong, lineWidth: 1))
                        }.buttonStyle(.plain).accessibilityLabel("Stop \(task.title)")
                    }
                }
            }
        }
    }

    private func stop(_ task: CodeTask) {
        busy.insert(task.id)
        Task {
            await store.attempt { _ = try await codeCall(store, "tasks.stop", ["sessionId": .string(session.id ?? ""), "taskId": .string(task.id)]) }
            busy.remove(task.id)
        }
    }
    private func stopLoops() {
        Task {
            await store.attempt {
                let result = try await codeCall(store, "loops.stop", ["sessionId": .string(session.id ?? ""), "target": .null])
                store.notify("Stopped \(result["stopped"].int) \(result["stopped"].int == 1 ? "loop" : "loops")")
            }
        }
    }
}

/// A task opened: a command's live output, a sub-agent's transcript, or a loop's schedule.
struct CodeTaskDetail: View {
    let store: AppStore
    let taskId: String
    @State private var stopping = false

    private var session: CodeSession { CodeSession(store: store) }
    private var task: CodeTask? { session.tasks.first { $0.id == taskId } }

    var body: some View {
        Group {
            if let task {
                switch task.kind {
                case "command": CodeCommandView(store: store, task: task)
                case "agent": CodeAgentView(store: store, task: task)
                default: CodeLoopView(store: store, task: task)
                }
            } else {
                EmptyState(title: "Task cleared", symbol: "checkmark.circle", message: "This task is no longer in the list.")
            }
        }
        .background(Theme.sunken)
        .navigationTitle(task?.kindLabel ?? "Task").navigationBarTitleDisplayMode(.inline)
    }
}

/// A command's output, read again every second while it runs.
@MainActor @Observable final class CodeCommandOutput {
    private(set) var text = ""
    private(set) var truncated = false
    private(set) var error: String?
    private var offset = 0
    static let tail = 100_000

    func run(store: AppStore, sessionId: String, taskId: String) async {
        while !Task.isCancelled {
            do {
                let answer = try await codeCall(store, "tasks.output", ["sessionId": .string(sessionId), "taskId": .string(taskId), "since": .number(Double(offset))])
                offset = answer["offset"].int
                text = String((text + answer["output"].string).suffix(Self.tail))
                truncated = truncated || answer["truncated"].bool
                error = nil
                if !answer["running"].bool { return }
            } catch is CancellationError { return } catch { self.error = error.localizedDescription; return }
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

private struct CodeCommandView: View {
    let store: AppStore
    let task: CodeTask
    @State private var output = CodeCommandOutput()
    @State private var stopping = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            if task.running { ProgressView().controlSize(.small) }
                            Text(task.running ? "Running" : task.outcome).font(.footnote.weight(.semibold)).foregroundStyle(task.status == "failed" ? Theme.danger : Theme.inkMuted)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("$").foregroundStyle(Theme.inkMuted)
                                Text(task.command ?? task.title).textSelection(.enabled)
                            }
                            .font(.mono(.footnote)).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            if let error = output.error {
                                Divider().overlay(Theme.hairline)
                                Text(error).font(.footnote).foregroundStyle(Theme.inkMuted).padding(12)
                            } else if !output.text.isEmpty || output.truncated {
                                Divider().overlay(Theme.hairline)
                                Text((output.truncated ? "[earlier output dropped]\n" : "") + output.text)
                                    .font(.mono(.footnote)).foregroundStyle(Theme.inkSecondary).textSelection(.enabled)
                                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                    .id("end")
                            } else if !task.running {
                                Divider().overlay(Theme.hairline)
                                Text("No output.").font(.footnote).foregroundStyle(Theme.inkMuted).padding(12)
                            }
                        }
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
                        if task.running {
                            Button("Stop", role: .destructive) { stopping = true }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Theme.danger)
                        }
                    }
                    .padding(16).frame(maxWidth: 820).frame(maxWidth: .infinity)
                }
                .onChange(of: output.text) { _, _ in if task.running { proxy.scrollTo("end", anchor: .bottom) } }
            }
        }
        .task(id: "\(task.id)|\(task.running)") { await output.run(store: store, sessionId: CodeSession(store: store).id ?? "", taskId: task.id) }
        .confirmationDialog("Stop this command?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await store.attempt { _ = try await codeCall(store, "tasks.stop", ["sessionId": .string(CodeSession(store: store).id ?? ""), "taskId": .string(task.id)]) } } }
        } message: { Text("The command stops where it is. Its output so far stays here.") }
    }
}

/// A sub-agent's own transcript, followed live: its model, the prompt it got, and what it has done.
@MainActor @Observable final class CodeAgentModel {
    private(set) var transcript: Transcript?
    private(set) var error: String?
    private let store: AppStore
    private let sessionId: String
    private var observer: UUID?

    init(store: AppStore, sessionId: String) {
        self.store = store
        self.sessionId = sessionId
        CodeEvents.shared.install(on: store)
        observer = CodeEvents.shared.observe { [weak self] method, value in
            guard let self, method == "session.event", value["sessionId"].string == self.sessionId, self.transcript != nil else { return }
            if self.transcript?.apply(value) == false { Task { await self.load() } }
        }
    }
    isolated deinit {
        if let observer { CodeEvents.shared.remove(observer) }
    }

    func load() async {
        do { transcript = Transcript(snapshot: try await codeCall(store, "sessions.subscribe", ["id": .string(sessionId)])); error = nil }
        catch is CancellationError { return } catch { self.error = error.localizedDescription }
    }
    func leave() { let store = store, id = sessionId; Task { _ = try? await store.rpc.call("sessions.unsubscribe", ["id": .string(id)]) } }
}

private struct CodeAgentView: View {
    let store: AppStore
    let task: CodeTask
    @State private var model: CodeAgentModel

    init(store: AppStore, task: CodeTask) {
        self.store = store
        self.task = task
        _model = State(initialValue: CodeAgentModel(store: store, sessionId: task.sessionId ?? ""))
    }

    private var modelName: String? {
        let ref = model.transcript?.snapshot["session"]["model"].string ?? ""
        return store.models.first { $0["ref"].string == ref }?["displayName"].string ?? (ref.isEmpty ? nil : ref)
    }

    var body: some View {
        Group {
            if let error = model.error { InlineError(message: error) { Task { await model.load() } } }
            else if let transcript = model.transcript {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(spacing: 8) {
                            if task.running { ProgressView().controlSize(.small) }
                            Text(task.running ? "Working" : task.outcome).font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                            if let modelName { Text("· \(modelName)").font(.footnote).foregroundStyle(Theme.inkMuted) }
                        }
                        if let prompt = transcript.messages.first(where: { $0["role"].string == "user" }).map({ $0["parts"].array.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n") }), !prompt.isEmpty {
                            Text(prompt).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(12).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        ForEach(Array(transcript.messages.filter { $0["role"].string == "assistant" }.enumerated()), id: \.offset) { _, message in
                            ForEach(Array(message["parts"].array.enumerated()), id: \.offset) { _, part in
                                switch part["type"].string {
                                case "text": MarkdownView(text: part["text"].string, serif: false)
                                case "tool_call": CodeToolLine(call: part)
                                default: EmptyView()
                                }
                            }
                        }
                    }
                    .padding(16).frame(maxWidth: Theme.readingWidth, alignment: .leading).frame(maxWidth: .infinity)
                }
            } else { ProgressView().controlSize(.large) }
        }
        .task { await model.load() }
        .onDisappear { model.leave() }
    }
}

/// One tool call as a line: what it did and to what.
struct CodeToolLine: View {
    let call: JSON

    static func summary(_ call: JSON) -> (verb: String, target: String, symbol: String) {
        let input = call["input"]
        func file(_ key: String = "file_path") -> String { CodePath.name(input[key].string) }
        switch call["name"].string {
        case "Read": return ("Read", file(), "doc.text")
        case "Write": return ("Wrote", file(), "square.and.pencil")
        case "Edit": return ("Edited", file(), "pencil")
        case "Bash": return ("Ran", input["description"].string.isEmpty ? String(input["command"].string.split(separator: "\n").first ?? "") : input["description"].string, "terminal")
        case "Grep": return ("Searched for", input["pattern"].string, "magnifyingglass")
        case "Glob": return ("Found files", input["pattern"].string, "magnifyingglass")
        case "WebFetch", "WebSearch": return ("Looked up", input["url"].string.isEmpty ? input["query"].string : input["url"].string, "globe")
        case "Agent": return ("Started a sub-agent", input["description"].string, "person.crop.circle.badge.clock")
        case "TodoWrite": return ("Updated the task list", "", "checklist")
        default: return (call["name"].string, "", "wrench.and.screwdriver")
        }
    }

    var body: some View {
        let info = Self.summary(call)
        HStack(spacing: 10) {
            Image(systemName: info.symbol).font(.system(size: 13)).foregroundStyle(Theme.inkMuted).frame(width: 18)
            Text(info.verb).font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
            if !info.target.isEmpty { Text(info.target).font(.subheadline).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct CodeLoopView: View {
    let store: AppStore
    let task: CodeTask
    @State private var stopping = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(task.running ? "Sends this as your message:" : "\(task.outcome). It sent this as your message:").font(.footnote).foregroundStyle(Theme.inkMuted)
                Text(task.title).font(.subheadline).foregroundStyle(Theme.inkSecondary).textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(task.schedule(now: Int(context.date.timeIntervalSince1970 * 1000))).font(.subheadline.weight(.medium))
                }
                if task.running {
                    let ends = Date(timeIntervalSince1970: Double(task.startedAt + CodeFormat.loopMaxAgeMs) / 1000).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
                    Text("A run that comes due while the session is busy waits until it is idle. Stopping a response keeps the loop: its next run comes a full interval after the stop. The loop ends after \(CodeFormat.loopMaxRuns) runs or on \(ends), when you stop it or delete the session, and when Atelier's backend restarts.")
                        .font(.footnote).foregroundStyle(Theme.inkMuted)
                    Button("Stop loop", role: .destructive) { stopping = true }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Theme.danger)
                }
            }
            .padding(16).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }
        .confirmationDialog("Stop this loop?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop loop", role: .destructive) { Task { await store.attempt { _ = try await codeCall(store, "tasks.stop", ["sessionId": .string(CodeSession(store: store).id ?? ""), "taskId": .string(task.id)]) } } }
        } message: { Text("It stops sending its prompt.") }
    }
}

/// `/loop`: a prompt sent now and again every so often, each time once the session is idle.
struct CodeNewLoopSheet: View {
    let store: AppStore
    @State private var prompt = ""
    @State private var interval = "10m"
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    private static let presets = ["1m", "5m", "10m", "30m", "1h", "6h", "1d"]
    private var running: Int { CodeSession(store: store).tasks.filter { $0.kind == "loop" && $0.running }.count }
    private var problem: String? { interval.isEmpty ? nil : CodeFormat.loopIntervalError(interval) }
    private var valid: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && CodeFormat.loopIntervalError(interval) == nil && running < CodeFormat.loopMaxPerSession }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $prompt).frame(minHeight: 110)
                        if prompt.isEmpty { Text("Check the deploy and tell me what changed since the last run").foregroundStyle(Theme.inkMuted.opacity(0.7)).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                    }
                } header: { Text("What to send") } footer: {
                    Text("Sent as your message, now or as soon as the session is idle. Write it so it makes sense on its own, says what to report, and says what to do when nothing changed.")
                }
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Self.presets, id: \.self) { preset in
                                Button { interval = preset } label: {
                                    Text("Every \(preset)").font(.subheadline.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 7)
                                        .foregroundStyle(interval == preset ? .white : Theme.ink)
                                        .background(interval == preset ? AnyShapeStyle(Theme.clay) : AnyShapeStyle(Theme.fill), in: Capsule())
                                }.buttonStyle(.plain)
                            }
                        }
                    }.listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                    VStack(alignment: .leading, spacing: 4) {
                        FieldRow(title: "Or a time of your own", placeholder: "30s, 5m, 2h, 1h30m", text: $interval, mono: true)
                        if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
                    }
                } header: { Text("How often") } footer: {
                    Text("The shortest is 1m and the longest 1d. A loop ends after \(CodeFormat.loopMaxRuns) runs, after 7 days, or when the backend restarts.")
                }
                if running >= CodeFormat.loopMaxPerSession { Section { Text("This session already has \(CodeFormat.loopMaxPerSession) loops running. Stop one to start another.").font(.footnote).foregroundStyle(Theme.danger) } }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Start a loop").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { start() } label: { if busy { ProgressView() } else { Text("Start").fontWeight(.semibold) } }.disabled(!valid || busy)
                }
            }
        }
        .tint(Theme.clay).presentationDetents([.large])
    }

    private func start() {
        guard let ms = CodeFormat.parseInterval(interval), let id = CodeSession(store: store).id else { return }
        busy = true
        Task {
            defer { busy = false }
            if await store.attempt({
                let result = try await codeCall(store, "loops.start", ["sessionId": .string(id), "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)), "intervalMs": .number(Double(ms))])
                let every = CodeFormat.interval(result["intervalMs"].int)
                store.notify("Loop started: every \(every)\(result["intervalMs"].int > ms ? " (the shortest interval)" : "")")
            }) { dismiss() }
        }
    }
}

// MARK: - Checkpoints: back to before one of your messages

struct CodeCheckpointsPanel: View {
    let store: AppStore
    @State private var folders: CodeFolders
    @State private var points: Resource<[JSON]>
    @State private var selected: String?
    @State private var confirming: (files: Bool, conversation: Bool)?
    @State private var busy: String?
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
        _points = State(initialValue: Resource { try await codeCall(store, "checkpoints.list", ["sessionId": .string(CodeSession(store: store).id ?? "")]).array })
    }

    private var session: CodeSession { CodeSession(store: store) }

    /// The checkpoints of the conversation's current branch, newest first.
    private func rewindPoints(_ list: [JSON]) -> [(message: JSON, paths: [String])] {
        let paths = Dictionary(list.map { ($0["messageId"].string, $0["paths"].array.map(\.string)) }, uniquingKeysWith: { first, _ in first })
        return session.messages.compactMap { message in paths[message["id"].string].map { (message, $0) } }.reversed()
    }
    private func text(_ message: JSON) -> String { message["parts"].array.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n") }
    private func display(_ path: String) -> String {
        guard let root = folders.workspace?.root, path.hasPrefix(root + "/") else { return path }
        return String(path.dropFirst(root.count + 1))
    }

    var body: some View {
        CodePanelFrame(title: "Rewind", store: store) {
            ResourceList(resource: points, isEmpty: { rewindPoints($0).isEmpty }, empty: {
                EmptyState(title: "Nothing to rewind yet", symbol: "clock.arrow.circlepath", message: "No message of yours has led to files being written or edited.")
            }) { list in
                let items = rewindPoints(list)
                Section {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        let id = item.message["id"].string
                        Button { selected = id } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: selected == id ? "largecircle.fill.circle" : "circle").foregroundStyle(selected == id ? Theme.clay : Theme.inkMuted).padding(.top, 2)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(text(item.message).isEmpty ? "Attachments" : text(item.message)).font(.body).foregroundStyle(Theme.ink).lineLimit(3).multilineTextAlignment(.leading)
                                    Text("Changed \(item.paths.map(display).joined(separator: ", "))").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2).multilineTextAlignment(.leading)
                                }
                                Spacer(minLength: 0)
                            }.contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected == id ? .isSelected : [])
                    }
                } header: { Text("Go back to before") } footer: {
                    Text("Changes made by commands aren't tracked, so they stay as they are. Restoring a file puts back its content from before the message: edits you made to it since are overwritten.")
                }
                if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger) } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        }
        .task { await folders.load(); await points.reload(); selected = selected ?? rewindPoints(points.value ?? []).first?.message["id"].string }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button(confirmButton, role: .destructive) { if let confirming { rewind(files: confirming.files, conversation: confirming.conversation) } }
        } message: { Text(confirmMessage) }
    }

    private var confirmTitle: String {
        guard let confirming else { return "" }
        return confirming.files && confirming.conversation ? "Restore code and conversation?" : confirming.files ? "Restore the code?" : "Restore the conversation?"
    }
    private var confirmButton: String {
        guard let confirming else { return "" }
        return confirming.files && confirming.conversation ? "Restore code and conversation" : confirming.files ? "Restore code" : "Restore conversation"
    }
    private var confirmMessage: String {
        guard let confirming else { return "" }
        let files = "Files the assistant wrote or edited go back to how they were, and files it created are removed. Edits of your own to them since are lost."
        let conversation = "The conversation moves back to before that message, which returns to the message box to send again. The old branch stays reachable."
        return confirming.files && confirming.conversation ? "\(files) \(conversation)" : confirming.files ? files : conversation
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if session.running { Text("Stop the response before rewinding.").font(.footnote).foregroundStyle(Theme.inkMuted) }
            let off = selected == nil || session.running || busy != nil
            Button { confirming = (true, true) } label: { Text("Restore code and conversation") }.buttonStyle(ClayButtonStyle(busy: busy == "both")).disabled(off)
            HStack(spacing: 8) {
                Button { confirming = (true, false) } label: { Text("Restore code") }.buttonStyle(QuietButtonStyle()).disabled(off)
                Button { confirming = (false, true) } label: { Text("Restore conversation") }.buttonStyle(QuietButtonStyle()).disabled(off)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
        .opacity((points.value.map { rewindPoints($0).isEmpty } ?? true) ? 0 : 1)
    }

    private func rewind(files: Bool, conversation: Bool) {
        guard let selected, let id = session.id, let message = session.messages.first(where: { $0["id"].string == selected }) else { return }
        busy = files && conversation ? "both" : files ? "code" : "conversation"
        problem = nil
        let words = text(message)
        Task {
            defer { busy = nil }
            do {
                let answer = try await codeCall(store, "checkpoints.rewind", ["sessionId": .string(id), "messageId": .string(selected), "files": .bool(files), "conversation": .bool(conversation)])
                if answer["snapshot"] != .null { store.transcript = Transcript(snapshot: answer["snapshot"]) }
                let count = answer["restored"].array.count
                let noun = "\(count) \(count == 1 ? "file" : "files")"
                store.notify(files && conversation ? "Restored \(noun) and the conversation" : files ? "Restored \(noun)" : "Conversation rewound")
                if conversation { store.draft = words; dismiss() } else { await points.reload() }
            } catch is CancellationError { return } catch { problem = error.localizedDescription }
        }
    }
}

// MARK: - Folder: where this session works, and moving it

struct CodeFolderPanel: View {
    let store: AppStore
    @State private var folders: CodeFolders
    @State private var confirming: CodeWorkspace?
    @State private var waiting: CodeWorkspace?
    @State private var problem: String?
    @State private var busy = false

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
    }

    private var session: CodeSession { CodeSession(store: store) }
    private var runningTasks: Int { session.tasks.filter(\.running).count }
    private var current: CodeWorkspace? { folders.workspace }
    /// Folders on the same computer, reachable now: a session doesn't move to another computer or into a codespace.
    private var targets: [CodeWorkspace] {
        guard let current, current.kind != .codespace else { return [] }
        return folders.folders.filter { $0.id != current.id && $0.kind == current.kind && $0.host == current.host && $0.deviceId == current.deviceId }
    }

    var body: some View {
        CodePanelFrame(title: "Folder", store: store) {
            Group {
                if !folders.didLoad {
                    if let error = folders.error { InlineError(message: error) { Task { await folders.load(devices: true) } } } else { ProgressView().controlSize(.large) }
                } else if let current {
                    List {
                        Section {
                            HStack(spacing: 12) {
                                IconTile(symbol: current.kind == .codespace ? "cloud" : current.kind == .ssh ? "server.rack" : "folder", size: 36)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        Text(current.scratch ? "No folder" : current.name).font(.system(.body, weight: .semibold)).lineLimit(1)
                                        if let badge = current.kindBadge { StatusBadge(text: badge) }
                                        if !current.trusted { StatusBadge(text: "Not trusted", tone: .warn) }
                                        if !current.available { StatusBadge(text: "Offline", tone: .neutral) }
                                    }
                                    if !current.scratch { Text(current.location).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(2).truncationMode(.middle) }
                                    Text(current.computer(devices: folders.devices)).font(.footnote).foregroundStyle(Theme.inkMuted)
                                }
                            }
                        } header: { Text("This session works in") }
                        Section {
                            if current.kind == .codespace {
                                Text("A codespace is one repository. Start a new session for another one.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                            } else if targets.isEmpty {
                                Text("No other folders on this computer. Folders you open there show here.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                            }
                            ForEach(targets) { target in
                                Button { runningTasks > 0 ? (confirming = target) : move(to: target) } label: {
                                    HStack(spacing: 12) {
                                        IconTile(symbol: "folder", size: 28)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(target.label).foregroundStyle(Theme.ink).lineLimit(1)
                                            Text(target.available ? target.location : "Its computer is offline").font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle)
                                        }
                                        Spacer()
                                        if waiting?.id == target.id { StatusBadge(text: "Moving", tone: .clay) }
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain).disabled(!target.available || busy)
                            }
                            if let waiting {
                                ActionRow(title: "Stay in \(current.label)", symbol: "arrow.uturn.backward") { stay(current) }
                                    .accessibilityHint("Calls off the move to \(waiting.label)")
                            }
                        } header: { Text("Move this session to") } footer: {
                            Text(session.running ? "A reply is running, so it moves when the reply ends. The conversation goes on in the new folder; the files, terminal and changes follow." : "The conversation goes on in the new folder; the files, terminal and changes follow. Nothing is copied.")
                        }
                        if let problem { Section { Text(problem).font(.subheadline).foregroundStyle(Theme.danger) } }
                    }
                    .listStyle(.insetGrouped).scrollContentBackground(.hidden)
                } else {
                    EmptyState(title: "No folder", symbol: "folder.badge.questionmark", message: "This session has no folder. Start a Code session in a folder to see its files and changes.")
                }
            }
        }
        .task { await folders.load(devices: true) }
        .confirmationDialog(runningTasks == 1 ? "Move while a background task runs?" : "Move while \(runningTasks) background tasks run?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { target in
            Button("Move") { move(to: target) }
        } message: { target in Text("Commands keep running in \(current?.label ?? "the old folder"), and sub-agents finish their work there. The conversation goes on in \(target.label).") }
    }

    private func move(to target: CodeWorkspace) {
        guard let id = session.id else { return }
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                let result = try await codeCall(store, "sessions.move", ["id": .string(id), "workspaceId": .string(target.id)])
                if result["pending"].bool { waiting = target; store.notify("Moves when this reply ends") }
                else { waiting = nil; store.notify("Moved to \(target.label)"); try? await store.refresh() }
                await folders.load(devices: true)
            } catch is CancellationError { return } catch { problem = error.localizedDescription }
        }
    }
    private func stay(_ current: CodeWorkspace) {
        guard let id = session.id else { return }
        waiting = nil
        Task { await store.attempt { _ = try await codeCall(store, "sessions.move", ["id": .string(id), "workspaceId": .string(current.id)]) } }
    }
}
