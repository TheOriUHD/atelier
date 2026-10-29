import CoreGraphics
import XCTest

@testable import AtelierComputer

final class EscTrackerTests: XCTestCase {
  func testShortPressIsDownThenUp() {
    var esc = EscTracker()
    XCTAssertEqual(esc.keyDown(at: 1000, autorepeat: false), [.down])
    XCTAssertEqual(esc.tick(at: 1300, physicallyDown: true), [])
    XCTAssertEqual(esc.keyUp(at: 1420), [.up(heldMs: 420)])
    XCTAssertFalse(esc.isDown)
  }

  func testHoldingASecondStops() {
    var esc = EscTracker()
    XCTAssertEqual(esc.keyDown(at: 0, autorepeat: false), [.down])
    XCTAssertEqual(esc.tick(at: 950, physicallyDown: true), [])
    XCTAssertEqual(esc.tick(at: 1000, physicallyDown: true), [.stopped(heldMs: 1000)])
    // Only once per hold, and no `up` after a stop.
    XCTAssertEqual(esc.tick(at: 1050, physicallyDown: true), [])
    XCTAssertEqual(esc.keyDown(at: 1100, autorepeat: true), [])
    XCTAssertEqual(esc.keyUp(at: 1500), [])
    // The next press starts over.
    XCTAssertEqual(esc.keyDown(at: 3000, autorepeat: false), [.down])
    XCTAssertEqual(esc.keyUp(at: 3100), [.up(heldMs: 100)])
  }

  func testAutorepeatAdvancesTheHold() {
    var esc = EscTracker()
    _ = esc.keyDown(at: 0, autorepeat: false)
    XCTAssertEqual(esc.keyDown(at: 500, autorepeat: true), [])
    XCTAssertEqual(esc.keyDown(at: 1033, autorepeat: true), [.stopped(heldMs: 1033)])
  }

  func testAutorepeatAloneDoesNotStartAHold() {
    var esc = EscTracker()
    XCTAssertEqual(esc.keyDown(at: 0, autorepeat: true), [])
    XCTAssertFalse(esc.isDown)
  }

  func testThePollAloneDetectsAHold() {
    // Secure input on: the tap sees nothing, the key-state poll does.
    var esc = EscTracker()
    XCTAssertEqual(esc.tick(at: 0, physicallyDown: false), [])
    XCTAssertEqual(esc.tick(at: 50, physicallyDown: true), [.down])
    XCTAssertEqual(esc.tick(at: 1000, physicallyDown: true), [])
    XCTAssertEqual(esc.tick(at: 1050, physicallyDown: true), [.stopped(heldMs: 1000)])
  }

  func testThePollSeesAnEarlyRelease() {
    var esc = EscTracker()
    _ = esc.tick(at: 0, physicallyDown: true)
    XCTAssertEqual(esc.tick(at: 300, physicallyDown: false), [.up(heldMs: 300)])
    // The tap's late key-up adds nothing.
    XCTAssertEqual(esc.keyUp(at: 310), [])
  }

  func testAPollThatNeverSeesTheKeyCannotCancelATapHold() {
    // If reading the key state doesn't work, the tap's hold still reaches the stop.
    var esc = EscTracker()
    _ = esc.keyDown(at: 0, autorepeat: false)
    XCTAssertEqual(esc.tick(at: 50, physicallyDown: false), [])
    XCTAssertEqual(esc.tick(at: 500, physicallyDown: false), [])
    XCTAssertEqual(esc.tick(at: 1000, physicallyDown: false), [.stopped(heldMs: 1000)])
  }

  func testAPollThatSawTheKeyEndsATapHold() {
    // The tap missed the key-up (secure input came on mid-hold).
    var esc = EscTracker()
    _ = esc.keyDown(at: 0, autorepeat: false)
    XCTAssertEqual(esc.tick(at: 50, physicallyDown: true), [])
    XCTAssertEqual(esc.tick(at: 400, physicallyDown: false), [.up(heldMs: 400)])
  }

