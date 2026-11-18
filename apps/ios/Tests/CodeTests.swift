import XCTest
import SwiftUI
@testable import Atelier

// The logic of Code mode: diffs, the terminal, rules, plans, intervals and the small formats the screens show.

final class CodeDiffTests: XCTestCase {
    private let diff = """
    diff --git a/src/server.ts b/src/server.ts
    index 9a8b7c6..1d2e3f4 100644
    --- a/src/server.ts
    +++ b/src/server.ts
    @@ -2,4 +2,5 @@ import http from 'node:http';
     import { sleep } from './util.ts';
    -export function start() {
    +export async function start() {
    +  await sleep(1);
       return 1;
     }
    @@ -20,2 +21,3 @@ function handler() {
       res.end();
     }
    +// end
    diff --git a/logo.png b/logo.png
    index 1111111..2222222 100644
    Binary files a/logo.png and b/logo.png differ
    diff --git a/new.txt b/new.txt
    new file mode 100644
    index 0000000..3b4c5d6
    --- /dev/null
    +++ b/new.txt
    @@ -0,0 +1 @@
    +hello
    """

    func testFilesHunksAndCounts() {
        let files = CodeDiff.parse(diff)
        XCTAssertEqual(files.map(\.path), ["src/server.ts", "logo.png", "new.txt"])
        XCTAssertEqual(files[0].added, 3)
        XCTAssertEqual(files[0].removed, 1)
        XCTAssertEqual(files[0].hunks.count, 2)
        XCTAssertTrue(files[1].binary)
        XCTAssertEqual(files[2].status, .added)
        XCTAssertEqual(files[0].status, .modified)
    }

    func testLineNumbersFollowEachSide() {
        let rows = CodeDiff.parse(diff)[0].rows
        let numbered = rows.filter { $0.kind != .hunk }.map { ($0.kind, $0.line) }
        // The old file's line for a removal, the new file's for everything else.
        XCTAssertEqual(numbered[0].1, 2)   // context
        XCTAssertEqual(numbered[1].1, 3)   // removed: old line 3
        XCTAssertEqual(numbered[2].1, 3)   // added: new line 3
        XCTAssertEqual(numbered[3].1, 4)   // added
        XCTAssertEqual(numbered[4].1, 5)   // context
        XCTAssertEqual(rows.last?.line, 23)
    }

    func testHunkPatchIsTheHeaderPlusThatHunk() throws {
        let file = CodeDiff.parse(diff)[0]
        let patch = try XCTUnwrap(file.patch(forHunk: 1))
        XCTAssertTrue(patch.hasPrefix("diff --git a/src/server.ts b/src/server.ts\n"))
        XCTAssertTrue(patch.contains("+++ b/src/server.ts\n@@ -20,2 +21,3 @@"))
        XCTAssertFalse(patch.contains("export async function"))
        XCTAssertNil(file.patch(forHunk: 5))
    }

    func testHunkNumbers() {
        XCTAssertEqual(CodeDiff.hunkNumbers("@@ -12,7 +14,9 @@ func x()").old, 12)
        XCTAssertEqual(CodeDiff.hunkNumbers("@@ -12,7 +14,9 @@ func x()").new, 14)
        XCTAssertEqual(CodeDiff.hunkNumbers("@@ -0,0 +1 @@").new, 1)
    }

    func testCompareOptionsDependOnTheRepository() {
        XCTAssertEqual(CodeCompare.options(repo: false, branch: nil, defaultBranch: nil), [.session])
        XCTAssertEqual(CodeCompare.options(repo: true, branch: "main", defaultBranch: "main"), [.head, .staged, .session])
        XCTAssertEqual(CodeCompare.options(repo: true, branch: "feature/x", defaultBranch: "main"), [.head, .staged, .base, .session])
        XCTAssertEqual(CodeCompare.head.title(branch: "main", defaultBranch: "main"), "main → working tree")
        XCTAssertFalse(CodeCompare.staged.rejectable)
        XCTAssertTrue(CodeCompare.session.rejectable)
    }

    func testGitStatusFromTheServer() throws {
        XCTAssertNil(CodeGitStatus(.null))
        let status = try XCTUnwrap(CodeGitStatus(.obj(["branch": "main", "upstream": ["ahead": 2, "behind": 1], "files": [["path": "a.ts", "status": "conflicted", "staged": false], ["path": "b.ts", "status": "added", "staged": true]]])))
        XCTAssertEqual(status.ahead, 2)
        XCTAssertEqual(status.behind, 1)
        XCTAssertTrue(status.hasUpstream)
        XCTAssertEqual(status.stagedCount, 1)
        XCTAssertEqual(status.conflicts.map(\.path), ["a.ts"])
        XCTAssertEqual(status.files[0].letter, "!")
        let detached = try XCTUnwrap(CodeGitStatus(.obj(["branch": nil, "upstream": nil, "files": []])))
        XCTAssertNil(detached.branch)
        XCTAssertFalse(detached.hasUpstream)
    }
}

final class CodeTerminalTests: XCTestCase {
    func testPlainTextAndLineEnds() {
        var term = TerminalEmulator(cols: 20, rows: 5)
        term.feed("hello\r\nworld")
        XCTAssertEqual(term.text, "hello\nworld")
        XCTAssertEqual(term.cursorRow, 1)
        XCTAssertEqual(term.cursorCol, 5)
    }

