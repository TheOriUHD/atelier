import Foundation
import SwiftUI

// MARK: - The parts of Code mode that are logic, not screens
//
// Everything here is plain data and functions, so it can be tested without a server or a view: a folder as the server
// lists it, a unified diff taken apart, the permission modes, the checks a rule has to pass, and the small formats
// (durations, sizes, intervals) the Code screens show.

// MARK: Folders

/// One of the person's folders (`workspaces.list`).
struct CodeWorkspace: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable { case local, ssh, codespace }
    let id: String
    let kind: Kind
    let name: String
    let root: String
    let host: String?
    let deviceId: String?
    let available: Bool
    let scratch: Bool
    /// Absent from an older server, which applies everything the folder brings: then it counts as trusted.
    let trusted: Bool
    let lastUsedAt: Int

    init(_ json: JSON) {
        id = json["id"].string
        kind = Kind(rawValue: json["kind"].string) ?? .local
        name = json["name"].string
        root = json["root"].string
        host = json["host"].stringOrNil
        deviceId = json["deviceId"].stringOrNil
        available = json["available"].bool
        scratch = json["scratch"].bool
        trusted = json["trusted"].boolOrNil ?? true
        lastUsedAt = json["lastUsedAt"].int
    }

    /// How a folder is named in lists: SSH folders as `host:path`, a scratch folder as "No folder".
    var label: String {
        if scratch { return "No folder" }
        if kind == .ssh, let host { return "\(host):\(root)" }
        return ChatFolders.short(name)
    }
    /// Where it is, for the second line of a row.
    var location: String {
        if kind == .ssh, let host { return "\(host):\(root)" }
        if kind == .codespace { return root }
        return root
    }
    var kindBadge: String? {
        switch kind {
        case .local: nil
        case .ssh: "SSH"
        case .codespace: "Codespace"
        }
    }

    /// The machine a folder is on, in the words the desktop's Folders page uses.
    func computer(devices: [JSON]) -> String {
        switch kind {
        case .ssh: return host ?? "SSH host"
        case .codespace: return "Codespace \(host ?? "")".trimmingCharacters(in: .whitespaces)
        case .local:
            guard let deviceId else { return "The server's computer" }
            guard let device = devices.first(where: { $0["id"].string == deviceId }) else { return "A removed device" }
            return device["name"].string.isEmpty ? "Another computer" : device["name"].string
        }
    }

    /// Most recently used first, the order every folder list shows.
    static func recent(_ list: [CodeWorkspace]) -> [CodeWorkspace] { list.sorted { $0.lastUsedAt > $1.lastUsedAt } }
}

/// What the session's folder allows right now: used by every panel that needs one.
enum CodeFolderState: Equatable {
    case loading
    case none
    case missing
    case offline(String)
    case ready
}

// MARK: Unified diffs

struct CodeDiffRow: Equatable, Sendable, Identifiable {
    enum Kind: Sendable { case context, add, remove, hunk }
    let id: Int
    let kind: Kind
    let text: String
    /// The line on the row's side: the old file for a removal, the new one otherwise.
    let line: Int?
    /// Which hunk the row belongs to (the `@@` row names the hunk too).
    let hunk: Int?
}

struct CodeDiffFile: Equatable, Sendable, Identifiable {
    var id: String { path }
    var path: String
    var binary = false
    var added = 0
    var removed = 0
    var rows: [CodeDiffRow] = []
    /// The raw lines before the first hunk, each ending in a newline.
    var header = ""
    /// Each hunk's raw text, from its `@@` line on.
    var hunks: [String] = []

    enum Status: String, Sendable { case modified, added, deleted, renamed, untracked, conflicted }
    /// What the diff alone says happened to the file (used where git status isn't consulted).
    var status: Status {
        if header.contains("\nnew file mode") || header.hasPrefix("new file mode") { return .added }
        if header.contains("\ndeleted file mode") { return .deleted }
        if header.contains("\nrename from") { return .renamed }
        return .modified
    }
    /// What `git.revertHunk` takes to reject one change: the file's header lines and that hunk.
    func patch(forHunk index: Int) -> String? { hunks.indices.contains(index) ? header + hunks[index] : nil }
}

