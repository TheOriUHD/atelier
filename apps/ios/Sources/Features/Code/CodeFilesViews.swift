import SwiftUI
import UIKit

// MARK: - Files: the folder's tree, a search, and a viewer

/// The session's folder as a list you walk into, with a filter by name and a search inside files.
struct CodeFilesPanel: View {
    let store: AppStore
    @State private var folders: CodeFolders

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
    }

    var body: some View {
        CodePanelFrame(title: "Files", store: store) {
            CodeFolderGate(folders: folders) { workspace in
                CodeDirectoryView(store: store, workspace: workspace, directory: "")
            }
        }
        .task { await folders.load() }
    }
}

/// One level of the tree. At the top it also carries the search.
struct CodeDirectoryView: View {
    let store: AppStore
    let workspace: CodeWorkspace
    let directory: String
    @State private var entries: Resource<[JSON]>
    @State private var query = ""
    @State private var inFiles = false
    @State private var names: [String]?
    @State private var matches: (list: [CodeGrepFile], truncated: Bool)?
    @State private var searchError: String?
    @State private var searching = false

    init(store: AppStore, workspace: CodeWorkspace, directory: String) {
        self.store = store
        self.workspace = workspace
        self.directory = directory
        _entries = State(initialValue: Resource { try await codeCall(store, "workspaces.files", ["workspaceId": .string(workspace.id), "dir": .string(directory)]).array })
    }

