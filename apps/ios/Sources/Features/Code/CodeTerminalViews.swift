import SwiftUI
import UIKit

// MARK: - Terminal: a shell on the folder's computer

/// One shell: its screen, and the calls that open, feed, resize and close it.
@MainActor @Observable final class CodeTerminalModel: Identifiable {
    let id = UUID()
    let store: AppStore
    let workspaceId: String
    let directory: String?
    var title: String
    private(set) var emulator = TerminalEmulator(cols: 80, rows: 24)
    private(set) var terminalId: String?
    private(set) var ended: String?
    private(set) var starting = false
    /// Control is armed: the next letter typed is sent as Control-letter.
    var controlArmed = false
    private var received = 0
    private var early: [(String, String)] = []
    private var pending = ""
    private var flush: Task<Void, Never>?
    private var observer: UUID?
    private var size = (cols: 80, rows: 24)
    private var resizeTask: Task<Void, Never>?

    init(store: AppStore, workspaceId: String, directory: String?, title: String) {
        self.store = store
        self.workspaceId = workspaceId
        self.directory = directory
        self.title = title
        CodeEvents.shared.install(on: store)
        observer = CodeEvents.shared.observe { [weak self] method, value in
            guard let self else { return }
            if method == "terminals.data" {
                if value["terminalId"].string == self.terminalId { self.receive(value["data"].string) }
                else if self.terminalId == nil, self.starting { self.early.append((value["terminalId"].string, value["data"].string)) }
            } else if method == "terminals.exit", value["terminalId"].string == self.terminalId {
                self.terminalId = nil
                self.ended = value["code"].intOrNil.map { "The shell exited with code \($0)." } ?? "The shell exited."
            }
        }
    }
    isolated deinit {
        if let observer { CodeEvents.shared.remove(observer) }
        flush?.cancel(); resizeTask?.cancel()
    }

    var applicationCursor: Bool { emulator.applicationCursor }

    // MARK: Opening and closing

    func open(cols: Int, rows: Int) async {
        guard terminalId == nil, !starting else { return }
        starting = true; ended = nil
        size = (cols, rows)
        emulator = TerminalEmulator(cols: cols, rows: rows)
        received = 0
        defer { starting = false }
        do {
            var params: [String: JSON] = ["workspaceId": .string(workspaceId), "cols": .number(Double(cols)), "rows": .number(Double(rows))]
            if let directory, !directory.isEmpty { params["dir"] = .string(directory) }
            let id = try await codeCall(store, "terminals.open", params)["terminalId"].string
            terminalId = id
            for (target, data) in early where target == id { receive(data) }
            early.removeAll()
        } catch is CancellationError { return } catch { ended = error.localizedDescription }
    }

    func close() {
        flush?.cancel()
        guard let id = terminalId else { return }
        terminalId = nil
        let store = store
        Task { _ = try? await store.rpc.call("terminals.close", ["terminalId": .string(id)]) }
    }

    func restart() async {
        close()
        await open(cols: size.cols, rows: size.rows)
    }

    // MARK: Output

