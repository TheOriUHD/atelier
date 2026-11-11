import ApplicationServices
import CoreGraphics
import XCTest

@testable import AtelierComputer

// The SkyLight route as data: the records, the stamps, the click and the typing. Nothing here posts anything.

final class SkyLightTests: XCTestCase {
  func testTheFocusRecordNamesTheWindowAndTheDirection() {
    let record = SkyLight.focusRecord(window: 0x0102_0304, direction: 1)
    XCTAssertEqual(record.count, 0xF8)
    XCTAssertEqual(record[0x04], 0xF8)
    XCTAssertEqual(record[0x08], 0x0D)
    XCTAssertEqual(Array(record[0x3C..<0x40]), [0x04, 0x03, 0x02, 0x01])
    XCTAssertEqual(record[0x8A], 1)
    XCTAssertEqual(SkyLight.focusRecord(window: 7, direction: 2)[0x8A], 2)
    // Nothing else is set.
    var rest = record
    for i in [0x04, 0x08, 0x3C, 0x3D, 0x3E, 0x3F, 0x8A] { rest[i] = 0 }
    XCTAssertTrue(rest.allSatisfy { $0 == 0 })
  }

  func testTheMakeKeyRecords() {
    for kind: UInt8 in [1, 2] {
      let record = SkyLight.makeKeyRecord(window: 42, kind: kind)
      XCTAssertEqual(record.count, 0xF8)
      XCTAssertEqual(record[0x08], kind)
      XCTAssertEqual(record[0x3A], 0x10)
      XCTAssertTrue(record[0x20..<0x30].allSatisfy { $0 == 0xFF })
      XCTAssertEqual(Array(record[0x3C..<0x40]), [42, 0, 0, 0])
    }
  }

  func testThePointInsideTheWindowOnNewerMacs() {
    let window = CGRect(x: 100, y: 50, width: 800, height: 600)
    XCTAssertEqual(SkyLight.stampedPoint(CGPoint(x: 300, y: 250), window: window, major: 27), CGPoint(x: 200, y: 200))
    XCTAssertEqual(SkyLight.stampedPoint(CGPoint(x: 300, y: 250), window: window, major: 26), CGPoint(x: 300, y: 250))
  }

  func testAStampNamesTheProcessAndTheWindow() {
    let click = SkyLight.Stamp(pid: 9, window: 77, point: .zero, group: 5, phase: 3, clickState: 2, button: 1)
    let fields = Dictionary(uniqueKeysWithValues: click.fields)
    XCTAssertEqual(fields[40], 9)
    XCTAssertEqual(fields[51], 77)
    XCTAssertEqual(fields[91], 77)
    XCTAssertEqual(fields[92], 77)
    XCTAssertEqual(fields[58], 5)
    XCTAssertEqual(fields[0], 3)
    XCTAssertEqual(fields[1], 2)
    XCTAssertEqual(fields[3], 1)
    XCTAssertEqual(fields[7], 3)
    // A wheel event carries no gesture.
    let wheel = Dictionary(uniqueKeysWithValues: SkyLight.Stamp(pid: 9, window: 77, point: .zero, group: 0).fields)
    XCTAssertEqual(Set(wheel.keys), [40, 51, 91, 92])
  }

