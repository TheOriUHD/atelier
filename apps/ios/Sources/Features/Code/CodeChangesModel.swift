import Foundation
import Observation

/// A changed file as the Changes panel shows it.
struct CodeChanged: Identifiable, Equatable, Sendable {
    let path: String
    let status: CodeDiffFile.Status
    /// nil where staging doesn't apply (the session's or the branch's changes).
    let staged: Bool?
    let diff: CodeDiffFile?
    var id: String { path }
    var letter: String { status.letter }
}

/// The folder's git state and the diff of the open comparison, and everything the Changes and Git panels do to them.
/// Git runs on the folder's own machine, so its message comes back in words and shows as it is.
@MainActor @Observable final class CodeChangesModel {
    struct Branches: Equatable, Sendable { var current: String?; var list: [String]; var lastCommit: String?; var defaultBranch: String? }

    let store: AppStore
    let workspaceId: String
    let sessionId: String?
    var compare: CodeCompare = .head
    private(set) var status: CodeGitStatus?
    private(set) var statusLoaded = false
    private(set) var branches: Branches?
    private(set) var files: [CodeDiffFile] = []
    private(set) var truncated = false
    private(set) var loading = false
    private(set) var loadError: String?
    var actionError: String?
    private(set) var acting: String?
    var pullRequestURL: String?

    init(store: AppStore, workspaceId: String, sessionId: String?) {
        self.store = store
        self.workspaceId = workspaceId
        self.sessionId = sessionId
    }

    var isRepo: Bool { status != nil }
    /// Outside a repository only the session's own changes can be shown.
    var effective: CodeCompare { statusLoaded && !isRepo ? .session : compare }
    var options: [CodeCompare] { CodeCompare.options(repo: isRepo, branch: status?.branch, defaultBranch: branches?.defaultBranch) }

    /// Against HEAD, git status says what changed (untracked and conflicted files too); otherwise the diff does.
    var changed: [CodeChanged] {
        let byPath = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        if effective == .head, let status {
            return status.files.map { CodeChanged(path: $0.path, status: $0.status, staged: $0.staged, diff: byPath[$0.path]) }
        }
        return files.map { CodeChanged(path: $0.path, status: $0.status, staged: effective == .staged ? true : nil, diff: $0) }
    }

    // MARK: Reading

    func reload() async {
        loading = true
        defer { loading = false }
        do {
            let git = CodeGitStatus(try await codeCall(store, "workspaces.gitStatus", ["workspaceId": .string(workspaceId)]))
            status = git; statusLoaded = true
            if git != nil {
                let info = try await codeCall(store, "git.branches", ["workspaceId": .string(workspaceId)])
                branches = Branches(current: info["current"].stringOrNil, list: info["branches"].array.map(\.string), lastCommit: info["lastCommit"].stringOrNil, defaultBranch: info["defaultBranch"].stringOrNil)
                if !options.contains(compare) { compare = .head }
            } else { branches = nil }
            var params: [String: JSON] = ["workspaceId": .string(workspaceId), "compare": .string(effective.rawValue)]
            if let sessionId { params["sessionId"] = .string(sessionId) }
            let answer = try await codeCall(store, "workspaces.diff", params)
            let text = answer["diff"].string
            files = await Task.detached(priority: .userInitiated) { CodeDiff.parse(text) }.value
            truncated = answer["truncated"].bool
            loadError = nil
        } catch is CancellationError { return } catch { loadError = error.localizedDescription }
    }

    // MARK: Doing

    /// Runs one git action at a time, keeps the last failure's message, and reads the folder again after each.
    @discardableResult
    func run(_ name: String, _ action: () async throws -> Void) async -> Bool {
        guard acting == nil else { return false }
        acting = name; actionError = nil
        defer { acting = nil }
        var ok = false
        do { try await action(); ok = true } catch is CancellationError { return false } catch { actionError = error.localizedDescription }
        await reload()
        return ok
    }

    func stage(_ paths: [String], _ staged: Bool) async {
        await run("stage") { _ = try await codeCall(store, "git.stage", ["workspaceId": .string(workspaceId), "paths": .array(paths.map(JSON.string)), "staged": .bool(staged)]) }
    }

    func reject(_ file: CodeDiffFile, hunk: Int) async {
        guard let patch = file.patch(forHunk: hunk) else { return }
        await run("reject") { _ = try await codeCall(store, "git.revertHunk", ["workspaceId": .string(workspaceId), "patch": .string(patch)]) }
    }

    func commit(_ message: String) async -> Bool {
        await run("commit") { _ = try await codeCall(store, "git.commit", ["workspaceId": .string(workspaceId), "message": .string(message)]) }
    }

    func push() async {
        if await run("push", { _ = try await codeCall(store, "git.push", ["workspaceId": .string(workspaceId)]) }) { store.notify("Pushed") }
    }

    func checkout(_ branch: String, create: Bool) async -> Bool {
        await run("checkout") { _ = try await codeCall(store, "git.checkout", ["workspaceId": .string(workspaceId), "branch": .string(branch), "create": .bool(create)]) }
    }

    func openPullRequest(title: String, body: String, base: String?) async -> Bool {
        await run("pullRequest") {
            var params: [String: JSON] = ["workspaceId": .string(workspaceId), "title": .string(title), "body": .string(body)]
            if let base { params["base"] = .string(base) }
            pullRequestURL = try await codeCall(store, "git.pullRequest", params)["url"].string
        }
    }
}