    private func receive(_ data: String) {
        received += data.utf16.count
        pending += data
        // Output arrives in bursts: draw it about thirty times a second, not once per chunk.
        guard flush == nil else { return }
        flush = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(33))
            guard let self, !Task.isCancelled else { return }
            self.emulator.feed(self.pending)
            self.pending = ""
            self.flush = nil
        }
    }

    /// After the connection came back: shows what the shell wrote meanwhile (it keeps running for a few minutes).
    func reattach() async {
        guard let id = terminalId else { return }
        do {
            let answer = try await codeCall(store, "terminals.attach", ["terminalId": .string(id), "since": .number(Double(received))])
            let data = answer["data"].string
            emulator.feed("\r\n\u{1B}[2m[shell reconnected\(data.isEmpty && !answer["truncated"].bool ? "" : " — replaying buffered output")]\u{1B}[22m\r\n")
            if !data.isEmpty { receive(data) }
            await sendResize()
        } catch is CancellationError { return } catch {
            terminalId = nil
            ended = "The shell closed while the connection was down."
        }
    }

    // MARK: Input

    /// What the person typed: a line ends with Return, Control-armed letters become control characters.
    func type(_ text: String) {
        var out = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
        if controlArmed, let first = out.first, let control = TerminalKey.control(first) {
            out = control + out.dropFirst()
            controlArmed = false
        }
        send(out)
    }
    func press(_ key: TerminalKey) { send(key.sequence(applicationCursor: emulator.applicationCursor)) }
    func control(_ letter: Character) { if let sequence = TerminalKey.control(letter) { send(sequence) } }
    func paste() { if let text = UIPasteboard.general.string { send(text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")) } }

    func send(_ data: String) {
        guard let id = terminalId, !data.isEmpty else { return }
        let store = store
        Task { _ = try? await store.rpc.call("terminals.write", ["terminalId": .string(id), "data": .string(String(data.prefix(65_536)))]) }
    }

    // MARK: Size

    func fit(cols: Int, rows: Int) {
        guard cols >= 10, rows >= 2, (cols, rows) != (size.cols, size.rows) else { return }
        size = (cols, rows)
        emulator.resize(cols: cols, rows: rows)
        resizeTask?.cancel()
        resizeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await self?.sendResize()
        }
    }
    private func sendResize() async {
        guard let id = terminalId else { return }
        _ = try? await store.rpc.call("terminals.resize", ["terminalId": .string(id), "cols": .number(Double(size.cols)), "rows": .number(Double(size.rows))])
    }

    func clear() { emulator.clearAll(); send("\u{0C}") }
}

// MARK: Colors

enum CodeTerminalColors {
    private static let normal: [(UInt32, UInt32)] = [
        (0x3A3A38, 0x6E6C68), (0xB3261E, 0xEC7E7E), (0x1E7A1E, 0x4FBF4F), (0x8A5A00, 0xE0A21B),
        (0x184F95, 0x6DA7EC), (0x8E3D8E, 0xD68ED6), (0x0F6E7A, 0x5CC6D4), (0x52514E, 0xC3C2B7),
        (0x686762, 0x9C9A94), (0xD03B3B, 0xFF8A8A), (0x2E9A2E, 0x7ADF7A), (0xB77800, 0xF5C65A),
        (0x2A6BC0, 0x8FBFF5), (0xB25AB2, 0xE8A8E8), (0x1E8C9A, 0x86DCE8), (0x0B0B0B, 0xF0EFEC),
    ]
    static func indexed(_ index: Int) -> Color {
        if index < 16 { let pair = normal[index]; return Color.adaptive(light: pair.0, dark: pair.1) }
        if index < 232 {
            let n = index - 16
            let levels: [UInt32] = [0, 95, 135, 175, 215, 255]
            let r = levels[n / 36], g = levels[(n / 6) % 6], b = levels[n % 6]
            return Color(hex: r << 16 | g << 8 | b)
        }
        let v = UInt32(8 + (index - 232) * 10)
        return Color(hex: v << 16 | v << 8 | v)
    }
    static func color(_ color: TermColor, fallback: Color) -> Color {
        switch color {
        case .default: fallback
        case .indexed(let i): indexed(i)
        case .rgb(let r, let g, let b): Color(hex: UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b))
        }
    }

    /// One line of the screen as text, runs of the same style merged. The cursor's cell is drawn inverted.
    static func attributed(_ line: [TermCell], cursor: Int?, size: CGFloat) -> AttributedString {
        var out = AttributedString()
        var text = "", current: TermStyle?, isCursor = false
        func flush() {
            guard let style = current, !text.isEmpty else { text = ""; return }
            var run = AttributedString(text)
            var fg = color(style.fg, fallback: Theme.ink), bg: Color?
            if case .default = style.bg {} else { bg = color(style.bg, fallback: .clear) }
            if style.inverse || isCursor { let swapped = bg ?? Theme.sunken; bg = fg; fg = swapped }
            if style.dim { fg = fg.opacity(0.6) }
            run.foregroundColor = fg
            if let bg { run.backgroundColor = bg }
            run.font = .system(size: size, weight: style.bold ? .bold : .regular, design: .monospaced).italic(style.italic)
            if style.underline { run.underlineStyle = .single }
            if style.strike { run.strikethroughStyle = .single }
            out += run
            text = ""
        }
        for (column, cell) in line.enumerated() where !cell.tail {
            let atCursor = column == cursor
            if current != cell.style || atCursor != isCursor { flush(); current = cell.style; isCursor = atCursor }
            text.append(cell.char)
        }
        flush()
        return out
    }
}

// MARK: The keyboard

/// An invisible view that takes the keyboard and sends every key to the shell as it is typed, like a real terminal:
/// the software keyboard through `UIKeyInput`, a hardware keyboard through its key presses.
struct CodeTerminalInput: UIViewRepresentable {
    let model: CodeTerminalModel
    @Binding var focused: Bool

    func makeUIView(context: Context) -> CodeTerminalKeyView {
        let view = CodeTerminalKeyView()
        view.model = model
        view.onFocusChange = { value in DispatchQueue.main.async { focused = value } }
        return view
    }
    func updateUIView(_ view: CodeTerminalKeyView, context: Context) {
        view.model = model
        if focused, !view.isFirstResponder { DispatchQueue.main.async { _ = view.becomeFirstResponder() } }
        if !focused, view.isFirstResponder { DispatchQueue.main.async { _ = view.resignFirstResponder() } }
    }
}

