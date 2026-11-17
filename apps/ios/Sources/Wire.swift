import Foundation

indirect enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> JSON { if case .object(let o) = self { o[key] ?? .null } else { .null } }
    var string: String { if case .string(let s) = self { s } else { "" } }
    var array: [JSON] { if case .array(let a) = self { a } else { [] } }
    var int: Int { if case .number(let n) = self { Int(n) } else { 0 } }
    var bool: Bool { self == .bool(true) }
    var pretty: String { (try? String(data: JSONEncoder.pretty.encode(self), encoding: .utf8)) ?? "" }
    func setting(_ key: String, _ value: JSON) -> JSON {
        guard case .object(var o) = self else { return self }
        o[key] = value
        return .object(o)
    }
    static func text(_ value: String) -> JSON { .object(["type": .string("text"), "text": .string(value)]) }
}
private extension JSONEncoder {
    static var pretty: JSONEncoder { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return e }
}

struct MessageItem: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
}

struct Conversation: Identifiable, Sendable, Equatable {
    let raw: JSON
    var id: String { raw["id"].string }
    var title: String { raw["title"].string.isEmpty ? "New conversation" : raw["title"].string }
    var status: String { raw["status"].string }
    var model: String { raw["model"].string }
    var pinned: Bool { raw["pinnedAt"] != .null }
    var mode: String { raw["mode"].string }
}

struct Transcript: Sendable {
    var snapshot: JSON = .null
    var messages: [JSON] { snapshot["messages"].array }
    var seq: Int { snapshot["seq"].int }
    var pending: JSON { snapshot["pending"] }
    var status: String { snapshot["session"]["status"].string }
    mutating func apply(_ envelope: JSON) -> Bool {
        let next = envelope["seq"].int
        guard next > seq else { return true }
        guard next == seq + 1 else { return false }
        let event = envelope["event"]
        var messages = messages
        switch event["type"].string {
        case "message":
            let message = event["message"]
            if let i = messages.firstIndex(where: { $0["id"] == message["id"] }) { messages[i] = message }
            else { messages.append(message) }
        case "delta", "part":
            guard let i = messages.firstIndex(where: { $0["id"] == event["messageId"] }) else { return false }
            var parts = messages[i]["parts"].array
            let index = event["index"].int
            guard index >= 0, index <= parts.count else { return false }
            if event["type"].string == "part" {
                if index == parts.count { parts.append(event["part"]) } else { parts[index] = event["part"] }
            } else {
                let kind = event["kind"].string
                guard kind == "text" || kind == "thinking" else { return false }
                if index == parts.count { parts.append(.object(["type": .string(kind), "text": .string("")])) }
                parts[index] = parts[index].setting("text", .string(parts[index]["text"].string + event["text"].string))
            }
            messages[i] = messages[i].setting("parts", .array(parts))
        case "done":
            guard let i = messages.firstIndex(where: { $0["id"] == event["messageId"] }) else { return false }
            messages[i] = messages[i].setting("error", event["error"]).setting("usage", event["usage"])
        case "status": snapshot = snapshot.setting("session", snapshot["session"].setting("status", event["status"]))
        case "title": snapshot = snapshot.setting("session", snapshot["session"].setting("title", event["title"]))
        case "pending": snapshot = snapshot.setting("pending", event["pending"])
        case "todos": snapshot = snapshot.setting("todos", event["todos"])
        case "tasks": snapshot = snapshot.setting("tasks", event["tasks"])
        case "context": snapshot = snapshot.setting("context", event["context"])
        case "outbox": snapshot = snapshot.setting("outbox", event["items"])
        case "compacting": snapshot = snapshot.setting("compacting", event["active"])
        case "phase": snapshot = snapshot.setting("phase", event["phase"])
        case "queued": snapshot = snapshot.setting("queued", event["ahead"])
        case "tool_output":
            let key = event["callId"].string
            snapshot = snapshot.setting("toolOutput", snapshot["toolOutput"].setting(key, .string(snapshot["toolOutput"][key].string + event["text"].string)))
        case "tool_progress": break
        case "artifact", "compacted", "branch", "resync": return false
        case "suggestion", "limit_warning", "presence", "typing", "reaction": break
        default: return false
        }
        snapshot = snapshot.setting("messages", .array(messages)).setting("seq", .number(Double(next)))
        return true
    }
}

enum MobileError: LocalizedError {
    case message(String)
    /// An answer from the server: the JSON-RPC code, the stable application code the server puts in `data.code`
    /// (for example "forbidden"), the message, and a Settings link that fixes the problem (`data.fix`).
    case rpc(code: Int, appCode: String, message: String, fix: String?)
    var errorDescription: String? {
        switch self {
        case .message(let text): text
        case .rpc(_, _, let text, _): text
        }
    }
    var appCode: String? { if case .rpc(_, let code, _, _) = self, !code.isEmpty { code } else { nil } }
    var rpcCode: Int? { if case .rpc(let code, _, _, _) = self { code } else { nil } }
    var fix: String? { if case .rpc(_, _, _, let fix) = self { fix } else { nil } }
    /// The server doesn't know the procedure (an older server).
    var isUnsupported: Bool { rpcCode == -32601 }
}

func serverURL(_ input: String) throws -> URL {
    guard let url = URL(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
          LocalAddress.allows(url), url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else {
        throw MobileError.message("Enter an HTTPS server address without a path, password, or query.")
    }
    return url
}
