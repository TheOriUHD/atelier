import ApplicationServices
import CoreGraphics
import XCTest

@testable import AtelierComputer

// Background mode's pure parts: which window, which points, the events as data, and the checks on each call's params.
// Nothing here posts an event or presses anything.

final class WindowChoiceTests: XCTestCase {
  private func window(
    _ id: CGWindowID, pid: pid_t, layer: Int = 0, _ rect: CGRect = CGRect(x: 0, y: 25, width: 800, height: 600),
    alpha: Double = 1, onScreen: Bool = true
  ) -> WindowInfo {
    WindowInfo(id: id, pid: pid, layer: layer, bounds: rect, alpha: alpha, onScreen: onScreen)
  }

  func testFrontmostSkipsOtherAppsAndWindowsThatAreNotNormal() {
    let list = [
      window(1, pid: 10),  // another app, in front
      window(2, pid: 20, layer: 3),  // the app's floating panel
      window(3, pid: 20, CGRect(x: 0, y: 0, width: 10, height: 10)),  // a sliver
      window(4, pid: 20, alpha: 0),  // transparent
      window(5, pid: 20, onScreen: false),  // ordered out
      window(6, pid: 20, CGRect(x: 100, y: 100, width: 640, height: 480)),  // this one
      window(7, pid: 20),  // behind it
    ]
    XCTAssertEqual(WindowChoice.frontmost(list, pids: [20])?.id, 6)
    XCTAssertEqual(WindowChoice.frontmost(list, pids: [10])?.id, 1)
    XCTAssertNil(WindowChoice.frontmost(list, pids: [30]))
    XCTAssertNil(WindowChoice.frontmost([], pids: [20]))
  }

  func testFrontmostAcrossTheAppsProcesses() {
    let list = [window(1, pid: 10), window(2, pid: 21), window(3, pid: 20)]
    XCTAssertEqual(WindowChoice.frontmost(list, pids: [20, 21])?.id, 2)
  }

  func testFrontmostIsOnADisplay() {
    let displays = [CGRect(x: 0, y: 0, width: 1800, height: 1169), CGRect(x: 1800, y: -200, width: 2560, height: 1440)]
    let list = [
      window(1, pid: 20, CGRect(x: -20000, y: -20000, width: 800, height: 600)),  // parked outside every display
      window(2, pid: 20, CGRect(x: 4000, y: 0, width: 800, height: 600)),  // partly on the second display
      window(3, pid: 20),
    ]
    XCTAssertEqual(WindowChoice.frontmost(list, pids: [20], displays: displays)?.id, 2)
    XCTAssertNil(WindowChoice.frontmost(Array(list.prefix(1)), pids: [20], displays: displays))
    XCTAssertEqual(WindowChoice.frontmost(list, pids: [20])?.id, 1)
  }

  func testNormalWindowSize() {
    XCTAssertTrue(WindowChoice.isNormal(window(1, pid: 1, CGRect(x: 0, y: 0, width: 40, height: 40))))
    XCTAssertFalse(WindowChoice.isNormal(window(1, pid: 1, CGRect(x: 0, y: 0, width: 39, height: 400))))
    XCTAssertFalse(WindowChoice.isNormal(window(1, pid: 1, CGRect(x: 0, y: 0, width: 400, height: 39))))
    XCTAssertFalse(WindowChoice.isNormal(window(1, pid: 1, layer: -1)))
  }

  func testParsesWindowListEntries() throws {
    let rect = CGRect(x: -1440, y: 120, width: 900, height: 700)
    let entry: [String: Any] = [
      kCGWindowNumber as String: NSNumber(value: 4242), kCGWindowOwnerPID as String: NSNumber(value: 77),
      kCGWindowLayer as String: NSNumber(value: 0), kCGWindowAlpha as String: NSNumber(value: 1.0),
      kCGWindowIsOnscreen as String: NSNumber(value: true),
      kCGWindowBounds as String: rect.dictionaryRepresentation as NSDictionary,
    ]
    let info = try XCTUnwrap(WindowInfo(entry))
    XCTAssertEqual(info, WindowInfo(id: 4242, pid: 77, layer: 0, bounds: rect, alpha: 1, onScreen: true))
    // Off screen when the list doesn't say; nothing without a number, an owner or bounds.
    var offScreen = entry
    offScreen.removeValue(forKey: kCGWindowIsOnscreen as String)
    XCTAssertEqual(WindowInfo(offScreen)?.onScreen, false)
    for key in [kCGWindowNumber, kCGWindowOwnerPID, kCGWindowBounds] {
      var missing = entry
      missing.removeValue(forKey: key as String)
      XCTAssertNil(WindowInfo(missing), key as String)
    }
  }

