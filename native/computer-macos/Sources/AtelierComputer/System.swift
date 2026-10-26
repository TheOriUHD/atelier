import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum Permissions {
  static func status() -> PermissionsStatus {
    PermissionsStatus(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
  }

  /// Shows the OS prompt (or opens the right pane of System Settings) when the permission is missing.
  @MainActor
  static func request(_ kind: PermissionKind) -> PermissionsStatus {
    switch kind {
    case .accessibility:
      // kAXTrustedCheckOptionPrompt's value, spelled out (the global isn't concurrency-safe in Swift 6).
      _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    case .screenRecording:
      _ = CGRequestScreenCaptureAccess()
    }
    return status()
  }
}

enum Displays {
  static func activeIDs() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
  }

  static func isActive(_ id: CGDirectDisplayID) -> Bool {
    activeIDs().contains(id)
  }

  @MainActor
  static func list() -> [HelperDisplay] {
    let main = CGMainDisplayID()
    let screens = NSScreen.screens
    let displays = activeIDs().map { id -> HelperDisplay in
      let bounds = CGDisplayBounds(id)
      let screen = screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
      }
      return HelperDisplay(
        id: String(id), name: screen?.localizedName ?? "Display \(id)",
        scale: screen.map { Double($0.backingScaleFactor) } ?? modeScale(id), primary: id == main,
        x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
    }
    return displays.sorted { $0.primary && !$1.primary }
  }

  static func pixelScale(_ id: CGDirectDisplayID) -> Double { modeScale(id) }

  /// Pixels per point from the display mode, for a display NSScreen doesn't know (yet).
  private static func modeScale(_ id: CGDirectDisplayID) -> Double {
    guard let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 else { return 1 }
    return Double(mode.pixelWidth) / Double(mode.width)
  }
}

/// A running app, read on the main thread (NSRunningApplication's values change with the main run loop).
struct RunningApp: Sendable {
  var id: String
  var name: String
  var path: String?
  var pid: pid_t
  var active: Bool
  var hidden: Bool
  var regular: Bool
}

/// An .app bundle found in an application folder.
struct InstalledApp: Sendable, Equatable {
  var id: String
  var name: String
  var path: String
  var category: String?
}

enum Apps {
  @MainActor
  static func running() -> [RunningApp] {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return NSWorkspace.shared.runningApplications.compactMap { describe($0, front: front) }
  }

  @MainActor
  static func describe(_ app: NSRunningApplication, front: pid_t?) -> RunningApp? {
    guard let id = app.bundleIdentifier, !id.isEmpty, !app.isTerminated else { return nil }
    let path = app.bundleURL?.path
    let name = app.localizedName ?? path.flatMap { info(at: URL(fileURLWithPath: $0))?.name } ?? id
    return RunningApp(
      id: id, name: name, path: path, pid: app.processIdentifier, active: app.processIdentifier == front,
      hidden: app.isHidden, regular: app.activationPolicy == .regular)
  }

  @MainActor
  static func running(pid: pid_t) -> RunningApp? {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
    return describe(app, front: NSWorkspace.shared.frontmostApplication?.processIdentifier)
  }

