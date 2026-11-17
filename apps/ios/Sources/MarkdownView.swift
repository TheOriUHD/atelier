import SwiftUI

/// What the assistant writes, laid out as a page: headings, lists, quotes, code, tables, math and rules, in New York.
/// A half-streamed block (an open code fence, a table still being written) renders as far as it has got. Links open
/// in the browser (only web, mail and phone links), a paragraph in a right-to-left language reads right to left, and
/// a block can be quoted in a reply.
struct MarkdownView: View {
    let text: String
    var serif = true
    /// Offers "Quote in reply" on a block when set.
    var onQuote: ((String) -> Void)?
    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in MarkdownLinks.handle(url) })
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text)).font(heading(level)).padding(.top, level <= 2 ? 6 : 2).direction(text)
                .frame(maxWidth: .infinity, alignment: .leading).quotable(text, onQuote)
        case .paragraph(let text):
            Text(inline(text)).font(bodyFont).lineSpacing(5).direction(text).frame(maxWidth: .infinity, alignment: .leading).quotable(text, onQuote)
        case .list(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        marker(item)
                        Text(inline(item.text)).font(bodyFont).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18)
                    .direction(item.text)
                }
            }
            .quotable(items.map(\.text).joined(separator: "\n"), onQuote)
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                Capsule().fill(Theme.fillStrong).frame(width: 3)
                Text(inline(text)).font(bodyFont).italic().foregroundStyle(Theme.inkSecondary).lineSpacing(5).direction(text).frame(maxWidth: .infinity, alignment: .leading)
            }
            .quotable(text, onQuote)
        case .code(let language, let code):
            CodeBlock(language: language, code: code).quotable(code, onQuote)
        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows, inline: inline).quotable(([header] + rows).map { $0.joined(separator: " | ") }.joined(separator: "\n"), onQuote)
        case .math(let source):
            MathBlock(source: source)
        case .rule:
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.vertical, 6)
        }
    }

    @ViewBuilder private func marker(_ item: MarkdownBlock.Item) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square").font(.system(size: 16)).foregroundStyle(checked ? Theme.clay : Theme.inkMuted).accessibilityLabel(checked ? "Done" : "Not done")
        } else {
            Text(item.marker).font(item.ordered ? bodyFont.monospacedDigit() : .system(size: 17, weight: .bold)).foregroundStyle(Theme.inkMuted).frame(minWidth: 14, alignment: .trailing)
        }
    }

    private var bodyFont: Font { serif ? .reading(.body) : .system(.body) }
    private func heading(_ level: Int) -> Font {
        switch level {
        case 1: serif ? .reading(.title2, weight: .semibold) : .system(.title2, weight: .semibold)
        case 2: serif ? .reading(.title3, weight: .semibold) : .system(.title3, weight: .semibold)
        default: serif ? .reading(.headline, weight: .semibold) : .system(.headline)
        }
    }

    /// Bold, italics, `code`, links, bare addresses, strikethrough and inline math inside a line.
    private func inline(_ source: String) -> AttributedString { MarkdownInline.attributed(source) }
}

private extension View {
    /// Only where quoting is offered: a menu on every block would take the long press from text selection.
    @ViewBuilder func quotable(_ text: String, _ onQuote: ((String) -> Void)?) -> some View {
        if let onQuote {
            contextMenu {
                Button("Quote in reply", systemImage: "quote.opening") { onQuote(text) }
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
            }
        } else { self }
    }

    /// A paragraph in Arabic, Hebrew or another right-to-left script reads from the right.
    func direction(_ text: String) -> some View {
        environment(\.layoutDirection, MarkdownInline.isRightToLeft(text) ? .rightToLeft : .leftToRight)
    }
}

enum MarkdownLinks {
    /// Web, mail and phone links open; anything else (a script, a file) is dropped.
    static func handle(_ url: URL) -> OpenURLAction.Result {
        guard let scheme = url.scheme?.lowercased() else { return .discarded }
        return ["http", "https", "mailto", "tel"].contains(scheme) ? .systemAction : .discarded
    }
}

