import SwiftUI
import XCTest
@testable import Atelier

@MainActor final class KeyboardTests: XCTestCase {
    func testAFieldInAPresentedControllerIsNotThePages() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let root = UIViewController()
        let pageField = UITextField()
        root.view.addSubview(pageField)
        window.rootViewController = root
        window.makeKeyAndVisible()
        let sheet = UIViewController()
        let sheetField = UITextField()
        sheet.view.addSubview(sheetField)
        root.present(sheet, animated: false)
        XCTAssertNil(KeyboardProbe.presentation(of: pageField), "what is on the screen itself is no presentation")
        XCTAssertTrue(KeyboardProbe.presentation(of: sheetField) === sheet, "an alert's, a sheet's or a popover's field belongs to its presentation, wherever it floats")
        // A page that is itself in a presentation shares it with its own fields.
        let inner = UITextField()
        sheet.view.addSubview(inner)
        XCTAssertTrue(KeyboardProbe.presentation(of: inner) === KeyboardProbe.presentation(of: sheetField))
    }

    func testTheContainersUnderThePagesAreNotBlack() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let root = UIViewController()
        root.view.backgroundColor = .black
        let inner = UIView()
        inner.backgroundColor = UIColor(red: 0, green: 0, blue: 0, alpha: 1)
        root.view.addSubview(inner)
        let transparent = UIView()
        transparent.backgroundColor = UIColor(red: 0, green: 0, blue: 0, alpha: 0)
        root.view.addSubview(transparent)
        let grey = UIView()
        grey.backgroundColor = UIColor(white: 0.2, alpha: 1)
        root.view.addSubview(grey)
        window.rootViewController = root
        window.makeKeyAndVisible()
        PaperVoid.paint(window)
        XCTAssertFalse(PaperVoid.isOpaqueBlack(root.view))
        XCTAssertFalse(PaperVoid.isOpaqueBlack(inner))
        XCTAssertEqual(transparent.backgroundColor?.cgColor.alpha, 0, "a view made see-through stays so")
        XCTAssertEqual(grey.backgroundColor, UIColor(white: 0.2, alpha: 1), "only black is painted over")
        XCTAssertNotNil(window.backgroundColor)
    }

    func testAPageIsPaintedAsItArrivesAndASheetIsLeftAlone() {
        PaperVoid.paintHostingViewsAsTheyArrive()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let page = UIHostingController(rootView: Text("page"))
        page.view.backgroundColor = .black
        window.rootViewController = page
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(PaperVoid.isOpaqueBlack(page.view), "a page's hosting view is painted when it joins the window")
        let sheet = UIHostingController(rootView: Text("sheet"))
        sheet.view.backgroundColor = .black
        page.present(sheet, animated: false)
        XCTAssertTrue(PaperVoid.isOpaqueBlack(sheet.view), "the look of a sheet is the presentation's own")
    }

    private final class TestHostingView: UIView {}

    func testTheArrivalHookRunsForAHostingViewClass() {
        PaperVoid.paintHostingViewsAsTheyArrive()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        let view = TestHostingView(frame: root.view.bounds)
        view.backgroundColor = .black
        root.view.addSubview(view)
        XCTAssertFalse(PaperVoid.isOpaqueBlack(view))
    }
}