  func testWindowIDs() throws {
    XCTAssertEqual(try WindowChoice.windowID("123"), 123)
    XCTAssertEqual(try WindowChoice.windowID("4294967295"), UInt32.max)
    for bad in ["", "0", "abc", "-1", "12.5", " 12", "12 ", "4294967296", "99999999999", "0x1F", "１２"] {
      XCTAssertThrowsError(try WindowChoice.windowID(bad), bad) { error in
        XCTAssertEqual((error as? RPCError)?.code, ComputerErrorCode.invalidParams.rawValue, bad)
      }
    }
  }

  func testPointInsideTheWindow() {
    let bounds = CGRect(x: -1440, y: 100, width: 800, height: 600)
    XCTAssertTrue(WindowChoice.contains(bounds, CGPoint(x: -1000, y: 400)))
    // Left and top edges are in, right and bottom ones out.
    XCTAssertTrue(WindowChoice.contains(bounds, CGPoint(x: -1440, y: 100)))
    XCTAssertTrue(WindowChoice.contains(bounds, CGPoint(x: -640.5, y: 699.5)))
    XCTAssertFalse(WindowChoice.contains(bounds, CGPoint(x: -640, y: 400)))
    XCTAssertFalse(WindowChoice.contains(bounds, CGPoint(x: -1000, y: 700)))
    XCTAssertFalse(WindowChoice.contains(bounds, CGPoint(x: -1441, y: 400)))
    XCTAssertFalse(WindowChoice.contains(bounds, CGPoint(x: -1000, y: 99)))
    XCTAssertFalse(WindowChoice.contains(.zero, .zero))
    XCTAssertFalse(WindowChoice.contains(.null, .zero))
  }

  func testAPointOutsideIsInvalidParams() {
    let window = WindowInfo(id: 9, pid: 1, layer: 0, bounds: CGRect(x: 10, y: 20, width: 100, height: 50))
    XCTAssertNoThrow(try WindowChoice.check(CGPoint(x: 50, y: 40), in: window))
    XCTAssertThrowsError(try WindowChoice.check(CGPoint(x: 5, y: 40), in: window)) { error in
      let error = error as? RPCError
      XCTAssertEqual(error?.code, ComputerErrorCode.invalidParams.rawValue)
      XCTAssertTrue(error?.message.contains("outside window 9") == true, error?.message ?? "")
    }
  }

  func testNoWindowErrorsSayWhy() {
    let error = RPCError.noWindow("gone", reason: "gone")
    XCTAssertEqual(error.code, ComputerErrorCode.notFound.rawValue)
    XCTAssertEqual(error.data, .object(["reason": .string("gone")]))
  }
}

final class BackgroundEventsTests: XCTestCase {
  private let point = CGPoint(x: 512.5, y: 300)
  private let window: CGWindowID = 4711

  private func windowFields(_ spec: EventSpec) -> (Int64?, Int64?) {
    (spec.fields[.mouseEventWindowUnderMousePointer], spec.fields[.mouseEventWindowUnderMousePointerThatCanHandleThisEvent])
  }

  func testClickSteps() {
    let steps = BackgroundEvents.click(at: point, button: .left, count: 2, flags: .maskCommand, window: window)
    XCTAssertEqual(steps.map(\.event.kind), [
      .mouse(.mouseMoved, button: .left), .mouse(.leftMouseDown, button: .left), .mouse(.leftMouseUp, button: .left),
      .mouse(.leftMouseDown, button: .left), .mouse(.leftMouseUp, button: .left),
    ])
    for step in steps {
      XCTAssertEqual(step.event.location, point)
      XCTAssertEqual(step.event.flags, .maskCommand)
      XCTAssertTrue(windowFields(step.event) == (4711, 4711))
    }
    XCTAssertNil(steps[0].event.fields[.mouseEventClickState])
    XCTAssertEqual(steps[1...].map { $0.event.fields[.mouseEventClickState] }, [1, 1, 2, 2])
    // Every press names its release, the very event that follows it.
    XCTAssertNil(steps[0].release)
    XCTAssertEqual(steps[1].release, steps[2].event)
    XCTAssertEqual(steps[3].release, steps[4].event)
    XCTAssertEqual(steps.map(\.isRelease), [false, false, true, false, true])
    XCTAssertEqual(steps.map(\.pause), [0.03, 0.02, 0.04, 0.02, 0])
  }