  func testUnknownKeyStateChangesNothing() {
    // The helper is pressing Esc itself: nil.
    var esc = EscTracker()
    XCTAssertEqual(esc.tick(at: 0, physicallyDown: nil), [])
    XCTAssertFalse(esc.isDown)
  }

  func testTapAndPollTogetherReportOnce() {
    var esc = EscTracker()
    XCTAssertEqual(esc.tick(at: 0, physicallyDown: true), [.down])
    XCTAssertEqual(esc.keyDown(at: 5, autorepeat: false), [])
    XCTAssertEqual(esc.keyUp(at: 200), [.up(heldMs: 200)])
    XCTAssertEqual(esc.tick(at: 250, physicallyDown: false), [])
  }
}

final class UserInputFilterTests: XCTestCase {
  func testAtMostOncePer500msPerKind() {
    for kind in UserInputKind.allCases {
      var filter = UserInputFilter()
      XCTAssertTrue(filter.admit(kind, at: 0))
      XCTAssertFalse(filter.admit(kind, at: 100))
      XCTAssertFalse(filter.admit(kind, at: 499))
      XCTAssertTrue(filter.admit(kind, at: 500))
      XCTAssertFalse(filter.admit(kind, at: 900))
      XCTAssertTrue(filter.admit(kind, at: 1001))
    }
  }

  func testMovesNeverHideAButtonOrAKey() {
    var filter = UserInputFilter()
    // The person moves the pointer, then clicks and types within the same 500 ms: each still goes out.
    XCTAssertTrue(filter.admit(.move, at: 0))
    XCTAssertFalse(filter.admit(.move, at: 50))
    XCTAssertTrue(filter.admit(.mouse, at: 60))
    XCTAssertTrue(filter.admit(.key, at: 70))
    XCTAssertFalse(filter.admit(.mouse, at: 200))
    XCTAssertFalse(filter.admit(.key, at: 300))
    XCTAssertFalse(filter.admit(.move, at: 400))
    XCTAssertTrue(filter.admit(.move, at: 500))
    XCTAssertTrue(filter.admit(.mouse, at: 560))
  }

  func testMovesWithin24PointsAreTheHelpers() {
    let helper = CGPoint(x: 100, y: 100)
    XCTAssertFalse(UserInputFilter.isPersonMove(CGPoint(x: 110, y: 110), helperAt: helper))
    XCTAssertFalse(UserInputFilter.isPersonMove(CGPoint(x: 124, y: 100), helperAt: helper))
    XCTAssertTrue(UserInputFilter.isPersonMove(CGPoint(x: 125, y: 100), helperAt: helper))
    XCTAssertTrue(UserInputFilter.isPersonMove(CGPoint(x: 80, y: 80), helperAt: helper))
    XCTAssertFalse(UserInputFilter.isPersonMove(CGPoint(x: 500, y: 500), helperAt: nil))
  }
}

final class InputMathTests: XCTestCase {
  func testWheelDeltas() {
    // Positive dy scrolls the content down: wheel1 negative. Positive dx: right, wheel2 negative.
    XCTAssertEqual(InputController.wheelDeltas(dx: 0, dy: 3).wheel1, -3)
    XCTAssertEqual(InputController.wheelDeltas(dx: 0, dy: -5).wheel1, 5)
    XCTAssertEqual(InputController.wheelDeltas(dx: 2, dy: 0).wheel2, -2)
    XCTAssertEqual(InputController.wheelDeltas(dx: -2.6, dy: 0).wheel2, 3)
  }

  func testDragPath() {
    let path = InputController.dragPath(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: -50))
    XCTAssertEqual(path.count, 10)
    XCTAssertEqual(path.first, CGPoint(x: 10, y: -5))
    XCTAssertEqual(path.last, CGPoint(x: 100, y: -50))
  }

  func testTheTagIsATLR() {
    XCTAssertEqual(InputController.eventTag, 0x4154_4C52)
    let bytes = withUnsafeBytes(of: UInt32(InputController.eventTag).bigEndian, Array.init)
    XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "ATLR")
  }
}