enum CodeDiff {
    /// `git diff` output, one entry per file in the order git printed them (a port of the desktop's `parseUnifiedDiff`).
    static func parse(_ diff: String) -> [CodeDiffFile] {
        var files: [CodeDiffFile] = []
        var oldLine = 0, newLine = 0, serial = 0
        var lines = diff.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        for line in lines {
            if line.hasPrefix("diff --git ") {
                let path = line.range(of: " b/", options: .backwards).map { String(line[$0.upperBound...]) } ?? line
                files.append(CodeDiffFile(path: path))
            } else if files.isEmpty { continue }
            let i = files.count - 1
            if line.hasPrefix("@@") {
                let numbers = hunkNumbers(line)
                oldLine = numbers.old; newLine = numbers.new
                files[i].hunks.append("")
                files[i].rows.append(CodeDiffRow(id: serial, kind: .hunk, text: line, line: nil, hunk: files[i].hunks.count - 1)); serial += 1
            } else if files[i].hunks.isEmpty {
                if line.hasPrefix("+++ b/") { files[i].path = String(line.dropFirst(6)) }
                else if line.hasPrefix("rename to ") { files[i].path = String(line.dropFirst(10)) }
                else if line.hasPrefix("Binary files ") { files[i].binary = true }
                files[i].header += line + "\n"
                continue
            } else if line.hasPrefix("+") {
                files[i].rows.append(CodeDiffRow(id: serial, kind: .add, text: String(line.dropFirst()), line: newLine, hunk: files[i].hunks.count - 1)); serial += 1
                newLine += 1; files[i].added += 1
            } else if line.hasPrefix("-") {
                files[i].rows.append(CodeDiffRow(id: serial, kind: .remove, text: String(line.dropFirst()), line: oldLine, hunk: files[i].hunks.count - 1)); serial += 1
                oldLine += 1; files[i].removed += 1
            } else if line.hasPrefix(" ") {
                files[i].rows.append(CodeDiffRow(id: serial, kind: .context, text: String(line.dropFirst()), line: newLine, hunk: files[i].hunks.count - 1)); serial += 1
                oldLine += 1; newLine += 1
            }
            if !files[i].hunks.isEmpty { files[i].hunks[files[i].hunks.count - 1] += line + "\n" }
        }
        return files
    }

    /// The start lines of `@@ -a,b +c,d @@`.
    static func hunkNumbers(_ line: String) -> (old: Int, new: Int) {
        let parts = line.split(separator: " ")
        func start(_ part: Substring?) -> Int {
            guard let part else { return 0 }
            let digits = part.dropFirst().split(separator: ",").first.map(String.init) ?? ""
            return Int(digits) ?? 0
        }
        return (start(parts.dropFirst().first), start(parts.dropFirst(2).first))
    }
}

/// How the Changes panel compares the working tree (`workspaces.diff`'s `compare`).
enum CodeCompare: String, CaseIterable, Identifiable, Sendable {
    case head, staged, base, session
    var id: String { rawValue }

    /// What can be compared: outside a repository only the session's own changes; `base` only off the default branch.
    static func options(repo: Bool, branch: String?, defaultBranch: String?) -> [CodeCompare] {
        guard repo else { return [.session] }
        var list: [CodeCompare] = [.head, .staged]
        if let defaultBranch, defaultBranch != branch { list.append(.base) }
        list.append(.session)
        return list
    }
    func title(branch: String?, defaultBranch: String?) -> String {
        let head = branch ?? "HEAD"
        switch self {
        case .head: return "\(head) → working tree"
        case .staged: return "\(head) → staged"
        case .base: return "\(defaultBranch ?? "main") → working tree"
        case .session: return "Session start → working tree"
        }
    }
    func detail(defaultBranch: String?) -> String {
        switch self {
        case .head: "Changes not committed yet"
        case .staged: "What the next commit takes"
        case .base: "Everything since this branch left \(defaultBranch ?? "main")"
        case .session: "What this session's edits changed"
        }
    }
    /// Rejecting a hunk reverses it in the working tree: only for diffs that end there.
    var rejectable: Bool { self == .head || self == .session }
}

