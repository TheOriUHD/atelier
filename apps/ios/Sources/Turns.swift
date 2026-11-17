import Foundation

/// A transcript as a person reads it: their messages, and the assistant's turns, each one run of text, thinking and the
/// tools it used. The server's messages are finer than that (a tool's result is a message of its own, one reply may span
/// several messages), so this folds them together.
struct ToolStep: Identifiable {
    let call: JSON
    let result: JSON?
    var id: String { call["id"].string }
    var name: String { call["name"].string }
    var failed: Bool { result?["isError"].bool == true }
    var resultText: String { (result?["content"].array ?? []).map { $0["text"].string }.filter { !$0.isEmpty }.joined(separator: "\n") }
    /// Pictures a tool returned (a screenshot, a viewed image).
    var resultImages: [JSON] { (result?["content"].array ?? []).filter { $0["type"].string == "image" } }
    /// What GenerateImage, GenerateVideo and GenerateAudio made, with its model, prompt and cost.
    var generated: [JSON] { result?["generated"].array ?? [] }
    var finished: Bool { result != nil }
}

enum TurnBlock: Identifiable {
    case text(String, String)
    case thinking(String, String)
    case tools(String, [ToolStep])
    case file(String, JSON)
    case failure(String, JSON)
    /// The model provider ended the reply itself.
    case refusal(String)
    /// The `artifact` tool: a card that opens the document.
    case artifact(String, ToolStep)
    /// The `inline_visual` tool: a diagram or small interactive picture inside the reply.
    case visual(String, ToolStep)
    /// GenerateImage, GenerateVideo and GenerateAudio.
    case media(String, ToolStep)
    /// Another agent's word, or a background agent that ended: one quiet line among the steps.
    case notice(String, JSON)
    var id: String {
        switch self {
        case .text(let id, _), .thinking(let id, _), .tools(let id, _), .file(let id, _), .failure(let id, _), .refusal(let id), .artifact(let id, _), .visual(let id, _), .media(let id, _), .notice(let id, _): id
        }
    }
}

struct Turn: Identifiable {
    enum Role { case user, assistant, note }
    let id: String
    let role: Role
    var blocks: [TurnBlock]
    /// The first message, for editing a person's message and for the branch menu.
    let source: JSON
    var lastMessageID: String
    /// A person's message: a passage of an earlier message it replies to, and a picture they brushed over.
    var quotes: [String] = []
    var areas: [JSON] = []
    /// What the message stands for besides its text: a loop's send, a command the person ran, a move.
    var notice: JSON?
    /// A line of hidden context that is shown muted (a hook's feedback).
    var mutedLine: String?
    /// Co-op: who wrote it (user messages) or whom the reply answered (assistant turns).
    var author = ""
    var answerWith = ""
    var model = ""
    var createdAt: Double = 0
    var finalCreatedAt: Double = 0
    var messageIDs: [String] = []

    /// The finished text of the turn, for Copy.
    var plainText: String {
        blocks.compactMap { if case .text(_, let text) = $0 { text } else { nil } }.joined(separator: "\n\n")
    }
    var hasReply: Bool {
        blocks.contains {
            switch $0 {
            case .text, .artifact, .visual, .media: true
            default: false
            }
        }
    }

