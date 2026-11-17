import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// An artifact a conversation made: a document, a page, a picture or code. It shows as it looks and as its source, and
/// can be copied, shared or saved as a file; an artifact with several versions can be read at each of them.
struct ArtifactView: View {
    let artifact: JSON
    /// With a store, an artifact that has versions can load the others.
    var store: AppStore?
    @State private var source = false
    @State private var scripts = true
    @State private var loaded: JSON?
    @State private var version = 0
    @State private var loadingVersion = false
    @State private var exporting = false
    @Environment(\.dismiss) private var dismiss

    private var shown: JSON { loaded ?? artifact }
    private var kind: String { shown["type"].string }
    private var text: String { shown["content"]["content"].string }
    private var versions: Int { shown["versions"].int }
    private var current: Int { version > 0 ? version : shown["version"].int }
    private var title: String { shown["title"].string.isEmpty ? "Untitled" : shown["title"].string }
    private var fileName: String { ArtifactFiles.fileName(title: title, type: kind, language: shown["language"].stringOrNil) }
    /// Mermaid and React need their desktop runtimes: the code is shown instead.
    private var codeOnly: Bool { ["code", "react", "mermaid"].contains(kind) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if kind == "mermaid" || kind == "react" { note }
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.background)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !codeOnly { Button(source ? "Preview" : "Source") { source.toggle() } }
                    Menu {
                        ShareLink(item: ArtifactFiles.shareable(text: text, name: fileName)) { Label("Share", systemImage: "square.and.arrow.up") }
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                        Button("Save to Files", systemImage: "folder") { exporting = true }
                        if kind == "html" { Toggle(isOn: $scripts) { Label("Run scripts", systemImage: "play.circle") } }
                        if versions > 1 {
                            Divider()
                            Picker("Version", selection: Binding(get: { current }, set: { select($0) })) { ForEach((1...versions).reversed(), id: \.self) { Text("Version \($0)").tag($0) } }
                        }
                    } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Artifact actions")
                }
            }
            .fileExporter(isPresented: $exporting, document: ArtifactDocument(text: text), contentType: .plainText, defaultFilename: fileName) { _ in }
            .overlay { if loadingVersion { ProgressView().controlSize(.large) } }
        }
        .tint(Theme.clay)
    }

    @ViewBuilder private var content: some View {
        if source || codeOnly {
            ScrollView([.horizontal, .vertical]) {
                Text(text.isEmpty ? " " : text).font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding().fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if kind == "markdown" {
            ScrollView { MarkdownView(text: text).padding(20).frame(maxWidth: Theme.readingWidth).frame(maxWidth: .infinity) }
        } else {
            IsolatedHTML(content: kind == "svg" ? "<div style=\"display:flex;justify-content:center\">\(text)</div>" : text, scripts: scripts && kind == "html")
        }
    }

    private var note: some View {
        Label(kind == "mermaid" ? "This diagram is shown as its code. The desktop app draws it." : "This is shown as its code. The desktop app runs React pages.", systemImage: "info.circle")
            .font(.footnote).foregroundStyle(Theme.inkSecondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 10).background(Theme.fill)
    }

    private func select(_ number: Int) {
        guard let store, number != current else { return }
        loadingVersion = true
        Task {
            defer { loadingVersion = false }
            do {
                loaded = try await store.rpc.call("artifacts.get", ["id": shown["id"], "version": .number(Double(number))])
                version = number
            } catch { store.error = ChatError.text(error) }
        }
    }
}

enum ArtifactFiles {
    static func fileName(title: String, type: String, language: String?) -> String {
        let base = title.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let name = String((base.isEmpty ? "artifact" : base).prefix(60))
        let ext: String
        switch type {
        case "html": ext = "html"
        case "react": ext = "jsx"
        case "svg": ext = "svg"
        case "mermaid": ext = "mmd"
        case "markdown": ext = "md"
        default: ext = language.flatMap(extensionFor) ?? "txt"
        }
        return "\(name).\(ext)"
    }

    private static func extensionFor(_ language: String) -> String? {
        let map = ["python": "py", "javascript": "js", "typescript": "ts", "swift": "swift", "rust": "rs", "go": "go", "java": "java", "c": "c", "cpp": "cpp", "csharp": "cs", "ruby": "rb", "php": "php", "bash": "sh", "shell": "sh", "json": "json", "yaml": "yml", "sql": "sql", "css": "css", "html": "html", "markdown": "md", "kotlin": "kt"]
        return map[language.lowercased()]
    }

    /// The text as a file in the temporary folder, so the share sheet offers it as a file with its name.
    static func shareable(text: String, name: String) -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "AtelierShare", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: name)
        try? text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}

struct ArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

/// Generated pages, drawn in a web view with nothing to reach out with: no network, no storage, no forms and no way
/// back into the app. Scripts run only when asked (a page that moves needs them), and only inside that cell.
struct IsolatedHTML: UIViewRepresentable {
    let content: String
    var scripts = false

    static func policy(scripts: Bool) -> String {
        "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'" + (scripts ? "; script-src 'unsafe-inline' 'unsafe-eval'" : "")
    }

    static func page(_ content: String, scripts: Bool) -> String {
        let head = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy(scripts: scripts))\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\">"
        if let range = content.range(of: "<head>", options: .caseInsensitive) {
            var page = content
            page.insert(contentsOf: head, at: range.upperBound)
            return page
        }
        if content.range(of: "<html", options: .caseInsensitive) != nil, let range = content.range(of: "<html[^>]*>", options: [.regularExpression, .caseInsensitive]) {
            var page = content
            page.insert(contentsOf: "<head>\(head)</head>", at: range.upperBound)
            return page
        }
        return "<html><head>\(head)</head><body>\(content)</body></html>"
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = scripts
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let key = "\(scripts)|\(content)"
        guard context.coordinator.content != key else { return }
        context.coordinator.content = key
        view.configuration.defaultWebpagePreferences.allowsContentJavaScript = scripts
        view.loadHTMLString(Self.page(content, scripts: scripts), baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var content: String?
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.navigationType == .other && (navigationAction.request.url?.scheme == "about" || navigationAction.request.url == nil) ? .allow : .cancel)
        }
    }
}