    func testColorsAndStyles() {
        var term = TerminalEmulator(cols: 20, rows: 3)
        term.feed("\u{1B}[1;31mred\u{1B}[0m \u{1B}[38;5;208morange\u{1B}[0m \u{1B}[38;2;1;2;3mrgb\u{1B}[0m")
        let line = term.screen[0]
        XCTAssertEqual(line[0].style.fg, .indexed(1))
        XCTAssertTrue(line[0].style.bold)
        XCTAssertEqual(line[3].style, TermStyle())
        XCTAssertEqual(line[4].style.fg, .indexed(208))
        XCTAssertEqual(line[11].style.fg, .rgb(1, 2, 3))
    }

    func testCursorMovesAndErasing() {
        var term = TerminalEmulator(cols: 10, rows: 3)
        term.feed("abcdef\u{1B}[3D\u{1B}[K")
        XCTAssertEqual(term.text, "abc")
        term.feed("\u{1B}[2;3Hx")
        XCTAssertEqual(term.screen[1][2].char, "x")
        term.feed("\u{1B}[2J")
        XCTAssertEqual(term.text, "")
        term.feed("\u{1B}[HHi\u{1B}[1;1H\u{1B}[2P")
        XCTAssertEqual(term.text, "")
    }

    func testPromptRedrawWithCarriageReturnAndBackspace() {
        var term = TerminalEmulator(cols: 20, rows: 3)
        term.feed("$ ls\u{8}\u{1B}[K")
        term.feed("\r$ git status")
        XCTAssertEqual(term.text, "$ git status")
    }

    func testScrollingKeepsTheLinesThatLeaveTheScreen() {
        var term = TerminalEmulator(cols: 10, rows: 3)
        term.feed("1\r\n2\r\n3\r\n4\r\n5")
        XCTAssertEqual(term.scrollback.count, 2)
        XCTAssertEqual(term.lines.map(TerminalEmulator.text), ["1", "2", "3", "4", "5"])
        XCTAssertEqual(term.cursorLine, 4)
    }

    func testWrapAtTheLastColumn() {
        var term = TerminalEmulator(cols: 5, rows: 3)
        term.feed("abcdefg")
        XCTAssertEqual(term.screen.map(TerminalEmulator.text).prefix(2), ["abcde", "fg"])
    }

    func testAlternateScreenComesAndGoes() {
        var term = TerminalEmulator(cols: 10, rows: 3)
        term.feed("shell")
        term.feed("\u{1B}[?1049h\u{1B}[Hvim")
        XCTAssertTrue(term.inAlternateScreen)
        XCTAssertEqual(term.text, "vim")
        term.feed("\u{1B}[?1049l")
        XCTAssertFalse(term.inAlternateScreen)
        XCTAssertEqual(term.text, "shell")
    }

    func testASequenceCutInTwoPicksUp() {
        var term = TerminalEmulator(cols: 10, rows: 2)
        term.feed("a\u{1B}[3")
        term.feed("1mb")
        XCTAssertEqual(term.screen[0][1].style.fg, .indexed(1))
        XCTAssertEqual(term.text, "ab")
    }

    func testTitleCursorVisibilityAndApplicationKeys() {
        var term = TerminalEmulator(cols: 10, rows: 2)
        term.feed("\u{1B}]0;build\u{7}\u{1B}[?25l\u{1B}[?1h")
        XCTAssertEqual(term.title, "build")
        XCTAssertFalse(term.cursorVisible)
        XCTAssertTrue(term.applicationCursor)
        XCTAssertEqual(TerminalKey.up.sequence(applicationCursor: true), "\u{1B}OA")
        XCTAssertEqual(TerminalKey.up.sequence(applicationCursor: false), "\u{1B}[A")
    }

    func testScrollRegionAndLineInsertion() {
        var term = TerminalEmulator(cols: 5, rows: 4)
        term.feed("a\r\nb\r\nc\r\nd")
        term.feed("\u{1B}[2;3r\u{1B}[3;1H\n")
        // Inside the region the second and third lines scroll; the first and last stay.
        XCTAssertEqual(term.screen.map(TerminalEmulator.text), ["a", "c", "", "d"])
        term.feed("\u{1B}[r\u{1B}[2;1H\u{1B}[L")
        XCTAssertEqual(term.screen.map(TerminalEmulator.text), ["a", "", "c", ""])
    }

    func testResizeKeepsTheCursorOnScreen() {
        var term = TerminalEmulator(cols: 10, rows: 6)
        term.feed("a\r\nb\r\nc")
        term.resize(cols: 8, rows: 3)
        XCTAssertEqual(term.rows, 3)
        XCTAssertEqual(term.screen.count, 3)
        XCTAssertLessThan(term.cursorRow, 3)
        XCTAssertEqual(term.lines.map(TerminalEmulator.text).filter { !$0.isEmpty }, ["a", "b", "c"])
    }

    func testWideCharactersTakeTwoCells() {
        var term = TerminalEmulator(cols: 6, rows: 2)
        term.feed("a漢b")
        XCTAssertEqual(term.screen[0][1].char, "漢")
        XCTAssertTrue(term.screen[0][2].tail)
        XCTAssertEqual(term.screen[0][3].char, "b")
        XCTAssertEqual(term.text, "a漢b")
    }

    func testControlKeys() {
        XCTAssertEqual(TerminalKey.control("c"), "\u{03}")
        XCTAssertEqual(TerminalKey.control("D"), "\u{04}")
        XCTAssertEqual(TerminalKey.control("["), "\u{1B}")
        XCTAssertNil(TerminalKey.control("5"))
        XCTAssertEqual(TerminalKey.enter.sequence(applicationCursor: false), "\r")
    }
}

