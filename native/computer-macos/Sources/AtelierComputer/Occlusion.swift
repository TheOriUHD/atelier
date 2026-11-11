import ApplicationServices
import CoreGraphics
import Foundation

/// A window that other windows cover completely isn't drawn: Chromium (Chrome, Electron) and WebKit stop painting its
/// pages (checked on a Mac: a covered Brave showed its new address in the toolbar and an empty page), so its screenshot
/// is stale or blank. For the moment of a screenshot the window is shifted until a sliver of it shows past the windows
/// in front, the page paints, and it goes back where it was: about half a second, the app not brought forward. Claude's
/// helper does the same ("occluderBounds", "candidateOffsets", "wakeChromiumCompositor").
enum Occlusion {
  /// Points sampled across a window, per side, to tell whether any of it shows.
  static let samples = 24

  /// Whether some of `rect` shows: a sampled point in a display and under none of `covers` (the windows in front).
  static func shows(_ rect: CGRect, covers: [CGRect], displays: [CGRect]) -> Bool {
    for point in samplePoints(rect) where displays.contains(where: { $0.contains(point) }) {
      if !covers.contains(where: { $0.contains(point) }) { return true }
    }
    return false
  }

  /// A grid across the window, its edges included (an edge is what a shift uncovers first).
  static func samplePoints(_ rect: CGRect) -> [CGPoint] {
    guard rect.width > 2, rect.height > 2 else { return [] }
    var points: [CGPoint] = []
    for i in 0...samples {
      for j in 0...samples {
        let x = rect.minX + 1 + (rect.width - 2) * Double(i) / Double(samples)
        let y = rect.minY + 1 + (rect.height - 2) * Double(j) / Double(samples)
        points.append(CGPoint(x: x, y: y))
      }
    }
    return points
  }

  /// The smallest shift that leaves a sliver of the window showing, nil when it shows already or no shift up to a
  /// third of the screen does. Down first (the gap above the Dock), then right, left and up.
  static func peekOffset(window rect: CGRect, covers: [CGRect], displays: [CGRect]) -> CGVector? {
    if shows(rect, covers: covers, displays: displays) { return nil }
    let reach = (displays.map { max($0.width, $0.height) }.max() ?? 1000) / 3
    // A strip of a few points doesn't count as showing for macOS (a 4-point shift left the page unpainted; 30 points
    // painted it): at least 24.
    var step: Double = 24
    while step <= reach {
      for offset in [CGVector(dx: 0, dy: step), CGVector(dx: step, dy: 0), CGVector(dx: -step, dy: 0), CGVector(dx: 0, dy: -step)] {
        if shows(rect.offsetBy(dx: offset.dx, dy: offset.dy), covers: covers, displays: displays) { return offset }
      }
      step *= 2
    }
    return nil
  }

  /// The menu bar's window level (`kCGMainMenuWindowLevel`).
  static let menuBarLevel = 24

  /// The windows in front of `window` that hide it, from the on-screen list (front to back): other apps' normal windows
  /// and the menu bar. Windows above the normal level are mostly see-through overlays the window server doesn't count
  /// (the Dock's full-screen window is clear but for the Dock itself; apps float clear full-screen overlays), so they
  /// aren't counted either.
  static func covers(of window: WindowInfo, in list: [WindowInfo]) -> [CGRect] {
    var covers: [CGRect] = []
    for other in list {
      if other.id == window.id { break }
      guard other.layer == 0 || other.layer == menuBarLevel else { continue }
      if other.alpha > 0, other.bounds.width > 1, other.bounds.height > 1 { covers.append(other.bounds) }
    }
    return covers
  }

  /// The window's accessibility element (by its window number), to move it.
  static func element(of window: WindowInfo) -> AXUIElement? {
    let app = Inspect.application(window.pid)
    let windows = (Inspect.copy(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return windows.first { SkyLight.windowNumber(of: $0) == window.id }
  }

  /// When the window is covered completely: shifts it so a sliver shows and returns how to put it back (nil: nothing was
  /// moved). The caller waits for the page to paint, captures, and puts it back.
  static func peek(_ window: WindowInfo) -> (() -> Void)? {
    let list = Windows.list(onScreenOnly: true)
    let displays = Displays.activeIDs().map(CGDisplayBounds)
    guard let offset = peekOffset(window: window.bounds, covers: covers(of: window, in: list), displays: displays),
      let element = element(of: window),
      let raw = Inspect.copy(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID()
    else { return nil }
    var origin = CGPoint.zero
    AXValueGetValue(raw as! AXValue, .cgPoint, &origin)
    var moved = CGPoint(x: origin.x + offset.dx, y: origin.y + offset.dy)
    guard let value = AXValueCreate(.cgPoint, &moved),
      AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) == .success
    else { return nil }
    return {
      var back = origin
      if let value = AXValueCreate(.cgPoint, &back) {
        _ = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value)
      }
      // Back where it was before anything else is done: a click aimed by the screenshot would land off otherwise.
      for _ in 0..<25 {
        if let now = Windows.info(window.id)?.bounds, abs(now.minX - window.bounds.minX) < 1, abs(now.minY - window.bounds.minY) < 1 {
          return
        }
        usleep(20_000)
      }
    }
  }
}
