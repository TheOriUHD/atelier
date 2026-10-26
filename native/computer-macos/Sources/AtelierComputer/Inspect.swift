import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// What is under a point, or has the keyboard focus, as the Accessibility API tells it.
enum Inspect {
  /// The parts of an element `inspect.*` reports, read off the main thread (the AX calls can wait on the app).
  struct Element: Sendable, Equatable {
    var pid: pid_t?
    var role: String?
    var subrole: String?
    var title: String?
    var link: String?
  }

  static func point(_ params: InspectPointParams) async throws -> InspectPointResult {
    guard params.x.isFinite, params.y.isFinite else { throw RPCError.invalidParams("x and y must be numbers") }
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1.0)
    var hit: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(system, Float(params.x), Float(params.y), &hit)
    if status == .apiDisabled { throw RPCError.permission(.accessibility) }
    // No element (an app without accessibility, or one that didn't answer in time): still say whose window it is.
    let element = (status == .success ? hit : nil).map(read)
    let pid = element?.pid ?? windowOwner(at: CGPoint(x: params.x, y: params.y))
    return await result(element, pid: pid)
  }

  static func focused() async throws -> InspectPointResult {
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1.0)
    var focused = copy(system, "AXFocusedUIElement").flatMap(asElement)
    let front = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    if focused == nil, let front {
      // Some apps only answer when asked through their own application element.
      let app = AXUIElementCreateApplication(front)
      focused = copy(app, "AXFocusedUIElement").flatMap(asElement)
    }
    let element = focused.map(read)
    return await result(element, pid: element?.pid ?? front)
  }

  private static func result(_ element: Element?, pid: pid_t?) async -> InspectPointResult {
    let running = await pid.asyncMap { pid in await MainActor.run { Apps.running(pid: pid) } } ?? nil
    let app = running.map { Apps.helperApp($0) }
    return describe(element, app: app)
  }

  /// The wire result for an element: a password field is `secure`, and its value is never read as a title.
  static func describe(_ element: Element?, app: HelperApp?) -> InspectPointResult {
    guard let element else { return InspectPointResult(app: app, role: nil, title: nil, secure: false, link: nil) }
    return InspectPointResult(
      app: app, role: element.role, title: element.title, secure: isSecure(role: element.role, subrole: element.subrole),
      link: element.link)
  }

  static func isSecure(role: String?, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
  }

  /// The title: `AXTitle`, else `AXDescription`, else a short string `AXValue` (not a password field's), at most 200
  /// characters.
  static func title(title: String?, description: String?, value: String?, secure: Bool) -> String? {
    let candidates = [title, description, secure ? nil : value.flatMap { $0.count <= 200 ? $0 : nil }]
    for candidate in candidates {
      guard let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { continue }
      return String(text.prefix(200))
    }
    return nil
  }

  private static func read(_ element: AXUIElement) -> Element {
    var pid: pid_t = 0
    let hasPid = AXUIElementGetPid(element, &pid) == .success && pid > 0
    let role = copy(element, "AXRole") as? String
    let subrole = copy(element, "AXSubrole") as? String
    let secure = isSecure(role: role, subrole: subrole)
    let title = title(
      title: copy(element, "AXTitle") as? String, description: copy(element, "AXDescription") as? String,
      value: secure ? nil : copy(element, "AXValue") as? String, secure: secure)
    return Element(pid: hasPid ? pid : nil, role: role, subrole: subrole, title: title, link: link(of: element, role: role))
  }

  /// When the element or one of its 3 nearest ancestors is a link: its `AXURL`, or '' when it has none.
  private static func link(of element: AXUIElement, role: String?) -> String? {
    var current = element
    var currentRole = role
    for depth in 0...3 {
      if depth > 0 {
        guard let parent = copy(current, "AXParent").flatMap(asElement) else { return nil }
        current = parent
        currentRole = copy(current, "AXRole") as? String
      }
      if currentRole == "AXLink" {
        return url(copy(current, "AXURL")) ?? ""
      }
    }
    return nil
  }

  private static func url(_ value: CFTypeRef?) -> String? {
    guard let value else { return nil }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).absoluteString }
    if let string = value as? String { return string }
    return nil
  }

  private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
  }

  private static func asElement(_ value: CFTypeRef) -> AXUIElement? {
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }

  /// The process owning the frontmost window that contains a point (window bounds need no permission).
  static func windowOwner(at point: CGPoint) -> pid_t? {
    guard
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]
    else { return nil }
    for window in windows {
      guard let boundsDictionary = window["kCGWindowBounds"] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary), bounds.contains(point),
        let pid = window["kCGWindowOwnerPID"] as? Int
      else { continue }
      if let alpha = window["kCGWindowAlpha"] as? Double, alpha <= 0 { continue }
      return pid_t(pid)
    }
    return nil
  }
}

extension Optional {
  fileprivate func asyncMap<U>(_ transform: (Wrapped) async -> U) async -> U? {
    guard let value = self else { return nil }
    return await transform(value)
  }
}