/// One file of `workspaces.gitStatus`.
struct CodeGitFile: Identifiable, Equatable, Sendable {
    let path: String
    let status: CodeDiffFile.Status
    let staged: Bool
    var id: String { path }
    init(_ json: JSON) {
        path = json["path"].string
        status = CodeDiffFile.Status(rawValue: json["status"].string) ?? .modified
        staged = json["staged"].bool
    }
    var letter: String { status.letter }
    var word: String { status.word }
}

extension CodeDiffFile.Status {
    var letter: String {
        switch self {
        case .modified: "M"
        case .added: "A"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "U"
        case .conflicted: "!"
        }
    }
    /// How a screen reader says it.
    var word: String { self == .untracked ? "New" : self == .conflicted ? "Conflict" : rawValue.capitalized }
}

struct CodeGitStatus: Equatable, Sendable {
    var branch: String?
    var ahead: Int
    var behind: Int
    var hasUpstream: Bool
    var files: [CodeGitFile]

    /// `workspaces.gitStatus` answers null outside a repository.
    init?(_ json: JSON) {
        guard json != .null else { return nil }
        branch = json["branch"].stringOrNil
        hasUpstream = json["upstream"] != .null
        ahead = json["upstream"]["ahead"].int
        behind = json["upstream"]["behind"].int
        files = json["files"].array.map(CodeGitFile.init)
    }
    var stagedCount: Int { files.filter(\.staged).count }
    var conflicts: [CodeGitFile] { files.filter { $0.status == .conflicted } }
}

// MARK: Permission modes

/// Claude Code's permission modes as the app names them (docs/permissions.md).
enum CodeMode: String, CaseIterable, Identifiable, Sendable {
    case auto, ask = "default", acceptEdits, plan, planAuto, bypass = "bypassPermissions"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .auto: "Auto mode"
        case .ask: "Ask permissions"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan mode"
        case .planAuto: "Plan mode · Auto"
        case .bypass: "Bypass permissions"
        }
    }
    var short: String {
        switch self {
        case .auto: "Auto"
        case .ask: "Ask"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan"
        case .planAuto: "Plan · Auto"
        case .bypass: "Bypass"
        }
    }
    var detail: String {
        switch self {
        case .auto: "A separate review checks each action and blocks risky ones"
        case .ask: "Ask before editing files or running commands"
        case .acceptEdits: "Edit files without asking; still ask before commands"
        case .plan: "Read and plan only; changes wait until you approve the plan"
        case .planAuto: "Plan first; the reviewer answers what it would ask, and nothing changes until you approve"
        case .bypass: "Never ask, not even for risky commands"
        }
    }
    var symbol: String {
        switch self {
        case .auto: "checkmark.shield"
        case .ask: "hand.raised"
        case .acceptEdits: "pencil.line"
        case .plan, .planAuto: "list.bullet.clipboard"
        case .bypass: "exclamationmark.shield"
        }
    }
    var isPlan: Bool { self == .plan || self == .planAuto }

    /// What a session of this kind offers: Code all of them (Plan · Auto only where the server has it); a chat has no plan to approve.
    static func offered(code: Bool, planAuto: Bool) -> [CodeMode] {
        code ? allCases.filter { planAuto || $0 != .planAuto } : [.auto, .ask, .acceptEdits, .bypass]
    }
    /// A chat shows Plan (an admin's default made for Code) as the mode it asks in.
    func forChat() -> CodeMode { self == .plan ? .ask : self == .planAuto ? .auto : self }
}

// MARK: Rules

/// Checks for permission list entries before they are saved: Claude Code's syntax, `Tool` or `Tool(specifier)`, and
/// `mcp__server` or `mcp__server__tool` (the grammar the backend parses; see the desktop's `permission-rules.ts`).
enum CodeRules {
    static let example = "Bash(npm test *)"