  func testOtherButtons() {
    let right = BackgroundEvents.click(at: point, button: .right, count: 1, flags: [], window: window)
    XCTAssertEqual(right.map(\.event.kind), [
      .mouse(.mouseMoved, button: .left), .mouse(.rightMouseDown, button: .right), .mouse(.rightMouseUp, button: .right),
    ])
    let middle = BackgroundEvents.click(at: point, button: .middle, count: 3, flags: [], window: window)
    XCTAssertEqual(middle.count, 7)
    XCTAssertEqual(middle[5].event.kind, .mouse(.otherMouseDown, button: .center))
    XCTAssertEqual(middle[6].event.fields[.mouseEventClickState], 3)
  }

  func testScrollSteps() {
    let steps = BackgroundEvents.scroll(at: point, dx: -2, dy: 3, window: window)
    XCTAssertEqual(steps.map(\.event.kind), [.mouse(.mouseMoved, button: .left), .scroll(wheel1: -3, wheel2: 2)])
    XCTAssertEqual(steps[1].event.location, point)
    // No modifiers: the person's own held keys don't leak into it.
    XCTAssertEqual(steps[1].event.flags, [])
    // The move names the window; the scroll can't hold it (see testAScrollEventHasNoRoomForTheWindow).
    XCTAssertTrue(windowFields(steps[0].event) == (4711, 4711))
    XCTAssertTrue(steps[1].event.fields.isEmpty)
    XCTAssertTrue(steps.allSatisfy { $0.release == nil && !$0.isRelease })
    XCTAssertEqual(BackgroundEvents.scroll(at: point, dx: 0.2, dy: -0.4, window: window), [])
  }

  func testKeySteps() {
    let steps = BackgroundEvents.press(8, flags: [.maskCommand, .maskShift], repeat: 3)
    XCTAssertEqual(steps.count, 6)
    for (index, step) in steps.enumerated() {
      XCTAssertEqual(step.event.kind, .key(8, down: index % 2 == 0))
      XCTAssertEqual(step.event.flags, [.maskCommand, .maskShift])
      XCTAssertNil(step.event.location)
      XCTAssertTrue(step.event.fields.isEmpty)
    }
    XCTAssertEqual(steps[0].release, steps[1].event)
    XCTAssertEqual(steps.map(\.pause), [0.01, 0.02, 0.01, 0.02, 0.01, 0])
  }

  func testModifiersAloneAreUnsupported() throws {
    let stroke = try KeyMap.resolve(["cmd", "shift"], layout: nil)
    XCTAssertThrowsError(try Background.Key.steps(stroke, repeat: 1)) { error in
      XCTAssertEqual((error as? RPCError)?.code, ComputerErrorCode.unsupported.rawValue)
    }
    // With a key, its modifiers are only flags: no flagsChanged events.
    let steps = try Background.Key.steps(KeyMap.resolve(["cmd", "a"], layout: nil), repeat: 1)
    XCTAssertEqual(steps.map(\.event.kind), [.key(0, down: true), .key(0, down: false)])
    XCTAssertEqual(steps[0].event.flags, .maskCommand)
  }

  func testTypingSteps() {
    let steps = TypingEvents.steps("ab\r\ncd")
    XCTAssertEqual(steps.map(\.event.kind), [
      .text(Array("ab".utf16), down: true), .text(Array("ab".utf16), down: false), .key(36, down: true),
      .key(36, down: false), .text(Array("cd".utf16), down: true), .text(Array("cd".utf16), down: false),
    ])
    XCTAssertTrue(steps.allSatisfy { $0.event.flags == [] })
    XCTAssertEqual(steps.map(\.pause), [0, 0.012, 0.005, 0.012, 0, 0.012])
    XCTAssertEqual(steps.filter(\.isRelease).count, 3)
    XCTAssertEqual(TypingEvents.steps(""), [])
  }

  // ---------------------------------------------------------------- the CGEvents made from the data (never posted)