    private var title: String { directory.isEmpty ? workspace.name : CodePath.name(directory) }
    private var term: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        Group {
            if directory.isEmpty && !term.isEmpty { results } else { tree }
        }
        .background(Theme.sunken)
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .modifier(CodeSearchModifier(enabled: directory.isEmpty, query: $query, inFiles: $inFiles))
        .task(id: "\(term)|\(inFiles)") { await search() }
        .onAppear {
            #if DEBUG
            if directory.isEmpty, let preset = Launch.value("--code-query") { query = preset; inFiles = Launch.value("--code-scope") == "files" }
            #endif
        }
        .refreshable { await entries.reload() }
    }

    // MARK: The tree

    @ViewBuilder private var tree: some View {
        switch entries.state {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity).task { await entries.reload() }
        case .failed(let message):
            ScrollView { InlineError(message: message) { Task { await entries.reload() } }.padding(.top, 60) }
        case .loaded(let list):
            if list.isEmpty {
                ScrollView { EmptyState(title: "This folder is empty", symbol: "folder", message: nil).padding(.top, 60) }
            } else {
                List {
                    ForEach(list, id: \.self) { entry in
                        if entry["kind"].string == "dir" {
                            NavigationLink { CodeDirectoryView(store: store, workspace: workspace, directory: entry["path"].string) } label: { row(entry["name"].string, symbol: "folder", detail: nil) }
                        } else {
                            NavigationLink { CodeFileViewer(store: store, workspace: workspace, path: entry["path"].string) } label: {
                                row(entry["name"].string, symbol: CodePath.symbol(entry["name"].string), detail: entry["kind"].string == "symlink" ? "Link" : CodeFormat.bytes(entry["size"].int))
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped).scrollContentBackground(.hidden)
            }
        }
    }

    private func row(_ name: String, symbol: String, detail: String?) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: symbol, tint: symbol == "folder" ? Theme.clay : Theme.inkSecondary, size: 30)
            Text(name).font(.system(.body)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if let detail { Text(detail).font(.footnote).foregroundStyle(Theme.inkMuted) }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Search

    @ViewBuilder private var results: some View {
        List {
            if let searchError { Section { Text(searchError).font(.subheadline).foregroundStyle(Theme.danger) } }
            if inFiles {
                if term.count < 2 { Section { Text("Type at least two letters to search inside files.").font(.subheadline).foregroundStyle(Theme.inkMuted) } }
                else if let matches {
                    if matches.list.isEmpty { Section { Text("No files contain “\(term)”.").font(.subheadline).foregroundStyle(Theme.inkMuted) } }
                    ForEach(matches.list) { file in
                        Section {
                            ForEach(file.lines) { line in
                                NavigationLink { CodeFileViewer(store: store, workspace: workspace, path: file.path, line: line.line) } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        Text("\(line.line)").font(.mono(.caption).monospacedDigit()).foregroundStyle(Theme.inkMuted).frame(minWidth: 32, alignment: .trailing)
                                        Text(line.text.trimmingCharacters(in: .whitespaces)).font(.mono(.footnote)).foregroundStyle(Theme.ink).lineLimit(2)
                                    }
                                }
                            }
                        } header: { Label(file.path, systemImage: CodePath.symbol(CodePath.name(file.path))).textCase(nil).font(.footnote.weight(.semibold)).lineLimit(1).truncationMode(.middle) }
                    }
                    if matches.truncated { Section { Text("Only the first matches are shown. Search for something longer.").font(.footnote).foregroundStyle(Theme.inkMuted) } }
                } else if searching { Section { HStack { ProgressView(); Text("Searching in files…").foregroundStyle(Theme.inkMuted) } } }
            } else if let names {
                if names.isEmpty { Section { Text("No file names match “\(term)”.").font(.subheadline).foregroundStyle(Theme.inkMuted) } }
                else {
                    Section {
                        ForEach(names, id: \.self) { path in
                            NavigationLink { CodeFileViewer(store: store, workspace: workspace, path: path) } label: {
                                HStack(spacing: 12) {
                                    IconTile(symbol: CodePath.symbol(CodePath.name(path)), tint: Theme.inkSecondary, size: 30)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(CodePath.name(path)).foregroundStyle(Theme.ink).lineLimit(1)
                                        if !CodePath.directory(path).isEmpty { Text(CodePath.directory(path)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if searching { Section { HStack { ProgressView(); Text("Finding files…").foregroundStyle(Theme.inkMuted) } } }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    private func search() async {
        guard directory.isEmpty else { return }
        searchError = nil
        guard !term.isEmpty else { names = nil; matches = nil; searching = false; return }
        // Typing stays quick: the search follows a moment behind.
        try? await Task.sleep(for: .milliseconds(250))
        if Task.isCancelled { return }
        searching = true
        defer { searching = false }
        do {
            if inFiles {
                guard term.count >= 2 else { matches = nil; return }
                let answer = try await codeCall(store, "workspaces.grep", ["workspaceId": .string(workspace.id), "query": .string(term)])
                if Task.isCancelled { return }
                matches = (CodeGrepFile.group(answer["matches"].array), answer["truncated"].bool)
            } else {
                let answer = try await codeCall(store, "workspaces.findFiles", ["workspaceId": .string(workspace.id), "query": .string(term)])
                if Task.isCancelled { return }
                names = answer.array.map(\.string)
            }
        } catch is CancellationError { return } catch { searchError = error.localizedDescription }
    }
}

private struct CodeSearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var query: String
    @Binding var inFiles: Bool
    func body(content: Content) -> some View {
        if enabled {
            content
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: inFiles ? "Search inside files" : "Filter files by name")
                .searchScopes($inFiles) { Text("Names").tag(false); Text("In files").tag(true) }
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        } else { content }
    }
}

/// Matching lines of one file (`workspaces.grep`), in the order the server found them.
struct CodeGrepFile: Identifiable, Equatable, Sendable {
    struct Line: Identifiable, Equatable, Sendable { let line: Int; let text: String; var id: Int { line } }
    let path: String
    let lines: [Line]
    var id: String { path }

    static func group(_ matches: [JSON]) -> [CodeGrepFile] {
        var order: [String] = []
        var byPath: [String: [Line]] = [:]
        for match in matches {
            let path = match["path"].string
            if byPath[path] == nil { order.append(path) }
            byPath[path, default: []].append(Line(line: match["line"].int, text: match["text"].string))
        }
        return order.map { CodeGrepFile(path: $0, lines: byPath[$0] ?? []) }
    }
}

// MARK: The viewer

/// A file, read-only: numbered lines in the person's code theme; images shown; binary files said so.
struct CodeFileViewer: View {
    let store: AppStore
    let workspace: CodeWorkspace
    let path: String
    var line: Int?

    private enum Content { case loading, text([String], truncated: Bool, size: Int), image(UIImage), binary(Int), failed(String) }
    @State private var content = Content.loading
    @State private var highlighted: [AttributedString] = []
    @State private var wrap = true
    @State private var raw: String?
    @State private var sharing = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var theme: CodeSyntaxTheme { CodeAppearance.shared.theme(dark: scheme == .dark) }

    var body: some View {
        Group {
            switch content {
            case .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ScrollView { InlineError(message: message) { Task { await load() } }.padding(.top, 60) }
            case .binary(let size):
                ScrollView {
                    if size > 16 * 1024 * 1024 {
                        EmptyState(title: "Binary file", symbol: "doc.zipper", message: "\(CodeFormat.bytes(size)). It is not shown here, and files over 16 MB can't be copied from here.").padding(.top, 60)
                    } else {
                        EmptyState(title: "Binary file", symbol: "doc.zipper", message: "\(CodeFormat.bytes(size)). It is not shown here.", actionTitle: "Share a copy…") { Task { await share() } }.padding(.top, 60)
                    }
                }
            case .image(let image):
                ScrollView([.vertical, .horizontal]) { Image(uiImage: image).resizable().scaledToFit().padding(16).frame(maxWidth: .infinity) }
                    .background(Theme.surface)
            case .text(let lines, let truncated, _):
                VStack(spacing: 0) {
                    CodeSourceView(lines: highlighted.isEmpty ? lines.map { AttributedString($0) } : highlighted, theme: theme, focus: line, wrap: wrap)
                    if truncated {
                        Text("Only the beginning of this file is shown.").font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity).padding(10).background(.bar)
                    }
                }
            }
        }
        .background(Theme.sunken)
        .navigationTitle(CodePath.name(path)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if case .text = content {
                        Toggle("Wrap lines", systemImage: "text.word.spacing", isOn: $wrap)
                        Button("Copy contents", systemImage: "doc.on.doc") { if let raw { UIPasteboard.general.string = raw; store.notify("Copied") } }
                    }
                    Button("Copy path", systemImage: "link") { UIPasteboard.general.string = path; store.notify("Copied") }
                    Button("Mention in your message", systemImage: "at") {
                        store.draft += (store.draft.isEmpty || store.draft.hasSuffix(" ") || store.draft.hasSuffix("\n") ? "" : " ") + "@\(path) "
                        store.notify("Added to your message")
                    }
                    if case .image = content { Button("Share a copy…", systemImage: "square.and.arrow.up") { Task { await share() } } }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("File actions")
            }
        }
        .task { wrap = sizeClass != .regular; await CodeAppearance.shared.load(store: store); await load() }
    }

    private func load() async {
        content = .loading
        do {
            if CodePath.isImage(path) {
                let answer = try await codeCall(store, "workspaces.fileBytes", ["workspaceId": .string(workspace.id), "path": .string(path)])
                if let data = Data(base64Encoded: answer["dataBase64"].string), let image = UIImage(data: data) { content = .image(image); return }
            }
            let file = try await codeCall(store, "workspaces.readFile", ["workspaceId": .string(workspace.id), "path": .string(path)])
            guard let text = file["content"].stringOrNil else { content = .binary(file["size"].int); return }
            raw = text
            var lines = text.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() }
            content = .text(lines, truncated: file["truncated"].bool, size: file["size"].int)
            highlighted = await CodeHighlighting.lines(lines, language: CodePath.language(path), theme: theme)
        } catch is CancellationError { return } catch { content = .failed(error.localizedDescription) }
    }

    /// A copy of the file to save or send: the bytes come from the server, up to 16 MiB.
    private func share() async {
        guard !sharing else { return }
        sharing = true
        defer { sharing = false }
        do {
            let answer = try await codeCall(store, "workspaces.fileBytes", ["workspaceId": .string(workspace.id), "path": .string(path)])
            guard let data = Data(base64Encoded: answer["dataBase64"].string) else { throw MobileError.message("The server sent something this app can't read.") }
            let folder = FileManager.default.temporaryDirectory.appending(path: "atelier-share-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: CodePath.name(path))
            try data.write(to: url, options: .atomic)
            CodePresenter.topController().map { top in
                let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                controller.popoverPresentationController?.sourceView = top.view
                controller.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
                top.present(controller, animated: true)
            }
        } catch is CancellationError { return } catch { store.error = error.localizedDescription }
    }
}

/// Numbered source lines: wrapped to the screen, or on a canvas that scrolls sideways.
struct CodeSourceView: View {
    let lines: [AttributedString]
    let theme: CodeSyntaxTheme
    var focus: Int?
    var wrap: Bool
    @ScaledMetric(relativeTo: .footnote) private var digit: CGFloat = 8.1

    private var gutter: CGFloat { CGFloat(String(max(lines.count, 1)).count) * digit + 6 }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(index + 1)").font(.mono(.footnote).monospacedDigit()).foregroundStyle(theme.color(.comment)).frame(width: gutter, alignment: .trailing)
                            Text(line.characters.isEmpty ? AttributedString(" ") : line).font(.mono(.footnote))
                                .fixedSize(horizontal: !wrap, vertical: true)
                                .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 1)
                        .background(focus == index + 1 ? Theme.clay.opacity(0.18) : .clear)
                        .id(index + 1)
                    }
                }
                .padding(.vertical, 8)
                .textSelection(.enabled)
            }
            .background(theme.background)
            .onAppear { if let focus { DispatchQueue.main.async { proxy.scrollTo(max(1, focus - 3), anchor: .top) } } }
        }
    }
}

