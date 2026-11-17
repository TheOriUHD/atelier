import SwiftUI

// MARK: - Colors for code
//
// The desktop highlights with TextMate grammars; a phone can't carry sixty of them, so this reads the common shapes of
// source code (comments, strings, numbers, keywords, types, calls) for the languages people work in, and paints them
// with the same theme names Settings › Code stores. A theme this app doesn't know is drawn as the Atelier one.

struct CodeSyntaxTheme: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let dark: Bool
    /// Hex colors: background, text, keyword, type, string, number, comment, function.
    let colors: [UInt32]

    var background: Color { Color(hex: colors[0]) }
    var plain: Color { Color(hex: colors[1]) }
    func color(_ role: CodeSyntax.Role) -> Color {
        switch role {
        case .plain, .punctuation: plain
        case .keyword: Color(hex: colors[2])
        case .type: Color(hex: colors[3])
        case .string: Color(hex: colors[4])
        case .number: Color(hex: colors[5])
        case .comment: Color(hex: colors[6])
        case .function: Color(hex: colors[7])
        }
    }

    static let all: [CodeSyntaxTheme] = [
        CodeSyntaxTheme(id: "atelier-light", label: "Atelier Light", dark: false, colors: [0xFFFFFF, 0x0B0B0B, 0x92452B, 0x6D5C16, 0x006300, 0x734500, 0x5D5D58, 0x184F95]),
        CodeSyntaxTheme(id: "github-light", label: "GitHub Light", dark: false, colors: [0xFFFFFF, 0x24292E, 0xD73A49, 0x6F42C1, 0x032F62, 0x005CC5, 0x6A737D, 0x6F42C1]),
        CodeSyntaxTheme(id: "one-light", label: "One Light", dark: false, colors: [0xFAFAFA, 0x383A42, 0xA626A4, 0xC18401, 0x50A14F, 0x986801, 0xA0A1A7, 0x4078F2]),
        CodeSyntaxTheme(id: "solarized-light", label: "Solarized Light", dark: false, colors: [0xFDF6E3, 0x657B83, 0x859900, 0xB58900, 0x2AA198, 0xD33682, 0x93A1A1, 0x268BD2]),
        CodeSyntaxTheme(id: "catppuccin-latte", label: "Catppuccin Latte", dark: false, colors: [0xEFF1F5, 0x4C4F69, 0x8839EF, 0xDF8E1D, 0x40A02B, 0xFE640B, 0x9CA0B0, 0x1E66F5]),
        CodeSyntaxTheme(id: "vitesse-light", label: "Vitesse Light", dark: false, colors: [0xFFFFFF, 0x393A34, 0x1E754F, 0x2993A3, 0xB56959, 0x2F798A, 0xA0ADA0, 0x59873A]),
        CodeSyntaxTheme(id: "atelier-dark", label: "Atelier Dark", dark: true, colors: [0x151515, 0xF0EFEC, 0xD68E76, 0xFFD014, 0x0EBB0E, 0xDB9300, 0xA19F99, 0x6DA7EC]),
        CodeSyntaxTheme(id: "github-dark", label: "GitHub Dark", dark: true, colors: [0x0D1117, 0xC9D1D9, 0xFF7B72, 0xD2A8FF, 0xA5D6FF, 0x79C0FF, 0x8B949E, 0xD2A8FF]),
        CodeSyntaxTheme(id: "one-dark-pro", label: "One Dark Pro", dark: true, colors: [0x282C34, 0xABB2BF, 0xC678DD, 0xE5C07B, 0x98C379, 0xD19A66, 0x7F848E, 0x61AFEF]),
        CodeSyntaxTheme(id: "dracula", label: "Dracula", dark: true, colors: [0x282A36, 0xF8F8F2, 0xFF79C6, 0x8BE9FD, 0xF1FA8C, 0xBD93F9, 0x6272A4, 0x50FA7B]),
        CodeSyntaxTheme(id: "nord", label: "Nord", dark: true, colors: [0x2E3440, 0xD8DEE9, 0x81A1C1, 0x8FBCBB, 0xA3BE8C, 0xB48EAD, 0x616E88, 0x88C0D0]),
        CodeSyntaxTheme(id: "tokyo-night", label: "Tokyo Night", dark: true, colors: [0x1A1B26, 0xA9B1D6, 0x9D7CD8, 0x2AC3DE, 0x9ECE6A, 0xFF9E64, 0x565F89, 0x7AA2F7]),
        CodeSyntaxTheme(id: "catppuccin-mocha", label: "Catppuccin Mocha", dark: true, colors: [0x1E1E2E, 0xCDD6F4, 0xCBA6F7, 0xF9E2AF, 0xA6E3A1, 0xFAB387, 0x6C7086, 0x89B4FA]),
        CodeSyntaxTheme(id: "solarized-dark", label: "Solarized Dark", dark: true, colors: [0x002B36, 0x839496, 0x859900, 0xB58900, 0x2AA198, 0xD33682, 0x586E75, 0x268BD2]),
        CodeSyntaxTheme(id: "vitesse-dark", label: "Vitesse Dark", dark: true, colors: [0x121212, 0xDBD7CA, 0x4D9375, 0x5DA994, 0xC98A7D, 0x4C9A91, 0x758575, 0x80A665]),
    ]
    static func themes(dark: Bool) -> [CodeSyntaxTheme] { all.filter { $0.dark == dark } }
    /// The theme for an id; an id this app doesn't have is drawn as the Atelier one of its kind.
    static func resolve(_ id: String, dark: Bool) -> CodeSyntaxTheme {
        all.first { $0.id == id && $0.dark == dark } ?? all.first { $0.id == (dark ? "atelier-dark" : "atelier-light") }!
    }
    /// "tokyo-night-storm" as a person would write it, for a theme only the desktop has.
    static func label(forUnknown id: String) -> String { id.split(separator: "-").map { $0.capitalized }.joined(separator: " ") }
}