  func testMadeMouseEventCarriesEveryField() throws {
    let spec = BackgroundEvents.click(at: point, button: .left, count: 2, flags: .maskAlternate, window: window)[3].event
    let event = try spec.make(source: nil)
    XCTAssertEqual(event.type, .leftMouseDown)
    XCTAssertEqual(event.location, point)
    XCTAssertTrue(event.flags.contains(.maskAlternate))
    XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 2)
    XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointer), 4711)
    XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent), 4711)
  }

  func testMadeScrollEvent() throws {
    let spec = BackgroundEvents.scroll(at: point, dx: 0, dy: 5, window: window)[1].event
    let event = try spec.make(source: nil)
    XCTAssertEqual(event.type, .scrollWheel)
    XCTAssertEqual(event.location, point)
    XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventDeltaAxis1), -5)
    XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventIsContinuous), 0)
  }

  /// Why the scroll is aimed by its location: CoreGraphics drops the window fields on a scroll event, where a mouse
  /// event keeps them.
  func testAScrollEventHasNoRoomForTheWindow() throws {
    let scroll = try EventSpec.scroll(at: point, wheel1: -1, wheel2: 0).with(BackgroundEvents.windowFields(window)).make(source: nil)
    XCTAssertEqual(scroll.getIntegerValueField(.mouseEventWindowUnderMousePointer), 0)
    let move = try EventSpec.mouse(.mouseMoved, at: point, button: .left).with(BackgroundEvents.windowFields(window)).make(source: nil)
    XCTAssertEqual(move.getIntegerValueField(.mouseEventWindowUnderMousePointer), 4711)
  }

  func testMadeKeyEvents() throws {
    let key = try EventSpec.key(8, down: false, flags: .maskControl).make(source: nil)
    XCTAssertEqual(key.type, .keyUp)
    XCTAssertEqual(key.getIntegerValueField(.keyboardEventKeycode), 8)
    XCTAssertTrue(key.flags.contains(.maskControl))

    let text = try EventSpec.text(Array("é😀".utf16), down: true).make(source: nil)
    XCTAssertEqual(text.type, .keyDown)
    var length = 0
    var units = [UniChar](repeating: 0, count: 8)
    text.keyboardGetUnicodeString(maxStringLength: units.count, actualStringLength: &length, unicodeString: &units)
    XCTAssertEqual(Array(units.prefix(length)), Array("é😀".utf16))

    let modifier = try EventSpec.modifier(.shift, flags: .maskShift).make(source: nil)
    XCTAssertEqual(modifier.type, .flagsChanged)
    XCTAssertEqual(modifier.getIntegerValueField(.keyboardEventKeycode), Int64(Modifier.shift.keyCode))
  }
}

final class BackgroundRequestTests: XCTestCase {
  private func code(_ body: () throws -> Void) -> Int? {
    do {
      try body()
      return nil
    } catch {
      return (error as? RPCError)?.code
    }
  }

  private let invalid = ComputerErrorCode.invalidParams.rawValue

  private func click(window: String = "12", x: Double = 1, y: Double = 2, button: MouseButton = .left, count: Int = 1, modifiers: [String] = []) -> BgClickParams {
    BgClickParams(window: window, x: x, y: y, button: button, count: count, modifiers: modifiers)
  }

  func testClick() throws {
    let request = try Background.Click(click(count: 2, modifiers: ["cmd", "command", "shift"]))
    XCTAssertEqual(request.window, 12)
    XCTAssertEqual(request.point, CGPoint(x: 1, y: 2))
    XCTAssertEqual(request.modifiers, [.command, .shift])
    XCTAssertEqual(code { _ = try Background.Click(self.click(count: 0)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(count: 4)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(modifiers: ["hyper"])) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(x: .nan)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(y: .infinity)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(x: 2_000_000)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Click(self.click(window: "w1")) }, invalid)
  }

  func testOnlyAPlainLeftClickIsAPress() throws {
    XCTAssertTrue(try Background.Click(click()).isPlainClick)
    XCTAssertFalse(try Background.Click(click(count: 2)).isPlainClick)
    XCTAssertFalse(try Background.Click(click(button: .right)).isPlainClick)
    XCTAssertFalse(try Background.Click(click(button: .middle)).isPlainClick)
    XCTAssertFalse(try Background.Click(click(modifiers: ["cmd"])).isPlainClick)
  }

