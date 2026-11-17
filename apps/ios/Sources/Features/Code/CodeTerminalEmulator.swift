import Foundation

// MARK: - A small terminal: the screen a shell draws on
//
// Terminal output is text with escape sequences that move the cursor, clear parts of the screen and set colors. This
// keeps the grid they describe (a screen, the lines that scrolled off it, an alternate screen for full-screen programs)
// so the app can draw what a person would see. It understands what shells, `ls`, `git`, `less`, `top` and editors
// use: cursor movement, erasing, scrolling regions, insert/delete, 16, 256 and true colors, bold, underline, inverse and
// the alternate screen. It does not reflow lines when the window changes size: the shell redraws itself.

enum TermColor: Equatable, Sendable {
    case `default`
    case indexed(Int)
    case rgb(UInt8, UInt8, UInt8)
}

struct TermStyle: Equatable, Sendable {
    var fg: TermColor = .default
    var bg: TermColor = .default
    var bold = false
    var dim = false
    var italic = false
    var underline = false
    var inverse = false
    var strike = false
}

struct TermCell: Equatable, Sendable {
    var char: Character = " "
    var style = TermStyle()
    /// The second half of a wide character: drawn as part of the cell before it.
    var tail = false
}

struct TerminalEmulator: Sendable {
    private(set) var cols: Int
    private(set) var rows: Int
    private(set) var screen: [[TermCell]]
    private(set) var scrollback: [[TermCell]] = []
    private(set) var cursorRow = 0
    private(set) var cursorCol = 0
    private(set) var cursorVisible = true
    private(set) var title: String?
    /// Arrow keys send `ESC O A` instead of `ESC [ A` while a full-screen program asks for it.
    private(set) var applicationCursor = false
    private(set) var inAlternateScreen = false
    /// Increases with every change, so a view knows to draw again.
    private(set) var revision = 0

    static let scrollbackLimit = 3000

    private var style = TermStyle()
    private var wrapPending = false
    private var autowrap = true
    private var scrollTop = 0
    private var scrollBottom: Int
    private var saved: (row: Int, col: Int, style: TermStyle)?
    private var mainScreen: (screen: [[TermCell]], row: Int, col: Int)?

    private enum Mode { case ground, escape, csi, osc, oscEscape, skip }
    private var mode = Mode.ground
    private var parameters = ""
    private var oscText = ""

    init(cols: Int = 80, rows: Int = 24) {
        self.cols = max(2, cols)
        self.rows = max(2, rows)
        screen = Array(repeating: Array(repeating: TermCell(), count: max(2, cols)), count: max(2, rows))
        scrollBottom = max(2, rows) - 1
    }

    // MARK: Reading

    /// Everything to draw, oldest first: the scrolled-off lines, then the screen.
    var lines: [[TermCell]] { scrollback + screen }
    /// The cursor's line in `lines`.
    var cursorLine: Int { scrollback.count + cursorRow }

    /// The text of one line without trailing blanks, for tests and for copying.
    static func text(_ line: [TermCell]) -> String {
        var out = ""
        for cell in line where !cell.tail { out.append(cell.char) }
        while out.last == " " { out.removeLast() }
        return out
    }
    var text: String {
        var all = lines.map(Self.text)
        while all.last == "" { all.removeLast() }
        return all.joined(separator: "\n")
    }

    // MARK: Writing

    mutating func resize(cols newCols: Int, rows newRows: Int) {
        let newCols = max(2, newCols), newRows = max(2, newRows)
        guard newCols != cols || newRows != rows else { return }
        func fit(_ line: [TermCell]) -> [TermCell] {
            line.count == newCols ? line : line.count > newCols ? Array(line.prefix(newCols)) : line + Array(repeating: TermCell(), count: newCols - line.count)
        }
        screen = screen.map(fit)
        scrollback = scrollback.map(fit)
        while screen.count > newRows {
            // Blank lines below the cursor go first; then the top lines scroll away.
            if screen.count - 1 > cursorRow, Self.text(screen[screen.count - 1]).isEmpty { screen.removeLast() }
            else {
                let top = screen.removeFirst()
                if !inAlternateScreen { scrollback.append(top) }
                cursorRow = max(0, cursorRow - 1)
            }
        }
        while screen.count < newRows { screen.append(Array(repeating: TermCell(), count: newCols)) }
        cols = newCols; rows = newRows
        scrollTop = 0; scrollBottom = rows - 1
        cursorRow = min(cursorRow, rows - 1); cursorCol = min(cursorCol, cols - 1)
        wrapPending = false
        revision += 1
    }

    mutating func reset() {
        let keepCols = cols, keepRows = rows
        self = TerminalEmulator(cols: keepCols, rows: keepRows)
    }

