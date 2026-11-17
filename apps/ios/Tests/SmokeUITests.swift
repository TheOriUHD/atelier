import XCTest

final class SmokeUITests: XCTestCase {
    @MainActor func testSignInScreenAndValidation() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Welcome to Atelier"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["https://atelier.example.com"].exists)
        XCTAssertTrue(app.textFields["Username"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertFalse(app.buttons["Connect"].isEnabled)
        XCTAssertTrue(app.buttons["Use passkey or SSO in browser"].exists)
    }
}
