import SwiftUI

// MARK: - Changes: what the working tree differs by, file by file

/// The Changes panel: the files that changed, each with its diff; stage them, reject a hunk, commit what is staged.
struct CodeChangesPanel: View {
    let store: AppStore
    @State private var folders: CodeFolders

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
    }

    var body: some View {
        CodePanelFrame(title: "Changes", store: store) {
            CodeFolderGate(folders: folders) { workspace in
                CodeChangesHost(store: store, workspace: workspace)
            }
        }
        .task { await folders.load() }
    }
}

/// Owns the model for one folder and shows the changes.
private struct CodeChangesHost: View {
    let store: AppStore
    let workspace: CodeWorkspace
    @State private var model: CodeChangesModel

    init(store: AppStore, workspace: CodeWorkspace) {
        self.store = store
        self.workspace = workspace
        _model = State(initialValue: CodeChangesModel(store: store, workspaceId: workspace.id, sessionId: CodeSession(store: store).id))
    }

    var body: some View { CodeChangesView(model: model, workspace: workspace, store: store) }
}

struct CodeChangesView: View {
    let model: CodeChangesModel
    let workspace: CodeWorkspace
    let store: AppStore
    @State private var message = ""
    @State private var collapsed: Set<String> = []
    @State private var rejecting: (CodeDiffFile, Int)?
    @Environment(\.colorScheme) private var scheme
    @FocusState private var typing: Bool

    private var theme: CodeSyntaxTheme { CodeAppearance.shared.theme(dark: scheme == .dark) }
    private var stageable: [CodeChanged] { model.changed.filter { $0.staged != nil } }
    private var stagedCount: Int { stageable.filter { $0.staged == true }.count }