    /// Why `rule` can't be saved, or nil when it is fine.
    static func error(_ rule: String) -> String? {
        let text = rule.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let pattern = #"^([A-Za-z_][\w-]*(?:__[\w-]+(?:__[\w*-]+)?)?)\s*(?:\((.*)\))?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let toolRange = Range(match.range(at: 1), in: text) else {
            return "Write a rule as Tool or Tool(specifier), like \(example)."
        }
        let tool = String(text[toolRange])
        if !tool.hasPrefix("mcp__"), tool.first?.isUppercase != true { return "Tool names start with a capital letter, like Bash, Read or WebFetch." }
        if tool == "WebFetch", let specRange = Range(match.range(at: 2), in: text) {
            let spec = text[specRange]
            if !spec.isEmpty, !spec.hasPrefix("domain:") { return "WebFetch rules name a domain, like WebFetch(domain:example.com)." }
        }
        return nil
    }

    /// Additional directories are compared with absolute paths on the folder's machine.
    static func directoryError(_ path: String) -> String? {
        let text = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.hasPrefix("/") || text.hasPrefix("\\\\") { return nil }
        if text.count >= 3, let first = text.first, first.isLetter, text[text.index(after: text.startIndex)] == ":", "\\/".contains(text[text.index(text.startIndex, offsetBy: 2)]) { return nil }
        return "Use an absolute path, like /srv/shared or C:\\Shared."
    }
}

// MARK: Loops and time

enum CodeFormat {
    /// "12s", "40m 36s", "20h 46m 11s".
    static func duration(_ ms: Int) -> String {
        let s = max(0, ms / 1000)
        let h = s / 3600, m = (s % 3600) / 60
        if h > 0 { return "\(h)h \(m)m \(s % 60)s" }
        return m > 0 ? "\(m)m \(s % 60)s" : "\(s % 60)s"
    }

    /// "45s", "5m", "2h", "1h 30m", "1d".
    static func interval(_ ms: Int) -> String {
        var rest = max(0, Int((Double(ms) / 1000).rounded()))
        var parts: [String] = []
        for (unit, size) in [("d", 86_400), ("h", 3_600), ("m", 60), ("s", 1)] {
            let n = rest / size
            rest -= n * size
            if n > 0 { parts.append("\(n)\(unit)") }
        }
        return parts.isEmpty ? "0s" : parts.joined(separator: " ")
    }

    /// `30s`, `5m`, `2h`, `1d`, or a combination in that order (`1h30m`); nil when the text isn't one.
    static func parseInterval(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !trimmed.isEmpty,
              let regex = try? NSRegularExpression(pattern: #"^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$"#),
              let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) else { return nil }
        func part(_ i: Int) -> Int {
            guard let range = Range(match.range(at: i), in: trimmed) else { return 0 }
            return Int(trimmed[range]) ?? 0
        }
        return part(1) * 86_400_000 + part(2) * 3_600_000 + part(3) * 60_000 + part(4) * 1000
    }

    static let loopMinMs = 60_000
    static let loopMaxMs = 24 * 3_600_000
    static let loopMaxRuns = 500
    static let loopMaxPerSession = 5
    static let loopMaxAgeMs = 7 * 24 * 3_600_000

    /// Why this interval can't start a loop, or nil.
    static func loopIntervalError(_ text: String) -> String? {
        guard let ms = parseInterval(text) else { return "Use a time like 30s, 5m, 2h or 1h30m." }
        if ms <= 0 { return "The interval has to be longer than zero." }
        if ms > loopMaxMs { return "The longest interval is 1d." }
        return nil
    }