    /// Whether a thought says anything: more than a lone heading, which some providers send as the whole summary.
    static func hasThought(_ text: String) -> Bool {
        let plain = text.replacingOccurrences(of: "[*_#`>]", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        if plain.isEmpty { return false }
        let lines = plain.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return lines.count > 1 || plain.split(whereSeparator: \.isWhitespace).count > 8
    }

    private static let ownTools: Set<String> = ["artifact", "inline_visual", "GenerateImage", "GenerateVideo", "GenerateAudio"]

    /// A message of notes only: the model's hidden context, or an agent's word.
    private static func onlyContext(_ message: JSON) -> Bool {
        let parts = message["parts"].array
        return !parts.isEmpty && parts.allSatisfy { $0["type"].string == "context" }
    }
    private static func agentNotice(_ message: JSON) -> JSON? {
        guard message["role"].string == "user", onlyContext(message) else { return nil }
        for part in message["parts"].array where part["type"].string == "context" {
            let kind = part["notice"]["kind"].string
            if kind == "message" || kind == "agent" { return part["notice"] }
        }
        return nil
    }

    static func build(_ messages: [JSON], streamingMessageID: String? = nil, stopReasons: [String: String] = [:]) -> [Turn] {
        var results: [String: JSON] = [:]
        for message in messages { for part in message["parts"].array where part["type"].string == "tool_result" { results[part["callId"].string] = part } }
        var turns: [Turn] = []
        for message in messages {
            let id = message["id"].string
            let role = message["role"].string
            if message["kind"].string == "compaction_summary" {
                turns.append(Turn(id: id, role: .note, blocks: [], source: message, lastMessageID: id, notice: message["parts"].array.first { $0["notice"]["kind"].string == "compaction" }?["notice"], createdAt: message["createdAt"].double, messageIDs: [id]))
                continue
            }
            if message["kind"].string == "context" {
                let said = message["parts"].array.map { $0["text"].string }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if !said.isEmpty { turns.append(Turn(id: id, role: .note, blocks: [], source: message, lastMessageID: id, mutedLine: said, messageIDs: [id])) }
                continue
            }
            switch role {
            case "user":
                // Another agent's word carries on the assistant's turn as a step of its work.
                if let notice = agentNotice(message) {
                    if var last = turns.last, last.role == .assistant {
                        last.blocks.append(.notice("\(id)-notice", notice.setting("text", .string(notice["text"].string))))
                        last.messageIDs.append(id)
                        turns[turns.count - 1] = last
                    } else {
                        turns.append(Turn(id: id, role: .note, blocks: [.notice("\(id)-notice", notice)], source: message, lastMessageID: id, messageIDs: [id]))
                    }
                    continue
                }
                var blocks: [TurnBlock] = []
                var quotes: [String] = []
                var areas: [JSON] = []
                var notice: JSON?
                var muted = ""
                for (index, part) in message["parts"].array.enumerated() {
                    switch part["type"].string {
                    case "image", "document": blocks.append(.file("\(id)-\(index)", part))
                    case "text" where !part["text"].string.isEmpty: blocks.append(.text("\(id)-\(index)", part["text"].string))
                    case "context":
                        switch part["notice"]["kind"].string {
                        case "quote": quotes.append(part["notice"]["text"].string)
                        case "area": areas.append(part["notice"])
                        case "loop", "command", "moved": notice = part["notice"]
                        default: muted += (muted.isEmpty ? "" : "\n") + part["text"].string
                        }
                    default: break
                    }
                }
                if let notice, notice["kind"].string == "moved" {
                    turns.append(Turn(id: id, role: .note, blocks: [], source: message, lastMessageID: id, notice: notice, messageIDs: [id]))
                    continue
                }
                if let notice, notice["kind"].string == "command" {
                    turns.append(Turn(id: id, role: .user, blocks: [.text("\(id)-command", notice["command"].string)], source: message, lastMessageID: id, notice: notice, author: message["author"].string, createdAt: message["createdAt"].double, messageIDs: [id]))
                    continue
                }
                // A message of tool results or hidden notes only is not something the person said.
                if blocks.isEmpty && quotes.isEmpty && areas.isEmpty {
                    let said = muted.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !said.isEmpty { turns.append(Turn(id: id, role: .note, blocks: [], source: message, lastMessageID: id, mutedLine: said, messageIDs: [id])) }
                    continue
                }
                turns.append(Turn(id: id, role: .user, blocks: blocks, source: message, lastMessageID: id, quotes: quotes, areas: areas, notice: notice, author: message["author"].string, answerWith: message["answerWith"].string, createdAt: message["createdAt"].double, messageIDs: [id]))
            case "assistant":
                var blocks: [TurnBlock] = []
                for (index, part) in message["parts"].array.enumerated() {
                    let key = "\(id)-\(index)"
                    switch part["type"].string {
                    case "text":
                        if !part["text"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.text(key, part["text"].string)) }
                    case "thinking":
                        let newest = message["id"].string == streamingMessageID && index == message["parts"].array.count - 1
                        if part["redacted"].bool == false, hasThought(part["text"].string) || newest, !part["text"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.thinking(key, part["text"].string)) }
                    case "tool_call":
                        let step = ToolStep(call: part, result: results[part["id"].string])
                        switch part["name"].string {
                        case "artifact": blocks.append(.artifact(key, step))
                        case "inline_visual": blocks.append(.visual(key, step))
                        case "GenerateImage", "GenerateVideo", "GenerateAudio": blocks.append(.media(key, step))
                        default:
                            if case .tools(let first, let steps)? = blocks.last { blocks[blocks.count - 1] = .tools(first, steps + [step]) } else { blocks.append(.tools(key, [step])) }
                        }
                    case "image", "document": blocks.append(.file(key, part))
                    default: break
                    }
                }
                let refused = (message["stopReason"].string.isEmpty ? stopReasons[id] ?? "" : message["stopReason"].string) == "refusal"
                if message["error"] != .null { blocks.append(.failure("\(id)-error", message["error"])) }
                else if refused { blocks.append(.refusal("\(id)-refusal")) }
                if var last = turns.last, last.role == .assistant {
                    // One reply, several messages: carry on in the same turn, and join a run of tools across the seam.
                    for block in blocks {
                        if case .tools(_, let steps) = block, case .tools(let first, let before)? = last.blocks.last { last.blocks[last.blocks.count - 1] = .tools(first, before + steps) }
                        else { last.blocks.append(block) }
                    }
                    last.lastMessageID = id
                    last.messageIDs.append(id)
                    if !message["model"].string.isEmpty { last.model = message["model"].string }
                    last.finalCreatedAt = message["createdAt"].double
                    turns[turns.count - 1] = last
                } else {
                    turns.append(Turn(id: id, role: .assistant, blocks: blocks, source: message, lastMessageID: id, author: message["author"].string, model: message["model"].string, createdAt: message["createdAt"].double, finalCreatedAt: message["createdAt"].double, messageIDs: [id]))
                }
            default: continue
            }
        }
        return turns
    }
}