// MARK: - What `@` offers

/// Files of the session's folder that match what was typed after `@`, best first.
struct FileMentionList: View {
    let store: AppStore
    let query: String
    var onPick: (String) -> Void
    @State private var paths: [String] = []
    @State private var failed = false
    @State private var demoFolderId: String?
    @State private var rowsHeight: CGFloat = 0

    init(store: AppStore, query: String, onPick: @escaping (String) -> Void) {
        self.store = store
        self.query = query
        self.onPick = onPick
    }

    /// The session's folder; a screen shown from canned data (`--demo`) has none of its own, so the folders say.
    private var workspaceId: String? { CodeSession(store: store).workspaceId ?? demoFolderId }

    var body: some View {
        // A stack, not a `Group`: a task on an empty `Group` never runs, and this list starts empty.
        VStack(spacing: 0) {
            Color.clear.frame(height: 0)
            if !paths.isEmpty {
                // As tall as its rows, and scrolling once they are more than fit.
                ScrollView {
                    rows.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(max(rowsHeight, 1), 240))
                .card(radius: 16)
            }
        }
        .task(id: query) { await load() }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(paths.prefix(30), id: \.self) { path in
                Button { onPick(path) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: CodePath.symbol(CodePath.name(path))).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.inkMuted).frame(width: 22)
                        Text(CodePath.name(path)).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                        if !CodePath.directory(path).isEmpty { Text(CodePath.directory(path)).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.head) }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 9).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(path)
            }
        }
    }

    private func load() async {
        #if DEBUG
        if CodeSession(store: store).workspaceId == nil, demoFolderId == nil, Demo.requested != nil {
            let loaded = CodeFolders(store: store)
            await loaded.load()
            demoFolderId = loaded.folders.first?.id
        }
        #endif
        guard let workspaceId else { paths = []; return }
        try? await Task.sleep(for: .milliseconds(120))
        if Task.isCancelled { return }
        do {
            paths = try await codeCall(store, "workspaces.findFiles", ["workspaceId": .string(workspaceId), "query": .string(query)]).array.map(\.string)
            failed = false
        } catch is CancellationError { return } catch { paths = []; failed = true }
    }
}