    var body: some View {
        Group {
            if let error = model.loadError, model.files.isEmpty, !model.statusLoaded {
                ScrollView { InlineError(message: error) { Task { await model.reload() } }.padding(.top, 60) }
            } else if !model.statusLoaded {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else { content }
        }
        .background(Theme.sunken)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.reload() } }
                    if model.isRepo {
                        Button("Collapse all", systemImage: "chevron.up.chevron.down") { collapsed = Set(model.changed.map(\.path)) }
                        Button("Expand all", systemImage: "chevron.down") { collapsed = [] }
                    }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("More")
            }
        }
        .task { await CodeAppearance.shared.load(store: store); await model.reload() }
        .refreshable { await model.reload() }
        .confirmationDialog("Reject this change?", isPresented: Binding(get: { rejecting != nil }, set: { if !$0 { rejecting = nil } }), titleVisibility: .visible) {
            Button("Reject change", role: .destructive) { if let (file, hunk) = rejecting { Task { await model.reject(file, hunk: hunk) } }; rejecting = nil }
        } message: { Text("The lines of this change go back to how they were. It is undone in the files on the computer and can't be brought back from here.") }
    }

    private var compareMenu: some View {
        Menu {
            ForEach(model.options) { option in
                Button {
                    model.compare = option
                    Task { await model.reload() }
                } label: {
                    let title = option.title(branch: model.status?.branch, defaultBranch: model.branches?.defaultBranch)
                    if option == model.effective { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
                .accessibilityHint(option.detail(defaultBranch: model.branches?.defaultBranch))
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.left.arrow.right").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.clay)
                Text(model.effective.title(branch: model.status?.branch, defaultBranch: model.branches?.defaultBranch)).font(.mono(.footnote)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                if model.options.count > 1 { Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.inkMuted) }
            }
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle()).card(radius: 16)
        }
        .accessibilityLabel("Compare: \(model.effective.title(branch: model.status?.branch, defaultBranch: model.branches?.defaultBranch))")
    }

    @ViewBuilder private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                compareMenu
                if model.isRepo { gitRow }
                if let conflicts = model.status?.conflicts, !conflicts.isEmpty { conflictBanner(conflicts) }
                if let error = model.actionError { errorBanner(error) }
                if model.changed.isEmpty {
                    EmptyState(title: "No changes to show", symbol: "checkmark.circle", message: model.effective == .session ? "This session hasn't edited a file yet." : "The working tree matches what is committed.").padding(.top, 40)
                } else {
                    summary
                    ForEach(model.changed) { file in
                        CodeDiffCard(file: file, theme: theme, rejectable: model.effective.rejectable, busy: model.acting != nil,
                                     expanded: !collapsed.contains(file.path),
                                     toggle: { if collapsed.contains(file.path) { collapsed.remove(file.path) } else { collapsed.insert(file.path) } },
                                     stage: { staged in Task { await model.stage([file.path], staged) } },
                                     reject: { hunk in if let diff = file.diff { rejecting = (diff, hunk) } })
                    }
                    if model.truncated { Text("The diff is too large to show in full.").font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity).padding(8) }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: 820).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { if model.isRepo { commitBar } }
        .overlay(alignment: .top) { if model.loading { ProgressView().padding(10).glassEffect(.regular, in: .capsule).padding(.top, 6) } }
    }

    // MARK: Pieces

    private var gitRow: some View {
        NavigationLink {
            CodeGitView(model: model, workspace: workspace, store: store)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.clay)
                Text(model.status?.branch ?? "Detached HEAD").font(.mono(.subheadline)).foregroundStyle(Theme.ink).lineLimit(1)
                if let status = model.status, status.hasUpstream {
                    if status.ahead > 0 { Label("\(status.ahead)", systemImage: "arrow.up").font(.footnote).foregroundStyle(Theme.inkMuted) }
                    if status.behind > 0 { Label("\(status.behind)", systemImage: "arrow.down").font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
                Spacer(minLength: 6)
                Text("Git").font(.footnote).foregroundStyle(Theme.inkMuted)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            }
            .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle()).card(radius: 16)
        }
        .buttonStyle(.plain)
    }

    private var summary: some View {
        HStack(spacing: 10) {
            if !stageable.isEmpty {
                Button {
                    let all = stagedCount == stageable.count
                    Task { await model.stage((all ? stageable : stageable.filter { $0.staged == false }).map(\.path), !all) }
                } label: {
                    Label(stagedCount == stageable.count ? "Unstage all" : "Stage all", systemImage: stagedCount == stageable.count ? "minus.circle" : "plus.circle").font(.subheadline)
                }.disabled(model.acting != nil)
            }
            Text("\(model.changed.count) changed \(model.changed.count == 1 ? "file" : "files")\(stagedCount > 0 && model.effective == .head ? " · \(stagedCount) staged" : "")")
                .font(.footnote).foregroundStyle(Theme.inkMuted)
            Spacer()
        }
        .padding(.horizontal, 4)
    }

    private func conflictBanner(_ conflicts: [CodeGitFile]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(conflicts.count) \(conflicts.count == 1 ? "file has" : "files have") merge conflicts", systemImage: "exclamationmark.triangle").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.danger)
            Text("Resolve them in the files, or ask the assistant to, then stage them. A commit waits until none is left.").font(.footnote).foregroundStyle(Theme.inkSecondary)
            ForEach(conflicts) { Text($0.path).font(.mono(.caption)).foregroundStyle(Theme.inkSecondary).lineLimit(1).truncationMode(.middle) }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func errorBanner(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.danger)
            Text(error).font(.footnote).foregroundStyle(Theme.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button { model.actionError = nil } label: { Image(systemName: "xmark").font(.caption.weight(.bold)) }.buttonStyle(.plain).foregroundStyle(Theme.inkMuted).accessibilityLabel("Dismiss")
        }
        .padding(14).background(Theme.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var commitBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(stagedCount > 0 ? "Commit message" : "Stage changes to commit them", text: $message, axis: .vertical)
                .lineLimit(1...4).focused($typing)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.fill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Button {
                Task { if await model.commit(message.trimmingCharacters(in: .whitespacesAndNewlines)) { message = ""; typing = false; store.notify("Committed") } }
            } label: {
                if model.acting == "commit" { ProgressView().tint(.white) } else { Text("Commit").fontWeight(.semibold) }
            }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Theme.clay).controlSize(.large)
            .disabled(stagedCount == 0 || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.acting != nil)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
    }
}