    mutating func clearAll() {
        scrollback.removeAll()
        screen = Array(repeating: Array(repeating: TermCell(), count: cols), count: rows)
        cursorRow = 0; cursorCol = 0; wrapPending = false
        revision += 1
    }

    /// Feeds what the shell wrote. A sequence cut in two by the network picks up in the next call.
    mutating func feed(_ text: String) {
        for scalar in text.unicodeScalars { handle(scalar) }
        revision += 1
    }

    private mutating func handle(_ scalar: Unicode.Scalar) {
        let value = scalar.value
        switch mode {
        case .ground:
            switch value {
            case 0x1B: mode = .escape
            case 0x07, 0x00: break
            case 0x08: if cursorCol > 0 { cursorCol -= 1 }; wrapPending = false
            case 0x09: cursorCol = min(cols - 1, (cursorCol / 8 + 1) * 8); wrapPending = false
            case 0x0A, 0x0B, 0x0C: lineFeed()
            case 0x0D: cursorCol = 0; wrapPending = false
            case 0x20...: put(scalar)
            default: break
            }
        case .escape:
            mode = .ground
            switch scalar {
            case "[": mode = .csi; parameters = ""
            case "]": mode = .osc; oscText = ""
            case "P", "^", "_", "X": mode = .osc; oscText = ""
            case "(", ")", "*", "+", "#", "%", " ": mode = .skip
            case "7": saved = (cursorRow, cursorCol, style)
            case "8": if let saved { cursorRow = saved.row; cursorCol = min(saved.col, cols - 1); style = saved.style; wrapPending = false }
            case "M": reverseIndex()
            case "D": lineFeed()
            case "E": cursorCol = 0; lineFeed()
            case "c": reset()
            default: break
            }
        case .skip:
            mode = .ground
        case .csi:
            if value >= 0x40 && value <= 0x7E { mode = .ground; csi(final: scalar) }
            else if value == 0x1B { mode = .escape }
            else if value >= 0x20 && value <= 0x3F { parameters.unicodeScalars.append(scalar) }
        case .osc:
            if value == 0x07 { finishOSC() }
            else if value == 0x1B { mode = .oscEscape }
            else if oscText.count < 512 { oscText.unicodeScalars.append(scalar) }
        case .oscEscape:
            if scalar == "\\" { finishOSC() } else { mode = .ground }
        }
    }

    private mutating func finishOSC() {
        mode = .ground
        let parts = oscText.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
        if parts.count == 2, parts[0] == "0" || parts[0] == "2" { title = String(parts[1]) }
    }

    // MARK: Drawing characters

    private func width(of scalar: Unicode.Scalar) -> Int {
        let v = scalar.value
        if (0x1100...0x115F).contains(v) || (0x2E80...0xA4CF).contains(v) || (0xAC00...0xD7A3).contains(v) || (0xF900...0xFAFF).contains(v)
            || (0xFE30...0xFE6F).contains(v) || (0xFF00...0xFF60).contains(v) || (0xFFE0...0xFFE6).contains(v)
            || (0x1F300...0x1F64F).contains(v) || (0x1F900...0x1F9FF).contains(v) || (0x20000...0x3FFFD).contains(v) { return 2 }
        return 1
    }

    private mutating func put(_ scalar: Unicode.Scalar) {
        // Marks and joiners belong to the character before them.
        switch scalar.properties.generalCategory {
        case .nonspacingMark, .enclosingMark, .format:
            let col = wrapPending ? cursorCol : max(0, cursorCol - 1)
            if screen[cursorRow][col].char != " " { screen[cursorRow][col].char = Character(String(screen[cursorRow][col].char) + String(scalar)) }
            return
        default: break
        }
        let w = width(of: scalar)
        if wrapPending || cursorCol + w > cols {
            if autowrap { cursorCol = 0; lineFeed() }
            wrapPending = false
        }
        screen[cursorRow][cursorCol] = TermCell(char: Character(scalar), style: style)
        if w == 2, cursorCol + 1 < cols { screen[cursorRow][cursorCol + 1] = TermCell(char: " ", style: style, tail: true) }
        cursorCol += w
        if cursorCol >= cols { cursorCol = cols - 1; wrapPending = true }
    }

    private mutating func lineFeed() {
        if cursorRow == scrollBottom { scrollUp(1) } else if cursorRow < rows - 1 { cursorRow += 1 }
    }
    private mutating func reverseIndex() {
        if cursorRow == scrollTop { scrollDown(1) } else if cursorRow > 0 { cursorRow -= 1 }
    }

    private var blank: TermCell { TermCell(char: " ", style: TermStyle(bg: style.bg)) }
    private var blankLine: [TermCell] { Array(repeating: blank, count: cols) }