extension JSON {
    var double: Double { if case .number(let n) = self { n } else { 0 } }
}

/// What a tool call means to a person: a verb and the thing it worked on, not the JSON it was sent.
struct ToolInfo {
    let icon: String
    let verb: String
    let target: String
    /// Calls of one kind fold into one summary ("Read 4 files").
    let kind: Kind
    enum Kind: Hashable { case read, edit, run, search, web, agent, tasks, ask, memory, other(String) }

    init(_ call: JSON) {
        let name = call["name"].string
        let input = call["input"]
        func file(_ key: String = "file_path") -> String { (input[key].string as NSString).lastPathComponent }
        switch name {
        case "Read": self.init("doc.text", "Read", file(), .read)
        case "Edit", "MultiEdit", "NotebookEdit": self.init("square.and.pencil", "Edited", file(name == "NotebookEdit" ? "notebook_path" : "file_path"), .edit)
        case "Write": self.init("doc.badge.plus", "Wrote", file(), .edit)
        case "Bash":
            let description = input["description"].string
            self.init("terminal", "Ran", description.isEmpty ? String(input["command"].string.split(separator: "\n").first ?? "") : description, .run)
        case "BashOutput", "KillBash": self.init("terminal", "Checked a command", "", .run)
        case "Grep": self.init("magnifyingglass", "Searched", input["pattern"].string, .search)
        case "Glob": self.init("folder", "Listed", input["pattern"].string, .search)
        case "WebSearch": self.init("globe", "Searched the web", input["query"].string, .web)
        case "WebFetch": self.init("arrow.down.doc", "Fetched", URL(string: input["url"].string)?.host ?? input["url"].string, .web)
        case "Agent", "Task": self.init("person.2", "Ran an agent", input["description"].string, .agent)
        case "TodoWrite": self.init("checklist", "Updated the task list", "", .tasks)
        case "AskUser", "AskUserQuestion": self.init("questionmark.bubble", "Asked you", "", .ask)
        case "ExitPlanMode": self.init("list.bullet.clipboard", "Proposed a plan", "", .ask)
        case "SaveImage", "SaveVideo", "SaveAudio": self.init("square.and.arrow.down", "Saved", file(), .edit)
        case "ChangeDirectory": self.init("folder.badge.gearshape", "Changed folder", input["path"].string, .other(name))
        case "AddConnector": self.init("powerplug", "Added a connector", input["name"].string, .other(name))
        case "SendMessage": self.init("paperplane", "Sent a message", "", .agent)
        case "OpenApp": self.init("macwindow", "Opened", input["app"].string, .other(name))
        case "ComputerAction": self.init("cursorarrow.click.2", "Used the computer", "", .other(name))
        case "ViewImage": self.init("photo", "Looked at a picture", "", .read)
        case "MemorySearch", "MemoryView": self.init("brain", "Looked at memories", input["query"].string, .memory)
        case "MemoryUpdate":
            let op = input["op"].string
            self.init("brain", op == "delete" ? "Forgot a memory" : op == "update" ? "Updated a memory" : "Saved a memory", input["title"].string, .memory)
        case "ChatSearch": self.init("clock.arrow.circlepath", "Searched past chats", input["query"].string, .memory)
        case "ChatRead": self.init("clock.arrow.circlepath", "Read a past chat", "", .memory)
        default:
            let parts = name.components(separatedBy: "__")
            if parts.count >= 3, parts[0] == "mcp" { self.init("puzzlepiece.extension", parts[2].replacingOccurrences(of: "_", with: " ").capitalized, parts[1].replacingOccurrences(of: "_", with: " "), .other(name)) }
            else { self.init("wrench.and.screwdriver", name, "", .other(name)) }
        }
    }
    private init(_ icon: String, _ verb: String, _ target: String, _ kind: Kind) { self.icon = icon; self.verb = verb; self.target = target; self.kind = kind }

