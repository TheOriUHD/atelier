import CoreGraphics
import Foundation

/// A synthesized event as data: what it is and every field set on it, before `make` turns it into a CGEvent. Full
/// control and background input build the same events; only where they are posted differs (`InputRoute`).
public struct EventSpec: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case key(CGKeyCode, down: Bool)
    /// A modifier key going down or up: a flagsChanged event whose flags say which modifiers are now held.
    case modifier(CGKeyCode, down: Bool)
    /// Text typed by one key event that carries it (`keyboardSetUnicodeString`).
    case text([UniChar], down: Bool)
    case mouse(CGEventType, button: CGMouseButton)
    /// Line units: wheel1 vertical, wheel2 horizontal.
    case scroll(wheel1: Int32, wheel2: Int32)
  }

  public var kind: Kind
  /// Global points; mouse and scroll events only.
  public var location: CGPoint?
  /// nil leaves the flags the event source gives the event.
  public var flags: CGEventFlags?
  /// Integer fields set on the event: the click count, the window under the pointer.
  public var fields: [CGEventField: Int64]

  public init(kind: Kind, location: CGPoint? = nil, flags: CGEventFlags? = [], fields: [CGEventField: Int64] = [:]) {
    self.kind = kind
    self.location = location
    self.flags = flags
    self.fields = fields
  }

  public static func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) -> EventSpec {
    EventSpec(kind: .key(code, down: down), flags: flags)
  }

  /// A modifier going down or up: down when `flags` (the modifiers held after it) contain it.
  public static func modifier(_ modifier: Modifier, flags: CGEventFlags) -> EventSpec {
    EventSpec(kind: .modifier(modifier.keyCode, down: flags.contains(modifier.flag)), flags: flags)
  }

  public static func text(_ units: [UniChar], down: Bool) -> EventSpec {
    EventSpec(kind: .text(units, down: down), flags: [])
  }

  /// A mouse event; `clickState` 0 leaves the click count unset.
  public static func mouse(
    _ type: CGEventType, at point: CGPoint, button: MouseButton, clickState: Int64 = 0, flags: CGEventFlags = []
  ) -> EventSpec {
    var fields: [CGEventField: Int64] = [:]
    if clickState > 0 { fields[.mouseEventClickState] = clickState }
    return EventSpec(kind: .mouse(type, button: button.cgButton), location: point, flags: flags, fields: fields)
  }

  public static func scroll(at point: CGPoint, wheel1: Int32, wheel2: Int32, flags: CGEventFlags? = nil) -> EventSpec {
    EventSpec(kind: .scroll(wheel1: wheel1, wheel2: wheel2), location: point, flags: flags)
  }

  /// The same event with more fields set.
  public func with(_ more: [CGEventField: Int64]) -> EventSpec {
    var copy = self
    copy.fields.merge(more) { _, new in new }
    return copy
  }

  /// The CGEvent, from `source`. Nothing is posted.
  public func make(source: CGEventSource?) throws -> CGEvent {
    let event: CGEvent?
    switch kind {
    case .key(let code, let down), .modifier(let code, let down):
      event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    case .text(_, let down):
      event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
    case .mouse(let type, let button):
      event = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: location ?? .zero, mouseButton: button)
    case .scroll(let wheel1, let wheel2):
      event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0)
      if let location { event?.location = location }
    }
    guard let event else { throw RPCError.internal("could not create a \(kindName) event") }
    if let flags { event.flags = flags }
    switch kind {
    case .modifier: event.type = .flagsChanged
    case .text(let units, _):
      units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
    default: break
    }
    for (field, value) in fields { event.setIntegerValueField(field, value: value) }
    return event
  }

  private var kindName: String {
    switch kind {
    case .key, .modifier, .text: "key"
    case .mouse: "mouse"
    case .scroll: "scroll"
    }
  }
}

/// One event of a sequence, with what it holds down and the pause after it.
public struct EventStep: Equatable, Sendable {
  public var event: EventSpec
  /// For a press (a key or button going down): the event that lets go of it. A release, a stop or exiting posts it
  /// when the sequence doesn't get there.
  public var release: EventSpec?
  /// It lets go of an earlier press (it is that press's `release`).
  public var isRelease: Bool
  /// Seconds to wait after it.
  public var pause: Double