    private mutating func scrollUp(_ n: Int) {
        for _ in 0..<min(n, scrollBottom - scrollTop + 1) {
            let gone = screen.remove(at: scrollTop)
            if scrollTop == 0 && !inAlternateScreen {
                scrollback.append(gone)
                if scrollback.count > Self.scrollbackLimit { scrollback.removeFirst(scrollback.count - Self.scrollbackLimit) }
            }
            screen.insert(blankLine, at: scrollBottom)
        }
    }
    private mutating func scrollDown(_ n: Int) {
        for _ in 0..<min(n, scrollBottom - scrollTop + 1) {
            screen.remove(at: scrollBottom)
            screen.insert(blankLine, at: scrollTop)
        }
    }

    // MARK: Control sequences

    private func numbers(_ text: String) -> [Int?] {
        text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == ";" || $0 == ":" }).map { Int($0) }
    }

    private mutating func csi(final: Unicode.Scalar) {
        var text = parameters
        var marker: Character?
        if let first = text.first, "?<>=!".contains(first) { marker = first; text.removeFirst() }
        let p = numbers(text)
        func arg(_ i: Int, _ fallback: Int) -> Int { i < p.count ? (p[i].flatMap { $0 == 0 ? nil : $0 } ?? fallback) : fallback }
        wrapPending = (final == "m") ? wrapPending : false
        if marker == "?" {
            if final == "h" || final == "l" { privateMode(p.compactMap { $0 }, on: final == "h") }
            return
        }
        if marker != nil { return }
        switch final {
        case "A": cursorRow = max(cursorRow >= scrollTop ? scrollTop : 0, cursorRow - arg(0, 1))
        case "B": cursorRow = min(cursorRow <= scrollBottom ? scrollBottom : rows - 1, cursorRow + arg(0, 1))
        case "C": cursorCol = min(cols - 1, cursorCol + arg(0, 1))
        case "D": cursorCol = max(0, cursorCol - arg(0, 1))
        case "E": cursorRow = min(rows - 1, cursorRow + arg(0, 1)); cursorCol = 0
        case "F": cursorRow = max(0, cursorRow - arg(0, 1)); cursorCol = 0
        case "G", "`": cursorCol = min(cols - 1, arg(0, 1) - 1)
        case "H", "f": cursorRow = min(rows - 1, arg(0, 1) - 1); cursorCol = min(cols - 1, arg(1, 1) - 1)
        case "d": cursorRow = min(rows - 1, arg(0, 1) - 1)
        case "J": eraseDisplay(p.first.flatMap { $0 } ?? 0)
        case "K": eraseLine(p.first.flatMap { $0 } ?? 0)
        case "L": insertLines(arg(0, 1))
        case "M": deleteLines(arg(0, 1))
        case "P": deleteChars(arg(0, 1))
        case "@": insertChars(arg(0, 1))
        case "X":
            for c in cursorCol..<min(cols, cursorCol + arg(0, 1)) { screen[cursorRow][c] = blank }
        case "S": scrollUp(arg(0, 1))
        case "T": scrollDown(arg(0, 1))
        case "m": sgr(p)
        case "r":
            let top = arg(0, 1) - 1, bottom = arg(1, rows) - 1
            if top < bottom, bottom < rows { scrollTop = top; scrollBottom = bottom; cursorRow = 0; cursorCol = 0 }
        case "s": saved = (cursorRow, cursorCol, style)
        case "u": if let saved { cursorRow = saved.row; cursorCol = min(saved.col, cols - 1) }
        default: break
        }
    }

    private mutating func privateMode(_ modes: [Int], on: Bool) {
        for mode in modes {
            switch mode {
            case 1: applicationCursor = on
            case 7: autowrap = on
            case 25: cursorVisible = on
            case 47, 1047, 1049: setAlternateScreen(on, saveCursor: mode == 1049)
            default: break
            }
        }
    }

    private mutating func setAlternateScreen(_ on: Bool, saveCursor: Bool) {
        if on, !inAlternateScreen {
            mainScreen = (screen, cursorRow, cursorCol)
            screen = Array(repeating: Array(repeating: TermCell(), count: cols), count: rows)
            inAlternateScreen = true
            cursorRow = 0; cursorCol = 0
            scrollTop = 0; scrollBottom = rows - 1
        } else if !on, inAlternateScreen {
            if let mainScreen {
                screen = mainScreen.screen
                cursorRow = min(mainScreen.row, rows - 1); cursorCol = min(mainScreen.col, cols - 1)
            }
            mainScreen = nil
            inAlternateScreen = false
            scrollTop = 0; scrollBottom = rows - 1
        }
        wrapPending = false
    }

    private mutating func eraseDisplay(_ how: Int) {
        switch how {
        case 0:
            eraseLine(0)
            for r in (cursorRow + 1)..<max(cursorRow + 1, rows) { screen[r] = blankLine }
        case 1:
            for r in 0..<cursorRow { screen[r] = blankLine }
            eraseLine(1)
        case 2:
            for r in 0..<rows { screen[r] = blankLine }
        default:
            scrollback.removeAll()
            for r in 0..<rows { screen[r] = blankLine }
        }
    }
    private mutating func eraseLine(_ how: Int) {
        switch how {
        case 0: for c in cursorCol..<cols { screen[cursorRow][c] = blank }
        case 1: for c in 0...cursorCol { screen[cursorRow][c] = blank }
        default: screen[cursorRow] = blankLine
        }
    }
    private mutating func insertLines(_ n: Int) {
        guard cursorRow >= scrollTop, cursorRow <= scrollBottom else { return }
        for _ in 0..<min(n, scrollBottom - cursorRow + 1) {
            screen.remove(at: scrollBottom)
            screen.insert(blankLine, at: cursorRow)
        }
        cursorCol = 0
    }
    private mutating func deleteLines(_ n: Int) {
        guard cursorRow >= scrollTop, cursorRow <= scrollBottom else { return }
        for _ in 0..<min(n, scrollBottom - cursorRow + 1) {
            screen.remove(at: cursorRow)
            screen.insert(blankLine, at: scrollBottom)
        }
        cursorCol = 0
    }
    private mutating func deleteChars(_ n: Int) {
        let count = min(n, cols - cursorCol)
        screen[cursorRow].removeSubrange(cursorCol..<(cursorCol + count))
        screen[cursorRow].append(contentsOf: Array(repeating: blank, count: count))
    }
    private mutating func insertChars(_ n: Int) {
        let count = min(n, cols - cursorCol)
        screen[cursorRow].insert(contentsOf: Array(repeating: blank, count: count), at: cursorCol)
        screen[cursorRow].removeLast(count)
    }

    private mutating func sgr(_ p: [Int?]) {
        var codes = p.isEmpty ? [0] : p.map { $0 ?? 0 }
        var i = 0
        while i < codes.count {
            let code = codes[i]
            switch code {
            case 0: style = TermStyle()
            case 1: style.bold = true
            case 2: style.dim = true
            case 3: style.italic = true
            case 4: style.underline = true
            case 7: style.inverse = true
            case 9: style.strike = true
            case 22: style.bold = false; style.dim = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 27: style.inverse = false
            case 29: style.strike = false
            case 30...37: style.fg = .indexed(code - 30)
            case 39: style.fg = .default
            case 40...47: style.bg = .indexed(code - 40)
            case 49: style.bg = .default
            case 90...97: style.fg = .indexed(code - 90 + 8)
            case 100...107: style.bg = .indexed(code - 100 + 8)
            case 38, 48:
                var color: TermColor?
                if i + 2 < codes.count, codes[i + 1] == 5 { color = .indexed(min(255, max(0, codes[i + 2]))); i += 2 }
                else if i + 4 < codes.count, codes[i + 1] == 2 {
                    color = .rgb(UInt8(clamping: codes[i + 2]), UInt8(clamping: codes[i + 3]), UInt8(clamping: codes[i + 4])); i += 4
                }
                if let color { if code == 38 { style.fg = color } else { style.bg = color } }
            default: break
            }
            i += 1
        }
        codes.removeAll()
    }
}

