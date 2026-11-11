import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Background input (`bg.*`): into one app's window without the person's mouse and keyboard, the cursor unmoved and the
/// app left where it is. Where SkyLight is there (`SkyLight.available`), events go the way Claude's and ChatGPT's
/// computer use send them: the window is focused inside its app without the app becoming active, and the events reach
/// it stamped with the window and the point (`InputRoute.skyLight`); this is what Chrome's and Electron's pages take.
/// Without it: `AXPress` on a control, events posted to the process, and in Chromium apps focus and keys (`Chromium`).
/// Every call notes which app was in front before it: an app that brings itself forward (Chrome on cmd+T) is sent back
/// behind the person's app at once, and the result says so (`fronted`). Everything goes through the same input gate as Full
/// control: refused after an Esc stop, tagged so the control watch ignores it, let go of by a release or a stop.
enum Background {
  // ---------------------------------------------------------------- requests, checked before anything is looked up

  struct Click: Equatable {
    var window: CGWindowID
    var point: CGPoint
    var button: MouseButton
    var count: Int
    var modifiers: [Modifier]

    init(_ params: BgClickParams) throws {
      window = try WindowChoice.windowID(params.window)
      point = try Helper.point(params.x, params.y)
      guard (1...3).contains(params.count) else { throw RPCError.invalidParams("count must be 1, 2 or 3") }
      count = params.count
      button = params.button
      modifiers = try Helper.modifiers(params.modifiers)
    }

    /// One plain left click: what `AXPress` stands in for.
    var isPlainClick: Bool { button == .left && count == 1 && modifiers.isEmpty }
  }

  struct Scroll: Equatable {
    var window: CGWindowID
    var point: CGPoint
    var dx: Double
    var dy: Double

    init(_ params: BgScrollParams) throws {
      window = try WindowChoice.windowID(params.window)
      point = try Helper.point(params.x, params.y)
      guard params.dx.isFinite, params.dy.isFinite, abs(params.dx) <= 10_000, abs(params.dy) <= 10_000 else {
        throw RPCError.invalidParams("dx and dy must be numbers of lines, at most 10000")
      }
      dx = params.dx
      dy = params.dy
    }
  }

  struct Key: Equatable {
    var window: CGWindowID
    var count: Int

    init(_ params: BgKeyParams) throws {
      window = try WindowChoice.windowID(params.window)
      count = params.repeat ?? 1
      guard (1...100).contains(count) else { throw RPCError.invalidParams("repeat must be 1–100") }
    }

    /// The key to press, its modifiers only as flags. A stroke of modifiers alone can't be sent to one app.
    static func steps(_ stroke: KeyStroke, repeat count: Int) throws -> [EventStep] {
      guard let code = stroke.keyCode else {
        throw RPCError.unsupported("modifier keys alone can't be pressed in the background, only with a key")
      }
      return BackgroundEvents.press(code, flags: stroke.flags, repeat: count)
    }
  }

  struct Typing: Equatable {
    var window: CGWindowID
    var text: String
    /// In place of what the field holds.
    var replace: Bool

    init(_ params: BgTypeParams) throws {
      window = try WindowChoice.windowID(params.window)
      guard params.text.utf16.count <= 100_000 else { throw RPCError.invalidParams("text is longer than 100000") }
      text = params.text
      replace = params.replace ?? false
    }
  }

  // ---------------------------------------------------------------- AXPress instead of a click