  public init(_ event: EventSpec, release: EventSpec? = nil, isRelease: Bool = false, pause: Double = 0) {
    self.event = event
    self.release = release
    self.isRelease = isRelease
    self.pause = pause
  }

  /// A press and its release.
  static func pair(_ down: EventSpec, _ up: EventSpec, pauseBetween: Double, pauseAfter: Double) -> [EventStep] {
    [EventStep(down, release: up, pause: pauseBetween), EventStep(up, isRelease: true, pause: pauseAfter)]
  }
}

/// Typing text, for `key.type` and `bg.type` alike: runs of characters as key events that carry them, and line breaks
/// as Return.
public enum TypingEvents {
  public static let returnKey = CGKeyCode(36)

  public static func steps(_ text: String) -> [EventStep] {
    KeyText.pieces(text).flatMap { piece -> [EventStep] in
      switch piece {
      case .newline:
        EventStep.pair(
          .key(returnKey, down: true, flags: []), .key(returnKey, down: false, flags: []), pauseBetween: 0.005,
          pauseAfter: 0.012)
      case .text(let units):
        EventStep.pair(.text(units, down: true), .text(units, down: false), pauseBetween: 0, pauseAfter: 0.012)
      }
    }
  }
}

/// The events background input posts to an app's process. Mouse events name the window they are for in both "window
/// under the pointer" fields, the known way to make an app take a click over a window that isn't in front; nothing
/// moves the cursor, and modifiers are only flags on the events, never keys pressed for the whole system.
public enum BackgroundEvents {
  public static func windowFields(_ window: CGWindowID) -> [CGEventField: Int64] {
    [
      .mouseEventWindowUnderMousePointer: Int64(window),
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent: Int64(window),
    ]
  }

  /// A move to the point (for apps that track where the pointer is), then `count` presses with their click number.
  public static func click(
    at point: CGPoint, button: MouseButton, count: Int, flags: CGEventFlags, window: CGWindowID
  ) -> [EventStep] {
    let fields = windowFields(window)
    var steps = [EventStep(EventSpec.mouse(.mouseMoved, at: point, button: .left, flags: flags).with(fields), pause: 0.03)]
    for n in 1...max(1, count) {
      let down = EventSpec.mouse(button.downType, at: point, button: button, clickState: Int64(n), flags: flags)
      let up = EventSpec.mouse(button.upType, at: point, button: button, clickState: Int64(n), flags: flags)
      steps += EventStep.pair(down.with(fields), up.with(fields), pauseBetween: 0.02, pauseAfter: n < count ? 0.04 : 0)
    }
    return steps
  }

  /// A move to the point naming the window, then the wheel in lines there (nothing when both round to 0). A scroll
  /// event has no room for the window fields (CoreGraphics keeps them on mouse events only), so it is aimed by its
  /// location and the move before it. No modifiers: the person's own held keys don't turn it sideways.
  public static func scroll(at point: CGPoint, dx: Double, dy: Double, window: CGWindowID) -> [EventStep] {
    let (wheel1, wheel2) = InputController.wheelDeltas(dx: dx, dy: dy)
    guard wheel1 != 0 || wheel2 != 0 else { return [] }
    return [
      EventStep(EventSpec.mouse(.mouseMoved, at: point, button: .left).with(windowFields(window)), pause: 0.02),
      EventStep(EventSpec.scroll(at: point, wheel1: wheel1, wheel2: wheel2, flags: [])),
    ]
  }

  /// A key pressed `count` times, its modifiers in the flags of each event.
  public static func press(_ code: CGKeyCode, flags: CGEventFlags, repeat count: Int) -> [EventStep] {
    (0..<max(1, count)).flatMap { n in
      EventStep.pair(
        .key(code, down: true, flags: flags), .key(code, down: false, flags: flags), pauseBetween: 0.01,
        pauseAfter: n < count - 1 ? 0.02 : 0)
    }
  }
}
