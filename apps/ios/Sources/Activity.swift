import SwiftUI

/// The assistant's tool use, folded the way the desktop folds it: one quiet line ("Read 4 files, ran 2 commands") that
/// opens into the steps, each of which opens into its command, diff or output.
struct ToolGroupView: View {
    let steps: [ToolStep]
    /// The last group of a reply that is still being written stays open, so you can watch it work.
    let live: Bool
    /// What running commands have printed so far, by call id.
    var output: [String: String] = [:]
    /// Opens the whole file an Edit changed.
    var onViewEdit: ((ToolStep) -> Void)?
    @State private var open = Theme.expandedForDemo
    private var showing: Bool { open || (live && steps.count <= 4) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if steps.count > 1 {
                Button { withAnimation(.snappy(duration: 0.25)) { open.toggle() } } label: {
                    HStack(spacing: 8) {
                        if live { ProgressView().controlSize(.mini) } else { Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(showing ? 90 : 0)) }
                        Text(ToolInfo.summary(steps)).font(.subheadline)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.inkMuted)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHint(showing ? "Hides the steps" : "Shows the steps")
            }
            if showing || steps.count == 1 {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(steps) { step in ToolStepRow(step: step, running: live && step.result == nil, output: output[step.id] ?? "", onViewEdit: onViewEdit) }
                }
                .padding(.leading, steps.count > 1 ? 14 : 0)
                .overlay(alignment: .leading) { if steps.count > 1 { Rectangle().fill(Theme.hairline).frame(width: 1) } }
                .transition(.opacity)
            }
        }
    }
}

struct ToolStepRow: View {
    let step: ToolStep
    let running: Bool
    var output = ""
    var onViewEdit: ((ToolStep) -> Void)?
    @State private var open = Theme.expandedForDemo
    private var info: ToolInfo { ToolInfo(step.call) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy(duration: 0.25)) { open.toggle() } } label: {
                HStack(spacing: 10) {
                    Group {
                        if running { ProgressView().controlSize(.mini) }
                        else { Image(systemName: step.failed ? "exclamationmark.triangle" : info.icon).font(.system(size: 13)) }
                    }
                    .frame(width: 18)
                    .foregroundStyle(step.failed ? Theme.danger : Theme.inkMuted)
                    Text(info.verb).font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
                    if !info.target.isEmpty { Text(info.target).font(.subheadline).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
                    Spacer(minLength: 0)
                    if step.failed { Text("Failed").font(.caption.weight(.semibold)).foregroundStyle(Theme.danger) }
                }
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("\(info.verb) \(info.target)\(step.failed ? ", failed" : running ? ", running" : "")")
                .accessibilityHint(open ? "Hides the details" : "Shows the details")
            if open { ToolDetail(step: step, output: output, onViewEdit: onViewEdit).transition(.opacity.combined(with: .move(edge: .top))) }
            else if running, !output.isEmpty { ToolDetail.mono(String(output.suffix(600)), muted: true).padding(.leading, 28) }
        }
    }
}