/// A changed file: its name and counts, and under them its diff.
struct CodeDiffCard: View {
    let file: CodeChanged
    let theme: CodeSyntaxTheme
    let rejectable: Bool
    let busy: Bool
    let expanded: Bool
    let toggle: () -> Void
    let stage: (Bool) -> Void
    let reject: (Int) -> Void
    @State private var shown = 300
    @State private var highlighted: [Int: AttributedString] = [:]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let staged = file.staged {
                    Button { stage(!staged) } label: {
                        Image(systemName: staged ? "checkmark.circle.fill" : "circle").font(.system(size: 22)).foregroundStyle(staged ? Theme.clay : Theme.inkMuted).frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain).disabled(busy)
                    .accessibilityLabel(staged ? "Unstage \(file.path)" : "Stage \(file.path)")
                }
                Button(action: toggle) {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.inkMuted).rotationEffect(.degrees(expanded ? 90 : 0))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(CodePath.name(file.path)).font(.system(.subheadline, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            if !CodePath.directory(file.path).isEmpty { Text(CodePath.directory(file.path)).font(.caption).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.head) }
                        }
                        Spacer(minLength: 6)
                        Text(file.letter).font(.mono(.caption).weight(.semibold)).foregroundStyle(file.status == .conflicted ? Theme.danger : Theme.inkMuted).frame(width: 14)
                            .accessibilityLabel(file.status.word)
                        if let diff = file.diff, !diff.binary {
                            HStack(spacing: 4) {
                                Text("+\(diff.added)").foregroundStyle(Theme.success)
                                Text("−\(diff.removed)").foregroundStyle(Theme.danger)
                            }.font(.mono(.caption).monospacedDigit())
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, file.staged == nil ? 14 : 6).padding(.trailing, 14).padding(.vertical, 6)
            if expanded {
                Divider().overlay(Theme.hairline)
                diffBody(of: file.diff)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder private func diffBody(of diff: CodeDiffFile?) -> some View {
        if let diff {
            if diff.binary { note("Binary file changed.") }
            else if diff.rows.isEmpty { note("Empty file.") }
            else {
                let rows = Array(diff.rows.prefix(shown))
                let digits = String(rows.compactMap(\.line).max() ?? 9).count
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        if row.kind == .hunk {
                            HStack(spacing: 8) {
                                Text(row.text).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.tail)
                                Spacer(minLength: 6)
                                if rejectable, let hunk = row.hunk {
                                    Button("Reject") { reject(hunk) }.font(.footnote.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(Theme.danger).disabled(busy)
                                        .accessibilityLabel("Reject this change in \(file.path)")
                                }
                            }
                            .padding(.horizontal, 12).padding(.vertical, 4).background(Theme.fill)
                        } else { CodeDiffLine(row: row, text: highlighted[row.id], theme: theme, digits: digits) }
                    }
                    if diff.rows.count > shown {
                        Button("Show \(diff.rows.count - shown) more lines") { shown += 600 }.font(.footnote).frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                }
                .background(theme.background)
                .task(id: shown) { await highlight(diff, upTo: shown) }
            }
        } else { note("No diff to show.") }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity).padding(14)
    }

    /// Colors each hunk's lines on their own, so a comment left open in one doesn't color the next.
    private func highlight(_ diff: CodeDiffFile, upTo count: Int) async {
        let language = CodePath.language(diff.path)
        guard language != nil else { return }
        let rows = Array(diff.rows.prefix(count)).filter { $0.kind != .hunk && highlighted[$0.id] == nil }
        guard !rows.isEmpty else { return }
        var segments: [[CodeDiffRow]] = []
        var last: Int?
        for row in rows { if row.hunk != last { segments.append([]); last = row.hunk }; segments[segments.count - 1].append(row) }
        var next = highlighted
        for segment in segments {
            let lines = await CodeHighlighting.lines(segment.map(\.text), language: language, theme: theme)
            for (row, line) in zip(segment, lines) { next[row.id] = line }
        }
        highlighted = next
    }
}

/// One row of a diff: its line number, the +/- sign and the code.
struct CodeDiffLine: View {
    let row: CodeDiffRow
    let text: AttributedString?
    let theme: CodeSyntaxTheme
    let digits: Int
    @ScaledMetric(relativeTo: .footnote) private var digit: CGFloat = 8.1

    var body: some View {
        let sign = row.kind == .add ? "+" : row.kind == .remove ? "−" : ""
        let tone: Color = row.kind == .add ? Theme.success : row.kind == .remove ? Theme.danger : theme.color(.comment)
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(row.line.map(String.init) ?? "").frame(width: CGFloat(digits) * digit + 8, alignment: .trailing).foregroundStyle(tone)
            Text(sign).frame(width: 20).foregroundStyle(tone)
            Group {
                if let text { Text(text.characters.isEmpty ? AttributedString(" ") : text) }
                else { Text(row.text.isEmpty ? " " : row.text).foregroundStyle(theme.plain) }
            }
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        }
        .font(.mono(.footnote)).padding(.vertical, 1).padding(.trailing, 8)
        .background(row.kind == .add ? Theme.added : row.kind == .remove ? Theme.removed : .clear)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.kind == .add ? "Added" : row.kind == .remove ? "Removed" : "Unchanged") line \(row.line ?? 0): \(row.text)")
    }
}

// MARK: - Git: branch, commit, push, pull request

struct CodeGitPanel: View {
    let store: AppStore
    @State private var folders: CodeFolders