enum MarkdownInline {
    static func attributed(_ source: String) -> AttributedString {
        let prepared = MathText.replacingInline(source)
        var text = (try? AttributedString(markdown: prepared, options: .init(allowsExtendedAttributes: true, interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(prepared)
        for run in text.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                text[run.range].font = .system(.callout, design: .monospaced)
                text[run.range].backgroundColor = Theme.fill
            }
            if run.link != nil {
                text[run.range].foregroundColor = Theme.clay
                text[run.range].underlineStyle = .single
            }
        }
        autolink(&text)
        return text
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Bare web addresses become links, as they are in the browser.
    private static func autolink(_ text: inout AttributedString) {
        guard let detector else { return }
        let plain = String(text.characters)
        guard plain.contains("http") || plain.contains("www.") || plain.contains("@") else { return }
        let matches = detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
        for match in matches {
            guard let url = match.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? ""), let range = Range(match.range, in: plain),
                  let lower = AttributedString.Index(range.lowerBound, within: text), let upper = AttributedString.Index(range.upperBound, within: text) else { continue }
            let target = lower..<upper
            if text[target].runs.contains(where: { $0.link != nil }) { continue }
            text[target].link = url
            text[target].foregroundColor = Theme.clay
            text[target].underlineStyle = .single
        }
    }

    static func isRightToLeft(_ text: String) -> Bool {
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if scalar.properties.isAlphabetic {
                return (0x0590...0x08FF).contains(value) || (0xFB1D...0xFDFF).contains(value) || (0xFE70...0xFEFF).contains(value)
            }
        }
        return false
    }
}

// MARK: - Block parsing

enum MarkdownBlock {
    struct Item { let marker: String; let text: String; let depth: Int; let ordered: Bool; var checked: Bool? = nil }
    case heading(Int, String)
    case paragraph(String)
    case list([Item])
    case quote(String)
    case code(String, String)
    case table([String], [[String]])
    case math(String)
    case rule

    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0
        func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) { code.append(lines[i]); i += 1 }
                blocks.append(.code(language, code.joined(separator: "\n")))
                i += 1
                continue
            }
            // Display math: $$ … $$ on its own lines, or all on one.
            if trimmed.hasPrefix("$$") {
                flush()
                var body = String(trimmed.dropFirst(2))
                if body.hasSuffix("$$"), body.count >= 2 { body.removeLast(2); blocks.append(.math(body.trimmingCharacters(in: .whitespaces))); i += 1; continue }
                var math: [String] = body.isEmpty ? [] : [body]
                i += 1
                while i < lines.count {
                    let current = lines[i].trimmingCharacters(in: .whitespaces)
                    if current.hasSuffix("$$") { let last = String(current.dropLast(2)); if !last.isEmpty { math.append(last) }; i += 1; break }
                    math.append(lines[i]); i += 1
                }
                blocks.append(.math(math.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
                continue
            }
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let heading = headingLine(trimmed) { flush(); blocks.append(.heading(heading.0, heading.1)); i += 1; continue }
            if isRule(trimmed) { flush(); blocks.append(.rule); i += 1; continue }
            if trimmed.hasPrefix(">") {
                flush()
                var quote: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quote.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); i += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }
            if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableRule(lines[i + 1]) {
                flush()
                let header = cells(trimmed)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
                blocks.append(.table(header, rows))
                continue
            }
            if listItem(line) != nil {
                flush()
                var items: [Item] = []
                var number = 0
                var firstOrdered: Bool?
                // A bulleted list and a numbered one are two lists, even with one blank line between them.
                while i < lines.count, let item = listItem(lines[i]), item.depth > 0 || firstOrdered == nil || item.ordered == firstOrdered {
                    if firstOrdered == nil { firstOrdered = item.ordered }
                    if item.ordered { number += 1 }
                    var text = item.text
                    var checked: Bool?
                    if !item.ordered {
                        if text.hasPrefix("[ ] ") { checked = false; text = String(text.dropFirst(4)) }
                        else if text.lowercased().hasPrefix("[x] ") { checked = true; text = String(text.dropFirst(4)) }
                    }
                    items.append(Item(marker: item.ordered ? "\(item.number ?? number)." : "•", text: text, depth: item.depth, ordered: item.ordered, checked: checked))
                    i += 1
                    // A wrapped continuation line belongs to the item above it.
                    while i < lines.count, lines[i].hasPrefix("  "), listItem(lines[i]) == nil, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        let last = items.removeLast()
                        items.append(Item(marker: last.marker, text: last.text + "\n" + lines[i].trimmingCharacters(in: .whitespaces), depth: last.depth, ordered: last.ordered, checked: last.checked)); i += 1
                    }
                    if i + 1 < lines.count, lines[i].trimmingCharacters(in: .whitespaces).isEmpty, let next = listItem(lines[i + 1]), next.depth > 0 || next.ordered == firstOrdered { i += 1 }
                }
                blocks.append(.list(items))
                continue
            }
            paragraph.append(trimmed)
            i += 1
        }
        flush()
        return blocks
    }

    private static func headingLine(_ line: String) -> (Int, String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return (hashes, line.dropFirst(hashes).trimmingCharacters(in: .whitespaces))
    }
    private static func isRule(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        return compact.count >= 3 && (compact.allSatisfy { $0 == "-" } || compact.allSatisfy { $0 == "*" } || compact.allSatisfy { $0 == "_" })
    }
    private static func isTableRule(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
    }
    private static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
    private static func listItem(_ line: String) -> (text: String, depth: Int, ordered: Bool, number: Int?)? {
        let indent = line.prefix { $0 == " " }.count
        let rest = line.dropFirst(indent)
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            return (rest.dropFirst(2).trimmingCharacters(in: .whitespaces), indent / 2, false, nil)
        }
        let digits = rest.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count < 4, rest.dropFirst(digits.count).hasPrefix(". ") || rest.dropFirst(digits.count).hasPrefix(") ") {
            return (rest.dropFirst(digits.count + 2).trimmingCharacters(in: .whitespaces), indent / 2, true, Int(digits))
        }
        return nil
    }
}

