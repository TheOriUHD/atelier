import Foundation
import XCTest

@testable import AtelierComputer

final class AppsTests: XCTestCase {
  private func running(_ id: String, _ name: String, pid: Int32, regular: Bool = true, active: Bool = false) -> RunningApp {
    RunningApp(id: id, name: name, path: nil, pid: pid, active: active, hidden: false, regular: regular)
  }

  func testMergeDeduplicatesAndPrefersRunning() {
    let live = [
      running("com.apple.Safari", "Safari", pid: 10, active: true),
      running("com.apple.Safari", "Safari", pid: 11),
      running("com.example.menubar", "Menu Bar Thing", pid: 12, regular: false),
    ]
    let installed = [
      InstalledApp(id: "com.apple.Safari", name: "Safari", path: "/Applications/Safari.app", category: "public.app-category.productivity"),
      InstalledApp(id: "com.example.menubar", name: "Menu Bar Thing", path: "/Applications/Thing.app", category: nil),
      InstalledApp(id: "com.apple.Notes", name: "Notes", path: "/System/Applications/Notes.app", category: nil),
    ]
    let apps = Apps.merge(running: live, installed: installed)
    XCTAssertEqual(apps.map(\.id), ["com.example.menubar", "com.apple.Notes", "com.apple.Safari"])
    let safari = apps.first { $0.id == "com.apple.Safari" }
    XCTAssertEqual(safari?.pid, 10)
    XCTAssertEqual(safari?.active, true)
    XCTAssertEqual(safari?.running, true)
    // An installed app running as an accessory still says it's running.
    XCTAssertEqual(apps.first { $0.id == "com.example.menubar" }?.running, true)
    let notes = apps.first { $0.id == "com.apple.Notes" }
    XCTAssertEqual(notes?.running, false)
    XCTAssertNil(notes?.pid)
    XCTAssertEqual(notes?.path, "/System/Applications/Notes.app")
  }

  func testRunningOnlyListsRegularApps() {
    let apps = Apps.merge(
      running: [running("a.b", "B", pid: 1), running("c.d", "Agent", pid: 2, regular: false)], installed: nil)
    XCTAssertEqual(apps.map(\.id), ["a.b"])
  }

  func testNamesAreClipped() {
    XCTAssertEqual(Apps.clip(String(repeating: "x", count: 300), fallback: "id").count, 200)
    XCTAssertEqual(Apps.clip("  ", fallback: "the.id"), "the.id")
  }

  func testScanReadsBundles() throws {
    // A fake application folder: an app, a suite folder with an app inside, a duplicate id and a non-app.
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("atelier-computer-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    func app(_ relative: String, _ info: [String: String]) throws {
      let contents = root.appendingPathComponent(relative).appendingPathComponent("Contents")
      try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
      let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      try data.write(to: contents.appendingPathComponent("Info.plist"))
    }
    try app("One.app", ["CFBundleIdentifier": "test.one", "CFBundleDisplayName": "One Display", "CFBundleName": "One", "LSApplicationCategoryType": "public.app-category.utilities"])
    try app("Suite/Two.app", ["CFBundleIdentifier": "test.two", "CFBundleName": "Two"])
    try app("Suite/Deeper/Three.app", ["CFBundleIdentifier": "test.three"])
    try app("Zz Copy of One.app", ["CFBundleIdentifier": "test.one"])
    try app("Nameless.app", ["CFBundleIdentifier": "test.nameless"])
    try FileManager.default.createDirectory(at: root.appendingPathComponent("NotAnApp"), withIntermediateDirectories: true)

    let apps = Apps.scanInstalled(folders: [root]).sorted { $0.id < $1.id }
    XCTAssertEqual(apps.map(\.id), ["test.nameless", "test.one", "test.two"])
    XCTAssertEqual(apps[0].name, "Nameless")
    XCTAssertEqual(apps[1].name, "One Display")
    XCTAssertEqual(apps[1].category, "public.app-category.utilities")
    XCTAssertEqual(apps[2].name, "Two")
    XCTAssertNil(apps[2].category)
  }
}

final class InspectTests: XCTestCase {
  func testSecureFields() {
    XCTAssertTrue(Inspect.isSecure(role: "AXSecureTextField", subrole: nil))
    XCTAssertTrue(Inspect.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
    XCTAssertFalse(Inspect.isSecure(role: "AXTextField", subrole: "AXSearchField"))
    XCTAssertFalse(Inspect.isSecure(role: nil, subrole: nil))
  }

  func testTitleFallbacks() {
    XCTAssertEqual(Inspect.title(title: "Save", description: "d", value: "v", secure: false), "Save")
    XCTAssertEqual(Inspect.title(title: "", description: "Close", value: "v", secure: false), "Close")
    XCTAssertEqual(Inspect.title(title: nil, description: "  ", value: "hello", secure: false), "hello")
    // A password field's value is never a title.
    XCTAssertNil(Inspect.title(title: nil, description: nil, value: "hunter2", secure: true))
    // A long value (a document's text) isn't one either.
    XCTAssertNil(Inspect.title(title: nil, description: nil, value: String(repeating: "a", count: 201), secure: false))
    // Titles are at most 200 characters.
    XCTAssertEqual(Inspect.title(title: String(repeating: "t", count: 500), description: nil, value: nil, secure: false)?.count, 200)
  }

  func testDescribe() {
    let field = Inspect.Element(pid: 1, role: "AXTextField", subrole: "AXSecureTextField", title: "Password", link: nil)
    let result = Inspect.describe(field, app: nil)
    XCTAssertTrue(result.secure)
    XCTAssertEqual(result.role, "AXTextField")
    XCTAssertNil(result.link)
    let link = Inspect.Element(pid: 1, role: "AXStaticText", subrole: nil, title: "Docs", link: "")
    XCTAssertEqual(Inspect.describe(link, app: nil).link, "")
    let nothing = Inspect.describe(nil, app: nil)
    XCTAssertFalse(nothing.secure)
    XCTAssertNil(nothing.role)
  }
}