final class CodeRulesTests: XCTestCase {
    func testRulesFollowClaudeCodeSyntax() {
        XCTAssertNil(CodeRules.error("Bash(npm test *)"))
        XCTAssertNil(CodeRules.error("Read(./.env)"))
        XCTAssertNil(CodeRules.error("mcp__github__create_issue"))
        XCTAssertNil(CodeRules.error("WebFetch(domain:example.com)"))
        XCTAssertNil(CodeRules.error("Bash"))
        XCTAssertNotNil(CodeRules.error("bash(ls)"))
        XCTAssertNotNil(CodeRules.error("WebFetch(example.com)"))
        XCTAssertNotNil(CodeRules.error("not a rule at all"))
        XCTAssertNotNil(CodeRules.error("Bash(unclosed"))
        XCTAssertNil(CodeRules.error("  "))
    }

    func testDirectoriesAreAbsolute() {
        XCTAssertNil(CodeRules.directoryError("/srv/shared"))
        XCTAssertNil(CodeRules.directoryError("C:\\Shared"))
        XCTAssertNil(CodeRules.directoryError("D:/Shared"))
        XCTAssertNil(CodeRules.directoryError("\\\\host\\share"))
        XCTAssertNotNil(CodeRules.directoryError("shared"))
        XCTAssertNotNil(CodeRules.directoryError("~/shared"))
    }

    func testPermissionModes() {
        XCTAssertEqual(CodeMode.offered(code: true, planAuto: false), [.auto, .ask, .acceptEdits, .plan, .bypass])
        XCTAssertEqual(CodeMode.offered(code: true, planAuto: true).count, 6)
        XCTAssertEqual(CodeMode.offered(code: false, planAuto: true), [.auto, .ask, .acceptEdits, .bypass])
        XCTAssertEqual(CodeMode.plan.forChat(), .ask)
        XCTAssertEqual(CodeMode.planAuto.forChat(), .auto)
        XCTAssertEqual(CodeMode(rawValue: "default"), .ask)
        XCTAssertEqual(CodeMode(rawValue: "bypassPermissions"), .bypass)
        XCTAssertTrue(CodeMode.planAuto.isPlan)
    }

