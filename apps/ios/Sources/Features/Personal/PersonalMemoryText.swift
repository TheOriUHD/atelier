import Foundation

// MARK: - Memory: the words and the parsing that don't need a screen (ported from packages/protocol memory.ts)

enum PersonalMemoryText {
    static let fixed: [(section: String, title: String)] = [("preferences", "Preferences"), ("profile", "Profile")]
    static let listSections: [(section: String, title: String)] = [("topic", "Topics"), ("area", "Areas"), ("person", "People"), ("project", "Projects")]
    static let docs = "https://docs.atelierhq.dev/memory/"
    static let examples = ["My dog's name is Beans", "Keep lists under five things", "I work Pacific time hours", "I'm learning Japanese", "Call me Sam"]

    static func isFixed(_ section: String) -> Bool { section == "preferences" || section == "profile" }

    /// "How Ada wants Atelier to respond" / "Who Ada is".
    static func fixedSummary(section: String, name: String) -> String { section == "preferences" ? "How \(name) wants Atelier to respond" : "Who \(name) is" }

    /// An entry's details as single facts, without their bullets.
    static func lines(_ details: String) -> [String] {
        details.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            String(line).replacingOccurrences(of: #"^\s*(?:[-*•]|\d+[.)])\s+"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
    }

    /// "Updated Preferences", "Saved Beans and 2 more".
    static func describe(_ changes: [JSON]) -> String {
        guard let first = changes.first else { return "Nothing to change" }
        let verb = ["created": "Saved", "updated": "Updated", "deleted": "Forgot"][first["op"].string] ?? "Updated"
        let rest = changes.count - 1
        return "\(verb) \(first["title"].string)\(rest > 0 ? " and \(rest) more" : "")"
    }

    /// "Added 4 entries, updated Profile and Preferences": what an import did, each entry counted once.
    static func describeImport(_ changes: [JSON]) -> String {
        var created: [String: String] = [:]
        var updated: [(String, String)] = []
        for change in changes {
            let id = change["id"].string
            if change["op"].string == "created" { created[id] = change["title"].string }
            else if change["op"].string == "updated", created[id] == nil, !updated.contains(where: { $0.0 == id }) { updated.append((id, change["title"].string)) }
        }
        var parts: [String] = []
        if !created.isEmpty { parts.append("added \(created.count) \(created.count == 1 ? "entry" : "entries")") }
        if !updated.isEmpty {
            let titles = updated.map(\.1)
            let named = titles.count > 3 ? "\(titles.count) entries" : titles.count == 1 ? titles[0] : "\(titles.dropLast().joined(separator: ", ")) and \(titles.last ?? "")"
            parts.append("updated \(named)")
        }
        guard !parts.isEmpty else { return "Nothing in it could be added to memory" }
        let text = parts.joined(separator: ", ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    // MARK: Import

    static let importChunk = 6_000

    private static let heading = try? NSRegularExpression(pattern: #"^\s*(?:#{1,6}\s+\S.*|\*\*[^*]+\*\*:?|\d{1,2}[.)]\s+[A-Z][\w &/,'-]{0,50}:?|[A-Z][\w &/,'-]{0,50}:)\s*$"#)

    private static func isHeading(_ line: String) -> Bool {
        guard line.count < 80, let heading else { return false }
        return heading.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }

    /// An export cut into parts for import: whole sections where they fit, a long section in runs of lines with its heading repeated.
    static func splitExport(_ text: String, max: Int = importChunk) -> [String] {
        var sections: [(heading: String, lines: [String])] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n") {
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { continue }
            let line = raw.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
            if isHeading(line) { sections.append((line.trimmingCharacters(in: .whitespaces), [])) }
            else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                if sections.isEmpty { sections.append(("", [])) }
                sections[sections.count - 1].lines.append(line)
            }
        }
        var pieces: [String] = []
        for (heading, lines) in sections where !lines.isEmpty {
            var run: [String] = []
            var size = heading.count
            func flush() {
                if !run.isEmpty { pieces.append(([heading] + run).filter { !$0.isEmpty }.joined(separator: "\n")) }
                run = []; size = heading.count
            }
            for line in lines {
                let cut = line.count > max ? String(line.prefix(max)) : line
                if size + cut.count + 1 > max { flush() }
                run.append(cut); size += cut.count + 1
            }
            flush()
        }
        var parts: [String] = []
        for piece in pieces {
            if let last = parts.last, last.count + piece.count + 2 <= max { parts[parts.count - 1] = last + "\n\n" + piece } else { parts.append(piece) }
        }
        return parts
    }

    /// What Start import asks the person to paste into their other assistant (the Memory page of the docs).
    static let importPrompt = """
    I'm moving to another assistant and want to take what you know about me along. Export everything you have stored or learned about me: your saved memories and any context you've picked up from our conversations. Copy entries word for word where you can, and don't summarize, merge or leave anything out.

    Sort the entries into these sections, in this order, and skip a section only if you have nothing for it:

    1. Instructions: rules I've explicitly asked you to follow about tone, format, style, length or language, things to always or never do, and corrections I've made to how you respond. Only take these from your stored memories, not from guesses about my habits.
    2. Identity: my name, age, where I live, education, family and relationships, and languages I speak.
    3. Career: my roles, the companies I've worked for, and my skills.
    4. Interests: my hobbies and interests, each with everything you know about it (gear, plans, purchases, progress).
    5. People: the people in my life, one entry per fact, each starting with the person's name.
    6. Projects: one entry per fact about the projects I've told you about, each starting with the project's name: what it is, where it stands, and the decisions made so far.
    7. Preferences: my opinions and tastes, and how I like to work.

    Format: put each section under its own Markdown header, such as "## Identity". Write one entry per line, oldest first, as:
    [YYYY-MM-DD] - Entry
    Use [unknown] in place of the date when you don't know when you learned it.

    Put the whole export inside a single code block so I can copy it in one go. After the code block, tell me whether this is everything you have about me or whether some of it couldn't be included.
    """
}