private struct ToolDetail: View {
    let step: ToolStep
    let output: String
    var onViewEdit: ((ToolStep) -> Void)?
    private var input: JSON { step.call["input"] }
    private var name: String { step.name }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch name {
            case "Bash":
                Self.mono("$ " + input["command"].string)
            case "Edit", "MultiEdit":
                DiffLines(old: input["old_string"].string, new: input["new_string"].string)
                if step.finished, !step.failed, name == "Edit", let onViewEdit {
                    Button("See the whole file") { onViewEdit(step) }.font(.subheadline.weight(.medium)).tint(Theme.clay)
                }
            case "Write":
                Self.mono(String(input["content"].string.prefix(1500)) + (input["content"].string.count > 1500 ? "\n…" : ""))
            case "WebSearch":
                SearchResultRows(text: step.resultText)
            case "Read", "Grep", "Glob", "WebFetch", "TodoWrite", "Agent", "Task", "ViewImage": EmptyView()
            default:
                if input != .null, input != .object([:]) { Self.mono(input.pretty) }
            }
            let text = step.resultText.isEmpty ? output : step.resultText
            if !text.isEmpty, name != "Write", name != "Edit", name != "MultiEdit", name != "TodoWrite", name != "WebSearch" {
                Self.mono(String(text.prefix(2400)) + (text.count > 2400 ? "\n…" : ""), muted: true)
            }
            if !step.resultImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { ForEach(Array(step.resultImages.enumerated()), id: \.offset) { _, image in BlobImage(blob: image["blob"].string, mime: image["mime"].string, maxHeight: 140, corner: 10) } }
                }
            }
        }
        .padding(.leading, 28).padding(.bottom, 6)
    }

    static func mono(_ text: String, muted: Bool = false) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text).font(.system(size: 12.5, design: .monospaced)).lineSpacing(2).foregroundStyle(muted ? Theme.inkSecondary : Theme.ink).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(12)
                .environment(\.layoutDirection, .leftToRight)
        }
        .background(Theme.fill.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// A web search's results as rows that open the page: title, where it is and what it says.
struct SearchResultRows: View {
    let text: String
    var body: some View {
        let view = ChatSearchResult.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            if let note = view.note { Text(note).font(.footnote).foregroundStyle(Theme.inkMuted) }
            ForEach(Array(view.rows.enumerated()), id: \.offset) { _, row in
                Link(destination: row.link) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).multilineTextAlignment(.leading).lineLimit(2)
                        Text([row.host, row.published].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.clay).lineLimit(1)
                        if !row.snippet.isEmpty { Text(row.snippet).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(3).multilineTextAlignment(.leading) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if view.rows.isEmpty, !text.isEmpty { ToolDetail.mono(String(text.prefix(1200)), muted: true) }
            if let via = view.via { Text("Results from \(via)\(view.cached ? " (saved)" : "")").font(.caption).foregroundStyle(Theme.inkMuted) }
        }
    }
}

enum ChatSearchResult {
    struct Row { let title: String; let url: String; let host: String; let snippet: String; let published: String
        var link: URL { URL(string: url) ?? URL(string: "https://")! }
    }
    struct Parsed { var rows: [Row] = []; var via: String?; var cached = false; var note: String? }

    /// Reads a WebSearch result back into rows: a numbered list with a `(via Engine · 8 results)` footer.
    static func parse(_ text: String) -> Parsed {
        var view = Parsed()
        var notes: [String] = []
        for block in text.components(separatedBy: "\n\n").map({ $0.trimmingCharacters(in: .newlines) }) where !block.isEmpty {
            if block.hasPrefix("(via "), block.hasSuffix(")") {
                let inner = block.dropFirst(5).dropLast()
                view.via = inner.components(separatedBy: " · ").first
                view.cached = inner.contains("cached")
                continue
            }
            let lines = block.components(separatedBy: "\n")
            if let first = lines.first, let dot = first.range(of: #"^\d+\. "#, options: .regularExpression), lines.count > 1,
               let url = lines[1].trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init), url.hasPrefix("http://") || url.hasPrefix("https://") {
                let rest = lines.dropFirst(2).map { $0.trimmingCharacters(in: .whitespaces) }
                let meta = { (line: String) in line.hasPrefix("Published: ") || line.hasPrefix("Source: ") || line.hasPrefix("Page: ") }
                let host = URL(string: url)?.host?.replacingOccurrences(of: "www.", with: "") ?? url
                view.rows.append(Row(title: String(first[dot.upperBound...]), url: url, host: host, snippet: rest.filter { !meta($0) }.joined(separator: " "), published: rest.first { meta($0) && !$0.hasPrefix("Page: ") }.map { $0.replacingOccurrences(of: "Published: ", with: "").replacingOccurrences(of: "Source: ", with: "") } ?? ""))
            } else if !block.hasPrefix("No results") { notes.append(block) }
        }
        view.note = view.rows.isEmpty ? nil : (notes.isEmpty ? nil : notes.joined(separator: " "))
        return view
    }
}

/// An edit as removed and added lines.
struct DiffLines: View {
    let old: String
    let new: String
    var body: some View {
        let removed = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let added = new.isEmpty ? [] : new.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(removed.prefix(14).enumerated()), id: \.offset) { _, line in row("−", line, Theme.removed, Theme.danger) }
            ForEach(Array(added.prefix(14).enumerated()), id: \.offset) { _, line in row("+", line, Theme.added, Theme.success) }
            if removed.count > 14 || added.count > 14 { Text("…").font(.mono(.caption)).foregroundStyle(Theme.inkMuted).padding(.horizontal, 12).padding(.vertical, 4) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
    private func row(_ sign: String, _ line: String, _ background: Color, _ tint: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(sign).foregroundStyle(tint)
            Text(line.isEmpty ? " " : line)
        }
        .font(.system(size: 12.5, design: .monospaced)).padding(.horizontal, 12).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading).background(background)
    }
}

