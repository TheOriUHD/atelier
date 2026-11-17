import Foundation

/// Canned answers for the Code screens, in the real shapes, so `--demo` shows them without a server.
/// `--state` picks a case: empty, error, long, offline, norepo, conflict, plan, disconnected, forbidden, unsupported.
enum CodeDemo {
    #if DEBUG
    static var state: String { Launch.value("--state") ?? "" }
    private static func ago(_ seconds: Double) -> Double { (Date.now.timeIntervalSince1970 - seconds) * 1000 }

    // MARK: Folders

    nonisolated(unsafe) private static var removed: Set<String> = []
    nonisolated(unsafe) private static var trusted: Set<String> = []
    nonisolated(unsafe) private static var extraFolders: [JSON] = []

    private static var workspaces: [JSON] {
        if state == "empty" { return [] }
        let all: [JSON] = [
            ["id": "w1", "kind": "local", "name": "atelier-web", "root": "/Users/maya/Developer/atelier-web", "host": nil, "deviceId": "d1", "available": .bool(state != "offline"), "scratch": false, "trusted": true, "lastUsedAt": .number(ago(300))],
            ["id": "w2", "kind": "ssh", "name": "api", "root": "/srv/api", "host": "build-box", "deviceId": nil, "available": true, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(7200))],
            ["id": "w3", "kind": "codespace", "name": "mobile-app", "root": "/workspaces/mobile-app", "host": "fuzzy-space-guacamole-x7", "deviceId": nil, "available": true, "scratch": false, "trusted": .bool(trusted.contains("w3")), "lastUsedAt": .number(ago(86400))],
            ["id": "w4", "kind": "local", "name": "home-lab", "root": "/home/maya/lab", "host": nil, "deviceId": "d2", "available": false, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(5 * 86400))],
            ["id": "w6", "kind": "local", "name": "atelier-docs", "root": "/Users/maya/Developer/atelier-docs", "host": nil, "deviceId": "d1", "available": true, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(40_000))],
            ["id": "w5", "kind": "local", "name": "scratch-2026-11-17-a1b2", "root": "/data/scratch/a1b2", "host": nil, "deviceId": "d1", "available": true, "scratch": true, "trusted": true, "lastUsedAt": .number(ago(600))],
        ]
        var list = all.filter { !removed.contains($0["id"].string) } + extraFolders
        if state == "long" {
            for n in 0..<14 { list.append(["id": .string("x\(n)"), "kind": "local", "name": .string("project-\(n + 1)"), "root": .string("/Users/maya/Developer/project-\(n + 1)"), "host": nil, "deviceId": "d1", "available": true, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(Double(n + 2) * 86400))]) }
        }
        return list
    }

    // MARK: Files

    private static let source = """
    import http from 'node:http';
    import { sleep } from './util.ts';

    /** The server the health tests talk to. */
    export async function start(port = 0) {
      const server = http.createServer(handler);
      await new Promise((resolve) => server.listen(port, resolve));
      return server;
    }

    function handler(req: http.IncomingMessage, res: http.ServerResponse) {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }
      // Anything else is not found.
      res.statusCode = 404;
      res.end('not found');
    }

    export const LIMIT = 5000; // milliseconds

    export async function waitForPort(server: http.Server, timeout = LIMIT) {
      const started = Date.now();
      while (!server.listening) {
        if (Date.now() - started > timeout) throw new Error(`Timed out after ${timeout} ms`);
        await sleep(20);
      }
      return server.address();
    }
    """

    private static func entries(_ dir: String) -> [JSON] {
        func dirEntry(_ path: String) -> JSON { ["name": .string(CodePath.name(path)), "path": .string(path), "kind": "dir", "size": 0] }
        func file(_ path: String, _ size: Int) -> JSON { ["name": .string(CodePath.name(path)), "path": .string(path), "kind": "file", "size": .number(Double(size))] }
        switch dir {
        case "": return [dirEntry("docs"), dirEntry("src"), dirEntry("test"), file(".gitignore", 38), file("README.md", 1240), file("logo.png", 1432), file("package.json", 612), file("tsconfig.json", 320), file("build.bin", 48_213_000)]
        case "src": return [dirEntry("src/components"), file("src/server.ts", 1180), file("src/util.ts", 110), file("src/settings.ts", 2210)]
        case "src/components": return (state == "long" ? Array(1...60) : Array(1...3)).map { file("src/components/Panel\($0).tsx", 800 + $0 * 17) }
        case "test": return [file("test/server.test.ts", 940)]
        case "docs": return [file("docs/getting-started.md", 3200)]
        default: return []
        }
    }
    private static var allPaths: [String] { entries("").filter { $0["kind"].string == "file" }.map { $0["path"].string } + entries("src").map { $0["path"].string } + entries("src/components").map { $0["path"].string } + ["test/server.test.ts", "docs/getting-started.md"] }

    private static func fileContent(_ path: String) -> JSON {
        switch path {
        case "src/server.ts": return ["path": "src/server.ts", "content": .string(source), "truncated": false, "size": 1180]
        case "README.md": return ["path": "README.md", "content": "# Atelier web\n\nThe web client.\n\n## Develop\n\n```sh\npnpm dev\n```\n", "truncated": false, "size": 1240]
        case "package.json": return ["path": .string(path), "content": "{\n  \"name\": \"atelier-web\",\n  \"version\": \"0.10.1\",\n  \"scripts\": { \"dev\": \"vite\", \"test\": \"vitest\" },\n  \"private\": true\n}\n", "truncated": false, "size": 612]
        case "build.bin": return ["path": .string(path), "content": nil, "truncated": false, "size": 48_213_000]
        default:
            let lines = (1...(state == "long" ? 1800 : 24)).map { "// line \($0) of \(path): const value\($0) = compute(\($0)); /* a longer line to see how it wraps on a narrow screen */" }
            return ["path": .string(path), "content": .string(lines.joined(separator: "\n")), "truncated": .bool(state == "long"), "size": .number(Double(lines.count * 80))]
        }
    }

    // MARK: Git

    private static var gitStatus: JSON {
        if state == "norepo" { return .null }
        if state == "clean" { return ["branch": "main", "upstream": ["ahead": 0, "behind": 0], "files": []] }
        var files: [JSON] = [
            ["path": "src/server.ts", "status": "modified", "staged": false],
            ["path": "src/util.ts", "status": "added", "staged": true],
            ["path": "README.md", "status": "modified", "staged": true],
            ["path": "notes.txt", "status": "untracked", "staged": false],
            ["path": "logo.png", "status": "modified", "staged": false],
        ]
        if state == "conflict" { files.append(["path": "src/settings.ts", "status": "conflicted", "staged": false]) }
        return ["branch": "feature/wait-for-port", "upstream": ["ahead": 2, "behind": 1], "files": .array(files)]
    }

    private static let sampleDiff = """
    diff --git a/README.md b/README.md
    index 1a2b3c4..5d6e7f8 100644
    --- a/README.md
    +++ b/README.md
    @@ -1,5 +1,7 @@
     # Atelier web

    -The web client.
    +The web client, for the browser and the desktop shell.

     ## Develop
    +
    +Run `pnpm dev` and open http://localhost:5173.
    diff --git a/src/server.ts b/src/server.ts
    index 9a8b7c6..1d2e3f4 100644
    --- a/src/server.ts
    +++ b/src/server.ts
    @@ -2,9 +2,10 @@ import http from 'node:http';
     import { sleep } from './util.ts';

     /** The server the health tests talk to. */
    -export function start(port = 0) {
    +export async function start(port = 0) {
       const server = http.createServer(handler);
    -  server.listen(port);
    +  await new Promise((resolve) => server.listen(port, resolve));
       return server;
     }

    @@ -22,3 +23,11 @@ function handler(req: http.IncomingMessage, res: http.ServerResponse) {
       res.statusCode = 404;
       res.end('not found');
     }
    +
    +export const LIMIT = 5000; // milliseconds
    +
    +export async function waitForPort(server: http.Server, timeout = LIMIT) {
    +  const started = Date.now();
    +  while (!server.listening) {
    +    if (Date.now() - started > timeout) throw new Error(`Timed out after ${timeout} ms`);
    +    await sleep(20);
    +  }
    +  return server.address();
    +}
    diff --git a/src/util.ts b/src/util.ts
    new file mode 100644
    index 0000000..3b4c5d6
    --- /dev/null
    +++ b/src/util.ts
    @@ -0,0 +1,2 @@
    +export const sleep = (ms: number) =>
    +  new Promise((resolve) => setTimeout(resolve, ms));
    diff --git a/logo.png b/logo.png
    index 1111111..2222222 100644
    Binary files a/logo.png and b/logo.png differ

    """

    private static func diff(_ compare: String) -> String {
        if state == "clean" || state == "norepo" && compare != "session" { return "" }
        if compare == "staged" { return String(sampleDiff.components(separatedBy: "diff --git a/src/server.ts").first ?? "") }
        if state == "long" {
            var text = sampleDiff
            for n in 1...30 {
                text += "diff --git a/src/components/Panel\(n).tsx b/src/components/Panel\(n).tsx\nindex 1111111..2222222 100644\n--- a/src/components/Panel\(n).tsx\n+++ b/src/components/Panel\(n).tsx\n@@ -1,3 +1,4 @@\n import React from 'react';\n-export const Panel = () => null;\n+export const Panel = () => <div className=\"panel\" />;\n+export default Panel;\n"
            }
            return text
        }
        return sampleDiff
    }

    // MARK: Terminal

    nonisolated(unsafe) private static var shellLine = ""
    private static let prompt = "\u{1B}[1;32mmaya@mac\u{1B}[0m:\u{1B}[1;34m~/atelier-web\u{1B}[0m$ "

    private static func shell(_ text: String, _ id: String) {
        var out = ""
        for ch in text {
            if ch == "\r" {
                let command = shellLine.trimmingCharacters(in: .whitespaces)
                shellLine = ""
                out += "\r\n"
                switch command {
                case "": break
                case "ls": out += "\u{1B}[1;34mdocs\u{1B}[0m  \u{1B}[1;34msrc\u{1B}[0m  \u{1B}[1;34mtest\u{1B}[0m  README.md  package.json  tsconfig.json\r\n"
                case "git status": out += "On branch \u{1B}[32mfeature/wait-for-port\u{1B}[0m\r\nChanges not staged for commit:\r\n\t\u{1B}[31mmodified:   src/server.ts\u{1B}[0m\r\n\r\n"
                case "clear": out += "\u{1B}[2J\u{1B}[H"
                default: out += "zsh: command not found: \(command)\r\n"
                }
                out += prompt
            } else if ch == "\u{7F}" {
                if !shellLine.isEmpty { shellLine.removeLast(); out += "\u{8}\u{1B}[K" }
            } else if ch == "\u{3}" {
                shellLine = ""; out += "^C\r\n" + prompt
            } else if ch.asciiValue.map({ $0 >= 32 }) ?? true, !text.hasPrefix("\u{1B}") {
                shellLine.append(ch); out.append(ch)
            }
        }
        if !out.isEmpty { Task { @MainActor in CodeEvents.shared.emit("terminals.data", ["terminalId": .string(id), "data": .string(out)]) } }
    }

    // MARK: Tasks, plan, checkpoints for the demo conversation

    /// Background tasks of the demo session (the demo conversation carries none of its own).
    static var tasks: [JSON] {
        if state == "empty" || state == "clean" { return [] }
        var list: [JSON] = [
            ["id": "k1", "kind": "command", "title": "Run the dev server", "command": "pnpm dev --host", "sessionId": nil, "background": true, "loop": nil, "startedAt": .number(ago(1500)), "endedAt": nil, "status": "running", "exitCode": nil],
            ["id": "k2", "kind": "agent", "title": "Review the settings migration for missing defaults", "command": nil, "sessionId": "agent1", "background": true, "loop": nil, "startedAt": .number(ago(240)), "endedAt": nil, "status": "running", "exitCode": nil],
            ["id": "k3", "kind": "loop", "title": "Check the deploy and tell me what changed since the last run", "command": nil, "sessionId": nil, "background": false, "loop": ["intervalMs": 300_000, "runs": 3, "nextAt": .number(ago(-190)), "waiting": false], "startedAt": .number(ago(900)), "endedAt": nil, "status": "running", "exitCode": nil],
            ["id": "k4", "kind": "command", "title": "pnpm test --run", "command": "pnpm test --run", "sessionId": nil, "background": false, "loop": nil, "startedAt": .number(ago(4000)), "endedAt": .number(ago(3940)), "status": "failed", "exitCode": 1],
            ["id": "k5", "kind": "command", "title": "Build the docs", "command": "pnpm --filter docs build", "sessionId": nil, "background": false, "loop": nil, "startedAt": .number(ago(7000)), "endedAt": .number(ago(6900)), "status": "done", "exitCode": 0],
        ]
        if state == "long" { list[0] = ["id": "k1", "kind": "command", "title": "Run the integration test suite for every package in the workspace with the slow database fixtures enabled and a very long description that goes on", "command": "pnpm -r test:integration", "sessionId": nil, "background": true, "loop": nil, "startedAt": .number(ago(86_000)), "endedAt": nil, "status": "running", "exitCode": nil] }
        return list
    }

    /// Messages added to the demo conversation so the Plan panel has a plan.
    static var extraMessages: [JSON] {
        guard state == "plan" else { return [] }
        let plan = "## Wait for the port before the first request\n\nThe health test starts the server and sends its request in the same tick, so on a slow machine the request lands before the port is open.\n\n1. Make `start()` async and resolve once the server is listening.\n2. Add `waitForPort(server, timeout)` for tests that start a server another way.\n3. Update the three tests that call `start()` to `await` it.\n\n```ts\nexport async function start() {\n  const server = http.createServer(handler);\n  await new Promise((resolve) => server.listen(0, resolve));\n  return server;\n}\n```\n\nNothing outside `src/` and `test/` changes."
        return [["id": "plan1", "role": "assistant", "kind": "normal", "parts": [["type": "tool_call", "id": "pc1", "name": "ExitPlanMode", "input": ["plan": .string(plan)]]], "error": nil]]
    }

    // MARK: State that changes while the demo runs

    nonisolated(unsafe) private static var prefs: JSON = [
        "code": ["font": "", "syntaxTheme": ["light": "atelier-light", "dark": "atelier-dark"], "transcriptView": "normal", "suggestions": true, "permanentGoalMode": false, "explainChanges": false],
        "appearance": ["interfaceFont": "sans"],
        "git": ["authorName": "Maya Lindqvist", "authorEmail": ""],
        "permissions": ["allow": ["Bash(git status *)", "Bash(npm test *)", "Edit(/docs/**)"]],
        "models": [:],
    ]
    nonisolated(unsafe) private static var settings: JSON = [
        "permissions": ["defaultMode": "auto", "allow": ["Bash(npm test *)", "Bash(git status *)"], "ask": ["Bash(git push *)"], "deny": ["Read(./.env)", "Bash(rm *)"], "additionalDirectories": ["/srv/shared"]],
        "compat": ["claudeCode": true], "ultracode": ["enabled": true], "checkpoints": ["retentionDays": 30], "hooks": [:],
        "cloud": ["github": ["clientId": "Iv1.demo"]],
    ]
    nonisolated(unsafe) private static var instructions = "# Conventions\n\n- Use pnpm, not npm.\n- Run the tests before you commit.\n"
    nonisolated(unsafe) private static var githubConnected = true
    nonisolated(unsafe) private static var polls = 0
    nonisolated(unsafe) private static var codespaceStates: [String: String] = ["fuzzy-space-guacamole-x7": "Available", "scenic-umbrella-p9": "Shutdown"]
    nonisolated(unsafe) private static var connections: [JSON] = [
        ["id": "c1", "name": "Build box", "host": "build-box", "port": nil, "keyPath": nil, "folder": "~/projects", "passwordSaved": true],
        ["id": "c2", "name": "Home server", "host": "maya@home.example.net", "port": 2222, "keyPath": "~/.ssh/id_ed25519", "folder": nil, "passwordSaved": false],
    ]

    private static func set(_ node: JSON, _ path: [String], _ value: JSON) -> JSON { CodeJSONPath.setting(node, path, value) }
    private static func path(_ params: [String: JSON]) -> [String] { params["path"]?.array.map(\.string) ?? [] }

    private static func codespace(_ name: String, _ repo: String, _ display: String) -> JSON {
        ["name": .string(name), "displayName": .string(display), "repo": .string(repo), "state": .string(codespaceStates[name] ?? "Available"), "machine": "standardLinux32gb", "idleTimeoutMinutes": 30, "lastUsedAt": .number(ago(5400)), "root": .string("/workspaces/\(repo.split(separator: "/").last ?? "")")]
    }

    private static let logo = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAACn0lEQVR42u3QWVITUBCF4d6ZCILMQ0gEjaJJBEVRFAQnEEXXhigzAQREF+GTVb54q0LerL6S7r4Ddar+BZzz0c9PNcREPz5WEROAvECrFcQEIB/Q2WoFMdHZh3uICUAAEgJ9f38XMQHIC7QygZgA5AM6XZlATHT67g5iAhCAhEAny7cRE4D8QGXERCdLZcREx0vlWP35/ev/izWSjt/eCtyFXP4hFXYtZUQThYmyownMRN/e3LTOSKeR9XjKlyYMkwMaNyqYTtPI5AUdvR63KLBOI4sjdGl0jIwc0JhuEXWaRpp36OjVmGLRdc6N9B4ByAd0+PKGVonoNNI6RZdSR9HIAZVUShJI4RcdLpbkJahzbiS+RgeLJXnJAsmvOaCisGR1mkaid3SwUBSWOpDsHdUXisISBxK+c0CjkhLXaRq1fpDqL0Yl5QEkOOiACpIyAWr9INXnC5LyABIcpP35gqQsgCQHHdCIpEyAWj9I+3MjkvIAEhwEkA9ob25YUhZAkoO093xYUh5AgoMOaEhSJkCtHwSQD2j32ZCkLIAkBx3QoKRMgFo/SLuzg5LyABIclAKlbyR8RzuzA8ISBxK+o52nA8JSB5K9c0D98hLWkV4DkA9o+0m/SgnqqPxyQH0qJQmk8EsNKDUjrVO0PdOnWCo6eo9oa6ZXsUSAFB/R1uNe3eLrqN5xQD3qRdVR/mICFMvI4ghtPuoxKrCO0QsH1G1XQB2rC7ZAAZisx9PmdHeArHTsl9PG9PVgKdIE2xwUSIUp8FraeNgVq4u5RBoZEyiL6OuDLsTkgDoRE4C8QFOdiIm+TF1DTADyAk12ICYA+YDWJzsQE63fb0dMAPIC1doRE32uXUVMAPICVdsQE4B8QGvVNsREa5UriAlAnv4CvpuCg1DejNIAAAAASUVORK5CYII="

    // MARK: The answers

    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        let failing: Set<String> = ["workspaces.list", "workspaces.files", "workspaces.gitStatus", "prefs.get", "settings.get", "github.status", "checkpoints.list", "ssh.list"]
        if state == "error", failing.contains(method) { throw MobileError.message("The server could not be reached. Check your connection and try again.") }
        if state == "unsupported", ["workspaces.files", "workspaces.gitStatus", "checkpoints.list", "github.status", "ssh.list", "instructions.get"].contains(method) { throw MobileError.message("Unknown method \(method)") }
        if state == "forbidden", ["settings.set", "settings.reset", "instructions.set", "instructions.get"].contains(method) { throw MobileError.message("forbidden") }

        switch method {
        // Folders
        case "workspaces.list": return .array(workspaces)
        case "account.devices": return [["id": "d1", "name": "Maya's MacBook Pro", "platform": "macOS", "current": false, "online": true], ["id": "d2", "name": "Mac mini", "platform": "macOS", "current": false, "online": false]]
        case "workspaces.trust": trusted.insert(params["id"]?.string ?? ""); return workspaces.first { $0["id"] == params["id"] } ?? .null
        case "workspaces.remove": removed.insert(params["id"]?.string ?? ""); return ["ok": true]
        case "workspaces.sshHosts": return ["build-box", "home", "staging"]
        case "workspaces.addSsh":
            let folder: JSON = ["id": .string("s\(extraFolders.count)"), "kind": "ssh", "name": .string(CodePath.name(params["path"]?.string ?? "folder")), "root": params["path"] ?? "/", "host": params["host"] ?? nil, "deviceId": nil, "available": true, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(0))]
            extraFolders.append(folder); return folder
        case "workspaces.addCodespace":
            trusted.insert("w3"); return workspaces.first { $0["id"] == "w3" } ?? .null
        case "ssh.list": return .array(connections)
        case "ssh.save":
            var saved = params; saved["passwordSaved"] = false
            if let id = params["id"]?.stringOrNil, let i = connections.firstIndex(where: { $0["id"].string == id }) { saved["passwordSaved"] = connections[i]["passwordSaved"]; connections[i] = .object(saved) }
            else { saved["id"] = .string("c\(connections.count + 1)"); connections.append(.object(saved)) }
            return .object(saved)
        case "ssh.test": return ["ok": true, "message": .string("Connected to \(params["host"]?.string ?? "the host") as maya.")]
        case "ssh.remove": connections.removeAll { $0["id"] == params["id"] }; return ["ok": true]
        case "ssh.forgetPassword":
            if let i = connections.firstIndex(where: { $0["id"] == params["id"] }) { connections[i] = connections[i].setting("passwordSaved", false) }
            return ["ok": true]
        case "ssh.browse":
            let path = params["path"]?.stringOrNil ?? "/home/maya"
            let dirs: [String] = path == "/home/maya" ? ["projects", "notes", "work"] : path.hasSuffix("projects") ? ["api", "web", "infra"] : []
            return ["path": .string(path), "home": "/home/maya", "dirs": .array(dirs.map(JSON.string))]
        case "ssh.mkdir": return ["path": .string("\(params["parent"]?.string ?? "")/\(params["name"]?.string ?? "")")]
        case "ssh.answer": return ["ok": true]

        // Files
        case "workspaces.files": return .array(state == "clean" ? [] : entries(params["dir"]?.string ?? ""))
        case "workspaces.findFiles":
            let q = (params["query"]?.string ?? "").lowercased()
            return .array(allPaths.filter { q.isEmpty || $0.lowercased().contains(q) }.map(JSON.string))
        case "workspaces.readFile": return fileContent(params["path"]?.string ?? "")
        case "workspaces.fileBytes": return ["dataBase64": .string(logo), "mime": "image/png", "size": 1432]
        case "workspaces.grep":
            let q = params["query"]?.string ?? ""
            if state == "clean" || q.lowercased() == "zzz" { return ["matches": [], "truncated": false] }
            return ["matches": [["path": "src/server.ts", "line": 6, "text": "  const server = http.createServer(handler);"], ["path": "src/server.ts", "line": 7, "text": "  await new Promise((resolve) => server.listen(port, resolve));"], ["path": "test/server.test.ts", "line": 12, "text": "  const server = await start();"]], "truncated": false]

        // Git
        case "workspaces.gitStatus": return gitStatus
        case "workspaces.diff": return ["diff": .string(diff(params["compare"]?.string ?? "head")), "truncated": false, "base": "HEAD"]
        case "git.branches": return ["current": "feature/wait-for-port", "branches": ["main", "feature/wait-for-port", "fix/flaky-health-test", "release/0.10"], "lastCommit": "Wait for the port before the first request", "defaultBranch": "main"]
        case "git.checkout", "git.stage", "git.revertHunk": return ["ok": true]
        case "git.commit":
            if state == "error" { throw MobileError.message("Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email \"you@example.com\"") }
            return ["commit": "a1b2c3d"]
        case "git.push":
            if state == "error" { throw MobileError.message("To github.com:example/atelier-web.git\n ! [rejected]        feature/wait-for-port -> feature/wait-for-port (non-fast-forward)\nerror: failed to push some refs") }
            return ["ok": true]
        case "git.pullRequest": return ["url": "https://github.com/example/atelier-web/pull/412"]

        // Terminals
        case "terminals.open":
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(250))
                let welcome = "Last login: Tue Nov 17 09:41:12 on ttys003\r\n\(prompt)git status\r\nOn branch \u{1B}[32mfeature/wait-for-port\u{1B}[0m\r\nYour branch is ahead of 'origin/feature/wait-for-port' by 2 commits.\r\n\r\nChanges not staged for commit:\r\n\t\u{1B}[31mmodified:   src/server.ts\u{1B}[0m\r\n\r\nUntracked files:\r\n\t\u{1B}[31mnotes.txt\u{1B}[0m\r\n\r\n\(prompt)"
                CodeEvents.shared.emit("terminals.data", ["terminalId": "t1", "data": .string(welcome)])
            }
            return ["terminalId": "t1"]
        case "terminals.write": shell(params["data"]?.string ?? "", params["terminalId"]?.string ?? "t1"); return ["ok": true]
        case "terminals.resize", "terminals.close": return ["ok": true]
        case "terminals.attach": return ["data": "", "truncated": false]

        // Tasks, loops, checkpoints
        case "tasks.output":
            let since = params["since"]?.int ?? 0
            let text = "> atelier-web@0.10.1 dev\n> vite --host\n\n  VITE v6.0.3  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.20:5173/\n  \u{2713} hmr update /src/server.ts\n"
            let id = params["taskId"]?.string ?? ""
            let out = id == "k4" ? "FAIL  test/server.test.ts > health answers while starting\nError: Timed out after 5000 ms\n  ❯ waitForPort src/server.ts:31:15\n\nTest Files  1 failed | 3 passed (4)\n" : text
            return ["output": .string(since == 0 ? out : ""), "offset": .number(Double(out.utf16.count)), "truncated": false, "running": .bool(id == "k1"), "exitCode": id == "k4" ? 1 : nil]
        case "tasks.stop", "tasks.clear": return ["ok": true]
        case "loops.start": return ["taskId": "k9", "intervalMs": .number(max(60_000, Double(params["intervalMs"]?.int ?? 60_000)))]
        case "loops.stop": return ["stopped": 1]
        case "checkpoints.list":
            if state == "empty" || state == "clean" { return [] }
            return [["messageId": "u1", "paths": ["/repo/test/server.test.js", "/repo/src/server.js"]]]
        case "checkpoints.rewind": return ["restored": ["/repo/src/server.js"], "snapshot": .null]
        case "sessions.subscribe" where params["id"]?.string == "agent1":
            return ["session": ["id": "agent1", "status": "running", "title": "Review the settings migration", "model": "anthropic/sonnet"], "seq": 4,
                    "messages": [["id": "m1", "role": "user", "kind": "normal", "parts": [["type": "text", "text": "Review the settings migration in packages/core for missing defaults and report what you find."]], "error": nil],
                                 ["id": "m2", "role": "assistant", "kind": "normal", "parts": [["type": "text", "text": "I'll start with the schema and the migration itself."], ["type": "tool_call", "id": "ac1", "name": "Read", "input": ["file_path": "/repo/packages/core/src/store/schema.ts"]], ["type": "tool_call", "id": "ac2", "name": "Grep", "input": ["pattern": "migrateSettings"]], ["type": "text", "text": "Two settings had no default: `checkpoints.retentionDays` and `ultracode.enabled`."]], "error": nil]],
                    "pending": nil, "todos": [], "tasks": [], "toolOutput": [:], "context": nil, "compacting": false, "queued": nil, "phase": nil, "outbox": []]
        case "sessions.unsubscribe": return ["ok": true]

        // Sessions
        case "sessions.create":
            if state == "error" { throw MobileError.message("This server does not run commands on its own machine. Open the desktop app to add a folder on your computer.") }
            return ["id": "new1", "mode": "code", "workspaceId": params["workspaceId"] ?? nil, "title": "", "status": "idle", "model": params["model"] ?? nil, "updatedAt": .number(ago(0))]
        case "sessions.update":
            var raw: [String: JSON] = ["id": params["id"] ?? "s2", "mode": "code", "title": "Fix the flaky e2e test", "status": "running", "model": "anthropic/opus", "updatedAt": .number(ago(30)), "workspaceId": "w1"]
            if let mode = params["permissionMode"] { raw["permissionMode"] = mode }
            return .object(raw)
        case "sessions.move": return ["pending": false]

        // Preferences and settings
        case "prefs.get": return prefs
        case "prefs.set": prefs = set(prefs, path(params), params["value"] ?? .null); return prefs
        case "settings.get": return ["effective": settings, "origins": [:], "projectRoot": nil, "errors": []]
        case "settings.set": settings = set(settings, path(params), params["value"] ?? .null); return ["ok": true]
        case "settings.reset": settings = set(settings, path(params), .string("")); return ["ok": true]
        case "instructions.get": return ["content": .string(instructions)]
        case "instructions.set": instructions = params["content"]?.string ?? ""; return ["ok": true]

        // GitHub and codespaces
        case "github.status": return state == "disconnected" || !githubConnected ? ["connected": false] : ["connected": true, "login": "octocat"]
        case "github.connectToken":
            if (params["token"]?.string ?? "").hasPrefix("bad") { throw MobileError.message("GitHub did not accept this token.") }
            githubConnected = true; return ["connected": true, "login": "octocat"]
        case "github.deviceStart": polls = 0; return ["flowId": "flow1", "userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device", "interval": 2]
        case "github.devicePoll": polls += 1; if polls >= 3 { githubConnected = true; return ["status": "connected", "login": "octocat"] }; return ["status": "pending", "interval": 2]
        case "github.disconnect": githubConnected = false; return ["ok": true]
        case "github.repos":
            if state == "empty" { return [] }
            return [["fullName": "example/atelier-web", "private": true, "defaultBranch": "main", "pushedAt": .number(ago(3600))], ["fullName": "example/mobile-app", "private": false, "defaultBranch": "main", "pushedAt": .number(ago(86400))], ["fullName": "example/api", "private": true, "defaultBranch": "main", "pushedAt": .number(ago(5 * 86400))], ["fullName": "mayab/dotfiles", "private": false, "defaultBranch": "main", "pushedAt": .number(ago(40 * 86400))]]
        case "codespaces.list":
            if state == "empty" { return [] }
            return [codespace("fuzzy-space-guacamole-x7", "example/mobile-app", "fuzzy space guacamole"), codespace("scenic-umbrella-p9", "example/atelier-web", "scenic umbrella")]
        case "codespaces.machines": return [["name": "basicLinux32gb", "displayName": "2-core · 8 GB RAM · 32 GB storage", "cpus": 2, "memoryBytes": 8_589_934_592], ["name": "standardLinux32gb", "displayName": "4-core · 16 GB RAM · 32 GB storage", "cpus": 4, "memoryBytes": 17_179_869_184]]
        case "codespaces.create": return codespace("new-codespace-q1", params["repo"]?.string ?? "example/app", "new codespace")
        case "codespaces.open": return ["id": "w3", "kind": "codespace", "name": "mobile-app", "root": "/workspaces/mobile-app", "host": "fuzzy-space-guacamole-x7", "deviceId": nil, "available": true, "scratch": false, "trusted": true, "lastUsedAt": .number(ago(0))]
        case "codespaces.start": codespaceStates[params["name"]?.string ?? ""] = "Available"; return ["ok": true]
        case "codespaces.stop": codespaceStates[params["name"]?.string ?? ""] = "Shutdown"; return ["ok": true]
        case "codespaces.delete": return ["ok": true]
        default: return nil
        }
    }
    #else
    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? { nil }
    #endif
}
