import XCTest
@testable import Atelier

final class PresentationTests: XCTestCase {
    private func json(_ text: String) -> JSON { try! JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }

    func testMarkdownBlocks() {
        let blocks = MarkdownBlock.parse("""
        # Title

        Some **bold** text
        on two lines.

        - one
        - two
          wrapped

        1. first
        2. second

        > quoted

        ```swift
        let a = 1
        ```

        | A | B |
        |---|---|
        | 1 | 2 |

        ---
        """)
        guard blocks.count == 8 else { return XCTFail("expected 8 blocks, got \(blocks.count)") }
        if case .heading(let level, let text) = blocks[0] { XCTAssertEqual(level, 1); XCTAssertEqual(text, "Title") } else { XCTFail("heading") }
        if case .paragraph(let text) = blocks[1] { XCTAssertEqual(text, "Some **bold** text\non two lines.") } else { XCTFail("paragraph") }
        if case .list(let items) = blocks[2] { XCTAssertEqual(items.map(\.text), ["one", "two\nwrapped"]); XCTAssertFalse(items[0].ordered) } else { XCTFail("bullets") }
        if case .list(let items) = blocks[3] { XCTAssertEqual(items.map(\.marker), ["1.", "2."]) } else { XCTFail("numbers") }
        if case .quote(let text) = blocks[4] { XCTAssertEqual(text, "quoted") } else { XCTFail("quote") }
        if case .code(let language, let code) = blocks[5] { XCTAssertEqual(language, "swift"); XCTAssertEqual(code, "let a = 1") } else { XCTFail("code") }
        if case .table(let header, let rows) = blocks[6] { XCTAssertEqual(header, ["A", "B"]); XCTAssertEqual(rows, [["1", "2"]]) } else { XCTFail("table") }
        if case .rule = blocks[7] {} else { XCTFail("rule") }
    }

    func testAnUnclosedFenceRendersAsFarAsItHasGot() {
        let blocks = MarkdownBlock.parse("Here:\n\n```js\nlet x = 1")
        if case .code(let language, let code) = blocks.last { XCTAssertEqual(language, "js"); XCTAssertEqual(code, "let x = 1") } else { XCTFail("an open fence is still code") }
    }

    func testToolResultsFoldIntoTheirCallsAndHiddenMessagesDisappear() {
        let messages = [
            json(#"{"id":"u","role":"user","kind":"normal","parts":[{"type":"text","text":"Hi"}]}"#),
            json(#"{"id":"c","role":"user","kind":"context","parts":[{"type":"context","text":"hidden"}]}"#),
            json(#"{"id":"a1","role":"assistant","kind":"normal","parts":[{"type":"text","text":"Looking"},{"type":"tool_call","id":"t1","name":"Read","input":{"file_path":"/x/a.swift"}}]}"#),
            json(#"{"id":"r","role":"tool","kind":"normal","parts":[{"type":"tool_result","callId":"t1","content":[{"type":"text","text":"ok"}]}]}"#),
            json(#"{"id":"a2","role":"assistant","kind":"normal","parts":[{"type":"tool_call","id":"t2","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"Done"}]}"#),
        ]
        let turns = Turn.build(messages)
        XCTAssertEqual(turns.count, 3, "the person's message, the hook's note (shown muted, as the desktop does) and one assistant turn")
        XCTAssertEqual(turns[1].mutedLine, "hidden")
        XCTAssertEqual(turns[2].lastMessageID, "a2")
        guard case .tools(_, let steps) = turns[2].blocks[1] else { return XCTFail("the run of tools joins across the two messages") }
        XCTAssertEqual(steps.count, 2)
        XCTAssertEqual(steps[0].resultText, "ok")
        XCTAssertEqual(turns[2].plainText, "Looking\n\nDone")
    }

    func testToolDescriptions() {
        XCTAssertEqual(ToolInfo(json(#"{"name":"Read","input":{"file_path":"/a/b/App.swift"}}"#)).target, "App.swift")
        XCTAssertEqual(ToolInfo(json(#"{"name":"Bash","input":{"command":"npm test\nnpm run lint"}}"#)).target, "npm test")
        XCTAssertEqual(ToolInfo(json(#"{"name":"mcp__github__create_issue","input":{}}"#)).verb, "Create Issue")
        let step = { (name: String) in ToolStep(call: self.json(#"{"id":"x","name":"\#(name)","input":{}}"#), result: nil) }
        XCTAssertEqual(ToolInfo.summary([step("Read"), step("Read"), step("Bash")]), "Read 2 files, Ran 1 command")
    }
}
