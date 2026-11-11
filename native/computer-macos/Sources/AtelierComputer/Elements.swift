import ApplicationServices
import CoreGraphics
import Foundation

/// The controls of a window as its screenshot's companion: what can be clicked, typed into or chosen, with its name and
/// where it is, so the model aims at "[12] button Save" instead of guessing a pixel (Claude's helper sends the same list
/// with its window screenshots). Read through Accessibility, within a small time budget; a window that shows nothing to
/// Accessibility (a covered Electron app) gives an empty list and the screenshot alone.
enum Elements {
  /// The roles worth listing: the ones a person clicks, types into or chooses from.
  static let roles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXLink", "AXSlider", "AXIncrementor", "AXTab", "AXDisclosureTriangle",
    "AXCell", "AXMenuItem", "AXColorWell", "AXDateField",
  ]

  /// At most this many go with a screenshot: the first ones in reading order.
  static let limit = 60

  static let windowButtons: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]

  /// The window's controls, in reading order (top to bottom, then left to right), in global points.
  static func collect(in window: WindowInfo, budget: TimeInterval = 0.3) -> [CapturedElement] {
    guard AXIsProcessTrusted(), let root = Occlusion.element(of: window) else { return [] }
    let deadline = Date().addingTimeInterval(budget)
    var found: [CapturedElement] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    while !queue.isEmpty, visited < 4000, found.count < limit * 3, Date() < deadline {
      let (element, depth) = queue.removeFirst()
      visited += 1
      let role = Inspect.role(of: element)
      if let role, roles.contains(role), let item = describe(element, role: role, in: window.bounds) {
        found.append(item)
        // A control's own parts (a cell's text, a button's image) aren't listed again.
        if role != "AXCell" { continue }
      }
      guard depth < 40 else { continue }
      for child in (Inspect.copy(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { queue.append((child, depth + 1)) }
    }
    return Array(ordered(found).prefix(limit))
  }

  /// Top to bottom in rows of about the same height, left to right within a row.
  static func ordered(_ items: [CapturedElement]) -> [CapturedElement] {
    items.sorted { a, b in
      let rowA = Int((a.rect.y + a.rect.height / 2) / 12), rowB = Int((b.rect.y + b.rect.height / 2) / 12)
      return rowA != rowB ? rowA < rowB : a.rect.x < b.rect.x
    }
  }

  /// One control, when it is in the window and has a size; a password field's value is never read.
  private static func describe(_ element: AXUIElement, role: String, in bounds: CGRect) -> CapturedElement? {
    guard let frame = frame(of: element), frame.width >= 4, frame.height >= 4, frame.intersects(bounds) else { return nil }
    if (Inspect.copy(element, "AXHidden") as? Bool) == true { return nil }
    let subrole = Inspect.copy(element, kAXSubroleAttribute) as? String
    // The window's own buttons (close, minimize, zoom, full screen) aren't the task's.
    if let subrole, windowButtons.contains(subrole) { return nil }
    let secure = Inspect.isSecure(role: role, subrole: subrole)
    let title = Inspect.copy(element, kAXTitleAttribute) as? String
    let description = Inspect.copy(element, kAXDescriptionAttribute) as? String
    let help = Inspect.copy(element, kAXHelpAttribute) as? String
    let value = Inspect.copy(element, kAXValueAttribute)
    let text = value as? String
    let name = Inspect.title(title: title, description: description ?? help, value: role == "AXTextField" || role == "AXTextArea" ? nil : text, secure: secure) ?? ""
    var item = CapturedElement(role: shortRole(role, subrole: subrole), name: name, value: nil, rect: ScreenRect(frame))
    if secure {
      item.value = nil
    } else if let text, role == "AXTextField" || role == "AXTextArea" || role == "AXSearchField" || role == "AXComboBox" {
      item.value = String(text.prefix(120))
    } else if let number = value as? NSNumber, role == "AXCheckBox" || role == "AXRadioButton" {
      item.value = number.intValue == 0 ? "off" : "on"
    }
    if (Inspect.copy(element, kAXEnabledAttribute) as? Bool) == false { item.disabled = true }
    return item
  }

  /// "button", "textfield", "password", "checkbox" … as the model reads them.
  static func shortRole(_ role: String, subrole: String?) -> String {
    if Inspect.isSecure(role: role, subrole: subrole) { return "password" }
    switch role {
    case "AXTextField", "AXSearchField", "AXDateField": return "textfield"
    case "AXTextArea": return "textarea"
    case "AXCheckBox": return "checkbox"
    case "AXRadioButton": return "radio"
    case "AXPopUpButton", "AXComboBox": return "list"
    case "AXMenuButton": return "menubutton"
    case "AXDisclosureTriangle": return "disclosure"
    case "AXIncrementor": return "stepper"
    case "AXMenuItem": return "menuitem"
    default: return String(role.dropFirst(2)).lowercased()
    }
  }

  private static func frame(of element: AXUIElement) -> CGRect? {
    guard let rawPosition = Inspect.copy(element, kAXPositionAttribute), let rawSize = Inspect.copy(element, kAXSizeAttribute),
      CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID()
    else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin)
    AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
    return CGRect(origin: origin, size: size)
  }
}