  func testScroll() throws {
    let scroll = { (dx: Double, dy: Double) in BgScrollParams(window: "5", x: 1, y: 1, dx: dx, dy: dy) }
    XCTAssertEqual(try Background.Scroll(scroll(-3, 10_000)).dy, 10_000)
    XCTAssertEqual(code { _ = try Background.Scroll(scroll(.infinity, 0)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Scroll(scroll(0, -10_001)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Scroll(BgScrollParams(window: "", x: 1, y: 1, dx: 0, dy: 1)) }, invalid)
  }

  func testKey() throws {
    XCTAssertEqual(try Background.Key(BgKeyParams(window: "7", keys: ["a"], repeat: nil)).count, 1)
    XCTAssertEqual(try Background.Key(BgKeyParams(window: "7", keys: ["a"], repeat: 100)).count, 100)
    XCTAssertEqual(code { _ = try Background.Key(BgKeyParams(window: "7", keys: ["a"], repeat: 0)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Key(BgKeyParams(window: "7", keys: ["a"], repeat: 101)) }, invalid)
    XCTAssertEqual(code { _ = try Background.Key(BgKeyParams(window: "0", keys: ["a"], repeat: nil)) }, invalid)
  }

  func testTyping() throws {
    XCTAssertEqual(try Background.Typing(BgTypeParams(window: "7", text: "hi")).text, "hi")
    let long = String(repeating: "x", count: 100_001)
    XCTAssertEqual(code { _ = try Background.Typing(BgTypeParams(window: "7", text: long)) }, invalid)
  }

  func testCaptureOutput() throws {
    let output = try Capture.output(maxWidth: 1280, maxHeight: 800.7, quality: nil)
    XCTAssertEqual(output.maxWidth, 1280)
    XCTAssertEqual(output.maxHeight, 800)
    XCTAssertEqual(output.quality, 0.8)
    XCTAssertEqual(code { _ = try Capture.output(maxWidth: 0, maxHeight: 10, quality: nil) }, invalid)
    XCTAssertEqual(code { _ = try Capture.output(maxWidth: 10, maxHeight: 16385, quality: nil) }, invalid)
    XCTAssertEqual(code { _ = try Capture.output(maxWidth: 10, maxHeight: 10, quality: 1.5) }, invalid)
    XCTAssertEqual(code { _ = try Capture.output(maxWidth: .nan, maxHeight: 10, quality: nil) }, invalid)
  }

  func testWindowTitles() {
    XCTAssertNil(Capture.windowTitle(nil))
    XCTAssertNil(Capture.windowTitle("  \n"))
    XCTAssertEqual(Capture.windowTitle("  Inbox — Mail "), "Inbox — Mail")
    XCTAssertEqual(Capture.windowTitle(String(repeating: "t", count: 500))?.count, 200)
  }

  func testWindowCaptureResultWritesANullTitle() throws {
    let result = WindowCaptureResult(
      data: "", mime: "image/png", width: 1, height: 1, rect: ScreenRect(x: 0, y: 0, width: 1, height: 1), window: "3",
      title: nil)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.encoder().encode(result)) as? [String: Any])
    XCTAssertTrue(json["title"] is NSNull)
    XCTAssertEqual(json["window"] as? String, "3")
  }
}

final class PressChoiceTests: XCTestCase {
  private func target(_ chain: [Background.Node]) -> Int? {
    Background.pressTarget { $0 < chain.count ? chain[$0] : nil }
  }

  private func node(_ role: String?, press: Bool = true) -> Background.Node {
    Background.Node(role: role, actions: press ? ["AXShowMenu", "AXPress"] : ["AXShowMenu"])
  }

  func testAControlUnderThePoint() {
    for role in ["AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXDisclosureTriangle", "AXPopUpButton"] {
      XCTAssertEqual(target([node(role)]), 0, role)
    }
  }

  func testThroughALabelOrIconToItsControl() {
    XCTAssertEqual(target([node("AXStaticText", press: false), node("AXButton")]), 1)
    XCTAssertEqual(target([node("AXImage", press: false), node("AXGroup", press: false), node("AXLink")]), 2)
    XCTAssertEqual(
      target([node("AXStaticText"), node("AXGroup"), node("AXGroup"), node("AXLink")]), 3)
    // No deeper than three levels up.
    XCTAssertNil(target([node("AXStaticText"), node("AXGroup"), node("AXGroup"), node("AXGroup"), node("AXLink")]))
  }

  func testEverythingElseIsAPostedClick() {
    XCTAssertNil(target([node("AXButton", press: false)]))  // a control without AXPress
    XCTAssertNil(target([node("AXTextField")]))
    XCTAssertNil(target([node("AXStaticText"), node("AXWebArea"), node("AXButton")]))  // not passive in between
    XCTAssertNil(target([node("AXStaticText")]))  // no parent
    XCTAssertNil(target([node(nil)]))
    XCTAssertNil(target([]))
  }

  func testPressOutcomes() throws {
    XCTAssertEqual(try Background.outcome(.success), .pressed)
    // A press that opened a dialog keeps the app from answering: it went in, so it isn't clicked again.
    XCTAssertEqual(try Background.outcome(.cannotComplete), .pressed)
    for error in [AXError.actionUnsupported, .failure, .invalidUIElement, .illegalArgument, .notImplemented] {
      XCTAssertEqual(try Background.outcome(error), .post, "\(error.rawValue)")
    }
    XCTAssertThrowsError(try Background.outcome(.apiDisabled)) { error in
      XCTAssertEqual((error as? RPCError)?.code, ComputerErrorCode.permission.rawValue)
    }
  }
}