enum CodeSyntax {
    enum Role: Sendable { case plain, keyword, type, string, number, comment, function, punctuation }

    private struct Language {
        var keywords: Set<String>
        var lineComments: [String] = ["//"]
        var block: (String, String)? = ("/*", "*/")
        var quotes: [Character] = ["\"", "'"]
        /// Strings that may run over several lines: their opening delimiter.
        var multiline: [String] = []
        var caseInsensitive = false
        var jsonKeys = false
    }

    private static func words(_ text: String) -> Set<String> { Set(text.split(separator: " ").map(String.init)) }

    private static let cFamily = Language(keywords: words("if else for while do switch case default break continue return goto sizeof struct union enum typedef static const extern volatile inline void int char float double long short unsigned signed bool true false null nullptr NULL new delete class public private protected virtual override final namespace using template typename this try catch throw import package interface extends implements abstract synchronized async await fn let mut var val fun object when in is as"))

    private static func language(_ name: String?) -> Language? {
        switch name {
        case "javascript", "typescript":
            return Language(keywords: words("const let var function return if else for while do switch case default break continue new delete typeof instanceof in of void yield async await class extends super this import export from as default try catch finally throw null undefined true false enum interface type implements public private protected readonly static abstract declare namespace module keyof satisfies"), quotes: ["\"", "'", "`"], multiline: ["`"])
        case "swift":
            return Language(keywords: words("let var func return if else guard switch case default for while repeat break continue in is as try catch throw throws rethrows defer do class struct enum protocol extension import init deinit self Self super nil true false static private public internal fileprivate open final override mutating nonmutating async await actor some any where typealias associatedtype subscript inout lazy weak unowned @MainActor @Observable @State @Binding"), multiline: ["\"\"\""])
        case "python":
            return Language(keywords: words("def class return if elif else for while break continue pass import from as with try except finally raise lambda yield global nonlocal assert del in is not and or None True False async await match case self"), lineComments: ["#"], block: nil, multiline: ["\"\"\"", "'''"])
        case "ruby":
            return Language(keywords: words("def class module end if elsif else unless case when while until for in do begin rescue ensure raise return yield self nil true false and or not then require include extend attr_accessor attr_reader puts"), lineComments: ["#"], block: nil)
        case "go":
            return Language(keywords: words("func return if else for range switch case default break continue go defer select chan map struct interface type package import var const nil true false fallthrough goto"), quotes: ["\"", "'", "`"], multiline: ["`"])
        case "rust":
            return Language(keywords: words("fn let mut const static return if else match for while loop break continue struct enum impl trait pub use mod crate self Self super as in where move ref async await dyn unsafe type true false"))
        case "java", "c":
            return cFamily
        case "php":
            return Language(keywords: words("function return if else elseif foreach for while do switch case default break continue new class extends implements public private protected static const use namespace try catch finally throw echo null true false array isset empty"), lineComments: ["//", "#"])
        case "shell":
            return Language(keywords: words("if then else elif fi for while do done case esac in function return exit export local readonly echo cd set unset source alias true false"), lineComments: ["#"], block: nil)
        case "dockerfile":
            return Language(keywords: words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS"), lineComments: ["#"], block: nil)
        case "makefile":
            return Language(keywords: words("ifeq ifneq ifdef ifndef else endif include define endef export .PHONY"), lineComments: ["#"], block: nil)
        case "config":
            return Language(keywords: words("true false null yes no on off"), lineComments: ["#"], block: nil)
        case "json":
            return Language(keywords: words("true false null"), lineComments: [], block: nil, quotes: ["\""], jsonKeys: true)
        case "css":
            return Language(keywords: words("important inherit initial none auto"), lineComments: [], quotes: ["\"", "'"])
        case "sql":
            return Language(keywords: words("select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all null true false primary key foreign references default unique count sum avg min max like in is between exists case when then else end begin commit rollback"), lineComments: ["--"], caseInsensitive: true)
        case "markup":
            return Language(keywords: [], lineComments: [], block: ("<!--", "-->"))
        default:
            return nil
        }
    }

    /// Highlights a file's lines. Files with a very long line or too many lines are drawn plain.
    static func highlight(_ lines: [String], language name: String?, theme: CodeSyntaxTheme) -> [AttributedString] {
        let plain = { (text: String) -> AttributedString in
            var run = AttributedString(text)
            run.foregroundColor = theme.plain
            return run
        }
        if name == "markdown" { return lines.map { markdown($0, theme: theme) } }
        guard let language = language(name), lines.count <= 6000 else { return lines.map(plain) }
        var state: State = .none
        return lines.map { line in
            line.utf16.count > 2000 ? plain(line) : tokens(of: line, language: language, state: &state, name: name, theme: theme)
        }
    }

    private enum State { case none, block(String), multiline(String) }

    private static func markdown(_ line: String, theme: CodeSyntaxTheme) -> AttributedString {
        var run = AttributedString(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("#") { run.foregroundColor = theme.color(.keyword); run.font = .system(.footnote, design: .monospaced).bold() }
        else if trimmed.hasPrefix("```") || trimmed.hasPrefix("    ") { run.foregroundColor = theme.color(.string) }
        else if trimmed.hasPrefix(">") { run.foregroundColor = theme.color(.comment) }
        else { run.foregroundColor = theme.plain }
        return run
    }

    private static func isWordStart(_ c: Character) -> Bool { c.isLetter || c == "_" || c == "$" || c == "@" }
    private static func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "$" }

    private static func tokens(of line: String, language: Language, state: inout State, name: String?, theme: CodeSyntaxTheme) -> AttributedString {
        var out = AttributedString()
        var pending = ""
        var pendingRole = Role.plain
        func flush() {
            guard !pending.isEmpty else { return }
            var run = AttributedString(pending)
            run.foregroundColor = theme.color(pendingRole)
            if pendingRole == .comment { run.font = .system(.footnote, design: .monospaced).italic() }
            out += run
            pending = ""
        }
        func add(_ text: String, _ role: Role) {
            if role != pendingRole { flush(); pendingRole = role }
            pending += text
        }

        let chars = Array(line)
        var i = 0
        func hasPrefix(_ prefix: String, at index: Int) -> Bool {
            let p = Array(prefix)
            guard index + p.count <= chars.count else { return false }
            for k in 0..<p.count where chars[index + k] != p[k] { return false }
            return true
        }
        /// Reads to the end of a string that started before `start`; returns where it stopped and whether it closed.
        func scanString(from start: Int, closing: String) -> (Int, Bool) {
            var j = start
            let end = Array(closing)
            while j < chars.count {
                if chars[j] == "\\" { j += 2; continue }
                if hasPrefix(closing, at: j) { return (j + end.count, true) }
                j += 1
            }
            return (chars.count, false)
        }

        // Where an earlier line left off.
        switch state {
        case .block(let end):
            var j = 0
            var closed = false
            while j < chars.count { if hasPrefix(end, at: j) { j += end.count; closed = true; break }; j += 1 }
            add(String(chars[0..<min(j, chars.count)]), .comment)
            i = j
            if closed { state = .none }
        case .multiline(let delimiter):
            let (end, closed) = scanString(from: 0, closing: delimiter)
            add(String(chars[0..<min(end, chars.count)]), .string)
            i = end
            if closed { state = .none }
        case .none: break
        }

        while i < chars.count {
            let c = chars[i]
            if let comment = language.lineComments.first(where: { hasPrefix($0, at: i) }) {
                _ = comment
                add(String(chars[i...]), .comment); i = chars.count; break
            }
            if let block = language.block, hasPrefix(block.0, at: i) {
                var j = i + block.0.count
                var closed = false
                while j < chars.count { if hasPrefix(block.1, at: j) { j += block.1.count; closed = true; break }; j += 1 }
                add(String(chars[i..<min(j, chars.count)]), .comment)
                i = min(j, chars.count)
                if !closed { state = .block(block.1) }
                continue
            }
            if let delimiter = language.multiline.first(where: { hasPrefix($0, at: i) }) {
                let (end, closed) = scanString(from: i + delimiter.count, closing: delimiter)
                add(String(chars[i..<min(end, chars.count)]), .string)
                i = min(end, chars.count)
                if !closed { state = .multiline(delimiter) }
                continue
            }
            if language.quotes.contains(c) {
                let (end, _) = scanString(from: i + 1, closing: String(c))
                let text = String(chars[i..<min(end, chars.count)])
                var role = Role.string
                if language.jsonKeys {
                    var k = end
                    while k < chars.count, chars[k] == " " { k += 1 }
                    if k < chars.count, chars[k] == ":" { role = .function }
                }
                add(text, role)
                i = min(end, chars.count)
                continue
            }
            if c.isNumber, i == 0 || !isWord(chars[i - 1]) {
                var j = i
                while j < chars.count, chars[j].isHexDigit || "xXoObB._".contains(chars[j]) { j += 1 }
                add(String(chars[i..<j]), .number)
                i = j
                continue
            }
            if isWordStart(c) {
                var j = i + 1
                while j < chars.count, isWord(chars[j]) || (name == "css" && chars[j] == "-") { j += 1 }
                let word = String(chars[i..<j])
                var k = j
                while k < chars.count, chars[k] == " " { k += 1 }
                let lookup = language.caseInsensitive ? word.lowercased() : word
                let role: Role
                if language.keywords.contains(lookup) || language.keywords.contains(word) { role = .keyword }
                else if k < chars.count, chars[k] == "(" { role = .function }
                else if word.first?.isUppercase == true, word.count > 1, name != "shell", name != "config" { role = .type }
                else { role = .plain }
                add(word, role)
                i = j
                continue
            }
            if name == "markup", c == "<" {
                var j = i + 1
                if j < chars.count, chars[j] == "/" { j += 1 }
                while j < chars.count, isWord(chars[j]) || chars[j] == "-" { j += 1 }
                add(String(chars[i..<j]), .keyword)
                i = j
                continue
            }
            add(String(c), isWordStart(c) ? .plain : .punctuation)
            i += 1
        }
        flush()
        return out
    }
}