  func testALeftClickHasAMoveAPrimerOffEveryWindowAndThePresses() {
    let steps = SkyLight.click(
      at: CGPoint(x: 300, y: 250), stamped: CGPoint(x: 200, y: 200), pid: 9, window: 77, button: .left, count: 2, group: 5)
    XCTAssertEqual(
      steps.map(\.type), [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
    // The primer, at (-1, -1) in both places.
    XCTAssertEqual(steps[1].at, CGPoint(x: -1, y: -1))
    XCTAssertEqual(steps[1].stamp.point, CGPoint(x: -1, y: -1))
    // The presses at the point, numbered, inside the window.
    XCTAssertEqual(steps[3].at, CGPoint(x: 300, y: 250))
    XCTAssertEqual(steps[3].stamp.point, CGPoint(x: 200, y: 200))
    XCTAssertEqual(steps[3].stamp.clickState, 1)
    XCTAssertEqual(steps[5].stamp.clickState, 2)
    XCTAssertTrue(steps.allSatisfy { $0.stamp.group == 5 && $0.stamp.window == 77 })
  }

  func testAMiddleClickHasNoPrimer() {
    let steps = SkyLight.click(at: .zero, stamped: .zero, pid: 9, window: 77, button: .middle, count: 1, group: 5)
    XCTAssertEqual(steps.map(\.type), [.mouseMoved, .otherMouseDown, .otherMouseUp])
    XCTAssertEqual(steps[1].stamp.button, 2)
  }

  func testTypingIsACharacterAnEventWithReturnAndTabAsKeys() {
    XCTAssertEqual(
      SkyLight.typing("a é🎨\n\t"),
      [.text(Array("a".utf16)), .text(Array(" ".utf16)), .text(Array("é".utf16)), .text(Array("🎨".utf16)), .key(36), .key(48)])
    XCTAssertEqual(SkyLight.typing("\r\n"), [.key(36)])
  }

  func testTheTypedStepsCarryTheAuthenticationMessage() {
    let steps = Background.typingSteps("ab")
    XCTAssertEqual(steps.count, 4)
    XCTAssertTrue(steps.allSatisfy { $0.event.authenticate })
    XCTAssertEqual(steps[0].event.kind, .char(0, Array("a".utf16), down: true))
  }

  func testRefusesTheShortcutsThatMakeABrowserComeForward() throws {
    let layout = KeyboardLayoutMap(plain: ["t": 17, "n": 45, "l": 37])
    XCTAssertTrue(Background.frontsItself(try KeyMap.resolve(["cmd", "t"], layout: layout), chromium: true))
    XCTAssertTrue(Background.frontsItself(try KeyMap.resolve(["cmd", "shift", "n"], layout: layout), chromium: true))
    XCTAssertFalse(Background.frontsItself(try KeyMap.resolve(["cmd", "l"], layout: layout), chromium: true))
    XCTAssertFalse(Background.frontsItself(try KeyMap.resolve(["cmd", "t"], layout: layout), chromium: false))
  }
}

final class OcclusionTests: XCTestCase {
  let display = CGRect(x: 0, y: 0, width: 1800, height: 1169)

  func testAWindowPartlyInViewShowsAndIsLeftAlone() {
    let window = CGRect(x: 100, y: 100, width: 600, height: 400)
    XCTAssertTrue(Occlusion.shows(window, covers: [CGRect(x: 0, y: 0, width: 500, height: 1169)], displays: [display]))
    XCTAssertNil(Occlusion.peekOffset(window: window, covers: [CGRect(x: 0, y: 0, width: 500, height: 1169)], displays: [display]))
  }

  func testACoveredWindowIsShiftedJustEnoughToShow() {
    // Covered by a full-screen window above the Dock's strip: down until a sliver is past its bottom edge.
    let covers = [CGRect(x: 0, y: 39, width: 1800, height: 1053), CGRect(x: 0, y: 0, width: 1800, height: 39)]
    let window = CGRect(x: 180, y: 71, width: 1440, height: 900)
    XCTAssertFalse(Occlusion.shows(window, covers: covers, displays: [display]))
    let offset = Occlusion.peekOffset(window: window, covers: covers, displays: [display])
    XCTAssertEqual(offset, CGVector(dx: 0, dy: 192))
    XCTAssertTrue(Occlusion.shows(window.offsetBy(dx: 0, dy: 192), covers: covers, displays: [display]))
  }

  func testNoShiftWhenTheCoversFillTheScreen() {
    XCTAssertNil(Occlusion.peekOffset(window: CGRect(x: 100, y: 100, width: 600, height: 400), covers: [display], displays: [display]))
  }

  func testOnlyNormalWindowsAndTheMenuBarCover() {
    func window(_ id: CGWindowID, layer: Int, _ rect: CGRect) -> WindowInfo { WindowInfo(id: id, pid: 1, layer: layer, bounds: rect) }
    let target = window(9, layer: 0, CGRect(x: 100, y: 100, width: 600, height: 400))
    let list = [
      window(1, layer: 27, display),  // a see-through overlay
      window(2, layer: 24, CGRect(x: 0, y: 0, width: 1800, height: 39)),  // the menu bar
      window(3, layer: 20, display),  // the Dock's full-screen window
      window(4, layer: 0, CGRect(x: 0, y: 39, width: 1800, height: 1053)),  // an app
      target,
      window(5, layer: 0, display),  // behind it
    ]
    XCTAssertEqual(Occlusion.covers(of: target, in: list), [CGRect(x: 0, y: 0, width: 1800, height: 39), CGRect(x: 0, y: 39, width: 1800, height: 1053)])
  }
}