    func testHooksAreReadBeforeTheyAreSaved() {
        XCTAssertNotNil(CodeHooks.parse("{}").value)
        XCTAssertEqual(CodeHooks.parse("not json").problem, "This isn't valid JSON.")
        XCTAssertNotNil(CodeHooks.parse("[]").problem)
        XCTAssertNotNil(CodeHooks.parse(#"{"PreToolUse": "x"}"#).problem)
        let text = #"{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo"}]}],"Notification":[{"hooks":[{"type":"command","command":"x"}]}],"Stop":[{"hooks":[{"type":"prompt"}]}]}"#
        XCTAssertNil(CodeHooks.parse(text).problem)
        XCTAssertEqual(CodeHooks.notes(text), ["Notification hooks don't run in Atelier.", "“prompt” hooks under Stop don't run in Atelier; only “command” hooks do."])
    }
}

final class CodeFormatTests: XCTestCase {
    func testIntervals() {
        XCTAssertEqual(CodeFormat.parseInterval("5m"), 300_000)
        XCTAssertEqual(CodeFormat.parseInterval("1h30m"), 5_400_000)
        XCTAssertEqual(CodeFormat.parseInterval("1d"), 86_400_000)
        XCTAssertEqual(CodeFormat.parseInterval("45s"), 45_000)
        XCTAssertNil(CodeFormat.parseInterval("soon"))
        XCTAssertNil(CodeFormat.parseInterval(""))
        XCTAssertEqual(CodeFormat.interval(300_000), "5m")
        XCTAssertEqual(CodeFormat.interval(5_400_000), "1h 30m")
        XCTAssertEqual(CodeFormat.interval(45_000), "45s")
        XCTAssertNil(CodeFormat.loopIntervalError("10m"))
        XCTAssertNotNil(CodeFormat.loopIntervalError("2d"))
        XCTAssertNotNil(CodeFormat.loopIntervalError("0s"))
        XCTAssertNotNil(CodeFormat.loopIntervalError("often"))
    }

    func testDurationsAndOutcomes() {
        XCTAssertEqual(CodeFormat.duration(12_000), "12s")
        XCTAssertEqual(CodeFormat.duration(2_436_000), "40m 36s")
        XCTAssertEqual(CodeFormat.duration(74_771_000), "20h 46m 11s")
        XCTAssertEqual(CodeFormat.outcome(status: "failed", exitCode: 1), "Exit code 1")
        XCTAssertEqual(CodeFormat.outcome(status: "stopped", exitCode: nil), "Stopped")
        XCTAssertEqual(CodeFormat.outcome(status: "done", exitCode: 0), "Done")
        XCTAssertEqual(CodeFormat.outcome(status: "running", exitCode: nil), "Running")
    }

    func testLoopScheduleReadsLikeTheDesktop() {
        let now = 1_000_000
        let task = CodeTask(raw: .obj(["id": "k", "kind": "loop", "title": "check", "status": "running", "startedAt": 0, "loop": ["intervalMs": 300_000, "runs": 3, "nextAt": .number(Double(now + 190_000)), "waiting": false]]))
        XCTAssertEqual(task.schedule(now: now), "Every 5m · 3 runs · next in 3m 10s")
        let waiting = CodeTask(raw: .obj(["id": "k", "kind": "loop", "title": "check", "status": "running", "startedAt": 0, "loop": ["intervalMs": 60_000, "runs": 1, "nextAt": nil, "waiting": true]]))
        XCTAssertEqual(waiting.schedule(now: now), "Every 1m · 1 run · next once the session is idle")
        XCTAssertEqual(task.duration(now: 61_000), "1m 1s")
    }

    func testCodespaceStates() {
        XCTAssertEqual(CodeFormat.codespaceState("Available").0, "Running")
        XCTAssertEqual(CodeFormat.codespaceState("Shutdown").0, "Stopped")
        XCTAssertEqual(CodeFormat.codespaceState("Weird").0, "Weird")
        XCTAssertTrue(CodeFormat.codespaceSettled("Shutdown"))
        XCTAssertFalse(CodeFormat.codespaceSettled("Starting"))
    }

    func testRepositoryNamesFromPastedAddresses() {
        XCTAssertEqual(CodeNewCodespaceSheet.name(" https://github.com/example/app.git "), "example/app")
        XCTAssertEqual(CodeNewCodespaceSheet.name("example/app/"), "example/app")
        XCTAssertEqual(CodeNewCodespaceSheet.name("example/app"), "example/app")
    }

    func testRemoteFolderCrumbs() {
        let below = CodeRemoteFolderBrowser.crumbs(path: "/home/me/projects/api", home: "/home/me")
        XCTAssertEqual(below.map(\.label), ["me", "projects", "api"])
        XCTAssertEqual(below.map(\.path), ["/home/me", "/home/me/projects", "/home/me/projects/api"])
        let outside = CodeRemoteFolderBrowser.crumbs(path: "/srv/api", home: "/home/me")
        XCTAssertEqual(outside.map(\.path), ["/", "/srv", "/srv/api"])
    }

    func testErrorsInWords() {
        XCTAssertEqual(CodeFailure.words(MobileError.message("Unknown method workspaces.files")), "This server doesn't support this yet.")
        XCTAssertEqual(CodeFailure.words(MobileError.message("forbidden")), "You don't have access to this.")
        XCTAssertEqual(CodeFailure.words(MobileError.message("This folder's computer is offline.")), "This folder's computer is offline.")
        XCTAssertTrue(CodeFailure.isUnsupported(MobileError.message("Unknown method x")))
    }
}

final class CodePlanTests: XCTestCase {
    private func assistant(_ plan: String, id: String = "c1") -> JSON { .obj(["id": "a1", "role": "assistant", "parts": [["type": "tool_call", "id": .string(id), "name": "ExitPlanMode", "input": ["plan": .string(plan)]]]]) }
    private func result(_ id: String, error: Bool, text: String = "ok") -> JSON { .obj(["id": "t1", "role": "tool", "parts": [["type": "tool_result", "callId": .string(id), "content": [["type": "text", "text": .string(text)]], "isError": .bool(error)]]]) }

    func testThePlanAndWhereItStands() {
        XCTAssertNil(CodePlan.latest([]))
        XCTAssertEqual(CodePlan.latest([assistant("Do it")])?.status, .waiting)
        XCTAssertEqual(CodePlan.latest([assistant("")])?.status, .writing)
        XCTAssertEqual(CodePlan.latest([assistant("Do it"), result("c1", error: false)])?.status, .approved)
        XCTAssertEqual(CodePlan.latest([assistant("Do it"), result("c1", error: true)])?.status, .declined)
        // Called outside plan mode: nothing was up for approval.
        XCTAssertNil(CodePlan.latest([assistant("Do it"), result("c1", error: false, text: CodePlan.modeOff)]))
    }

    func testTheNewestPlanWins() {
        let list = [assistant("old", id: "c1"), result("c1", error: false), assistant("new", id: "c2")]
        XCTAssertEqual(CodePlan.latest(list)?.plan, "new")
        XCTAssertEqual(CodePlan.latest(list)?.status, .waiting)
    }

    func testBlocksKeepFencedCodeWhole() {
        let plan = "## Step\n\nFirst paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n- two"
        XCTAssertEqual(CodePlan.blocks(plan), ["## Step", "First paragraph.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "- one\n- two"])
    }

    func testRevisionMessage() {
        XCTAssertNil(CodePlan.revisionMessage(feedback: "  ", comments: []))
        XCTAssertEqual(CodePlan.revisionMessage(feedback: "Use pnpm", comments: []), "Use pnpm")
        let message = CodePlan.revisionMessage(feedback: "Mostly fine", comments: [("Step   two", "Too vague")])
        XCTAssertEqual(message, "Mostly fine\n\nComments on the plan:\n- On “Step two”: Too vague")
        XCTAssertLessThanOrEqual(CodePlan.revisionMessage(feedback: String(repeating: "x", count: 5000), comments: [])?.count ?? 0, 2000)
    }
}

final class CodeModelTests: XCTestCase {
    func testAFolderAsTheServerListsIt() {
        let ssh = CodeWorkspace(.obj(["id": "w2", "kind": "ssh", "name": "api", "root": "/srv/api", "host": "build-box", "deviceId": nil, "available": true, "scratch": false, "lastUsedAt": 5]))
        XCTAssertEqual(ssh.label, "build-box:/srv/api")
        XCTAssertEqual(ssh.kindBadge, "SSH")
        XCTAssertTrue(ssh.trusted, "an older server that doesn't say applies everything the folder brings")
        let untrusted = CodeWorkspace(.obj(["id": "w3", "kind": "codespace", "name": "app", "root": "/workspaces/app", "host": "fuzzy", "available": true, "scratch": false, "trusted": false, "lastUsedAt": 1]))
        XCTAssertFalse(untrusted.trusted)
        XCTAssertEqual(untrusted.computer(devices: []), "Codespace fuzzy")
        let local = CodeWorkspace(.obj(["id": "w1", "kind": "local", "name": "web", "root": "/Users/me/web", "deviceId": "d1", "available": false, "scratch": false, "lastUsedAt": 9]))
        XCTAssertEqual(local.computer(devices: [.obj(["id": "d1", "name": "MacBook"])]), "MacBook")
        XCTAssertEqual(local.computer(devices: []), "A removed device")
        let scratch = CodeWorkspace(.obj(["id": "w5", "kind": "local", "name": "scratch-1", "root": "/x", "scratch": true]))
        XCTAssertEqual(scratch.label, "No folder")
        XCTAssertEqual(CodeWorkspace.recent([ssh, untrusted, local]).map(\.id), ["local" == "x" ? "" : "w1", "w2", "w3"])
    }

    func testPathsAndLanguages() {
        XCTAssertEqual(CodePath.name("src/components/Button.tsx"), "Button.tsx")
        XCTAssertEqual(CodePath.directory("src/components/Button.tsx"), "src/components")
        XCTAssertEqual(CodePath.directory("README.md"), "")
        XCTAssertEqual(CodePath.language("a/b.tsx"), "typescript")
        XCTAssertEqual(CodePath.language("Dockerfile"), "dockerfile")
        XCTAssertNil(CodePath.language("notes.xyz"))
        XCTAssertTrue(CodePath.isImage("logo.PNG"))
        XCTAssertFalse(CodePath.isImage("logo.svg"))
        XCTAssertEqual(CodePath.symbol("a.json"), "curlybraces")
    }

    func testGrepResultsGroupByFileInOrder() {
        let files = CodeGrepFile.group([.obj(["path": "b.ts", "line": 3, "text": "x"]), .obj(["path": "a.ts", "line": 1, "text": "y"]), .obj(["path": "b.ts", "line": 9, "text": "z"])])
        XCTAssertEqual(files.map(\.path), ["b.ts", "a.ts"])
        XCTAssertEqual(files[0].lines.map(\.line), [3, 9])
    }

    func testBackgroundTasksReadFromTheSnapshot() {
        let task = CodeTask(raw: .obj(["id": "k4", "kind": "command", "title": "pnpm test", "command": "pnpm test", "status": "failed", "exitCode": 1, "startedAt": 1000, "endedAt": 61_000, "background": false]))
        XCTAssertFalse(task.running)
        XCTAssertEqual(task.outcome, "Exit code 1")
        XCTAssertEqual(task.duration(now: 999_999), "1m 0s")
        XCTAssertEqual(task.kindLabel, "Command")
        XCTAssertEqual(task.openLabel, "View output")
    }

    func testToolLinesSummarizeTheCall() {
        XCTAssertEqual(CodeToolLine.summary(.obj(["name": "Read", "input": ["file_path": "/repo/src/a.ts"]])).target, "a.ts")
        XCTAssertEqual(CodeToolLine.summary(.obj(["name": "Bash", "input": ["command": "pnpm test\nsecond", "description": ""]])).target, "pnpm test")
        XCTAssertEqual(CodeToolLine.summary(.obj(["name": "Grep", "input": ["pattern": "listen\\("]])).verb, "Searched for")
    }

    func testSettingAValueByItsPath() {
        let start: JSON = .obj(["code": ["font": "", "syntaxTheme": ["light": "a", "dark": "b"]]])
        let next = CodeJSONPath.setting(start, ["code", "syntaxTheme", "dark"], "nord")
        XCTAssertEqual(next["code"]["syntaxTheme"]["dark"].string, "nord")
        XCTAssertEqual(next["code"]["syntaxTheme"]["light"].string, "a")
        XCTAssertEqual(CodeJSONPath.setting(.null, ["a", "b"], 1)["a"]["b"].int, 1)
    }
}

final class CodeSyntaxTests: XCTestCase {
    private func roles(_ line: String, language: String) -> [String: Color] {
        let theme = CodeSyntaxTheme.resolve("atelier-light", dark: false)
        let text = CodeSyntax.highlight([line], language: language, theme: theme)[0]
        var out: [String: Color] = [:]
        for run in text.runs { if let color = run.foregroundColor { out[String(text[run.range].characters)] = color } }
        return out
    }

    func testTextIsNeverChanged() {
        let source = ["const a = 'x' + 1; // note", "/* open", "still comment */ let b = `t`", "", "\tindented"]
        let theme = CodeSyntaxTheme.resolve("github-dark", dark: true)
        let lines = CodeSyntax.highlight(source, language: "typescript", theme: theme)
        XCTAssertEqual(lines.map { String($0.characters) }, source)
    }

    func testKeywordsStringsAndCommentsGetTheirOwnColors() {
        let theme = CodeSyntaxTheme.resolve("atelier-light", dark: false)
        let found = roles("const name = 'Hello'; // greet", language: "typescript")
        XCTAssertEqual(found["const"], theme.color(.keyword))
        XCTAssertEqual(found["'Hello'"], theme.color(.string))
        XCTAssertEqual(found["// greet"], theme.color(.comment))
    }

    func testBlockCommentsRunOverLines() {
        let theme = CodeSyntaxTheme.resolve("atelier-light", dark: false)
        let lines = CodeSyntax.highlight(["a /* start", "middle", "end */ b"], language: "javascript", theme: theme)
        XCTAssertEqual(lines[1].runs.first?.foregroundColor, theme.color(.comment))
    }

    func testUnknownLanguagesAndThemesFallBack() {
        let lines = CodeSyntax.highlight(["anything"], language: nil, theme: CodeSyntaxTheme.resolve("no-such-theme", dark: true))
        XCTAssertEqual(String(lines[0].characters), "anything")
        XCTAssertEqual(CodeSyntaxTheme.resolve("no-such-theme", dark: true).id, "atelier-dark")
        XCTAssertEqual(CodeSyntaxTheme.resolve("dracula", dark: false).id, "atelier-light", "a dark theme can't be the light one")
        XCTAssertEqual(CodeSyntaxTheme.label(forUnknown: "tokyo-night-storm"), "Tokyo Night Storm")
    }
}

#if DEBUG
/// The canned answers are in the shapes the screens read.
final class CodeDemoTests: XCTestCase {
    func testFoldersAndTheirStates() throws {
        let list = try XCTUnwrap(CodeDemo.respond("workspaces.list", [:])).array.map(CodeWorkspace.init)
        XCTAssertGreaterThanOrEqual(list.count, 4)
        XCTAssertTrue(list.contains { $0.kind == .codespace && !$0.trusted })
        XCTAssertTrue(list.contains { !$0.available })
        XCTAssertTrue(list.contains { $0.scratch })
    }

    func testTheDiffParsesIntoFiles() throws {
        let answer = try XCTUnwrap(CodeDemo.respond("workspaces.diff", ["compare": "head"]))
        let files = CodeDiff.parse(answer["diff"].string)
        XCTAssertEqual(files.map(\.path), ["README.md", "src/server.ts", "src/util.ts", "logo.png"])
        XCTAssertTrue(files.last?.binary == true)
    }

    func testStatusBranchesAndFiles() throws {
        let status = try XCTUnwrap(CodeGitStatus(try XCTUnwrap(CodeDemo.respond("workspaces.gitStatus", [:]))))
        XCTAssertEqual(status.ahead, 2)
        XCTAssertEqual(try XCTUnwrap(CodeDemo.respond("git.branches", [:]))["branches"].array.count, 4)
        let tree = try XCTUnwrap(CodeDemo.respond("workspaces.files", ["dir": ""])).array
        XCTAssertEqual(tree.first?["kind"].string, "dir")
    }

    func testTasksAreTheDesktopsThree() {
        XCTAssertEqual(Set(CodeDemo.tasks.map { CodeTask(raw: $0).kind }), ["command", "agent", "loop"])
    }

    func testWhatItDoesNotKnowIsNil() throws {
        XCTAssertNil(try CodeDemo.respond("not.a.method", [:]))
    }
}
#endif

// MARK: - Against a real backend with a runner

/// The Code screens' own models against a backend that runs a real folder (`harness/code-live.ts`): files, git, a shell,
/// preferences and settings. Skipped unless `TEST_RUNNER_ATELIER_CODE_SERVER` names that backend.
@MainActor final class CodeServerIntegrationTests: XCTestCase {
    private func until(_ seconds: Double = 10, _ condition: @MainActor () -> Bool) async -> Bool {
        let end = Date.now.addingTimeInterval(seconds)
        while Date.now < end { if condition() { return true }; try? await Task.sleep(for: .milliseconds(100)) }
        return condition()
    }

    func testCodeScreensAgainstARealFolder() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ATELIER_CODE_SERVER"], let user = env["ATELIER_CODE_USER"], let password = env["ATELIER_CODE_PASSWORD"] else {
            throw XCTSkip("Set ATELIER_CODE_SERVER to a runner-backed backend (apps/ios/scripts or harness/code-live) to run this")
        }
        let store = AppStore()
        store.address = address
        try await store.login(username: user, password: password)

        // Folders
        let folders = CodeFolders(store: store)
        await folders.load(devices: true)
        XCTAssertTrue(folders.didLoad)
        let demo = try XCTUnwrap(folders.folders.first { $0.name == "demo-repo" })
        XCTAssertTrue(demo.available)

        // Files and search
        let top = try await codeCall(store, "workspaces.files", ["workspaceId": .string(demo.id), "dir": ""]).array
        XCTAssertEqual(top.first?["kind"].string, "dir")
        let found = try await codeCall(store, "workspaces.findFiles", ["workspaceId": .string(demo.id), "query": "panel1"]).array.map(\.string)
        XCTAssertTrue(found.contains { $0.hasSuffix("Panel10.tsx") })
        let grep = CodeGrepFile.group(try await codeCall(store, "workspaces.grep", ["workspaceId": .string(demo.id), "query": "server"])["matches"].array)
        XCTAssertFalse(grep.isEmpty)
        let readme = try await codeCall(store, "workspaces.readFile", ["workspaceId": .string(demo.id), "path": "README.md"])
        XCTAssertNotNil(readme["content"].stringOrNil)
        let blob = try await codeCall(store, "workspaces.readFile", ["workspaceId": .string(demo.id), "path": "blob.bin"])
        XCTAssertNil(blob["content"].stringOrNil)
        let bytes = try await codeCall(store, "workspaces.fileBytes", ["workspaceId": .string(demo.id), "path": "logo.png"])
        XCTAssertNotNil(UIImage(data: try XCTUnwrap(Data(base64Encoded: bytes["dataBase64"].string))))

        // Changes: the model reads status and the diff, stages, rejects a hunk, commits
        let model = CodeChangesModel(store: store, workspaceId: demo.id, sessionId: nil)
        await model.reload()
        XCTAssertTrue(model.isRepo)
        XCTAssertEqual(model.status?.branch, "main")
        XCTAssertTrue(model.changed.contains { $0.path == "src/server.ts" && $0.staged == false })
        XCTAssertTrue(model.changed.contains { $0.path == "notes.txt" && $0.status == .untracked })
        XCTAssertEqual(model.options, [.head, .staged, .session], "on the default branch there is no base comparison")
        await model.stage(["notes.txt"], true)
        XCTAssertTrue(model.changed.contains { $0.path == "notes.txt" && $0.staged == true })
        await model.stage(["notes.txt"], false)
        XCTAssertNil(model.actionError)
        let server = try XCTUnwrap(model.files.first { $0.path == "src/server.ts" })
        XCTAssertGreaterThan(server.hunks.count, 0)
        await model.reject(server, hunk: 0)
        XCTAssertNil(model.actionError, model.actionError ?? "")
        XCTAssertFalse(model.changed.contains { $0.path == "src/server.ts" }, "rejecting the only hunk puts the file back")
        // The readme's edit was staged: it commits. Then nothing is staged, and git refuses in its own words.
        let committed = await model.commit("Update the readme")
        XCTAssertTrue(committed, model.actionError ?? "")
        XCTAssertFalse(model.changed.contains { $0.path == "README.md" })
        let again = await model.commit("Nothing left to commit")
        XCTAssertFalse(again)
        XCTAssertNotNil(model.actionError)
        await model.push()
        XCTAssertTrue(model.actionError?.contains("origin") == true, model.actionError ?? "")
        let branches = try XCTUnwrap(model.branches)
        XCTAssertTrue(branches.list.contains("feature/wait-for-port"))

        // A shell: type a command, read its output off the emulator
        let terminal = CodeTerminalModel(store: store, workspaceId: demo.id, directory: "src", title: "Terminal")
        await terminal.open(cols: 80, rows: 24)
        XCTAssertNotNil(terminal.terminalId)
        try await Task.sleep(for: .milliseconds(800))
        terminal.type("echo ios-$((40+2))\r")
        let echoed = await until(10) { terminal.emulator.text.contains("ios-42") }
        XCTAssertTrue(echoed, terminal.emulator.text)
        terminal.type("pwd\r")
        let inSrc = await until(10) { terminal.emulator.text.contains("/demo-repo/src") }
        XCTAssertTrue(inSrc, terminal.emulator.text)
        terminal.close()

        // Preferences and settings written and read back
        let prefs = CodePrefs(store: store)
        await prefs.load()
        XCTAssertTrue(prefs.loaded)
        let saved = await prefs.set(["code", "syntaxTheme", "dark"], "dracula")
        XCTAssertTrue(saved)
        XCTAssertEqual(prefs.string(["code", "syntaxTheme", "dark"]), "dracula")
        _ = await prefs.set(["git", "authorName"], "Phone Person")
        XCTAssertEqual(prefs.string(["git", "authorName"]), "Phone Person")
        let system = CodeSystemSettings(store: store)
        await system.load()
        XCTAssertTrue(system.loaded)
        let wrote = await system.set(["permissions", "deny"], .array(["Read(./.env)"]))
        XCTAssertTrue(wrote)
        XCTAssertEqual(system.list(["permissions", "deny"]), ["Read(./.env)"])
        _ = try await codeCall(store, "instructions.set", ["content": "# From the phone\n"])
        let instructions = try await codeCall(store, "instructions.get")
        XCTAssertEqual(instructions["content"].string, "# From the phone\n")

        // GitHub without an account: the refusals are sentences
        let github = CodeGitHub(store: store)
        await github.load()
        XCTAssertEqual(github.connected, false)
        let problem = await github.connect(token: "not-a-real-token-0123456789")
        XCTAssertNotNil(problem)

        // A session in the folder, then its permission mode changes
        let created = try await codeCall(store, "sessions.create", ["mode": "code", "model": "demo/demo-model", "workspaceId": .string(demo.id), "permissionMode": "plan"])
        XCTAssertEqual(created["workspaceId"].string, demo.id)
        let updated = try await codeCall(store, "sessions.update", ["id": created["id"], "permissionMode": "acceptEdits"])
        XCTAssertEqual(CodeMode(rawValue: updated["permissionMode"].string), .acceptEdits)
        _ = try await codeCall(store, "sessions.delete", ["id": created["id"]])
    }
}

final class CodeTargetTests: XCTestCase {
    private func folder(_ id: String, kind: String = "local", host: String? = nil, device: String? = nil, available: Bool = true, scratch: Bool = false, used: Int) -> CodeWorkspace {
        CodeWorkspace(.obj(["id": .string(id), "kind": .string(kind), "name": .string(id), "root": .string("/r/\(id)"), "host": host.map { .string($0) } ?? .null, "deviceId": device.map { .string($0) } ?? .null, "available": .bool(available), "scratch": .bool(scratch), "lastUsedAt": .number(Double(used))]))
    }
    private let devices: [JSON] = [.obj(["id": "d1", "name": "MacBook"]), .obj(["id": "d2", "name": "Mac mini"])]

    func testFoldersAreGroupedByTheirPlace() {
        let list = [
            folder("a", used: 1),
            folder("b", device: "d1", used: 9), folder("c", device: "d1", used: 8),
            folder("d", device: "d2", available: false, used: 7),
            folder("e", kind: "codespace", host: "fuzzy", used: 5),
            folder("f", kind: "ssh", host: "build-box", used: 4),
            folder("g", kind: "ssh", host: "build-box", device: "d1", used: 3),
            folder("scratch", device: "d1", scratch: true, used: 99),
        ]
        let targets = CodeTarget.targets(folders: list, devices: devices)
        XCTAssertEqual(targets.map(\.id), ["server", "device:d1", "device:d2", "cloud", "ssh:build-box"])
        XCTAssertEqual(targets.map(\.name), ["This server", "MacBook", "Mac mini", "Cloud", "build-box"])
        XCTAssertEqual(targets[1].folders.map(\.id), ["b", "c", "g"], "a computer's folders, an SSH host reached through it too, the latest first, no scratch folder")
        XCTAssertEqual(targets.map(\.online), [true, true, false, true, true])
        XCTAssertNil(targets[2].firstUsable)
    }

    func testTheServerAndTheCloudAreAlwaysOffered() {
        let targets = CodeTarget.targets(folders: [], devices: [])
        XCTAssertEqual(targets.map(\.id), ["server", "cloud"])
        XCTAssertTrue(targets.allSatisfy { $0.online && $0.folders.isEmpty })
    }

    func testReachableComputersComeBeforeOfflineOnes() {
        let list = [folder("x", device: "d2", available: false, used: 9), folder("y", device: "d1", used: 1)]
        XCTAssertEqual(CodeTarget.targets(folders: list, devices: devices).map(\.id), ["server", "device:d1", "device:d2", "cloud"])
    }

    func testWhereToStart() {
        let list = [folder("a", used: 1), folder("b", device: "d1", used: 9), folder("d", device: "d2", available: false, used: 20)]
        let targets = CodeTarget.targets(folders: list, devices: devices)
        XCTAssertEqual(CodeTarget.initial(targets, remembered: nil)?.id, "device:d1", "the latest folder that can be reached decides")
        XCTAssertEqual(CodeTarget.initial(targets, remembered: "server")?.id, "server", "the place used last, while it can be used")
        XCTAssertEqual(CodeTarget.initial(targets, remembered: "device:d2")?.id, "device:d1", "an offline place is not started in")
        XCTAssertEqual(CodeTarget.initial(targets, remembered: "gone")?.id, "device:d1")
        XCTAssertEqual(CodeTarget.initial(CodeTarget.targets(folders: [], devices: []), remembered: nil)?.id, "server")
    }
}

final class UltracodeChargeTests: XCTestCase {
    private let t0 = Date(timeIntervalSinceReferenceDate: 1000)
    private func at(_ seconds: Double) -> Date { t0.addingTimeInterval(seconds) }

    /// Frames at 30 a second, the slider on or off Ultracode over a stretch of time.
    private func run(_ charge: inout UltracodeCharge, from start: Double, to end: Double, lit: Bool) -> Double {
        var level = charge.level
        var time = start
        while time <= end + 1e-9 { level = charge.level(at: at(time), lit: lit); time += 1.0 / 30 }
        return level
    }

    func testItRisesWhileLitAndFallsToNothingOnceLeft() {
        var charge = UltracodeCharge()
        XCTAssertTrue(charge.isEmpty)
        XCTAssertEqual(run(&charge, from: 0, to: 0.7, lit: true), 1, accuracy: 0.05)
        XCTAssertFalse(charge.isEmpty)
        // Left: it falls over 0.85 seconds, and nothing of it is left after.
        XCTAssertGreaterThan(run(&charge, from: 0.72, to: 1.0, lit: false), 0.5)
        XCTAssertFalse(charge.isEmpty, "still showing while it falls")
        XCTAssertEqual(run(&charge, from: 1.03, to: 1.8, lit: false), 0, accuracy: 0.001)
        XCTAssertTrue(charge.isEmpty, "nothing of the field stays once the slider is off Ultracode")
    }

    func testAQuickBackAndForthDoesNotJump() {
        var charge = UltracodeCharge()
        let rising = run(&charge, from: 0, to: 0.35, lit: true)
        XCTAssertEqual(rising, 0.5, accuracy: 0.06)
        let fallen = run(&charge, from: 0.37, to: 0.57, lit: false)
        XCTAssertLessThan(fallen, rising)
        XCTAssertGreaterThan(fallen, 0.2, "it fell a little, not to nothing")
        let again = run(&charge, from: 0.6, to: 0.7, lit: true)
        XCTAssertGreaterThan(again, fallen, "it rises again from where it was")
        XCTAssertLessThan(again, 0.9, "and does not start over at full")
    }

    func testAPatternStartsFreshOnlyWhenChargedFromNothing() {
        var charge = UltracodeCharge()
        _ = charge.level(at: at(0), lit: true)
        let first = charge.waveStart
        XCTAssertEqual(first, at(0))
        _ = run(&charge, from: 0.03, to: 0.5, lit: true)
        _ = run(&charge, from: 0.53, to: 0.7, lit: false)
        _ = charge.level(at: at(0.73), lit: true)
        XCTAssertEqual(charge.waveStart, first, "left and back while it still glows: the same waves go on")
        _ = run(&charge, from: 0.76, to: 1.0, lit: true)
        _ = run(&charge, from: 1.03, to: 2.2, lit: false)
        XCTAssertNil(charge.waveStart, "faded to nothing: nothing of the old pattern")
        _ = charge.level(at: at(3), lit: true)
        XCTAssertEqual(charge.waveStart, at(3))
    }
}
