import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// A window as the window server lists it (`CGWindowListCopyWindowInfo`, which needs no permission for this much).
public struct WindowInfo: Equatable, Sendable {
  public var id: CGWindowID
  public var pid: pid_t
  public var layer: Int
  /// Global points, the top-left of the main display at 0,0 (the space of `CGDisplayBounds`).
  public var bounds: CGRect
  public var alpha: Double
  public var onScreen: Bool

  public init(id: CGWindowID, pid: pid_t, layer: Int, bounds: CGRect, alpha: Double = 1, onScreen: Bool = true) {
    self.id = id
    self.pid = pid
    self.layer = layer
    self.bounds = bounds
    self.alpha = alpha
    self.onScreen = onScreen
  }

  /// One entry of the window list; nil when it lacks a number, an owner or bounds.
  public init?(_ entry: [String: Any]) {
    guard let number = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value, number > 0,
      let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary)
    else { return nil }
    self.init(
      id: number, pid: pid, layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: bounds,
      alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
      onScreen: (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
  }
}

/// Which window background mode works in, and the checks on the window a `bg.*` call names.
public enum WindowChoice {
  /// The smallest width and height of a window the person works in (not a helper sliver or an off-screen 1×1).
  public static let minimumSide: Double = 40

  /// A window the person works in: on the normal layer, on screen, not transparent, of a reasonable size.
  public static func isNormal(_ window: WindowInfo) -> Bool {
    window.layer == 0 && window.onScreen && window.alpha > 0 && window.bounds.width >= minimumSide
      && window.bounds.height >= minimumSide
  }

  /// The app's frontmost normal window: the first of its processes' in a front-to-back window list that is on a display
  /// (some apps park windows far outside every display; with no displays given, that isn't checked).
  public static func frontmost(_ windows: [WindowInfo], pids: Set<pid_t>, displays: [CGRect] = []) -> WindowInfo? {
    windows.first { window in
      pids.contains(window.pid) && isNormal(window)
        && (displays.isEmpty || displays.contains { $0.intersects(window.bounds) })
    }
  }

  /// The window number a `bg.*` call names, as `window.capture` wrote it.
  public static func windowID(_ raw: String) throws -> CGWindowID {
    guard !raw.isEmpty, raw.count <= 10, raw.allSatisfy({ $0.isASCII && $0.isNumber }), let id = UInt32(raw), id > 0
    else { throw RPCError.invalidParams("window must be a window number from window.capture, not \"\(raw.prefix(40))\"") }
    return id
  }

  /// Whether a global point is inside a window: its left and top edges included, its right and bottom ones not.
  public static func contains(_ bounds: CGRect, _ point: CGPoint) -> Bool {
    !bounds.isNull && bounds.width > 0 && bounds.height > 0 && bounds.contains(point)
  }

  public static func check(_ point: CGPoint, in window: WindowInfo) throws {
    guard contains(window.bounds, point) else {
      let b = window.bounds
      throw RPCError.invalidParams(
        "the point \(format(point.x)),\(format(point.y)) is outside window \(window.id) (x \(format(b.minX))–\(format(b.maxX)), y \(format(b.minY))–\(format(b.maxY)))"
      )
    }
  }

  private static func format(_ value: CGFloat) -> String {
    value == value.rounded() ? String(Int(value)) : String(format: "%.1f", Double(value))
  }
}

extension RPCError {
  /// -32033 with why, in `data.reason`: `notRunning`, `hidden`, `noWindow` (none on screen), `gone` (closed),
  /// `offScreen` (minimized, hidden or on another Space since it was captured).
  static func noWindow(_ message: String, reason: String) -> RPCError {
    RPCError(.notFound, message, data: .object(["reason": .string(reason)]))
  }
}

enum Windows {
  /// The app's frontmost normal window on screen, on one of the displays.
  static func frontmost(pids: Set<pid_t>) -> WindowInfo? {
    WindowChoice.frontmost(list(onScreenOnly: true), pids: pids, displays: Displays.activeIDs().map(CGDisplayBounds))
  }

  /// The windows, front to back.
  static func list(onScreenOnly: Bool) -> [WindowInfo] {
    let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll]
    guard let entries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return entries.compactMap(WindowInfo.init)
  }

  static func info(_ id: CGWindowID) -> WindowInfo? {
    guard let entries = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] else { return nil }
    return entries.compactMap(WindowInfo.init).first { $0.id == id }
  }

  /// The window a `bg.*` call names: it still exists and belongs to a running app; with `onScreen` (the calls that
  /// act at a point), it is on screen too. Nothing here waits on the main thread.
  static func target(_ raw: String, onScreen: Bool) throws -> WindowInfo {
    let id = try WindowChoice.windowID(raw)
    guard let window = info(id) else {
      throw RPCError.noWindow("window \(raw) is gone: take a new window.capture", reason: "gone")
    }
    guard isRunningApp(window.pid) else {
      throw RPCError.noWindow("window \(raw) doesn't belong to a running app", reason: "notRunning")
    }
    if onScreen && !window.onScreen {
      throw RPCError.noWindow(
        "window \(raw) isn't on screen (minimized, hidden or on another Space): take a new window.capture",
        reason: "offScreen")
    }
    return window
  }

  /// A live process that is an app (NSRunningApplication only knows apps, not daemons).
  static func isRunningApp(_ pid: pid_t) -> Bool {
    guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else { return false }
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    return !app.isTerminated
  }

  /// Restores a minimized window of these processes through Accessibility, without activating the app: the first
  /// standard window it lists as minimized, else the first minimized one. False when none is minimized.
  static func restoreMinimized(pids: [pid_t]) throws -> Bool {
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }
    for pid in pids {
      let app = Inspect.application(pid)
      guard let windows = Inspect.copy(app, kAXWindowsAttribute)
        .flatMap({ $0 as? [AnyObject] })?.compactMap({ Inspect.asElement($0) })
      else { continue }
      let minimized = windows.filter { (Inspect.copy($0, kAXMinimizedAttribute) as? Bool) == true }
      let standard = minimized.first { (Inspect.copy($0, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole }
      guard let window = standard ?? minimized.first else { continue }
      let status = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
      if status == .apiDisabled { throw RPCError.permission(.accessibility) }
      guard status == .success else {
        throw RPCError.unsupported("the app's minimized window couldn't be restored (Accessibility error \(status.rawValue))")
      }
      return true
    }
    return false
  }

  /// Waits for one of these processes' windows to be on screen and settled (a restored window animates out of the
  /// Dock), at most `timeout` seconds.
  static func waitForWindow(pids: Set<pid_t>, timeout: Double) async -> WindowInfo? {
    let deadline = Date().addingTimeInterval(timeout)
    var last: WindowInfo?
    while Date() < deadline {
      let window = frontmost(pids: pids)
      if let window, let previous = last, previous.id == window.id, previous.bounds == window.bounds {
        return window
      }
      last = window
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
    return last
  }
}