    /// "How a finished task ended": Done, Exit code 1, Stopped.
    static func outcome(status: String, exitCode: Int?) -> String {
        switch status {
        case "running": "Running"
        case "failed": exitCode.map { "Exit code \($0)" } ?? "Failed"
        case "stopped": "Stopped"
        default: "Done"
        }
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    /// GitHub's codespace states as the app names them, with the tone of their badge.
    static func codespaceState(_ state: String) -> (String, StatusBadge.Tone) {
        switch state {
        case "Available": ("Running", .good)
        case "Shutdown": ("Stopped", .neutral)
        case "Starting": ("Starting", .warn)
        case "ShuttingDown": ("Stopping", .warn)
        case "Provisioning": ("Creating", .warn)
        case "Rebuilding": ("Rebuilding", .warn)
        case "Failed": ("Failed", .bad)
        case "Unavailable": ("Unavailable", .bad)
        default: (state, .neutral)
        }
    }
    /// States that don't change by themselves; any other one is read again until it settles.
    static func codespaceSettled(_ state: String) -> Bool { ["Available", "Shutdown", "Failed", "Unavailable", "Archived"].contains(state) }
}

/// A background task (`session.tasks`) with the words the Tasks panel uses for it.
struct CodeTask: Identifiable, Equatable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var kind: String { raw["kind"].string }
    var title: String { raw["title"].string }
    var command: String? { raw["command"].stringOrNil }
    var sessionId: String? { raw["sessionId"].stringOrNil }
    var background: Bool { raw["background"].bool }
    var status: String { raw["status"].string }
    var running: Bool { status == "running" }
    var startedAt: Int { raw["startedAt"].int }
    var endedAt: Int? { raw["endedAt"].intOrNil }
    var exitCode: Int? { raw["exitCode"].intOrNil }
    var outcome: String { CodeFormat.outcome(status: status, exitCode: exitCode) }
    var kindLabel: String { kind == "command" ? "Command" : kind == "agent" ? "Agent" : "Loop" }
    var openLabel: String { kind == "command" ? "View output" : kind == "agent" ? "View transcript" : "View loop" }
    var symbol: String { kind == "command" ? "terminal" : kind == "agent" ? "person.crop.circle.badge.clock" : "repeat" }

    var loopIntervalMs: Int { raw["loop"]["intervalMs"].int }
    var loopRuns: Int { raw["loop"]["runs"].int }
    var loopNextAt: Int? { raw["loop"]["nextAt"].intOrNil }
    var loopWaiting: Bool { raw["loop"]["waiting"].bool }

    func duration(now: Int) -> String { CodeFormat.duration((endedAt ?? now) - startedAt) }