    init(store: AppStore) {
        self.store = store
        _folders = State(initialValue: CodeFolders(store: store))
    }

    var body: some View {
        CodePanelFrame(title: "Git", store: store) {
            CodeFolderGate(folders: folders) { workspace in CodeGitHost(store: store, workspace: workspace) }
        }
        .task { await folders.load() }
    }
}

private struct CodeGitHost: View {
    let store: AppStore
    let workspace: CodeWorkspace
    @State private var model: CodeChangesModel

    init(store: AppStore, workspace: CodeWorkspace) {
        self.store = store
        self.workspace = workspace
        _model = State(initialValue: CodeChangesModel(store: store, workspaceId: workspace.id, sessionId: CodeSession(store: store).id))
    }
    var body: some View {
        CodeGitView(model: model, workspace: workspace, store: store)
            .task { await model.reload() }
    }
}

struct CodeGitView: View {
    let model: CodeChangesModel
    let workspace: CodeWorkspace
    let store: AppStore
    @State private var newBranch = false
    @State private var branchName = ""
    @State private var pullRequest = false
    @State private var message = ""
    @Environment(\.openURL) private var openURL

    private var status: CodeGitStatus? { model.status }
    private var staged: [CodeGitFile] { status?.files.filter(\.staged) ?? [] }

    var body: some View {
        List {
            if !model.statusLoaded {
                if let error = model.loadError { InlineError(message: error) { Task { await model.reload() } }.listRowBackground(Color.clear) }
                else { HStack { Spacer(); ProgressView().controlSize(.large); Spacer() }.frame(minHeight: 160).listRowBackground(Color.clear) }
            } else if let status {
                if let error = model.actionError {
                    Section {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.danger)
                            Text(error).font(.footnote).textSelection(.enabled)
                        }
                    }
                }
                branchSection(status)
                commitSection(status)
                pushSection(status)
                pullRequestSection
            } else {
                EmptyState(title: "Not a git repository", symbol: "arrow.triangle.branch", message: "This folder isn't under git, so there is no branch to switch or push. Changes the session made are still listed under Changes.").listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Git").navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.reload() }
        .alert("New branch", isPresented: $newBranch) {
            TextField("feature/my-change", text: $branchName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Create") { Task { if await model.checkout(branchName.trimmingCharacters(in: .whitespaces), create: true) { store.notify("Switched to \(branchName)") } } }
        } message: { Text("Starts from what is checked out now, and keeps your changes.") }
        .sheet(isPresented: $pullRequest) { CodePullRequestSheet(model: model) }
        .onAppear {
            #if DEBUG
            if Launch.value("--code-open") == "pr" { pullRequest = true }
            if Launch.value("--code-open") == "branch" { newBranch = true }
            #endif
        }
    }

    private func branchSection(_ status: CodeGitStatus) -> some View {
        SettingsSection(title: "Branch") {
            HStack {
                Text("Current").foregroundStyle(Theme.ink)
                Spacer()
                Text(status.branch ?? "Detached HEAD").font(.mono(.subheadline)).foregroundStyle(Theme.inkMuted).lineLimit(1)
            }
            if status.hasUpstream {
                HStack {
                    Text("Compared with origin").foregroundStyle(Theme.ink)
                    Spacer()
                    Text(status.ahead == 0 && status.behind == 0 ? "Up to date" : [status.ahead > 0 ? "\(status.ahead) ahead" : nil, status.behind > 0 ? "\(status.behind) behind" : nil].compactMap { $0 }.joined(separator: ", "))
                        .font(.subheadline).foregroundStyle(Theme.inkMuted)
                }
            }
            NavigationLink { CodeBranchList(model: model, store: store) } label: { NavRow(symbol: "arrow.triangle.branch", title: "Switch branch", subtitle: "\(model.branches?.list.count ?? 0) branches") }
            ActionRow(title: "New branch…", symbol: "plus", busy: model.acting == "checkout") { branchName = ""; newBranch = true }
        }
    }

    private func commitSection(_ status: CodeGitStatus) -> some View {
        SettingsSection(title: "Commit", footer: status.conflicts.isEmpty ? "The author is set in Settings › Code. Empty uses the repository's own git configuration." : "\(status.conflicts.count) \(status.conflicts.count == 1 ? "file has" : "files have") merge conflicts. Resolve them and stage them before you commit.") {
            NavigationLink { CodeChangesView(model: model, workspace: workspace, store: store).navigationTitle("Changes").navigationBarTitleDisplayMode(.inline) } label: {
                NavRow(symbol: "plusminus", title: "Changes", subtitle: "\(status.files.count) changed · \(staged.count) staged")
            }
            TextField(staged.isEmpty ? "Stage changes to commit them" : "Commit message", text: $message, axis: .vertical).lineLimit(1...5)
            ActionRow(title: staged.isEmpty ? "Commit" : "Commit \(staged.count) \(staged.count == 1 ? "file" : "files")", symbol: "checkmark.circle", busy: model.acting == "commit") {
                Task { if await model.commit(message.trimmingCharacters(in: .whitespacesAndNewlines)) { message = ""; store.notify("Committed") } }
            }
            .disabled(staged.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !status.conflicts.isEmpty)
        }
    }

    private func pushSection(_ status: CodeGitStatus) -> some View {
        let nothing = status.hasUpstream && status.ahead == 0
        return SettingsSection(title: "Push", footer: nothing ? "Nothing to push: the branch matches origin." : "Sends the current branch to origin and sets it as the upstream. Git runs on the folder's computer, so its credentials apply.") {
            ActionRow(title: status.ahead > 0 ? "Push \(status.ahead) \(status.ahead == 1 ? "commit" : "commits")" : "Push", symbol: "arrow.up", busy: model.acting == "push") { Task { await model.push() } }
                .disabled(nothing)
        }
    }

    private var pullRequestSection: some View {
        SettingsSection(title: "Pull request", footer: "For the current branch, with the GitHub CLI (gh) on this folder's computer, signed in with gh auth login.") {
            ActionRow(title: "Open a pull request…", symbol: "arrow.triangle.pull") { pullRequest = true }
            if let url = model.pullRequestURL, let link = URL(string: url) {
                Button { openURL(link) } label: {
                    HStack { Label("Pull request opened", systemImage: "checkmark.circle").foregroundStyle(Theme.success); Spacer(); Text(url).font(.mono(.caption)).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.middle) }
                }.buttonStyle(.plain)
            }
        }
    }
}

