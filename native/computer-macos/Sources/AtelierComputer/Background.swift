import ApplicationServices
import CoreGraphics
import Foundation

/// Background input (`bg.*`): into one app's window without the person's mouse and keyboard. Events go straight to the
/// app's process (`InputRoute.process`): the cursor doesn't move, the app isn't brought forward. A plain click on a
/// control is an `AXPress` instead, which needs no pointer at all. Everything goes through the same input gate as Full
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

    init(_ params: BgTypeParams) throws {
      window = try WindowChoice.windowID(params.window)
      guard params.text.utf16.count <= 100_000 else { throw RPCError.invalidParams("text is longer than 100000") }
      text = params.text
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

  // ---------------------------------------------------------------- the calls

  static func click(_ params: BgClickParams, input: InputController) throws {
    let click = try Click(params)
    let window = try Windows.target(params.window, onScreen: true)
    try WindowChoice.check(click.point, in: window)
    try input.ready()
    if click.isPlainClick, try press(at: click.point, in: window, input: input) { return }
    let steps = BackgroundEvents.click(
      at: click.point, button: click.button, count: click.count, flags: Modifier.flags(click.modifiers),
      window: window.id)
    try input.run(steps, route: .process(window.pid))
  }

  static func scroll(_ params: BgScrollParams, input: InputController) throws {
    let scroll = try Scroll(params)
    let window = try Windows.target(params.window, onScreen: true)
    try WindowChoice.check(scroll.point, in: window)
    try input.run(
      BackgroundEvents.scroll(at: scroll.point, dx: scroll.dx, dy: scroll.dy, window: window.id),
      route: .process(window.pid))
  }

  /// Keys go to the app's focused element (`bg.focused`), wherever it is in the app.
  static func key(_ params: BgKeyParams, layout: () -> KeyboardLayoutMap?, input: InputController) throws {
    let key = try Key(params)
    let window = try Windows.target(params.window, onScreen: false)
    let steps = try Key.steps(KeyMap.resolve(params.keys, layout: layout()), repeat: key.count)
    try input.run(steps, route: .process(window.pid))
  }

  static func type(_ params: BgTypeParams, input: InputController) throws {
    let typing = try Typing(params)
    let window = try Windows.target(params.window, onScreen: false)
    try input.run(TypingEvents.steps(typing.text), route: .process(window.pid))
  }
}