  /// Roles of controls a plain click presses, and that `AXPress` presses the same way.
  static let pressableRoles: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXDisclosureTriangle", "AXPopUpButton",
    "AXMenuButton",
  ]
  /// Roles inside a control that a click on them reaches: its label, its icon, a group around them.
  static let passiveRoles: Set<String> = ["AXStaticText", "AXImage", "AXGroup"]
  /// How far up from the element hit a control is looked for.
  static let pressDepth = 3

  struct Node: Equatable {
    var role: String?
    var actions: [String]
  }

  /// Which element `AXPress` goes to: walking up from the element hit (depth 0) through passive elements only, the
  /// first control a click presses, when it offers `AXPress`. nil: post the click instead. `node(depth)` reads the
  /// element that many levels up (nil when there is none), only as far as needed.
  static func pressTarget(_ node: (Int) -> Node?) -> Int? {
    for depth in 0...pressDepth {
      guard let node = node(depth), let role = node.role else { return nil }
      if pressableRoles.contains(role) { return node.actions.contains(kAXPressAction) ? depth : nil }
      if !passiveRoles.contains(role) { return nil }
    }
    return nil
  }

  enum PressOutcome: Equatable {
    case pressed
    /// It didn't take: post the click.
    case post
  }

  /// What `AXPress`'s answer means. Done when it succeeded, and when the app didn't answer within the timeout: the
  /// press went in, and a dialog it opened keeps the app from answering (posting the click as well would press twice).
  static func outcome(_ error: AXError) throws -> PressOutcome {
    switch error {
    case .success, .cannotComplete: return .pressed
    case .apiDisabled: throw RPCError.permission(.accessibility)
    default: return .post
    }
  }

  /// `AXPress` on the control under the point when that is what the click would do. True when it pressed.
  private static func press(at point: CGPoint, in window: WindowInfo, input: InputController) throws -> Bool {
    guard let hit = try Inspect.element(at: point, in: Inspect.application(window.pid)) else { return false }
    var chain = [hit]
    let index = pressTarget { depth in
      while chain.count <= depth {
        guard let parent = Inspect.parent(of: chain[chain.count - 1]) else { return nil }
        chain.append(parent)
      }
      return Node(role: Inspect.role(of: chain[depth]), actions: Inspect.actions(of: chain[depth]))
    }
    guard let index else { return false }
    // The press is input like any other: refused once the person held Esc, also while the element was looked up.
    try input.ready()
    return try outcome(AXUIElementPerformAction(chain[index], kAXPressAction as CFString)) == .pressed
  }

  // ---------------------------------------------------------------- the person's app stays in front

  /// The app in front and its front window, before an action.
  struct Front: Equatable {
    var pid: pid_t
    var window: CGWindowID?
  }

  static func front() -> Front? {
    let pid: pid_t? =
      Thread.isMainThread
      ? NSWorkspace.shared.frontmostApplication?.processIdentifier
      : DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    guard let pid else { return nil }
    let windows = Windows.list(onScreenOnly: true).filter { $0.pid == pid && $0.layer == 0 }
    return Front(pid: pid, window: windows.first?.id)
  }

  /// Whether one of `target`'s windows sits above the person's front window and overlaps it: the app raised it over
  /// their work. An app may do that without coming to the front (seen on a Mac: a link in Chrome that opened a tab put
  /// Chrome's window over Atelier while Atelier stayed the front app). `list` is front to back.
  static func raised(_ target: pid_t, over front: Front, in list: [WindowInfo]) -> Bool {
    guard let id = front.window, let theirs = list.first(where: { $0.id == id }) else { return false }
    for window in list {
      if window.id == id { return false }
      if window.pid == target, window.layer == theirs.layer, window.alpha > 0, window.bounds.intersects(theirs.bounds) {
        return true
      }
    }
    return false
  }

  /// Runs an action into `target`'s app and, when that app came to the front because of it or raised a window over the
  /// person's (it wasn't before, and the person had another app in front), puts the person's app and window back in
  /// front. True when that happened. A raise that comes later (a tab opened once a page has loaded) is watched for
  /// a few seconds more and undone the same way.
  static func keepingFront(_ target: pid_t, _ action: () throws -> Void) throws -> Bool {
    let before = front()
    let over = before.map { raised(target, over: $0, in: Windows.list(onScreenOnly: true)) } ?? false
    try action()
    guard let before, before.pid != target else { return false }
    // The app answers on its own main thread: a moment, then a look.
    for _ in 0..<6 {
      usleep(50_000)
      if fronted(target, before: before, wasOver: over) {
        bringBack(before, over: target)
        return true
      }
    }
    watch(target, before: before, wasOver: over)
    return false
  }

  /// The target came to the front, or (the person's app still in front) raised a window over theirs.
  private static func fronted(_ target: pid_t, before: Front, wasOver: Bool) -> Bool {
    guard let now = front() else { return false }
    if now.pid == target { return true }
    return now.pid == before.pid && !wasOver && raised(target, over: before, in: Windows.list(onScreenOnly: true))
  }

  /// Which watch is the current one: a newer action ends the one before.
  nonisolated(unsafe) private static var watching = 0
  private static let watchLock = NSLock()

  /// Looks for a late raise for three seconds after an action, while the person's app is still in front. The target
  /// coming to the front itself counts only in the first second: later it is more likely the person switching to it.
  private static func watch(_ target: pid_t, before: Front, wasOver: Bool) {
    watchLock.lock()
    watching += 1
    let mine = watching
    watchLock.unlock()
    DispatchQueue.global(qos: .userInitiated).async {
      for tick in 0..<30 {
        usleep(100_000)
        watchLock.lock()
        let current = watching == mine
        watchLock.unlock()
        guard current, let now = front() else { return }
        if now.pid == target {
          if tick < 10 { bringBack(before, over: target) }
          return
        }
        guard now.pid == before.pid else { return }
        if !wasOver, raised(target, over: before, in: Windows.list(onScreenOnly: true)) {
          bringBack(before, over: target)
          return
        }
      }
    }
  }

  /// The person's app back in front with its window: the window server's own call (yabai's), then Accessibility's
  /// `AXFrontmost`, until it holds (at most a second). The app in front again doesn't put its window back over one
  /// `target` raised (seen with a link that opened a tab: TextEdit in front, Brave's window still above TextEdit's), so
  /// then the person's window is raised too.
  static func bringBack(_ front: Front, over target: pid_t? = nil) {
    SkyLight.bringToFront(pid: front.pid, window: front.window)
    for _ in 0..<10 {
      if Self.front()?.pid == front.pid { break }
      usleep(100_000)
      _ = AXUIElementSetAttributeValue(Inspect.application(front.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    guard let target else { return }
    for _ in 0..<5 {
      guard raised(target, over: front, in: Windows.list(onScreenOnly: true)) else { return }
      raiseWindow(front)
      usleep(60_000)
    }
  }

  /// Raises the person's front window over the others (Accessibility's raise, on their own app's window).
  private static func raiseWindow(_ front: Front) {
    guard let id = front.window, let info = Windows.info(id), let element = Occlusion.element(of: info) else { return }
    _ = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
  }

  static let passwordField =
    "That is a password field: passwords are never typed, so it isn't clicked either. Leave signing in to the person."

  /// macOS's secure input is on: a password field somewhere has the keyboard (an app behind can turn it on too, and a
  /// covered Electron app hides from Accessibility which of its fields has the focus).
  static func secureInputOn() -> Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return ((session?["kCGSSessionSecureInputPID"] as? Int) ?? 0) > 0
  }

  /// The person is typing in another window of the same app: keys sent to it would land under their hands.
  static func checkNotInUse(_ window: WindowInfo) throws {
    guard let front = front(), front.pid == window.pid else { return }
    if let key = SkyLight.keyWindow(of: window.pid), key != window.id {
      throw RPCError.unsupported("The person is using another window of this app right now: keys sent to it would land there.")
    }
  }

  /// Shortcuts that make a browser open a tab or a window, which it brings to the front itself.
  static func frontsItself(_ stroke: KeyStroke, chromium: Bool) -> Bool {
    guard chromium, stroke.modifierFlags.contains(.maskCommand) else { return false }
    // T (new tab), N (new window or incognito window).
    return stroke.keyCode == 17 || stroke.keyCode == 45
  }

  // ---------------------------------------------------------------- the calls

  /// Whether a click on the element opens a menu of the app's own: a pop-up button, a list in a page (`<select>`: a pop-up
  /// button with its options as menu items). A page's own menus (a button that shows a list drawn in the page) don't.
  static func opensMenu(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<3 {
      guard let node = current else { return false }
      if Inspect.role(of: node) == "AXPopUpButton" {
        guard Chromium.inPage(node) else { return true }
        let children = (Inspect.copy(node, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        return children.contains { ["AXMenu", "AXMenuItem"].contains(Inspect.role(of: $0) ?? "") }
      }
      current = Inspect.parent(of: node)
    }
    return false
  }

  /// The window level of a menu that pops up (`NSPopUpMenuWindowLevel`).
  static let popUpMenuLevel = 101

  /// Whether the app has a menu open: a click opened one (a list in a page, a pop-up button), which would sit on the
  /// person's screen and take their mouse.
  static func menuOpen(_ pid: pid_t) -> Bool {
    Windows.list(onScreenOnly: true).contains { $0.pid == pid && $0.layer == popUpMenuLevel }
  }

  @discardableResult
  static func click(_ params: BgClickParams, input: InputController) throws -> Bool {
    let click = try Click(params)
    let window = try Windows.target(params.window, onScreen: true)
    try WindowChoice.check(click.point, in: window)
    try input.ready()
    guard SkyLight.available else {
      try publicClick(click, window: window, input: input)
      return false
    }
    let chromium = Chromium.isChromium(pid: window.pid)
    let hit = try Inspect.element(at: click.point, in: Inspect.application(window.pid))
    let role = hit.flatMap(Inspect.role(of:))
    if click.button == .right {
      throw RPCError.unsupported(
        chromium
          ? "A right click can't be sent in the background in this app: it would land as a left click."
          : "A right click opens a menu, which can't be used in the background.")
    }
    if let hit, opensMenu(hit) {
      throw RPCError.unsupported(
        "That is a list to choose from: a click opens its menu, which can't be used in the background (it would cover the person's screen). Choosing from it needs Full control: ask with FullControl.")
    }
    if let hit, Inspect.isSecure(role: role, subrole: Inspect.copy(hit, "AXSubrole") as? String) {
      throw RPCError.unsupported(Self.passwordField)
    }
    if let hit, let role, Chromium.textRoles.contains(role) { Chromium.remember(window.pid, hit) }
    let secureBefore = secureInputOn()
    let stamped = SkyLight.stampedPoint(click.point, window: window.bounds)
    let group = Int64(DispatchTime.now().uptimeNanoseconds & 0x7FFF_FFFF)
    let flags = Modifier.flags(click.modifiers)
    let steps = SkyLight.click(
      at: click.point, stamped: stamped, pid: window.pid, window: window.id, button: click.button, count: click.count,
      group: group
    ).map { step -> EventStep in
      // Each press carries its own release, so a stop in between lets go of the button.
      func spec(_ type: CGEventType) -> EventSpec {
        var spec = EventSpec.mouse(type, at: step.at, button: click.button, clickState: step.stamp.clickState, flags: flags)
        spec.stamp = step.stamp
        return spec
      }
      let pressed = step.type == .leftMouseDown || step.type == .rightMouseDown || step.type == .otherMouseDown
      let released = step.type == .leftMouseUp || step.type == .rightMouseUp || step.type == .otherMouseUp
      let upType: CGEventType = step.type == .leftMouseDown ? .leftMouseUp : click.button.upType
      return EventStep(spec(step.type), release: pressed ? spec(upType) : nil, isRelease: released, pause: Double(step.pause) / 1000)
    }
    var menu = false
    let fronted = try keepingFront(window.pid) {
      try SkyLight.focus(pid: window.pid, window: window.id)
      try input.run(steps, route: .skyLight(window.pid))
      usleep(150_000)
      // A menu opened: closed again (Esc). Its options can't be reached in the background (a closed list in a page shows
      // only the chosen one to Accessibility, and keys go to the page), as in Claude's helper, which refuses these too.
      if menuOpen(window.pid) {
        menu = true
        var escape = EventSpec.key(53, down: true, flags: [])
        escape.authenticate = true
        var release = EventSpec.key(53, down: false, flags: [])
        release.authenticate = true
        try input.run(EventStep.pair(escape, release, pauseBetween: 0.01, pauseAfter: 0.05), route: .skyLight(window.pid))
      }
    }
    // A password field Accessibility couldn't name (a covered Electron app shows none of its page) turns macOS's secure
    // input on, for everyone, while it has the focus: the focus moves on (Tab) and nothing is typed there.
    if !secureBefore, secureInputOn() {
      var tab = EventSpec.key(48, down: true, flags: [])
      tab.authenticate = true
      var up = EventSpec.key(48, down: false, flags: [])
      up.authenticate = true
      _ = try? keepingFront(window.pid) {
        try SkyLight.makeKey(pid: window.pid, window: window.id)
        try input.run(EventStep.pair(tab, up, pauseBetween: 0.01, pauseAfter: 0.05), route: .skyLight(window.pid))
      }
      throw RPCError.unsupported(Self.passwordField + " The focus moved on to the next field.")
    }
    if menu {
      throw RPCError.unsupported(
        "That opened a menu (a list to choose from), which can't be used in the background, so it was closed again. Choosing from it needs Full control: ask with FullControl.")
    }
    return fronted
  }

  private static func publicClick(_ click: Click, window: WindowInfo, input: InputController) throws {
    if Chromium.isChromium(pid: window.pid), try Chromium.click(click, window: window, input: input) { return }
    if click.isPlainClick, try press(at: click.point, in: window, input: input) { return }
    let steps = BackgroundEvents.click(
      at: click.point, button: click.button, count: click.count, flags: Modifier.flags(click.modifiers),
      window: window.id)
    try input.run(steps, route: .process(window.pid))
  }

  @discardableResult
  static func scroll(_ params: BgScrollParams, input: InputController) throws -> Bool {
    let scroll = try Scroll(params)
    let window = try Windows.target(params.window, onScreen: true)
    try WindowChoice.check(scroll.point, in: window)
    guard SkyLight.available else {
      if Chromium.isChromium(pid: window.pid), try Chromium.scroll(scroll, window: window, input: input) { return false }
      try input.run(
        BackgroundEvents.scroll(at: scroll.point, dx: scroll.dx, dy: scroll.dy, window: window.id),
        route: .process(window.pid))
      return false
    }
    let (wheel1, wheel2) = InputController.wheelDeltas(dx: scroll.dx, dy: scroll.dy)
    guard wheel1 != 0 || wheel2 != 0 else { return false }
    let stamp = SkyLight.Stamp(
      pid: window.pid, window: window.id, point: SkyLight.stampedPoint(scroll.point, window: window.bounds), group: 0)
    var move = EventSpec.mouse(.mouseMoved, at: scroll.point, button: .left)
    move.stamp = stamp
    var wheel = EventSpec.scroll(at: scroll.point, wheel1: wheel1, wheel2: wheel2, flags: [])
    wheel.stamp = stamp
    return try keepingFront(window.pid) {
      try SkyLight.focus(pid: window.pid, window: window.id)
      try input.run([EventStep(move, pause: 0.02), EventStep(wheel)], route: .skyLight(window.pid))
    }
  }

  /// Keys go to the app's focused element (`bg.focused`), wherever it is in the app.
  @discardableResult
  static func key(_ params: BgKeyParams, layout: () -> KeyboardLayoutMap?, input: InputController) throws -> Bool {
    let key = try Key(params)
    let window = try Windows.target(params.window, onScreen: false)
    let stroke = try KeyMap.resolve(params.keys, layout: layout())
    let chromium = Chromium.isChromium(pid: window.pid)
    guard SkyLight.available else {
      if chromium, try Chromium.key(stroke, pid: window.pid, input: input) { return false }
      try input.run(Key.steps(stroke, repeat: key.count), route: .process(window.pid))
      return false
    }
    if frontsItself(stroke, chromium: chromium) {
      throw RPCError.unsupported(
        "That opens a tab or a window, which the browser brings to the front. In the background, use the tab you have: cmd+L, the address, return.")
    }
    try checkNotInUse(window)
    // cmd+A in a page field selects nothing: its text is selected through Accessibility.
    if chromium, try Chromium.key(stroke, pid: window.pid, input: input) { return false }
    var steps = try Key.steps(stroke, repeat: key.count)
    // Plain keys carry the authentication message (Chromium wants it); shortcuts don't, so the app's menus see them.
    let shortcut = !stroke.modifierFlags.intersection([.maskCommand, .maskControl]).isEmpty
    if !shortcut {
      steps = steps.map { step in
        var step = step
        step.event.authenticate = true
        step.release?.authenticate = true
        return step
      }
    }
    return try keepingFront(window.pid) {
      try SkyLight.makeKey(pid: window.pid, window: window.id)
      try input.run(steps, route: .skyLight(window.pid))
    }
  }

  @discardableResult
  static func type(_ params: BgTypeParams, layout: () -> KeyboardLayoutMap?, input: InputController) throws -> Bool {
    let typing = try Typing(params)
    let window = try Windows.target(params.window, onScreen: false)
    guard SkyLight.available else {
      if Chromium.isChromium(pid: window.pid) {
        try Chromium.type(typing.text, replace: typing.replace, pid: window.pid, layout: layout(), input: input)
        return false
      }
      if typing.replace {
        try input.run(BackgroundEvents.press(0, flags: .maskCommand, repeat: 1), route: .process(window.pid))
      }
      try input.run(TypingEvents.steps(typing.text), route: .process(window.pid))
      return false
    }
    try checkNotInUse(window)
    if secureInputOn() {
      throw RPCError.unsupported(
        "A password field has the keyboard (macOS's secure input is on): passwords are never typed, so nothing is typed while it's on.")
    }
    let target = Chromium.typingTarget(window.pid)
    if let target, Inspect.isSecure(role: Inspect.role(of: target), subrole: Inspect.copy(target, "AXSubrole") as? String) {
      throw RPCError.unsupported("That is a password field: passwords are never typed.")
    }
    return try keepingFront(window.pid) {
      try SkyLight.makeKey(pid: window.pid, window: window.id)
      if typing.replace {
        try input.ready()
        // The field's text, cleared or selected the way the app takes it; cmd+A where Accessibility can't.
        if let target, Chromium.settable(target, kAXValueAttribute) {
          _ = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, "" as CFString)
        } else if let target, Chromium.selectAll(target) {
        } else {
          var all = EventSpec.key(0, down: true, flags: .maskCommand)
          all.authenticate = false
          try input.run(
            EventStep.pair(all, .key(0, down: false, flags: .maskCommand), pauseBetween: 0.01, pauseAfter: 0.04),
            route: .skyLight(window.pid))
        }
        usleep(40_000)
      }
      try input.run(typingSteps(typing.text), route: .skyLight(window.pid))
    }
  }

  /// Each character on a key event of its own (keycode 0), with the authentication message; Return and Tab as keys.
  static func typingSteps(_ text: String) -> [EventStep] {
    SkyLight.typing(text).flatMap { key -> [EventStep] in
      var down: EventSpec
      var up: EventSpec
      switch key {
      case .key(let code):
        down = .key(code, down: true, flags: [])
        up = .key(code, down: false, flags: [])
      case .text(let units):
        down = .char(0, units, down: true)
        up = .char(0, units, down: false)
      }
      down.authenticate = true
      up.authenticate = true
      return EventStep.pair(down, up, pauseBetween: 0.006, pauseAfter: 0.006)
    }
  }
}