/// The model's thinking: a muted line that opens into what it wrote.
struct ThinkingView: View {
    let text: String
    /// Still being written: the newest line shows as the summary.
    var active = false
    @State private var open = Theme.expandedForDemo
    private var summary: String {
        guard active else { return "Thought process" }
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").last.map(String.init) ?? ""
        let plain = line.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: CharacterSet(charactersIn: " #>*-"))
        return plain.isEmpty ? "Thinking" : plain
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy(duration: 0.25)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    if active { ProgressView().controlSize(.mini) } else { Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(open ? 90 : 0)) }
                    Text(summary).font(.subheadline).lineLimit(1)
                }.foregroundStyle(Theme.inkMuted).padding(.vertical, 4).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint(open ? "Hides the thinking" : "Shows the thinking")
            if open {
                Text(text).font(.reading(.subheadline)).italic().foregroundStyle(Theme.inkSecondary).lineSpacing(4).textSelection(.enabled)
                    .padding(.leading, 14)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 1) }
            }
        }
    }
}

/// A line among the steps: another agent's word, or a background agent that ended.
struct NoticeLine: View {
    let notice: JSON
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Theme.inkMuted)
            Text(line).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(3)
            Spacer(minLength: 0)
        }.accessibilityElement(children: .combine)
    }
    private var symbol: String { notice["kind"].string == "agent" ? (notice["status"].string == "failed" ? "exclamationmark.triangle" : "person.2") : "paperplane" }
    private var line: String {
        if notice["kind"].string == "agent" {
            let status = notice["status"].string
            return "Agent \"\(notice["title"].string)\" \(status == "done" ? "finished" : status == "failed" ? "failed" : "was stopped")"
        }
        let from = notice["from"]
        let who = from["relation"].string == "parent" ? "the main session" : from["relation"].string == "sub-agent" ? "an agent" : from["title"].string
        return "Message from \(who): \(notice["text"].string)"
    }
}

/// The task list: one line above the message box that opens into the list.
struct TodosCard: View {
    let todos: [JSON]
    @State private var open = false
    private var done: Int { todos.filter { $0["status"].string == "completed" }.count }
    private var current: JSON? { todos.first { $0["status"].string == "in_progress" } ?? todos.first { $0["status"].string != "completed" } }
    private var title: String {
        if done == todos.count { return "All tasks done" }
        guard let current else { return "Tasks" }
        let active = current["activeForm"].string
        return active.isEmpty ? current["content"].string : active
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy(duration: 0.28)) { open.toggle() } } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().stroke(Theme.fillStrong, lineWidth: 2.5)
                        Circle().trim(from: 0, to: todos.isEmpty ? 0 : Double(done) / Double(todos.count)).stroke(Theme.clay, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).rotationEffect(.degrees(-90))
                    }.frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text("\(done) of \(todos.count) done").font(.caption).foregroundStyle(Theme.inkMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.inkMuted).rotationEffect(.degrees(open ? 180 : 0))
                }
                .padding(.horizontal, 16).padding(.vertical, 12).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Tasks: \(done) of \(todos.count) done").accessibilityHint(open ? "Hides the list" : "Shows the list")
            if open {
                Divider().overlay(Theme.hairline)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                        let status = todo["status"].string
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: status == "completed" ? "checkmark.circle.fill" : status == "in_progress" ? "circle.dotted" : "circle")
                                .foregroundStyle(status == "completed" ? Theme.clay : Theme.inkMuted).font(.system(size: 15))
                            Text(todo["content"].string).font(.subheadline).foregroundStyle(status == "completed" ? Theme.inkMuted : Theme.ink).strikethrough(status == "completed", color: Theme.inkMuted)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 22, style: .continuous))
    }
}