final class CodeTerminalKeyView: UIView, UIKeyInput {
    weak var model: CodeTerminalModel?
    var onFocusChange: ((Bool) -> Void)?

    override var canBecomeFirstResponder: Bool { true }
    var hasText: Bool { true }

    // Typing traits: nothing is corrected, capitalized or replaced.
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    var returnKeyType: UIReturnKeyType = .default

    override func becomeFirstResponder() -> Bool { let ok = super.becomeFirstResponder(); if ok { onFocusChange?(true) }; return ok }
    override func resignFirstResponder() -> Bool { let ok = super.resignFirstResponder(); if ok { onFocusChange?(false) }; return ok }

    func insertText(_ text: String) { model?.type(text) }
    func deleteBackward() { model?.send("\u{7F}") }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled = Set<UIPress>()
        for press in presses {
            guard let key = press.key else { unhandled.insert(press); continue }
            let handled: Bool = {
                guard let model else { return false }
                switch key.keyCode {
                case .keyboardUpArrow: model.press(.up)
                case .keyboardDownArrow: model.press(.down)
                case .keyboardLeftArrow: model.press(.left)
                case .keyboardRightArrow: model.press(.right)
                case .keyboardEscape: model.press(.escape)
                case .keyboardTab: model.press(key.modifierFlags.contains(.shift) ? .backTab : .tab)
                case .keyboardHome: model.press(.home)
                case .keyboardEnd: model.press(.end)
                case .keyboardPageUp: model.press(.pageUp)
                case .keyboardPageDown: model.press(.pageDown)
                case .keyboardDeleteForward: model.press(.delete)
                default:
                    if key.modifierFlags.contains(.control), let character = key.charactersIgnoringModifiers.first, let control = TerminalKey.control(character) { model.send(control) }
                    else { return false }
                }
                return true
            }()
            if !handled { unhandled.insert(press) }
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }
}

// MARK: The panel

/// Terminals on the session's folder, as tabs: a screen, a key row for what a phone keyboard lacks, and the keyboard.
struct CodeTerminalPanel: View {
    let store: AppStore
    var startDirectory: String?
    @State private var folders: CodeFolders
    @State private var tabs: [CodeTerminalModel] = []
    @State private var active: UUID?

    init(store: AppStore, startDirectory: String? = nil) {
        self.store = store
        self.startDirectory = startDirectory
        _folders = State(initialValue: CodeFolders(store: store))
    }

    private var current: CodeTerminalModel? { tabs.first { $0.id == active } ?? tabs.first }

    var body: some View {
        CodePanelFrame(title: "Terminal", store: store) {
            CodeFolderGate(folders: folders) { workspace in
                VStack(spacing: 0) {
                    if tabs.count > 1 { tabStrip }
                    if let current {
                        CodeTerminalScreen(model: current).id(current.id)
                    }
                }
                .task(id: workspace.id) { if tabs.isEmpty { addTab(workspace) } }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button("New terminal", systemImage: "plus") { addTab(workspace) }
                            if let current {
                                Button("Clear", systemImage: "eraser") { current.clear() }
                                if tabs.count > 1 { Button("Close this terminal", systemImage: "xmark", role: .destructive) { close(current) } }
                            }
                        } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Terminal actions")
                    }
                }
            }
        }
        .task { await folders.load() }
        .onDisappear { tabs.forEach { $0.close() } }
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(tabs) { tab in
                    Button { active = tab.id } label: {
                        Text(tab.title).font(.subheadline.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 6)
                            .foregroundStyle(tab.id == current?.id ? .white : Theme.ink)
                            .background(tab.id == current?.id ? AnyShapeStyle(Theme.clay) : AnyShapeStyle(Theme.fill), in: Capsule())
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
        }
        .background(Theme.sunken)
    }

    private func addTab(_ workspace: CodeWorkspace) {
        let number = tabs.count + 1
        let tab = CodeTerminalModel(store: store, workspaceId: workspace.id, directory: tabs.isEmpty ? startDirectory : nil, title: number == 1 ? "Terminal" : "Terminal \(number)")
        tabs.append(tab); active = tab.id
        if tabs.count == 2 { tabs[0].title = "Terminal 1" }
    }
    private func close(_ tab: CodeTerminalModel) {
        tab.close()
        tabs.removeAll { $0.id == tab.id }
        active = tabs.last?.id
    }
}

/// One shell's screen with its key row.
struct CodeTerminalScreen: View {
    let model: CodeTerminalModel
    @State private var focused = false
    @State private var follow = true
    @Environment(\.scenePhase) private var phase
    private let fontSize: CGFloat = 12
    private var cell: CGSize {
        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        return CGSize(width: ("M" as NSString).size(withAttributes: [.font: font]).width, height: ceil(font.lineHeight))
    }