// MARK: - Keys

/// What a key sends to the shell.
enum TerminalKey: Sendable {
    case up, down, left, right, home, end, pageUp, pageDown, escape, tab, backTab, delete, enter

    func sequence(applicationCursor: Bool) -> String {
        let csi = applicationCursor ? "\u{1B}O" : "\u{1B}["
        switch self {
        case .up: return csi + "A"
        case .down: return csi + "B"
        case .right: return csi + "C"
        case .left: return csi + "D"
        case .home: return csi + "H"
        case .end: return csi + "F"
        case .pageUp: return "\u{1B}[5~"
        case .pageDown: return "\u{1B}[6~"
        case .delete: return "\u{1B}[3~"
        case .escape: return "\u{1B}"
        case .tab: return "\t"
        case .backTab: return "\u{1B}[Z"
        case .enter: return "\r"
        }
    }

    /// Control-C is 0x03, Control-D 0x04 …: the letter's position in the alphabet.
    static func control(_ character: Character) -> String? {
        guard let scalar = character.lowercased().unicodeScalars.first, character.unicodeScalars.count == 1 else { return nil }
        switch scalar.value {
        case 0x61...0x7A: return String(UnicodeScalar(scalar.value - 0x60) ?? scalar)
        case 0x5B: return "\u{1B}"
        case 0x5C: return "\u{1C}"
        case 0x5D: return "\u{1D}"
        case 0x20: return "\u{00}"
        default: return nil
        }
    }
}