    /// "Read 4 files, ran 2 commands (1 failed)".
    static func summary(_ steps: [ToolStep]) -> String {
        var order: [Kind] = []
        var counts: [Kind: Int] = [:]
        var names: [Kind: String] = [:]
        for step in steps {
            let info = ToolInfo(step.call)
            if counts[info.kind] == nil { order.append(info.kind); names[info.kind] = info.verb }
            counts[info.kind, default: 0] += 1
        }
        let parts = order.map { kind -> String in
            let n = counts[kind] ?? 0
            switch kind {
            case .read: return "Read \(n) file\(n == 1 ? "" : "s")"
            case .edit: return "Edited \(n) file\(n == 1 ? "" : "s")"
            case .run: return "Ran \(n) command\(n == 1 ? "" : "s")"
            case .search: return n == 1 ? "Searched" : "Searched \(n) times"
            case .web: return n == 1 ? "Searched the web" : "Looked up \(n) pages"
            case .agent: return "Ran \(n) agent\(n == 1 ? "" : "s")"
            case .tasks: return "Updated tasks"
            case .ask: return "Asked you"
            case .memory: return n == 1 ? (names[kind] ?? "Used memory") : "Used memory"
            case .other: return n == 1 ? (names[kind] ?? "Used a tool") : "\(names[kind] ?? "Tool") ×\(n)"
            }
        }
        let failed = steps.filter(\.failed).count
        let joined = parts.joined(separator: ", ")
        return failed > 0 ? "\(joined) (\(failed) failed)" : joined
    }
}