    var body: some View {
        GeometryReader { geometry in
            let cols = Int((geometry.size.width - 16) / cell.width)
            let rows = Int((geometry.size.height - 12) / cell.height)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let lines = model.emulator.lines
                        ForEach(lines.indices, id: \.self) { index in
                            let cursor = model.emulator.cursorVisible && focused && index == model.emulator.cursorLine ? model.emulator.cursorCol : nil
                            Text(CodeTerminalColors.attributed(lines[index], cursor: cursor, size: fontSize))
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                                .frame(height: cell.height, alignment: .leading)
                                .id(index)
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDismissesKeyboard(.never)
                .defaultScrollAnchor(.bottom)
                .onChange(of: model.emulator.revision) { _, _ in if follow { proxy.scrollTo(model.emulator.lines.count - 1, anchor: .bottom) } }
                .onScrollPhaseChange { _, new in if new == .interacting { follow = false } }
                .overlay(alignment: .bottomTrailing) {
                    if !follow {
                        Button { follow = true; withAnimation { proxy.scrollTo(model.emulator.lines.count - 1, anchor: .bottom) } } label: { Image(systemName: "arrow.down").font(.system(size: 15, weight: .semibold)).frame(width: 40, height: 40) }
                            .buttonStyle(.glass).clipShape(Circle()).padding(14).accessibilityLabel("Scroll to the end")
                    }
                }
            }
            .background(Theme.sunken)
            .background(CodeTerminalInput(model: model, focused: $focused).frame(width: 1, height: 1))
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
            .overlay { overlayState }
            .task(id: "\(cols)x\(rows)") {
                // The first layout pass can be empty: wait for a real size.
                guard cols >= 10, rows >= 2 else { return }
                if model.terminalId == nil, !model.starting, model.ended == nil { await model.open(cols: cols, rows: rows) } else { model.fit(cols: cols, rows: rows) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { keyRow }
        .onChange(of: model.store.connected) { _, connected in if connected { Task { await model.reattach() } } }
        .accessibilityLabel("Terminal")
    }

    @ViewBuilder private var overlayState: some View {
        if let ended = model.ended {
            VStack(spacing: 12) {
                Text(ended).font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                Button("Restart") { Task { await model.restart() } }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Theme.clay)
            }
            .padding(20).glassEffect(.regular, in: .rect(cornerRadius: 22)).padding(24)
        } else if model.terminalId == nil {
            ProgressView("Starting the shell…").padding(20).glassEffect(.regular, in: .rect(cornerRadius: 20))
        }
    }

    // MARK: Keys a phone keyboard lacks

    private var keyRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                key("Esc") { model.press(.escape) }
                key("Tab") { model.press(.tab) }
                Button { model.controlArmed.toggle() } label: {
                    Text("Ctrl").font(.subheadline.weight(.semibold)).padding(.horizontal, 12).frame(minWidth: 44, minHeight: 36)
                        .foregroundStyle(model.controlArmed ? .white : Theme.ink)
                        .background(model.controlArmed ? AnyShapeStyle(Theme.clay) : AnyShapeStyle(Theme.fill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }.buttonStyle(.plain).accessibilityLabel("Control").accessibilityAddTraits(model.controlArmed ? .isSelected : [])
                key("C-c", label: "Control C: interrupt") { model.control("c") }
                key("C-d", label: "Control D: end of input") { model.control("d") }
                key("↑", label: "Up") { model.press(.up) }
                key("↓", label: "Down") { model.press(.down) }
                key("←", label: "Left") { model.press(.left) }
                key("→", label: "Right") { model.press(.right) }
                key("|", label: "Pipe") { model.type("|") }
                key("~", label: "Tilde") { model.type("~") }
                key("/", label: "Slash") { model.type("/") }
                key("-", label: "Dash") { model.type("-") }
                key("Paste", label: "Paste") { model.paste() }
                Button { focused.toggle() } label: {
                    Image(systemName: focused ? "keyboard.chevron.compact.down" : "keyboard").font(.system(size: 16)).frame(minWidth: 44, minHeight: 36)
                        .background(Theme.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous)).foregroundStyle(Theme.ink)
                }.buttonStyle(.plain).accessibilityLabel(focused ? "Hide the keyboard" : "Show the keyboard")
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
        .background(.bar)
    }

    private func key(_ title: String, label: String? = nil, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(.subheadline, design: .monospaced).weight(.semibold)).padding(.horizontal, 10).frame(minWidth: 44, minHeight: 36)
                .foregroundStyle(Theme.ink).background(Theme.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain).accessibilityLabel(label ?? title)
    }
}