// MARK: - Code

struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false
    @State private var expanded = false
    private let collapsedLines = 24
    private var lines: Int { code.reduce(1) { $1 == "\n" ? $0 + 1 : $0 } }
    private var long: Bool { lines > collapsedLines + 6 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "Code" : language).font(.caption.weight(.medium)).foregroundStyle(Theme.inkMuted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption.weight(.medium)).foregroundStyle(copied ? Theme.success : Theme.inkMuted).labelStyle(.titleAndIcon)
                }.buttonStyle(.plain).accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 8)
            Divider().overlay(Theme.hairline)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(visible).font(.system(size: 13.5, design: .monospaced)).lineSpacing(3).fixedSize(horizontal: true, vertical: false).padding(14)
                    .environment(\.layoutDirection, .leftToRight)
            }
            if long {
                Divider().overlay(Theme.hairline)
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    Text(expanded ? "Show less" : "Show all \(lines) lines").font(.caption.weight(.medium)).foregroundStyle(Theme.inkSecondary).frame(maxWidth: .infinity).padding(.vertical, 9).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
        .background(Theme.fill.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
    }

    private var visible: String {
        guard long, !expanded else { return code }
        return code.split(separator: "\n", maxSplits: collapsedLines, omittingEmptySubsequences: false).prefix(collapsedLines).joined(separator: "\n") + "\n…"
    }
}

private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]
    let inline: (String) -> AttributedString
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, cell in Text(inline(cell)).font(.system(.subheadline, weight: .semibold)) } }
                Divider().overlay(Theme.hairline).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(inline(cell)).font(.system(.subheadline)) } }
                }
            }.padding(14)
        }
        .background(Theme.fill.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
    }
}

// MARK: - Math