    /// "Every 5m · 3 runs · next in 4m 12s": a loop's schedule.
    func schedule(now: Int) -> String {
        var parts = ["Every \(CodeFormat.interval(loopIntervalMs))", "\(loopRuns) \(loopRuns == 1 ? "run" : "runs")"]
        if running {
            if loopWaiting { parts.append("next once the session is idle") }
            else if let next = loopNextAt { parts.append("next in \(CodeFormat.duration(Int((Double(max(0, next - now)) / 1000).rounded(.up)) * 1000))") }
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: Plans

enum CodePlan {
    enum Status: Sendable { case writing, waiting, approved, declined
        var words: String {
            switch self {
            case .writing: "Writing the plan…"
            case .waiting: "Waiting for your approval"
            case .approved: "Approved"
            case .declined: "Not approved"
            }
        }
    }
    static let modeOff = "Plan mode is off, so this plan needs no approval: go ahead with the work."

    /// The newest plan in the conversation and where it stands, or nil before the first.
    static func latest(_ messages: [JSON]) -> (plan: String, status: Status)? {
        for index in messages.indices.reversed() {
            let message = messages[index]
            guard message["role"].string == "assistant" else { continue }
            guard let call = message["parts"].array.last(where: { $0["type"].string == "tool_call" && $0["name"].string == "ExitPlanMode" }) else { continue }
            var result: JSON?
            for later in messages[index...] {
                if let found = later["parts"].array.first(where: { $0["type"].string == "tool_result" && $0["callId"] == call["id"] }) { result = found; break }
            }
            if let result, result["content"].array.map({ $0["text"].string }).joined(separator: "\n") == modeOff { continue }
            let plan = call["input"]["plan"].string
            let status: Status = result.map { $0["isError"].bool ? .declined : .approved } ?? (plan.isEmpty ? .writing : .waiting)
            return (plan, status)
        }
        return nil
    }

    /// Splits a plan into the blocks a person comments on: paragraphs, lists and fenced code stay whole.
    static func blocks(_ plan: String) -> [String] {
        var blocks: [String] = [], current: [String] = [], fenced = false
        func flush() { if !current.isEmpty { blocks.append(current.joined(separator: "\n")); current = [] } }
        for line in plan.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { fenced.toggle(); current.append(line); if !fenced { flush() }; continue }
            if !fenced, line.trimmingCharacters(in: .whitespaces).isEmpty { flush() } else { current.append(line) }
        }
        flush()
        return blocks
    }

    /// What the model is told when the plan is sent back: the person's words, then each comment with its passage.
    static func revisionMessage(feedback: String, comments: [(quote: String, text: String)], max: Int = 2000) -> String? {
        var parts: [String] = []
        if !feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(feedback.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if !comments.isEmpty {
            let lines = comments.map { "- On “\(clip($0.quote.split(whereSeparator: \.isWhitespace).joined(separator: " "), 140))”: \($0.text.trimmingCharacters(in: .whitespacesAndNewlines))" }
            parts.append("Comments on the plan:\n" + lines.joined(separator: "\n"))
        }
        let message = parts.joined(separator: "\n\n")
        return message.isEmpty ? nil : clip(message, max)
    }
    private static func clip(_ text: String, _ max: Int) -> String {
        text.count > max ? String(text.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : text
    }
}

// MARK: Paths

enum CodePath {
    static func name(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }
    static func directory(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }
    static func ext(_ path: String) -> String { (name(path) as NSString).pathExtension.lowercased() }

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "ico", "tiff", "avif"]
    static func isImage(_ path: String) -> Bool { imageExtensions.contains(ext(path)) }

    /// The language a highlighter should use for a file name, or nil for plain text.
    static func language(_ path: String) -> String? {
        let file = name(path).lowercased()
        if file == "dockerfile" || file == "makefile" { return file }
        switch ext(path) {
        case "ts", "tsx", "mts", "cts": return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "swift": return "swift"
        case "py": return "python"
        case "rb": return "ruby"
        case "go": return "go"
        case "rs": return "rust"
        case "java", "kt", "kts": return "java"
        case "c", "h", "cc", "cpp", "hpp", "cs", "m", "mm": return "c"
        case "php": return "php"
        case "sh", "bash", "zsh", "fish": return "shell"
        case "json", "jsonc", "json5": return "json"
        case "yml", "yaml", "toml", "ini", "conf", "cfg", "env": return "config"
        case "html", "htm", "xml", "svg", "vue", "svelte": return "markup"
        case "css", "scss", "less": return "css"
        case "sql": return "sql"
        case "md", "mdx": return "markdown"
        default: return nil
        }
    }

    /// An outline symbol for a file, by its name.
    static func symbol(_ file: String) -> String {
        let lower = file.lowercased()
        switch (lower as NSString).pathExtension {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "py", "rb", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "vue", "svelte", "html", "css", "scss", "sql": return "chevron.left.forwardslash.chevron.right"
        case "json", "jsonc", "json5": return "curlybraces"
        case "md", "mdx", "txt", "rst", "adoc": return "doc.text"
        case "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "heic": return "photo"
        case "csv", "tsv", "xlsx", "xls": return "tablecells"
        case "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar": return "archivebox"
        case "sh", "bash", "zsh", "fish", "ps1": return "terminal"
        case "lock": return "lock"
        case "yml", "yaml", "toml", "ini", "env", "conf", "cfg": return "gearshape"
        default: return lower.hasPrefix(".") || ["dockerfile", "makefile"].contains(lower) ? "gearshape" : "doc"
        }
    }
}

// MARK: Errors in words

enum CodeFailure {
    /// An error the way a person reads it: a procedure an older server doesn't have becomes a calm sentence.
    static func words(_ error: Error) -> String {
        let text = error.localizedDescription
        if text.hasPrefix("Unknown method") { return "This server doesn't support this yet." }
        if text.localizedCaseInsensitiveContains("forbidden") && text.count < 40 { return "You don't have access to this." }
        return text
    }
    static func isUnsupported(_ error: Error) -> Bool { error.localizedDescription.hasPrefix("Unknown method") }
}