  @MainActor
  static func frontmost() -> RunningApp? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return describe(app, front: app.processIdentifier)
  }

  static func helperApp(_ app: RunningApp, category: String? = nil) -> HelperApp {
    HelperApp(
      id: app.id, name: clip(app.name, fallback: app.id), path: app.path, pid: Int(app.pid), running: true,
      active: app.active, hidden: app.hidden,
      category: category ?? app.path.flatMap { info(at: URL(fileURLWithPath: $0))?.category })
  }

  static func helperApp(_ app: InstalledApp) -> HelperApp {
    HelperApp(
      id: app.id, name: clip(app.name, fallback: app.id), path: app.path, pid: nil, running: false, active: false,
      hidden: false, category: app.category)
  }

  /// The running regular apps, and with `installed` the apps in the application folders too: one entry per bundle
  /// id, a running copy's details winning over the installed one's, sorted by name.
  static func merge(running: [RunningApp], installed: [InstalledApp]?) -> [HelperApp] {
    var apps: [String: HelperApp] = [:]
    for app in running where app.regular && apps[app.id] == nil {
      apps[app.id] = helperApp(app)
    }
    if let installed {
      let anyRunning = Dictionary(running.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      for app in installed where apps[app.id] == nil {
        if let live = anyRunning[app.id] {
          apps[app.id] = helperApp(live, category: app.category)
        } else {
          apps[app.id] = helperApp(app)
        }
      }
    }
    return apps.values.sorted {
      let order = $0.name.localizedCaseInsensitiveCompare($1.name)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }

  static func list(installed: Bool) async -> [HelperApp] {
    let live = await MainActor.run { running() }
    return merge(running: live, installed: installed ? scanInstalled() : nil)
  }

  /// The standard application folders, and one level of subfolders in each (`/Applications/Utilities`, suites).
  static func applicationFolders() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [
      URL(fileURLWithPath: "/Applications"),
      URL(fileURLWithPath: "/System/Applications"),
      URL(fileURLWithPath: "/System/Applications/Utilities"),
      home.appendingPathComponent("Applications"),
    ]
  }

  /// The first copy of a bundle id wins: folders in order, entries by name.
  static func scanInstalled(folders: [URL] = applicationFolders()) -> [InstalledApp] {
    let files = FileManager.default
    var seenPaths = Set<String>()
    var seenIDs = Set<String>()
    var apps: [InstalledApp] = []
    func add(_ url: URL) {
      let path = url.standardizedFileURL.path
      guard seenPaths.insert(path).inserted, let info = info(at: url), seenIDs.insert(info.id).inserted else { return }
      apps.append(InstalledApp(id: info.id, name: info.name, path: path, category: info.category))
    }
    func entries(_ folder: URL) -> [URL] {
      (try? files.contentsOfDirectory(
        at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]))?
        .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending } ?? []
    }
    for folder in folders {
      for entry in entries(folder) {
        if entry.pathExtension == "app" {
          add(entry)
        } else if (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
          for inner in entries(entry) where inner.pathExtension == "app" { add(inner) }
        }
      }
    }
    return apps
  }

  /// An app bundle's id, name (`CFBundleDisplayName`, else `CFBundleName`, else the file name) and
  /// `LSApplicationCategoryType`.
  static func info(at url: URL) -> (id: String, name: String, category: String?)? {
    let plist = url.appendingPathComponent("Contents/Info.plist")
    var dictionary: [String: Any]?
    if let data = try? Data(contentsOf: plist) {
      dictionary = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }
    if dictionary == nil { dictionary = Bundle(url: url)?.infoDictionary }  // e.g. iPad apps' wrapper bundles
    guard let dictionary, let id = dictionary["CFBundleIdentifier"] as? String, !id.isEmpty else { return nil }
    let fileName = url.deletingPathExtension().lastPathComponent
    let name = [dictionary["CFBundleDisplayName"], dictionary["CFBundleName"]]
      .compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty } ?? fileName
    let category = (dictionary["LSApplicationCategoryType"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    return (id, name, category)
  }

  static func clip(_ name: String, fallback: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let value = trimmed.isEmpty ? fallback : trimmed
    return String(value.prefix(200))
  }

  static func frontmostApp() async -> HelperApp? {
    await MainActor.run { frontmost() }.map { helperApp($0) }
  }

  static func open(id: String, activate: Bool) async throws -> HelperApp {
    guard !id.isEmpty else { throw RPCError.invalidParams("id must not be empty") }
    guard let url = await MainActor.run(body: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) })
    else { throw RPCError.notFound("no app \(id)") }
    let deadline = Date().addingTimeInterval(10)

    let failure: NSError? = await withCheckedContinuation { continuation in
      let once = Once()
      DispatchQueue.main.async {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = activate
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
          if once.claim() { continuation.resume(returning: error.map { $0 as NSError }) }
        }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
        if once.claim() { continuation.resume(returning: nil) }
      }
    }
    if let failure {
      if failure.domain == NSCocoaErrorDomain, failure.code == NSFileNoSuchFileError || failure.code == NSFileReadNoSuchFileError {
        throw RPCError.notFound("no app \(id)")
      }
      throw RPCError.internal("could not open \(id): \(failure.localizedDescription)")
    }

    // Running once it shows up; finished launching (its windows are up) if that happens before the deadline.
    var found: RunningApp?
    while true {
      let state = await MainActor.run { () -> (RunningApp, Bool)? in
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id)
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard let app = apps.first(where: { $0.isFinishedLaunching }) ?? apps.first,
          let described = describe(app, front: front)
        else { return nil }
        return (described, app.isFinishedLaunching)
      }
      if let state {
        found = state.0
        if state.1 { break }
      }
      if Date() >= deadline { break }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    guard let found else { throw RPCError.notFound("\(id) didn't start within 10 s") }
    return helperApp(found)
  }

  @MainActor
  static func hide(ids: [String]) -> [String] {
    var hidden: [String] = []
    for id in ids {
      var did = false
      for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) where !app.isHidden {
        if app.hide() { did = true }
      }
      if did && !hidden.contains(id) { hidden.append(id) }
    }
    return hidden
  }

  @MainActor
  static func unhide(ids: [String]) {
    for id in ids {
      // Unhiding a shown app does nothing, and this process's idea of which are hidden may lag behind.
      for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) {
        app.unhide()
      }
    }
  }
}

/// True for the first caller only.
final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false

  func claim() -> Bool {
    lock.withLock {
      if done { return false }
      done = true
      return true
    }
  }
}
