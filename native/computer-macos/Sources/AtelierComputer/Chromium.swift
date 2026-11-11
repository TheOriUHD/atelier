import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// Background input for apps built on Chromium: Chrome, Edge, Brave, Arc, Vivaldi and Opera, and the Electron and CEF
/// apps (Slack, VS Code, Discord, Notion, Spotify, …). Checked on a Mac against Chrome and an Electron app
/// (2026-11-11), with the app behind another one:
/// - mouse events posted to the app are ignored (a click, a move first, the window made main: nothing), and so are
///   scroll events; `AXPress` on page content answers success and does nothing;
/// - focus set through Accessibility moves the page's keyboard focus without bringing the app forward, and key events
///   posted to the app reach the focused element: Space presses a button or a checkbox, Return follows a link, Page
///   Down and the arrows scroll, menu shortcuts (cmd+L) work;
/// - a key event carries one character: one carrying several types nothing. Setting a field's value through
///   Accessibility fires its `input` event; cmd+A in a page field selects nothing.
/// - the page's elements only show to Accessibility once `AXEnhancedUserInterface` is set on the app (an Electron app
///   ignores `AXManualAccessibility`; both answer the set with an error and turn it on all the same).
/// So a click on a button, a link, a checkbox or a field focuses it and presses the key that activates it; typing is a
/// key event per character; scrolling focuses what is under the point and presses arrows. A spot that is none of these
/// can't be clicked this way, and the agent is told to ask for Full control.
enum Chromium {
  // ---------------------------------------------------------------- which apps

  /// Whether a bundle is built on Chromium, from what is in its Frameworks folder: an Electron or CEF framework, a
  /// renderer helper app (Electron, CEF), or a framework with renderer helpers inside (Chrome and its kin).
  static func isChromium(frameworks: [String], helpers: [String]) -> Bool {
    let marker = { (name: String) in name.hasSuffix("Helper (Renderer).app") }
    if frameworks.contains(where: { $0 == "Electron Framework.framework" || $0 == "Chromium Embedded Framework.framework" || marker($0) }) {
      return true
    }
    return helpers.contains(where: marker)
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var known: [String: Bool] = [:]
  /// What `AXEnhancedUserInterface` was before it was turned on, per app turned on.
  nonisolated(unsafe) private static var switched: [pid_t: Bool] = [:]
  /// The element focused last through Accessibility, per app: an inactive Electron app doesn't say what has its focus.
  nonisolated(unsafe) private static var focused: [pid_t: AXUIElement] = [:]

  /// Whether the process's app is built on Chromium (read once per bundle).
  static func isChromium(pid: pid_t) -> Bool {
    guard let bundle = bundlePath(pid) else { return false }
    lock.lock()
    if let answer = known[bundle] {
      lock.unlock()
      return answer
    }
    lock.unlock()
    let manager = FileManager.default
    let frameworksDir = (bundle as NSString).appendingPathComponent("Contents/Frameworks")
    let frameworks = (try? manager.contentsOfDirectory(atPath: frameworksDir)) ?? []
    var helpers: [String] = []
    for framework in frameworks where framework.hasSuffix(".framework") {
      let versions = (frameworksDir as NSString).appendingPathComponent("\(framework)/Versions")
      for version in (try? manager.contentsOfDirectory(atPath: versions)) ?? [] where version != "Current" {
        helpers += (try? manager.contentsOfDirectory(atPath: (versions as NSString).appendingPathComponent("\(version)/Helpers"))) ?? []
      }
    }
    let answer = isChromium(frameworks: frameworks, helpers: helpers)
    lock.lock()
    known[bundle] = answer
    lock.unlock()
    return answer
  }

  /// The outermost `.app` the process runs from.
  private static func bundlePath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    let path = String(cString: buffer)
    guard let range = path.range(of: ".app/") else { return nil }
    return String(path[..<range.lowerBound]) + ".app"
  }

  // ---------------------------------------------------------------- the page's elements

  /// Turns the app's page elements on for Accessibility (once per app; `restore` turns them off again). True when it
  /// was turned on just now: the page takes a moment to show.
  @discardableResult
  static func prepare(_ pid: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard switched[pid] == nil else { return false }
    let app = Inspect.application(pid)
    switched[pid] = (Inspect.copy(app, "AXEnhancedUserInterface") as? Bool) ?? false
    // Both answer with an error and do it all the same (Chrome and Electron: -25208).
    _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return true
  }

