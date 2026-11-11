import XCTest

@testable import AtelierComputer

final class ElementsTests: XCTestCase {
  private func item(_ name: String, x: Double, y: Double) -> CapturedElement {
    CapturedElement(role: "button", name: name, value: nil, rect: ScreenRect(x: x, y: y, width: 40, height: 20))
  }

  func testReadingOrderIsRowsThenLeftToRight() {
    let items = [item("c", x: 300, y: 104), item("a", x: 10, y: 100), item("b", x: 120, y: 98), item("d", x: 10, y: 160)]
    XCTAssertEqual(Elements.ordered(items).map(\.name), ["a", "b", "c", "d"])
  }

  func testShortRoles() {
    XCTAssertEqual(Elements.shortRole("AXButton", subrole: nil), "button")
    XCTAssertEqual(Elements.shortRole("AXTextField", subrole: nil), "textfield")
    XCTAssertEqual(Elements.shortRole("AXTextField", subrole: "AXSecureTextField"), "password")
    XCTAssertEqual(Elements.shortRole("AXPopUpButton", subrole: nil), "list")
    XCTAssertEqual(Elements.shortRole("AXCheckBox", subrole: nil), "checkbox")
    XCTAssertEqual(Elements.shortRole("AXCell", subrole: nil), "cell")
  }

  func testCaptureResultCarriesElementsOnTheWire() throws {
    let result = WindowCaptureResult(data: "", mime: "image/jpeg", width: 10, height: 10, rect: ScreenRect(x: 0, y: 0, width: 10, height: 10), window: "1", title: nil, elements: [item("Save", x: 1, y: 2)])
    let json = String(data: try JSONEncoder().encode(result), encoding: .utf8)!
    XCTAssertTrue(json.contains("\"elements\":[{"))
    XCTAssertTrue(json.contains("\"name\":\"Save\""))
  }
}
