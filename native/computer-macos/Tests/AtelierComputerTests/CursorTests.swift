import CoreGraphics
import XCTest

@testable import AtelierComputer

final class CursorTests: XCTestCase {
  /// The arrow's tip lands on the point it acts on: global top-left coordinates turned into the window's Cocoa origin.
  @MainActor
  func testTipSitsOnThePoint() {
    let origin = SoftwareCursor.origin(for: CGPoint(x: 500, y: 300), primaryHeight: 1000)
    XCTAssertEqual(origin, CGPoint(x: 478, y: 658))
    // The tip in the window, counted from the bottom like the window's layer: origin + tip is the point flipped.
    XCTAssertEqual(origin.x + SoftwareCursor.tipInLayer.x, 500)
    XCTAssertEqual(origin.y + SoftwareCursor.tipInLayer.y, 1000 - 300)
  }

  /// The arrow points up and to the left from its tip: everything else is right of and below it.
  @MainActor
  func testArrowPointsUpAndLeft() {
    let box = SoftwareCursor.arrowPath().boundingBox
    XCTAssertEqual(box.minX, 0)
    XCTAssertEqual(box.maxY, 0)
    XCTAssertGreaterThan(box.width, 10)
    XCTAssertGreaterThan(box.height, 20)
  }
}
