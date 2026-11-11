import ApplicationServices
import CoreGraphics
import XCTest

@testable import AtelierComputer

// Background input for Chromium apps: the decisions as data. Nothing here focuses, posts or presses anything.

final class ChromiumTests: XCTestCase {
  func testKnowsChromiumAppsByTheirFrameworks() {
    // Electron (Slack, VS Code, Discord) and CEF (Spotify): the framework, or the renderer helper beside it.
    XCTAssertTrue(Chromium.isChromium(frameworks: ["Electron Framework.framework", "Slack Helper.app"], helpers: []))
    XCTAssertTrue(Chromium.isChromium(frameworks: ["Chromium Embedded Framework.framework"], helpers: []))
    XCTAssertTrue(Chromium.isChromium(frameworks: ["Notion Helper (Renderer).app"], helpers: []))
    // Chrome and its kin: the renderer helper inside the browser's framework.
    XCTAssertTrue(
      Chromium.isChromium(
        frameworks: ["Google Chrome Framework.framework"], helpers: ["Google Chrome Helper (Renderer).app", "Google Chrome Helper.app"]))
    // A native app.
    XCTAssertFalse(Chromium.isChromium(frameworks: ["Sparkle.framework"], helpers: ["Autoupdate.app"]))
    XCTAssertFalse(Chromium.isChromium(frameworks: [], helpers: []))
  }

  func testWhatAClickDoesToEachControl() {
    XCTAssertEqual(Chromium.step(role: "AXTextField"), .focus)
    XCTAssertEqual(Chromium.step(role: "AXTextArea"), .focus)
    XCTAssertEqual(Chromium.step(role: "AXPopUpButton"), .focus)
    XCTAssertEqual(Chromium.step(role: "AXLink"), .focusThen(36))
    XCTAssertEqual(Chromium.step(role: "AXButton"), .focusThen(49))
    XCTAssertEqual(Chromium.step(role: "AXCheckBox"), .focusThen(49))
    XCTAssertNil(Chromium.step(role: "AXGroup"))
    XCTAssertNil(Chromium.step(role: "AXStaticText"))
    XCTAssertNil(Chromium.step(role: nil))
  }

  func testAClickOnALinksTextGoesToTheLinkAndStopsAtThePage() {
    let roles = { (chain: [String?]) in { (level: Int) -> String?? in level < chain.count ? .some(chain[level]) : nil } }
    // The text inside a span inside a link.
    XCTAssertEqual(Chromium.target(roles(["AXStaticText", "AXGroup", "AXLink", "AXGroup", "AXWebArea"]))?.depth, 2)
    XCTAssertEqual(Chromium.target(roles(["AXStaticText", "AXGroup", "AXLink"]))?.step, .focusThen(36))
    // A clickable div with no control around it: nothing below the page.
    XCTAssertNil(Chromium.target(roles(["AXStaticText", "AXGroup", "AXGroup", "AXWebArea", "AXButton"])))
    // No parent past the top.
    XCTAssertNil(Chromium.target(roles(["AXStaticText"])))
    // Too deep: further up than a click on a control's label reaches.
    XCTAssertNil(Chromium.target(roles(Array(repeating: "AXGroup", count: Chromium.depth + 1) + ["AXButton"])))
  }

  func testTypesOneCharacterAnEventOnItsKey() {
    let layout = KeyboardLayoutMap(plain: ["h": 4, "i": 34])
    let steps = Chromium.typing("hi é\n", layout: layout)
    let downs = steps.filter { $0.release != nil }.map(\.event.kind)
    XCTAssertEqual(
      downs,
      [
        .char(4, Array("h".utf16), down: true), .char(34, Array("i".utf16), down: true),
        .char(49, Array(" ".utf16), down: true), .char(0, Array("é".utf16), down: true), .key(36, down: true),
      ])
    // Every press is let go of.
    XCTAssertEqual(steps.filter(\.isRelease).count, downs.count)
    // An emoji is one character, carried whole.
    XCTAssertEqual(Chromium.typing("🎨", layout: layout).first?.event.kind, .char(0, Array("🎨".utf16), down: true))
    XCTAssertEqual(Chromium.typing("a\r\nb", layout: layout).filter { $0.release != nil }.count, 3)
  }

  func testSplitsEmojiFromTheRestOfTheText() {
    let runs = Chromium.runs("hi 🎨🖌 there é\r\n")
    XCTAssertEqual(runs.map(\.text), ["hi ", "🎨🖌", " there é\r\n"])
    XCTAssertEqual(runs.map(\.wide), [false, true, false])
    XCTAssertTrue(Chromium.runs("").isEmpty)
  }

  func testTheOneCharacterEventCarriesItsKeyAndText() throws {
    let event = try EventSpec.char(4, Array("H".utf16), down: true).make(source: nil)
    XCTAssertEqual(event.getIntegerValueField(.keyboardEventKeycode), 4)
    var length = 0
    var units = [UniChar](repeating: 0, count: 4)
    event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &units)
    XCTAssertEqual(String(utf16CodeUnits: units, count: length), "H")
  }

  func testSplicesTextInPlaceOfTheSelection() {
    XCTAssertEqual(Chromium.spliced("hello world", range: CFRange(location: 5, length: 0), with: ","), "hello, world")
    XCTAssertEqual(Chromium.spliced("hello world", range: CFRange(location: 6, length: 5), with: "there"), "hello there")
    XCTAssertEqual(Chromium.spliced("ab", range: CFRange(location: 10, length: 3), with: "c"), "abc")
    XCTAssertEqual(Chromium.spliced("🎨x", range: CFRange(location: 2, length: 1), with: "y"), "🎨y")
  }

  func testScrollsWithArrowsALineEach() {
    XCTAssertTrue(Chromium.scrollKeys(dx: 0, dy: 3).elementsEqual([(CGKeyCode(125), 3)], by: { $0.code == $1.0 && $0.count == $1.1 }))
    XCTAssertTrue(Chromium.scrollKeys(dx: -2, dy: -1).elementsEqual([(CGKeyCode(126), 1), (CGKeyCode(123), 2)], by: { $0.code == $1.0 && $0.count == $1.1 }))
    XCTAssertEqual(Chromium.scrollKeys(dx: 0, dy: 500).first?.count, 60)
    XCTAssertTrue(Chromium.scrollKeys(dx: 0.2, dy: 0).isEmpty)
  }
}