  /// `bg.end`: what `prepare` turned on is turned off again (a screen reader that had it on keeps it), and the focus
  /// remembered is forgotten.
  static func restore() {
    lock.lock()
    let apps = switched
    switched = [:]
    focused = [:]
    lock.unlock()
    for (pid, before) in apps where !before {
      _ = AXUIElementSetAttributeValue(Inspect.application(pid), "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
    }
  }

  static func lastFocused(_ pid: pid_t) -> AXUIElement? {
    lock.lock()
    defer { lock.unlock() }
    return focused[pid]
  }

  /// The element at the point, waiting a little for the page when it was just turned on (until something below the
  /// page itself answers, at most 1.5 s).
  static func element(at point: CGPoint, pid: pid_t, fresh: Bool) throws -> AXUIElement? {
    let app = Inspect.application(pid)
    var hit = try Inspect.element(at: point, in: app)
    guard fresh else { return hit }
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline, hit == nil || Inspect.role(of: hit!) == "AXWebArea" {
      usleep(100_000)
      hit = try Inspect.element(at: point, in: app)
    }
    return hit
  }

  // ---------------------------------------------------------------- what a click does

  enum Step: Equatable {
    /// Focus it (a field, a list to choose from by typing).
    case focus
    /// Focus it, then press this key (Space for a button or a checkbox, Return for a link).
    case focusThen(CGKeyCode)
  }

  static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]
  static let spaceRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuButton", "AXDisclosureTriangle", "AXSwitch",
    "AXToggle",
  ]
  /// Where looking further up stops: the page itself is no control.
  static let pageRoles: Set<String> = ["AXWebArea", "AXWindow", "AXApplication"]
  static let space = CGKeyCode(49)
  static let returnKey = CGKeyCode(36)
  /// How far up from the element hit a control is looked for (a link's text inside a span inside the link…).
  static let depth = 8

  /// What a click on an element of this role does; nil: nothing, look at its parent.
  static func step(role: String?) -> Step? {
    guard let role else { return nil }
    if textRoles.contains(role) || role == "AXPopUpButton" { return .focus }
    if role == "AXLink" { return .focusThen(returnKey) }
    if spaceRoles.contains(role) { return .focusThen(space) }
    return nil
  }

  /// The control a click at the element hit (depth 0) goes to, walking up; nil when there is none below the page.
  /// `role(depth)` reads the role that many levels up (nil past the top).
  static func target(_ role: (Int) -> String??) -> (depth: Int, step: Step)? {
    for level in 0...depth {
      guard let found = role(level) else { return nil }
      if let name = found, pageRoles.contains(name) { return nil }
      if let step = step(role: found) { return (level, step) }
    }
    return nil
  }

  /// Whether the element is inside a page (its ancestors reach an `AXWebArea`), not the app's own toolbar.
  static func inPage(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<60 {
      guard let node = current else { return false }
      if Inspect.role(of: node) == "AXWebArea" { return true }
      current = Inspect.parent(of: node)
    }
    return false
  }

  static let unclickable =
    "In the background this app only takes clicks on buttons, links, checkboxes and fields, and that spot is none of them."

  /// A click in a Chromium app: true when it was done here, false to go on the usual way (the app's own controls
  /// outside a page, which `AXPress` reaches).
  static func click(_ click: Background.Click, window: WindowInfo, input: InputController) throws -> Bool {
    let fresh = prepare(window.pid)
    guard let hit = try element(at: click.point, pid: window.pid, fresh: fresh) else { return false }
    var chain = [hit]
    let found = target { level in
      while chain.count <= level {
        guard let parent = Inspect.parent(of: chain[chain.count - 1]) else { return nil }
        chain.append(parent)
      }
      return .some(Inspect.role(of: chain[level]))
    }
    guard let found else {
      // A field outside a page (the address bar) is focused the same way; other spots outside a page go on as usual.
      if !inPage(hit) { return false }
      throw RPCError.unsupported(unclickable)
    }
    let element = chain[found.depth]
    if !inPage(element), found.step != .focus { return false }
    // Double and triple clicks into a field only focus it; anything else but a plain click needs the real mouse.
    guard click.isPlainClick || (found.step == .focus && click.button == .left && click.modifiers.isEmpty) else {
      throw RPCError.unsupported("A right click, a click with keys held or a double click on a control can't be done in the background in this app.")
    }
    try focus(element, pid: window.pid, input: input)
    if case .focusThen(let key) = found.step {
      usleep(80_000)
      try input.run(BackgroundEvents.press(key, flags: [], repeat: 1), route: .process(window.pid))
    }
    return true
  }

  /// Focus through Accessibility: the app stays where it is.
  static func focus(_ element: AXUIElement, pid: pid_t, input: InputController) throws {
    try input.ready()
    let status = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if status == .apiDisabled { throw RPCError.permission(.accessibility) }
    guard status == .success else { throw RPCError.unsupported(unclickable) }
    lock.lock()
    focused[pid] = element
    lock.unlock()
  }

  // ---------------------------------------------------------------- typing

  /// One key event per character, each on the key that types it on this layout where there is one (any key carries
  /// characters the layout doesn't have); line breaks as Return.
  static func typing(_ text: String, layout: KeyboardLayoutMap?) -> [EventStep] {
    text.flatMap { character -> [EventStep] in
      if character == "\n" || character == "\r" || character == "\r\n" {
        return EventStep.pair(
          .key(returnKey, down: true, flags: []), .key(returnKey, down: false, flags: []), pauseBetween: 0.004,
          pauseAfter: 0.008)
      }
      let code = character == " " ? space : (KeyMap.key(for: character, layout: layout, command: false)?.code ?? 0)
      let units = Array(String(character).utf16)
      return EventStep.pair(
        .char(code, units, down: true), .char(code, units, down: false), pauseBetween: 0, pauseAfter: 0.006)
    }
  }

  /// Longer than this, text goes into a plain field through Accessibility at once rather than a key at a time.
  static let spliceLength = 300

  /// The element typing goes to: the app's focus, or the one focused here last (an inactive Electron app answers none).
  static func typingTarget(_ pid: pid_t) -> AXUIElement? {
    Inspect.focusedElement(in: Inspect.application(pid)) ?? lastFocused(pid)
  }

  static func type(_ text: String, replace: Bool, pid: pid_t, layout: KeyboardLayoutMap?, input: InputController) throws {
    prepare(pid)
    let target = typingTarget(pid)
    if let target, Inspect.isSecure(role: Inspect.role(of: target), subrole: Inspect.copy(target, "AXSubrole") as? String) {
      throw RPCError.unsupported("That is a password field: passwords are never typed.")
    }
    if replace {
      try input.ready()
      if let target, settable(target, kAXValueAttribute) {
        _ = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, "" as CFString)
      } else if let target, selectAll(target) {
        // Typing replaces the selection.
      } else {
        try input.run(BackgroundEvents.press(0, flags: .maskCommand, repeat: 1), route: .process(pid))
      }
      usleep(40_000)
    }
    let plainField = target.map { textRoles.contains(Inspect.role(of: $0) ?? "") && settable($0, kAXValueAttribute) } ?? false
    if text.utf16.count > spliceLength, plainField, let target, splice(text, into: target) { return }
    // Characters beyond one UTF-16 unit (emoji) don't arrive as key events in every Chromium app (Brave): in a plain
    // field they go in through its value, at the caret; the rest is typed.
    for run in runs(text) {
      if run.wide, plainField, let target {
        try input.ready()
        usleep(40_000)
        if splice(run.text, into: target) { continue }
      }
      try input.run(typing(run.text, layout: layout), route: .process(pid))
    }
  }

  /// The text in runs of characters that fit one UTF-16 unit, and of wider ones (emoji).
  static func runs(_ text: String) -> [(text: String, wide: Bool)] {
    var runs: [(text: String, wide: Bool)] = []
    for character in text {
      let wide = String(character).utf16.count > 1 && character != "\r\n"
      if let last = runs.last, last.wide == wide {
        runs[runs.count - 1].text.append(character)
      } else {
        runs.append((String(character), wide))
      }
    }
    return runs
  }

  static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
  }

  /// Selects all of a field's text through Accessibility (cmd+A selects nothing in a page field).
  static func selectAll(_ element: AXUIElement) -> Bool {
    guard settable(element, kAXSelectedTextRangeAttribute) else { return false }
    let length = (Inspect.copy(element, kAXNumberOfCharactersAttribute) as? Int) ?? ((Inspect.copy(element, kAXValueAttribute) as? String)?.utf16.count ?? 0)
    var range = CFRange(location: 0, length: length)
    guard let value = AXValueCreate(.cfRange, &range) else { return false }
    return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
  }

  /// The text put in place of the selection through the field's value, the caret after it.
  static func splice(_ text: String, into element: AXUIElement) -> Bool {
    let current = (Inspect.copy(element, kAXValueAttribute) as? String) ?? ""
    var range = CFRange(location: current.utf16.count, length: 0)
    if let raw = Inspect.copy(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
      AXValueGetValue(raw as! AXValue, .cfRange, &range)
    }
    let updated = spliced(current, range: range, with: text)
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, updated as CFString) == .success else { return false }
    var caret = CFRange(location: min(range.location, current.utf16.count) + text.utf16.count, length: 0)
    if let value = AXValueCreate(.cfRange, &caret) {
      _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
    }
    return true
  }

  /// `current` with the UTF-16 range replaced by `text` (clamped to it).
  static func spliced(_ current: String, range: CFRange, with text: String) -> String {
    let units = Array(current.utf16)
    let start = max(0, min(range.location, units.count))
    let end = max(start, min(start + max(0, range.length), units.count))
    return String(decoding: units[..<start] + Array(text.utf16) + units[end...], as: UTF16.self)
  }

  // ---------------------------------------------------------------- keys

  /// cmd+A in a field selects its text through Accessibility; true when done here.
  static func key(_ stroke: KeyStroke, pid: pid_t, input: InputController) throws -> Bool {
    prepare(pid)
    guard stroke.keyCode == 0, stroke.flags == .maskCommand, let target = typingTarget(pid),
      textRoles.contains(Inspect.role(of: target) ?? "")
    else { return false }
    try input.ready()
    return selectAll(target)
  }

  // ---------------------------------------------------------------- scrolling

  /// Roles that take the arrow keys themselves: focused, they would change instead of scrolling.
  static let arrowRoles: Set<String> = textRoles.union(["AXPopUpButton", "AXRadioButton", "AXSlider", "AXList", "AXTabGroup"])

  /// The arrow presses for a scroll of `dx`, `dy` lines (one press a line, at most 60 each way).
  static func scrollKeys(dx: Double, dy: Double) -> [(code: CGKeyCode, count: Int)] {
    var keys: [(CGKeyCode, Int)] = []
    let rows = min(60, Int(abs(dy).rounded()))
    if rows > 0 { keys.append((dy > 0 ? CGKeyCode(125) : CGKeyCode(126), rows)) }
    let columns = min(60, Int(abs(dx).rounded()))
    if columns > 0 { keys.append((dx > 0 ? CGKeyCode(124) : CGKeyCode(123), columns)) }
    return keys
  }

  /// A scroll in a Chromium app: what is under the point (or the page) gets the focus, then the arrows. True when done.
  static func scroll(_ scroll: Background.Scroll, window: WindowInfo, input: InputController) throws -> Bool {
    let fresh = prepare(window.pid)
    guard let hit = try element(at: scroll.point, pid: window.pid, fresh: fresh), inPage(hit) else { return false }
    var current: AXUIElement? = hit
    var chosen: AXUIElement?
    for _ in 0..<40 {
      guard let node = current else { break }
      let role = Inspect.role(of: node) ?? ""
      if role == "AXWebArea" || (!arrowRoles.contains(role) && settable(node, kAXFocusedAttribute)) {
        chosen = node
        break
      }
      current = Inspect.parent(of: node)
    }
    guard let chosen else { return false }
    try focus(chosen, pid: window.pid, input: input)
    usleep(60_000)
    for (code, count) in scrollKeys(dx: scroll.dx, dy: scroll.dy) {
      try input.run(BackgroundEvents.press(code, flags: [], repeat: count), route: .process(window.pid))
    }
    return true
  }
}