/// LaTeX as plain Unicode: Greek letters, fractions, roots, sums, indices and the usual symbols. It is not typesetting,
/// but it reads as the formula it is.
enum MathText {
    private static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠", "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝",
        "infty": "∞", "partial": "∂", "nabla": "∇", "forall": "∀", "exists": "∃", "in": "∈", "notin": "∉", "subset": "⊂", "subseteq": "⊆", "cup": "∪", "cap": "∩", "emptyset": "∅",
        "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "Leftarrow": "⇐", "leftrightarrow": "↔", "Leftrightarrow": "⇔", "mapsto": "↦",
        "sum": "∑", "prod": "∏", "int": "∫", "oint": "∮", "sqrt": "√", "ldots": "…", "cdots": "⋯", "dots": "…", "degree": "°", "circ": "∘", "neg": "¬", "land": "∧", "lor": "∨", "angle": "∠", "perp": "⊥", "parallel": "∥",
        "quad": " ", "qquad": "  ", ",": " ", ";": " ", "!": "", "left": "", "right": "", "displaystyle": "", "mathrm": "", "mathbf": "", "text": "", "operatorname": "",
    ]
    private static let superscripts: [Character: Character] = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ"]
    private static let subscripts: [Character: Character] = ["0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
        "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ", "x": "ₓ"]

    /// `$…$` and `\(…\)` inside a line, as readable text (and not a price such as `$5 and $6`).
    static func replacingInline(_ source: String) -> String {
        guard source.contains("$") || source.contains("\\(") else { return source }
        var result = source
        for pattern in [#"\\\((.+?)\\\)"#, #"(?<![\\$\d])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)"#] {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(result.startIndex..., in: result)
            var output = ""
            var last = result.startIndex
            for match in regex.matches(in: result, range: range) {
                guard let whole = Range(match.range, in: result), let inner = Range(match.range(at: 1), in: result) else { continue }
                let body = String(result[inner])
                // A dollar amount between two dollar signs is not a formula.
                if pattern.contains("(?<!") && !body.contains(where: { "\\^_{}=<>+-*/".contains($0) }) && body.count > 1 && body.allSatisfy({ $0.isLetter || $0.isWhitespace }) { continue }
                output += result[last..<whole.lowerBound]
                output += "_\(plain(body))_".replacingOccurrences(of: "__", with: "_")
                last = whole.upperBound
            }
            output += result[last...]
            result = output
        }
        return result
    }

    static func plain(_ latex: String) -> String {
        var text = latex
        // \frac{a}{b} -> (a)/(b); \sqrt{x} -> √(x)
        text = replace(#"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}"#, in: text) { "(\($0[1]))/(\($0[2]))" }
        text = replace(#"\\sqrt\s*\{([^{}]*)\}"#, in: text) { "√(\($0[1]))" }
        text = replace(#"\\(?:mathrm|mathbf|text|operatorname|mathit|mathcal|mathbb)\s*\{([^{}]*)\}"#, in: text) { $0[1] }
        text = replace(#"\\([A-Za-z]+|[,;!])"#, in: text) { symbols[$0[1]] ?? $0[1] }
        text = replace(#"\^\{([^{}]*)\}"#, in: text) { script($0[1], table: superscripts, mark: "^") }
        text = replace(#"\^([A-Za-z0-9+\-])"#, in: text) { script($0[1], table: superscripts, mark: "^") }
        text = replace(#"_\{([^{}]*)\}"#, in: text) { script($0[1], table: subscripts, mark: "_") }
        text = replace(#"_([A-Za-z0-9+\-])"#, in: text) { script($0[1], table: subscripts, mark: "_") }
        return text.replacingOccurrences(of: "{", with: "").replacingOccurrences(of: "}", with: "").replacingOccurrences(of: "\\", with: "")
    }

    private static func script(_ text: String, table: [Character: Character], mark: String) -> String {
        let mapped = text.map { table[$0] }
        if mapped.allSatisfy({ $0 != nil }) { return String(mapped.compactMap { $0 }) }
        return text.count == 1 ? "\(mark)\(text)" : "\(mark)(\(text))"
    }

    private static func replace(_ pattern: String, in text: String, _ transform: ([String]) -> String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        var output = ""
        var last = text.startIndex
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(match.range, in: text) else { continue }
            let groups = (0..<match.numberOfRanges).map { index in Range(match.range(at: index), in: text).map { String(text[$0]) } ?? "" }
            output += text[last..<whole.lowerBound]
            output += transform(groups)
            last = whole.upperBound
        }
        output += text[last...]
        return output
    }
}

private struct MathBlock: View {
    let source: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(MathText.plain(source)).font(.reading(.title3)).italic().foregroundStyle(Theme.ink).fixedSize(horizontal: true, vertical: false).padding(.horizontal, 6).padding(.vertical, 8)
                .frame(maxWidth: .infinity)
        }
        .accessibilityLabel(MathText.plain(source))
    }
}
