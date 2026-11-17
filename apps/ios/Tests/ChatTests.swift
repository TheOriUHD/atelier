import XCTest
import SwiftUI
@testable import Atelier

@MainActor final class ChatTests: XCTestCase {
    private func json(_ text: String) -> JSON { try! JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }

    // MARK: branches

    func testRetryReplacesTheOldBranchAndMakesVersions() {
        let messages = [
            json(#"{"id":"u","parentId":null,"role":"user","kind":"normal","parts":[]}"#),
            json(#"{"id":"a1","parentId":"u","role":"assistant","kind":"normal","parts":[]}"#),
            json(#"{"id":"t1","parentId":"a1","role":"tool","kind":"normal","parts":[]}"#),
            json(#"{"id":"a2","parentId":"u","role":"assistant","kind":"normal","parts":[]}"#),
            json(#"{"id":"a3","parentId":"u","role":"assistant","kind":"normal","parts":[]}"#),
        ]
        let branch = Branching.resolve(messages: messages, siblings: .object([:]))
        XCTAssertEqual(branch.messages.map { $0["id"].string }, ["u", "a3"])
        XCTAssertEqual(branch.siblings["a3"], ["a1", "a2", "a3"])
        XCTAssertNil(branch.siblings["u"])
    }

    func testASnapshotsOwnVersionsSurvive() {
        let siblings = json(#"{"a":["x","a"],"u":["u","u2"]}"#)
        let branch = Branching.resolve(messages: [json(#"{"id":"u","parentId":null}"#), json(#"{"id":"a","parentId":"u"}"#)], siblings: siblings)
        XCTAssertEqual(branch.messages.count, 2)
        XCTAssertEqual(branch.siblings["a"], ["x", "a"])
        XCTAssertEqual(branch.siblings["u"], ["u", "u2"])
    }

    func testACompactionSummaryIsNeverTakenForAVersion() {
        let messages = [
            json(#"{"id":"a","parentId":null,"kind":"normal"}"#),
            json(#"{"id":"s","parentId":"a","kind":"compaction_summary"}"#),
            json(#"{"id":"b","parentId":"a","kind":"normal"}"#),
        ]
        XCTAssertEqual(Branching.resolve(messages: messages, siblings: .null).messages.count, 3)
    }

    // MARK: effort

    func testEffortLevelsFollowTheModel() {
        let leveled = json(#"{"capabilities":{"reasoning":"effort"},"effortLevels":["low","medium","high"]}"#)
        XCTAssertEqual(ChatEffort.native(leveled), ["low", "medium", "high"])
        XCTAssertEqual(ChatEffort.choices(leveled, mode: "chat"), ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(ChatEffort.choices(leveled, mode: "code").last, "ultracode")
        XCTAssertEqual(ChatEffort.recommended(leveled, mode: "chat"), "medium")
        XCTAssertEqual(ChatEffort.shown("ultracode", model: leveled, mode: "chat"), "max")
        XCTAssertEqual(ChatEffort.shown("ultracode", model: leveled, mode: "code"), "ultracode")
        XCTAssertEqual(ChatEffort.shown(nil, model: leveled, mode: "chat"), "medium")
        XCTAssertEqual(ChatEffort.label("xhigh"), "Extra")
        XCTAssertEqual(ChatEffort.choices(leveled, mode: "code", ultracode: false).last, "max")
    }

    func testAModelWithFixedStopsOffersOnlyThose() {
        let fixed = json(#"{"capabilities":{"reasoning":"effort"},"effortStops":[{"effort":"low","label":"Instant"},{"effort":"high","label":"Pro","warning":"Slow"}]}"#)
        XCTAssertEqual(ChatEffort.choices(fixed, mode: "code"), ["low", "high"])
        XCTAssertEqual(ChatEffort.name("high", model: fixed), "Pro")
        XCTAssertEqual(ChatEffort.warning("high", model: fixed), "Slow")
    }

    func testEffortHelpSaysWhatTheModelIsAskedInstead() {
        let switchOnly = json(#"{"capabilities":{"reasoning":"toggle"}}"#)
        XCTAssertTrue(ChatEffort.explanation("high", model: switchOnly, mode: "chat").contains("Thinking is controlled separately"))
        XCTAssertTrue(ChatEffort.explanation("max", model: switchOnly, mode: "chat").contains("always on"))
    }

    // MARK: lists

    private func session(_ id: String, ago: TimeInterval, pinned: Bool = false, status: String = "idle", unseen: Bool = false, group: String? = nil) -> Conversation {
        Conversation(raw: .obj(["id": .string(id), "title": .string(id), "mode": "chat", "status": .string(status), "updatedAt": .number((Date.now.timeIntervalSince1970 - ago) * 1000), "createdAt": .number((Date.now.timeIntervalSince1970 - ago - 10) * 1000), "pinnedAt": pinned ? 1 : .null, "finishedUnseen": .bool(unseen), "groupId": group.map(JSON.string) ?? .null]))
    }

    func testTheListGroupsByDayAndPinsFirst() {
        let list = [session("new", ago: 60), session("old", ago: 40 * 86400), session("pin", ago: 5 * 86400, pinned: true), session("week", ago: 4 * 86400)]
        let arranged = ChatArrange.arrange(list, grouping: .date, sorting: .activity, groups: [], workspaces: [], showEmptyGroups: false)
        XCTAssertEqual(arranged.pinned.map(\.id), ["pin"])
        XCTAssertEqual(arranged.groups.map(\.title), ["Today", "Previous 7 days", "Older"])
    }

    func testTheListGroupsByStatusAndByTheirOwnGroups() {
        let list = [session("a", ago: 10, status: "waiting"), session("b", ago: 20, status: "running"), session("c", ago: 30, unseen: true), session("d", ago: 40, group: "g1")]
        let byState = ChatArrange.arrange(list, grouping: .state, sorting: .activity, groups: [], workspaces: [], showEmptyGroups: false)
        XCTAssertEqual(byState.groups.map(\.title), ["Needs your attention", "Running", "Finished", "Idle"])
        let groups: [JSON] = [.obj(["id": "g1", "name": "Work", "collapsed": false]), .obj(["id": "g2", "name": "Empty", "collapsed": true])]
        let custom = ChatArrange.arrange(list, grouping: .custom, sorting: .name, groups: groups, workspaces: [], showEmptyGroups: false)
        XCTAssertEqual(custom.groups.map(\.title), ["Work", "Ungrouped"])
        XCTAssertEqual(ChatArrange.arrange(list, grouping: .custom, sorting: .name, groups: groups, workspaces: [], showEmptyGroups: true).groups.map(\.title), ["Work", "Empty", "Ungrouped"])
        XCTAssertTrue(ChatArrange.arrange(list, grouping: .custom, sorting: .name, groups: groups, workspaces: [], showEmptyGroups: true).groups[1].collapsed)
    }

    func testDaysAreCalendarDays() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(ChatDayGroup.of(now.addingTimeInterval(-60), now: now), .today)
        XCTAssertEqual(ChatDayGroup.of(now.addingTimeInterval(-86400 * 8), now: now), .month)
        XCTAssertEqual(ChatDayGroup.of(now.addingTimeInterval(-86400 * 90), now: now), .older)
    }

    // MARK: models

    func testModelsAreGroupedByProviderAndByComputer() {
        let models = [
            json(#"{"ref":"a/x","providerId":"a","displayName":"X","hidden":false,"favorite":false,"order":2}"#),
            json(#"{"ref":"a/y","providerId":"a","displayName":"Y","hidden":false,"favorite":true,"order":3}"#),
            json(#"{"ref":"u/z","providerId":"u","displayName":"Z","hidden":false,"personal":{"deviceId":"d","deviceName":"Home desktop"},"available":false,"order":1}"#),
            json(#"{"ref":"a/h","providerId":"a","displayName":"Hidden","hidden":true}"#),
        ]
        let groups = ChatModels.groups(models, providerNames: ["a": "Anthropic"])
        XCTAssertEqual(groups.map(\.label), ["Anthropic", "Home desktop"])
        XCTAssertEqual(groups[0].models.map { $0["displayName"].string }, ["Y", "X"], "favourites first")
        XCTAssertTrue(groups[1].offline)
        XCTAssertEqual(ChatModels.groups(models, providerNames: ["a": "Anthropic"], matching: "home").count, 0)
        XCTAssertEqual(ChatModels.groups(models, providerNames: ["a": "Anthropic"], matching: "anthro").first?.models.count, 2)
        XCTAssertEqual(ChatModels.subtitle(json(#"{"contextLength":200000,"capabilities":{"vision":true,"reasoning":"effort","tools":"prompted"},"free":true}"#)), "200K context · vision · reasoning · prompted tools · free")
        XCTAssertEqual(ChatModels.subtitle(models[2]), "Home desktop isn't connected")
    }

    // MARK: commands

    func testSlashCommands() {
        XCTAssertEqual(ChatSlash.menuQuery("/co"), "co")
        XCTAssertNil(ChatSlash.menuQuery("/compact now"))
        XCTAssertNil(ChatSlash.menuQuery("hello /co"))
        let parsed = ChatSlash.parse("/compact keep the decisions")
        XCTAssertEqual(parsed?.name, "compact")
        XCTAssertEqual(parsed?.args, "keep the decisions")
        XCTAssertNil(ChatSlash.parse("no command"))
        let commands = [ChatSlashCommand(name: "compact", detail: ""), ChatSlashCommand(name: "review", detail: ""), ChatSlashCommand(name: "plugin:review", detail: "")]
        XCTAssertEqual(ChatSlash.filter(commands, query: "rev").map(\.name), ["review", "plugin:review"])
        XCTAssertEqual(ChatSlash.mention(in: "look at @src/ma"), "src/ma")
        XCTAssertNil(ChatSlash.mention(in: "look at @src/main.swift "))
        XCTAssertEqual(ChatSlash.replacingMention(in: "look at @src/ma", with: "src/main.swift"), "look at @src/main.swift ")
    }

    func testLoopCommands() {
        XCTAssertEqual(ChatLoop.parse(""), .list)
        XCTAssertEqual(ChatLoop.parse("stop"), .stop(nil))
        XCTAssertEqual(ChatLoop.parse("stop 2"), .stop("2"))
        XCTAssertEqual(ChatLoop.parse("5m check the deploy"), .start(interval: 300_000, prompt: "check the deploy"))
        XCTAssertEqual(ChatLoop.parse("check the deploy"), .start(interval: ChatLoop.defaultInterval, prompt: "check the deploy"))
        XCTAssertEqual(ChatLoop.interval("1h30m"), 5_400_000)
        XCTAssertNil(ChatLoop.interval("30m1h"))
        XCTAssertEqual(ChatLoop.format(5_400_000), "1h 30m")
        if case .error = ChatLoop.parse("5m") {} else { XCTFail("an interval needs a prompt") }
        if case .error = ChatLoop.parse("3d do it") {} else { XCTFail("a loop cannot be longer than a day") }
    }

    // MARK: words

    func testServerErrorsAreTranslated() {
        XCTAssertEqual(ChatError.text("Unknown method foo.bar"), ChatError.unsupported)
        XCTAssertTrue(ChatError.text("Invalid params").contains("Update Atelier"))
        XCTAssertEqual(ChatError.text("Only admins can do this."), "Only admins can do this.")
        XCTAssertEqual(ChatError.text("Wrong username or password."), "Wrong username or password.")
        XCTAssertTrue(ChatError.isUnsupported(MobileError.message("Unknown method x")))
        XCTAssertEqual(ChatError.text(MobileError.rpc(code: -32601, appCode: "", message: "Method not found", fix: nil)), ChatError.unsupported, "the JSON-RPC code decides")
        XCTAssertEqual(ChatError.text(MobileError.rpc(code: -32000, appCode: "forbidden", message: "Not allowed", fix: nil)), "You don't have permission to do this.")
        XCTAssertEqual(ChatError.text(MobileError.rpc(code: -32000, appCode: "forbidden", message: "Only admins can do this.", fix: nil)), "Only admins can do this.")
        XCTAssertTrue(ChatError.isForbidden(MobileError.rpc(code: -32000, appCode: "forbidden", message: "x", fix: nil)))
    }

    func testNumbersAreFormatted() {
        XCTAssertEqual(ChatText.tokens(950), "950")
        XCTAssertEqual(ChatText.tokens(152_000), "152K")
        XCTAssertEqual(ChatText.tokens(1_500_000), "1.5M")
        XCTAssertEqual(ChatText.tokens(2_000_000), "2M")
        XCTAssertEqual(ChatText.percent(50, of: 200), "25%")
        XCTAssertEqual(ChatText.elapsed(75_000), "1m 15s")
        XCTAssertEqual(ChatText.plural(1, "file"), "1 file")
        XCTAssertEqual(ChatText.plural(3, "file"), "3 files")
    }

    func testTheContextRowsFillTheWindow() {
        let context = json(#"{"used":100,"limit":1000,"threshold":800,"categories":{"systemPrompt":10,"systemTools":20,"mcpTools":0,"skills":10,"messages":60}}"#)
        let rows = ChatContext.rows(context)
        XCTAssertEqual(rows.reduce(0) { $0 + $1.tokens }, 1000)
        XCTAssertEqual(rows.first { $0.id == "free" }?.tokens, 700)
        XCTAssertEqual(rows.first { $0.id == "buffer" }?.tokens, 200)
    }

    func testReactionsAreAddedAndTakenBack() {
        var list = ChatReactions.applying([], participant: "a", emoji: "👍", on: true)
        list = ChatReactions.applying(list, participant: "b", emoji: "👍", on: true)
        XCTAssertEqual(list.first?["participants"].array.count, 2)
        list = ChatReactions.applying(list, participant: "a", emoji: "👍", on: false)
        XCTAssertEqual(list.first?["participants"].array.map(\.string), ["b"])
        XCTAssertTrue(ChatReactions.applying(list, participant: "b", emoji: "👍", on: false).isEmpty)
    }

    // MARK: rendering

    func testMathReadsAsPlainText() {
        XCTAssertEqual(MathText.plain(#"A = \pi r^2"#), "A = π r²")
        XCTAssertEqual(MathText.plain(#"\frac{a}{b} + \sqrt{x}"#), "(a)/(b) + √(x)")
        XCTAssertEqual(MathText.plain(#"x_{i} \leq y"#), "xᵢ ≤ y")
        XCTAssertTrue(MathText.replacingInline("It costs $5 and $6 today").contains("$5 and $6"))
        XCTAssertTrue(MathText.replacingInline(#"Area $\pi r^2$ here"#).contains("π r²"))
    }

    func testRightToLeftTextIsRecognised() {
        XCTAssertTrue(MarkdownInline.isRightToLeft("مرحبا بالعالم"))
        XCTAssertTrue(MarkdownInline.isRightToLeft("  שלום עולם"))
        XCTAssertFalse(MarkdownInline.isRightToLeft("Hello"))
        XCTAssertTrue(MarkdownInline.isRightToLeft("123 مرحبا"), "digits have no direction, the first letter decides")
        XCTAssertFalse(MarkdownInline.isRightToLeft("Hello مرحبا"), "the first letter decides")
    }

    func testLinksAreFoundAndOnlyWebOnesOpen() {
        let text = String(MarkdownInline.attributed("See https://atelierhq.dev and [docs](https://docs.atelierhq.dev).").characters)
        XCTAssertTrue(text.contains("docs"))
        let attributed = MarkdownInline.attributed("Go to https://atelierhq.dev now")
        XCTAssertEqual(attributed.runs.compactMap(\.link).map(\.absoluteString), ["https://atelierhq.dev"])
        let system = "\(OpenURLAction.Result.systemAction)"
        XCTAssertNotEqual("\(MarkdownLinks.handle(URL(string: "javascript:alert(1)")!))", system)
        XCTAssertEqual("\(MarkdownLinks.handle(URL(string: "https://atelierhq.dev")!))", system)
        XCTAssertEqual("\(MarkdownLinks.handle(URL(string: "mailto:a@b.c")!))", system)
    }

    func testTaskListsAndDisplayMath() {
        let blocks = MarkdownBlock.parse("- [x] done\n- [ ] todo\n\n$$\nE = mc^2\n$$")
        guard blocks.count == 2 else { return XCTFail("a list and a formula, got \(blocks.count)") }
        if case .list(let items) = blocks[0] { XCTAssertEqual(items.map { $0.checked }, [true, false]); XCTAssertEqual(items[0].text, "done") } else { XCTFail("list") }
        if case .math(let source) = blocks[1] { XCTAssertEqual(source, "E = mc^2") } else { XCTFail("math") }
    }

    func testSearchResultsAreReadBackIntoRows() {
        let parsed = ChatSearchResult.parse("1. Release checklist\nhttps://example.com/a\nA short list.\n\n2. Ship Tuesdays\nhttps://blog.example.org/b\nPublished: Oct 13, 2026 · Blog\nFreeze early.\n\n(via DuckDuckGo · 2 results)")
        XCTAssertEqual(parsed.rows.count, 2)
        XCTAssertEqual(parsed.rows[0].host, "example.com")
        XCTAssertEqual(parsed.rows[1].published, "Oct 13, 2026 · Blog")
        XCTAssertEqual(parsed.rows[1].snippet, "Freeze early.")
        XCTAssertEqual(parsed.via, "DuckDuckGo")
        XCTAssertTrue(ChatSearchResult.parse("No results for that.").rows.isEmpty)
    }

    func testPartialToolInputIsReadWhileItStreams() {
        XCTAssertEqual(ChatPartialJSON.field(#"{"identifier":"launch-plan","title":"Launch pl"#, "identifier"), "launch-plan")
        XCTAssertEqual(ChatPartialJSON.field(#"{"identifier":"x","title":"Launch pl"#, "title"), "Launch pl")
        XCTAssertEqual(ChatPartialJSON.field(#"{"title":"Line\nbreak \"q\""}"#, "title"), "Line\nbreak \"q\"")
        XCTAssertNil(ChatPartialJSON.field(#"{"title":"#, "title"))
        XCTAssertNil(ChatPartialJSON.field(nil, "title"))
    }

    // MARK: transcript

    func testGeneratedMediaArtifactsAndNoticesGetTheirOwnBlocks() {
        let messages = [
            json(#"{"id":"u","role":"user","kind":"normal","parts":[{"type":"context","text":"","notice":{"kind":"quote","text":"quoted"}},{"type":"text","text":"Hi"}]}"#),
            json(#"{"id":"a","role":"assistant","kind":"normal","stopReason":"refusal","parts":[{"type":"tool_call","id":"g","name":"GenerateImage","input":{}},{"type":"tool_call","id":"r","name":"artifact","input":{"identifier":"x"}},{"type":"tool_call","id":"t","name":"Read","input":{}},{"type":"text","text":"Done"}]}"#),
            json(#"{"id":"n","role":"user","kind":"normal","parts":[{"type":"context","text":"x","notice":{"kind":"agent","taskId":"t","title":"Check","status":"done","sessionId":"s"}}]}"#),
            json(#"{"id":"c","role":"user","kind":"normal","parts":[{"type":"context","text":"","notice":{"kind":"command","command":"/compact"}}]}"#),
        ]
        let turns = Turn.build(messages)
        XCTAssertEqual(turns.count, 3)
        XCTAssertEqual(turns[0].quotes, ["quoted"])
        guard case .media = turns[1].blocks[0], case .artifact = turns[1].blocks[1], case .tools = turns[1].blocks[2], case .text = turns[1].blocks[3] else { return XCTFail("block kinds: \(turns[1].blocks.map(\.id))") }
        guard case .refusal = turns[1].blocks[4], case .notice = turns[1].blocks[5] else { return XCTFail("a refusal and the agent's word end the turn") }
        XCTAssertEqual(turns[2].plainText, "/compact")
        XCTAssertEqual(turns[2].notice?["kind"].string, "command")
    }

    func testAHooksNoteIsShownMutedAndACompactionSummaryDivides() {
        let turns = Turn.build([
            json(#"{"id":"c","role":"user","kind":"context","parts":[{"type":"context","text":"Hook feedback"}]}"#),
            json(#"{"id":"s","role":"user","kind":"compaction_summary","parts":[{"type":"context","text":"","notice":{"kind":"compaction","saved":1200}},{"type":"text","text":"Summary"}]}"#),
        ])
        XCTAssertEqual(turns.map(\.role), [.note, .note])
        XCTAssertEqual(turns[0].mutedLine, "Hook feedback")
        XCTAssertEqual(turns[1].notice?["saved"].int, 1200)
    }

    func testThoughtsThatSayNothingAreLeftOut() {
        XCTAssertFalse(Turn.hasThought("**Preparing backup access**"))
        XCTAssertTrue(Turn.hasThought("First look at the config.\nThen compare it with the schema."))
        XCTAssertFalse(Turn.hasThought("   "))
    }

    // MARK: sign in

    func testServerAddressesAreNormalisedAndExplained() {
        XCTAssertEqual(ChatSignIn.normalized("atelier.example.com/"), "https://atelier.example.com")
        XCTAssertEqual(ChatSignIn.normalized(" https://a.b "), "https://a.b")
        XCTAssertNil(ChatSignIn.addressProblem("atelier.example.com"))
        XCTAssertNil(ChatSignIn.addressProblem(""))
        XCTAssertTrue(ChatSignIn.addressProblem("http://atelier.example.com")?.contains("HTTPS") == true)
        XCTAssertNotNil(ChatSignIn.addressProblem("https://example.com/path"))
    }

    func testInviteCodesAreNormalised() {
        XCTAssertEqual(ChatSignIn.normalizedInvite("a1b2-c3d4-e5f6-g7h8"), "A1B2C3D4E5F6G7H8")
        XCTAssertEqual(ChatSignIn.normalizedInvite("A1B2-C3D4-E5F6-G7H8-"), "A1B2C3D4E5F6G7H8", "dashes are ignored wherever they are")
        XCTAssertNil(ChatSignIn.normalizedInvite("A1B2-C3D4-E5F6-G7H"), "15 symbols")
        XCTAssertEqual(ChatSignIn.normalizedInvite("a1b2 c3d4 e5f6 g7h8"), "A1B2C3D4E5F6G7H8")
        XCTAssertEqual(ChatSignIn.normalizedInvite("OIL0-0000-0000-0000"), "0110000000000000", "O is 0, I and L are 1")
        XCTAssertNil(ChatSignIn.normalizedInvite("short"))
        XCTAssertNil(ChatSignIn.normalizedInvite("U1B2-C3D4-E5F6-G7H8"), "U is not in the alphabet")
    }

    func testConnectionFailuresSayWhatWentWrong() {
        XCTAssertNotNil(ChatSignIn.probe(for: URLError(.serverCertificateUntrusted)).failure)
        if case .certificate = ChatSignIn.probe(for: URLError(.serverCertificateUntrusted)) {} else { XCTFail("certificate") }
        if case .unreachable(let text) = ChatSignIn.probe(for: URLError(.cannotFindHost)) { XCTAssertTrue(text.contains("Can't find")) } else { XCTFail("host") }
        if case .unreachable(let text) = ChatSignIn.probe(for: URLError(.notConnectedToInternet)) { XCTAssertTrue(text.contains("offline")) } else { XCTFail("offline") }
        XCTAssertTrue(SignInView.validUsername("philipp.b"))
        XCTAssertFalse(SignInView.validUsername("a"))
        XCTAssertFalse(SignInView.validUsername("-bad"))
        XCTAssertFalse(SignInView.validUsername("has space"))
    }

    // MARK: forms

    func testAConnectorsFormIsReadFromItsSchema() {
        let schema = json(#"{"required":["workspace"],"properties":{"workspace":{"type":"string","title":"Workspace"},"pages":{"type":"integer","minimum":1,"maximum":20},"public":{"type":"boolean"},"kind":{"type":"string","enum":["notes","docs"],"enumNames":["Notes","Documents"]},"tags":{"type":"array","items":{"enum":["a","b"]}},"blob":{"type":"object"}}}"#)
        let fields = ChatElicitationField.fields(schema)
        XCTAssertEqual(Set(fields.map(\.name)), ["workspace", "pages", "public", "kind", "tags"], "an object field is left out")
        XCTAssertEqual(fields.first { $0.name == "kind" }?.options.map(\.label), ["Notes", "Documents"])
        XCTAssertEqual(ChatElicitationField.content(fields, values: [:]).problem, "Enter Workspace.")
        XCTAssertEqual(ChatElicitationField.content(fields, values: ["workspace": "Home", "pages": "30"]).problem, "pages is at most 20.")
        XCTAssertEqual(ChatElicitationField.content(fields, values: ["workspace": "Home", "pages": "2.5"]).problem, "pages needs a whole number.")
        let ok = ChatElicitationField.content(fields, values: ["workspace": "Home", "pages": "3", "public": "true", "kind": "docs", "tags": "a\u{1F}b"])
        XCTAssertEqual(ok.content?["pages"], 3)
        XCTAssertEqual(ok.content?["public"], true)
        XCTAssertEqual(ok.content?["tags"], ["a", "b"])
    }

    func testAPlanRevisionCarriesTheCommentsWithTheirPassages() {
        let comments = CodePlanComments.shared
        comments.clear("plan-test")
        comments.add("plan-test", quote: "Write a migration that reads the old keys.", text: "Also the shortcuts")
        let message = comments.revision("plan-test", feedback: "Looks close")
        XCTAssertTrue(message?.hasPrefix("Looks close\n\nComments on the plan:") == true)
        XCTAssertTrue(message?.contains("Also the shortcuts") == true)
        comments.clear("plan-test")
        XCTAssertNil(comments.revision("plan-test", feedback: "  "))
    }

    func testAPermissionTitleSaysWhatIsAsked() {
        func title(_ payload: String) -> String { ChatPermissionCard.title(json(payload)) }
        XCTAssertEqual(title(#"{"toolName":"Bash","input":{"description":"Run the tests"}}"#), "Allow Atelier to run Run the tests?")
        XCTAssertEqual(title(#"{"toolName":"Bash","input":{"description":"Run the tests"},"agent":"Check"}"#), "Allow sub-agent \"Check\" to run this command?")
        XCTAssertEqual(title(#"{"toolName":"Edit","input":{"file_path":"/repo/a.swift"}}"#), "Allow Atelier to edit a.swift?")
        XCTAssertEqual(title(#"{"toolName":"GenerateImage","input":{"count":3}}"#), "Allow Atelier to make 3 images?")
        XCTAssertEqual(title(#"{"toolName":"mcp__github__create_issue","input":{}}"#), "Allow Atelier to use Create Issue?")
    }

    // MARK: projects, files, artifacts

    func testProjectFilesUseThePromptBudgetInUploadOrder() {
        let files = [json(#"{"id":"a","tokens":40000}"#), json(#"{"id":"b","tokens":30000}"#), json(#"{"id":"c","tokens":10000}"#), json(#"{"id":"d","tokens":null}"#)]
        let budget = ChatProjectMeta.fileBudget(files)
        XCTAssertEqual(budget.total, 80000)
        XCTAssertEqual(budget.over, ["b"], "b does not fit after a, c still does")
        XCTAssertEqual(ChatProjectMeta.fileType(json(#"{"name":"notes.md","mime":"text/markdown"}"#)), "MD")
        XCTAssertEqual(ChatProjectMeta.fileType(json(#"{"name":"README","mime":"text/plain"}"#)), "PLAIN")
    }

    func testArtifactFilesGetTheirExtension() {
        XCTAssertEqual(ArtifactFiles.fileName(title: "Launch plan for 0.11", type: "markdown", language: nil), "launch-plan-for-0-11.md")
        XCTAssertEqual(ArtifactFiles.fileName(title: "Port helper", type: "code", language: "swift"), "port-helper.swift")
        XCTAssertEqual(ArtifactFiles.fileName(title: "", type: "html", language: nil), "artifact.html")
        XCTAssertTrue(IsolatedHTML.policy(scripts: false).contains("default-src 'none'"))
        XCTAssertFalse(IsolatedHTML.policy(scripts: false).contains("script-src"))
        XCTAssertTrue(IsolatedHTML.policy(scripts: true).contains("connect-src 'none'"))
        let page = IsolatedHTML.page("<html><head><title>x</title></head><body>hi</body></html>", scripts: false)
        XCTAssertTrue(page.contains("Content-Security-Policy"))
        XCTAssertTrue(page.contains("<title>x</title>"))
    }

    func testConversationFieldsReadTheServersShape() {
        let value = session("c", ago: 0)
        XCTAssertEqual(value.displayTitle, "c")
        XCTAssertTrue(value.thinking, "absent means on")
        let temp = Conversation(raw: .obj(["id": "t", "title": "", "mode": "code", "temporary": "private", "coop": ["role": "editor", "hostName": "Ben"], "archivedAt": 5]))
        XCTAssertEqual(temp.displayTitle, "New session")
        XCTAssertTrue(temp.isTemporary && temp.isGuest && temp.archived)
        XCTAssertEqual(temp.coopHost, "Ben")
    }

    // MARK: the hub

    func testTheHubNotesWhatTheStoreIgnoresAndKeepsItQuiet() {
        let store = AppStore()
        let hub = ChatHub.of(store)
        XCTAssertTrue(ChatHub.of(store) === hub, "one hub per store")
        store.selected = "s"
        store.transcript = Transcript(snapshot: .obj(["seq": 1, "messages": [["id": "m", "role": "assistant", "parts": []]], "session": .obj(["id": "s"])]))
        store.rpc.event?("groups.changed", [["id": "g", "name": "Work", "collapsed": false]])
        XCTAssertEqual(hub.groups.count, 1)
        store.rpc.event?("settings.changed", ["effective": ["capabilities": ["webSearch": ["enabled": true]]]])
        XCTAssertTrue(hub.webSearchOn)
        // Tool input streaming in is kept for the cards, and does not make the store load the conversation again.
        store.rpc.event?("session.event", ["sessionId": "s", "seq": 2, "event": ["type": "delta", "messageId": "m", "index": 1, "kind": "tool_input", "text": "{\"title\":\"Hi"]])
        store.rpc.event?("session.event", ["sessionId": "s", "seq": 3, "event": ["type": "delta", "messageId": "m", "index": 1, "kind": "tool_input", "text": "!\"}"]])
        XCTAssertEqual(hub.toolInputs["m:1"], "{\"title\":\"Hi!\"}")
        XCTAssertEqual(store.transcript.seq, 3, "applied in order, no reload")
        store.rpc.event?("session.event", ["sessionId": "s", "seq": 4, "event": ["type": "reaction", "messageId": "m", "participantId": "account:a", "emoji": "🎉", "on": true]])
        XCTAssertEqual(hub.reactions["s"]?["m"]?.first?["participants"].array.count, 1)
        store.rpc.event?("session.event", ["sessionId": "s", "seq": 5, "event": ["type": "done", "messageId": "m", "usage": .null, "stopReason": "refusal", "error": .null]])
        XCTAssertEqual(hub.stopReasons["m"], "refusal")
        store.rpc.event?("session.event", ["sessionId": "s", "seq": 6, "event": ["type": "host_away", "away": true]])
        XCTAssertEqual(hub.hostAway["s"], true)
        XCTAssertEqual(store.transcript.seq, 6, "the away notice is not a reason to load again")
        store.rpc.event?("auth.signedOut", .null)
        XCTAssertFalse(store.signedIn)
        XCTAssertTrue(hub.signedOutMessage?.contains("sign-in ended") == true)
    }

    func testTheOpenConversationIsFoundEvenWhenTheListLacksIt() {
        let store = AppStore()
        store.selected = "temporary"
        XCTAssertNil(ChatNav.session(store))
        store.transcript = Transcript(snapshot: .obj(["session": .obj(["id": "temporary", "title": "", "mode": "chat", "temporary": "private"]), "messages": [], "seq": 0]))
        XCTAssertEqual(ChatNav.session(store)?.isTemporary, true)
        XCTAssertTrue(ChatNav.loaded(store))
        store.selected = "other"
        XCTAssertFalse(ChatNav.loaded(store), "until its snapshot arrives the page shows it loading")
    }

    func testTheNewConversationStartsWithTheModelThePersonPrefers() {
        let hub = ChatHub.of(AppStore())
        let models: [JSON] = [.obj(["ref": "a/x", "hidden": false]), .obj(["ref": "a/y", "hidden": false, "available": false]), .obj(["ref": "a/z", "hidden": false])]
        hub.settings = ["models": ["defaults": ["chat": "a/z"]]]
        XCTAssertEqual(hub.defaultModel(mode: "chat", models: models), "a/z")
        hub.prefs = ["models": ["chat": "a/y"]]
        XCTAssertEqual(hub.defaultModel(mode: "chat", models: models), "a/z", "a model that cannot answer is not chosen")
        hub.prefs = ["models": ["chat": "a/x"]]
        XCTAssertEqual(hub.defaultModel(mode: "chat", models: models), "a/x")
        XCTAssertEqual(hub.defaultModel(mode: "code", models: []), "")
    }

    func testTheAreaMaskIsBlackWithWhiteWhereThePersonPainted() throws {
        XCTAssertEqual(ChatAreaEditor.maskSize(8192, 4096), CGSize(width: 4096, height: 2048))
        XCTAssertEqual(ChatAreaEditor.maskSize(100, 50), CGSize(width: 100, height: 50))
        XCTAssertEqual(ChatAreaEditor.brushFraction(size: 100, width: 1000, height: 500), 0.4, accuracy: 0.001)
        XCTAssertGreaterThan(ChatAreaEditor.brushFraction(size: 1, width: 10, height: 10), 0.3, "never under a few pixels")
        let painted = ChatAreaEditor.Stroke(erase: false, fraction: 0.2, points: [CGPoint(x: 0.5, y: 0.5)])
        let erased = ChatAreaEditor.Stroke(erase: true, fraction: 0.05, points: [CGPoint(x: 0.5, y: 0.5)])
        func luminance(_ strokes: [ChatAreaEditor.Stroke], x: Int, y: Int) throws -> UInt8 {
            let data = try XCTUnwrap(ChatAreaEditor.mask(strokes: strokes, width: 100, height: 100))
            let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
            XCTAssertEqual(image.width, 100)
            let pixels = try XCTUnwrap(image.dataProvider?.data as Data?)
            let bytes = image.bitsPerPixel / 8
            return pixels[y * image.bytesPerRow + x * bytes]
        }
        XCTAssertEqual(try luminance([painted], x: 50, y: 50), 255)
        XCTAssertEqual(try luminance([painted], x: 2, y: 2), 0)
        XCTAssertEqual(try luminance([painted, erased], x: 50, y: 50), 0, "erasing paints black again")
        XCTAssertEqual(try luminance([painted, erased], x: 57, y: 50), 255)
    }

    // MARK: voice and the effort menu

    func testDictatedWordsJoinWhatWasTypedWithOneSpace() {
        XCTAssertEqual(ChatComposer.join("", "hello there"), "hello there")
        XCTAssertEqual(ChatComposer.join("Please", " add tests "), "Please add tests")
        XCTAssertEqual(ChatComposer.join("Line one\n", "line two"), "Line one\nline two")
        XCTAssertEqual(ChatComposer.join("Keep this", "  "), "Keep this")
    }

    func testTheEffortSliderSnapsToTheNearestLevel() {
        // A 300 point track with 22 point ends and five levels: stops every 64 points from 22.
        XCTAssertEqual(EffortSlider.nearest(0, width: 300, inset: 22, count: 5), 0)
        XCTAssertEqual(EffortSlider.nearest(60, width: 300, inset: 22, count: 5), 1)
        XCTAssertEqual(EffortSlider.nearest(150, width: 300, inset: 22, count: 5), 2)
        XCTAssertEqual(EffortSlider.nearest(278, width: 300, inset: 22, count: 5), 4)
        XCTAssertEqual(EffortSlider.nearest(900, width: 300, inset: 22, count: 5), 4)
        XCTAssertEqual(EffortSlider.nearest(150, width: 300, inset: 22, count: 1), 0)
    }
}