/// The branches of the repository; choosing one checks it out and keeps your changes.
struct CodeBranchList: View {
    let model: CodeChangesModel
    let store: AppStore
    @State private var query = ""

    var body: some View {
        List {
            if let error = model.actionError { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger).textSelection(.enabled) } }
            Section {
                ForEach((model.branches?.list ?? []).filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { branch in
                    Button {
                        guard branch != model.branches?.current else { return }
                        Task { if await model.checkout(branch, create: false) { store.notify("Switched to \(branch)") } }
                    } label: {
                        HStack {
                            Text(branch).font(.mono(.body)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            if branch == model.branches?.current { Image(systemName: "checkmark").foregroundStyle(Theme.clay) }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(model.acting != nil)
                }
            } footer: { Text("Switching keeps the changes you haven't committed, as long as git can carry them over.") }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
        .navigationTitle("Switch branch").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Filter branches")
        .overlay { if model.acting == "checkout" { ProgressView().padding(20).glassEffect(.regular, in: .rect(cornerRadius: 16)) } }
    }
}

/// A title, a base branch and a description for a pull request on the current branch.
struct CodePullRequestSheet: View {
    let model: CodeChangesModel
    @State private var title: String?
    @State private var body_ = ""
    @State private var base = ""
    @Environment(\.dismiss) private var dismiss

    private var shownTitle: String { title ?? model.branches?.lastCommit ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FieldRow(title: "Title", placeholder: "What this change does", text: Binding(get: { shownTitle }, set: { title = $0 }), autocapitalize: true)
                    PickRow(title: "Base branch", selection: $base, options: [("", "Repository default")] + (model.branches?.list ?? []).filter { $0 != model.branches?.current }.map { ($0, $0) })
                } footer: { Text("The title starts as the newest commit's subject.") }
                Section("Description") {
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $body_).frame(minHeight: 140).font(.body)
                        if body_.isEmpty { Text("What changed and why (optional)").foregroundStyle(Theme.inkMuted.opacity(0.7)).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                    }
                }
                if let error = model.actionError { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger).textSelection(.enabled) } }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Open a pull request").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { if await model.openPullRequest(title: shownTitle.trimmingCharacters(in: .whitespaces), body: body_, base: base.isEmpty ? nil : base) { dismiss() } }
                    } label: { if model.acting == "pullRequest" { ProgressView() } else { Text("Open").fontWeight(.semibold) } }
                        .disabled(shownTitle.trimmingCharacters(in: .whitespaces).isEmpty || model.acting != nil)
                }
            }
            .onAppear { model.actionError = nil }
        }
        .tint(Theme.clay)
        .presentationDetents([.large])
    }
}
