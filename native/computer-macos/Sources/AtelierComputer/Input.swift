import ApplicationServices
import CoreGraphics
import Foundation

extension MouseButton {
  var cgButton: CGMouseButton {
    switch self {
    case .left: .left
    case .right: .right
    case .middle: .center
    }
  }

  var downType: CGEventType {
    switch self {
    case .left: .leftMouseDown
    case .right: .rightMouseDown
    case .middle: .otherMouseDown
    }
  }

  var upType: CGEventType {
    switch self {
    case .left: .leftMouseUp
    case .right: .rightMouseUp
    case .middle: .otherMouseUp
    }
  }

  var dragType: CGEventType {
    switch self {
    case .left: .leftMouseDragged
    case .right: .rightMouseDragged
    case .middle: .otherMouseDragged
    }
  }
}

/// Synthesized mouse and keyboard input. Every event is posted to the HID tap and tagged 'ATLR' in
/// `kCGEventSourceUserData`, so the control watch can tell it from the person's own input. Keys, modifiers and buttons
/// it presses are tracked, so `releaseAll` (and the Esc stop, and exiting) can let go of them.
public final class InputController: @unchecked Sendable {
  /// 'ATLR'.
  public static let eventTag: Int64 = 0x4154_4C52
  static let escape = CGKeyCode(53)

  /// Guards everything below; `key.hold` waits on it.
  private let condition = NSCondition()
  private let source: CGEventSource?
  private var stopped = false
  private var terminated = false
  /// Bumped by every release, so a hold in progress knows it was let go.
  private var generation = 0
  private var heldKeys: [CGKeyCode] = []
  private var heldModifiers: [Modifier] = []
  private var heldButtons: [MouseButton] = []
  private var lastPointer: CGPoint?
  private var lastEscapeEventAt: UInt64 = 0

  public init() {
    source = CGEventSource(stateID: .hidSystemState)
    // Never hold back the person's own keyboard and mouse after a synthesized event: they must be able to reach Esc.
    source?.localEventsSuppressionInterval = 0
    source?.userData = Self.eventTag
  }

  // ---------------------------------------------------------------- state

  public var isStopped: Bool { condition.withLock { stopped } }

  /// Where the helper last put the pointer.
  public var lastPointerPosition: CGPoint? { condition.withLock { lastPointer } }

  func setPointerBaseline(_ point: CGPoint) {
    condition.withLock { if lastPointer == nil { lastPointer = point } }
  }

  /// The helper holds Esc itself, or posted an Esc event in the last 300 ms: the Esc key-state poll would see its
  /// own key, not the person's.
  func ownsEscape(now: UInt64) -> Bool {
    condition.withLock { heldKeys.contains(Self.escape) || now &- lastEscapeEventAt < 300_000_000 }
  }

  public func cursorPosition() -> Point {
    Point(CGEvent(source: nil)?.location ?? lastPointerPosition ?? .zero)
  }

  /// The person held Esc: refuse input from now on, and let go of everything.
  public func stop() {
    condition.lock()
    stopped = true
    releaseLocked()
    condition.unlock()
  }

  public func resume() {
    condition.withLock { stopped = false }
  }

  /// The helper is exiting: let go of everything, and post nothing more.
  public func terminate() {
    condition.lock()
    terminated = true
    releaseLocked()
    condition.unlock()
  }

  public func releaseAll() {
    condition.lock()
    releaseLocked()
    condition.unlock()
  }

  private func releaseLocked() {
    var flags = Modifier.flags(heldModifiers)
    for code in heldKeys.reversed() {
      if let event = try? keyEvent(code, down: false, flags: flags) { postLocked(event) }
    }
    let location = CGEvent(source: nil)?.location ?? lastPointer ?? .zero
    for button in heldButtons.reversed() {
      if let event = try? mouseEvent(button.upType, at: location, button: button, clickState: 1, flags: flags) {
        postLocked(event)
      }
    }
    for modifier in heldModifiers.reversed() {
      flags.remove(modifier.flag)
      if let event = try? modifierEvent(modifier, flags: flags) { postLocked(event) }
    }
    heldKeys = []
    heldButtons = []
    heldModifiers = []
    generation += 1
    condition.broadcast()
  }

  // ---------------------------------------------------------------- posting

  private enum Change {
    case none, keyDown(CGKeyCode), keyUp(CGKeyCode), modifierDown(Modifier), modifierUp(Modifier)
    case buttonDown(MouseButton), buttonUp(MouseButton)
  }

  /// Input may go out: not stopped, and Accessibility granted (posting events needs it).
  private func ready() throws {
    if condition.withLock({ stopped || terminated }) { throw RPCError.stopped }
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }
  }

  /// Posts one event unless input was stopped meanwhile; the check and the post are atomic with `stop()`.
  private func post(_ event: CGEvent, _ change: Change = .none) throws {
    condition.lock()
    defer { condition.unlock() }
    if stopped || terminated { throw RPCError.stopped }
    postLocked(event)
    switch change {
    case .none: break
    case .keyDown(let code):
      if !heldKeys.contains(code) { heldKeys.append(code) }
    case .keyUp(let code):
      heldKeys.removeAll { $0 == code }
    case .modifierDown(let modifier):
      if !heldModifiers.contains(modifier) { heldModifiers.append(modifier) }
    case .modifierUp(let modifier):
      heldModifiers.removeAll { $0 == modifier }
    case .buttonDown(let button):
      if !heldButtons.contains(button) { heldButtons.append(button) }
    case .buttonUp(let button):
      heldButtons.removeAll { $0 == button }
    }
    switch change {
    case .keyDown(Self.escape), .keyUp(Self.escape): lastEscapeEventAt = DispatchTime.now().uptimeNanoseconds
    default: break
    }
  }

  private func postLocked(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: Self.eventTag)
    event.post(tap: .cghidEventTap)
    switch event.type {
    case .mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp,
      .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel:
      lastPointer = event.location
    default: break
    }
  }

  private func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws -> CGEvent {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw RPCError.internal("could not create a key event")
    }
    event.flags = flags
    return event
  }

  /// A modifier key going down or up: a flagsChanged event whose flags say which modifiers are now held.
  private func modifierEvent(_ modifier: Modifier, flags: CGEventFlags) throws -> CGEvent {
    let event = try keyEvent(modifier.keyCode, down: flags.contains(modifier.flag), flags: flags)
    event.type = .flagsChanged
    return event
  }

  private func mouseEvent(
    _ type: CGEventType, at point: CGPoint, button: MouseButton, clickState: Int64 = 0, flags: CGEventFlags = []
  ) throws -> CGEvent {
    guard
      let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button.cgButton)
    else { throw RPCError.internal("could not create a mouse event") }
    if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
    event.flags = flags
    return event
  }

  private func pause(_ seconds: Double) {
    Thread.sleep(forTimeInterval: seconds)
  }

  /// Runs a sequence of events; if something other than a stop breaks it, lets go of what it held.
  private func sequence(_ body: () throws -> Void) throws {
    do {
      try body()
    } catch let error as RPCError where error.isStopped {
      throw error
    } catch {
      releaseAll()
      throw error
    }
  }

  private func pressModifiers(_ modifiers: [Modifier]) throws -> CGEventFlags {
    var flags = CGEventFlags()
    for modifier in modifiers {
      flags.insert(modifier.flag)
      try post(modifierEvent(modifier, flags: flags), .modifierDown(modifier))
      pause(0.008)
    }
    return flags
  }

  /// Lets go of the modifiers, last first; only those still held (a release may have come in between).
  private func releaseModifiers(_ modifiers: [Modifier]) throws {
    let held = condition.withLock { heldModifiers }
    var flags = Modifier.flags(held)
    for modifier in modifiers.reversed() where held.contains(modifier) {
      flags.remove(modifier.flag)
      try post(modifierEvent(modifier, flags: flags), .modifierUp(modifier))
      pause(0.008)
    }
  }

  // ---------------------------------------------------------------- mouse

  /// Moves the pointer; with a button held this is a drag, so `mouse.down`, `mouse.move`, `mouse.up` drags too.
  private func postMove(_ point: CGPoint) throws {
    if let held = condition.withLock({ heldButtons.first }) {
      try post(mouseEvent(held.dragType, at: point, button: held))
    } else {
      try post(mouseEvent(.mouseMoved, at: point, button: .left))
    }
  }

  public func move(to point: CGPoint) throws {
    try ready()
    try sequence { try postMove(point) }
  }

  public func click(at point: CGPoint, button: MouseButton, count: Int, modifiers: [Modifier]) throws {
    try ready()
    try sequence {
      try postMove(point)
      pause(0.03)
      let flags = try pressModifiers(modifiers)
      for n in 1...count {
        try post(mouseEvent(button.downType, at: point, button: button, clickState: Int64(n), flags: flags), .buttonDown(button))
        pause(0.02)
        try post(mouseEvent(button.upType, at: point, button: button, clickState: Int64(n), flags: flags), .buttonUp(button))
        if n < count { pause(0.04) }
      }
      pause(0.01)
      try releaseModifiers(modifiers)
    }
  }

  public func buttonDown(at point: CGPoint, button: MouseButton) throws {
    try ready()
    try sequence {
      try postMove(point)
      pause(0.02)
      try post(mouseEvent(button.downType, at: point, button: button, clickState: 1), .buttonDown(button))
    }
  }

  public func buttonUp(at point: CGPoint, button: MouseButton) throws {
    try ready()
    try sequence {
      try postMove(point)
      pause(0.02)
      try post(mouseEvent(button.upType, at: point, button: button, clickState: 1), .buttonUp(button))
    }
  }

  public func drag(from start: CGPoint, to end: CGPoint, button: MouseButton) throws {
    try ready()
    try sequence {
      try postMove(start)
      pause(0.03)
      try post(mouseEvent(button.downType, at: start, button: button, clickState: 1), .buttonDown(button))
      pause(0.05)
      for point in Self.dragPath(from: start, to: end) {
        try post(mouseEvent(button.dragType, at: point, button: button))
        pause(0.016)
      }
      pause(0.03)
      try post(mouseEvent(button.upType, at: end, button: button, clickState: 1), .buttonUp(button))
    }
  }

  /// The dragged moves between `start` and `end`, `end` included.
  static func dragPath(from start: CGPoint, to end: CGPoint, steps: Int = 10) -> [CGPoint] {
    (1...steps).map { step in
      let t = CGFloat(step) / CGFloat(steps)
      return CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
    }
  }

  /// Wheel deltas for a scroll in lines: positive `dy` scrolls the content down (the wheel turns towards the person,
  /// a negative wheel1), positive `dx` right (a negative wheel2).
  static func wheelDeltas(dx: Double, dy: Double) -> (wheel1: Int32, wheel2: Int32) {
    (Int32(-dy.rounded()), Int32(-dx.rounded()))
  }

  public func scroll(at point: CGPoint, dx: Double, dy: Double) throws {
    try ready()
    try sequence {
      try postMove(point)
      pause(0.02)
      let (wheel1, wheel2) = Self.wheelDeltas(dx: dx, dy: dy)
      guard wheel1 != 0 || wheel2 != 0 else { return }
      guard
        let event = CGEvent(
          scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0)
      else { throw RPCError.internal("could not create a scroll event") }
      event.location = point
      try post(event)
    }
  }

  // ---------------------------------------------------------------- keyboard

  public func press(_ stroke: KeyStroke, repeat count: Int) throws {
    try ready()
    try sequence {
      let flags = try pressModifiers(stroke.modifiers).union(stroke.keyFlags)
      if let code = stroke.keyCode {
        for n in 0..<count {
          try post(keyEvent(code, down: true, flags: flags), .keyDown(code))
          pause(0.01)
          try post(keyEvent(code, down: false, flags: flags), .keyUp(code))
          if n < count - 1 { pause(0.02) }
        }
      }
      pause(0.01)
      try releaseModifiers(stroke.modifiers)
    }
  }

  public func type(_ text: String) throws {
    try ready()
    try sequence {
      for piece in KeyText.pieces(text) {
        switch piece {
        case .newline:
          let code = CGKeyCode(36)
          try post(keyEvent(code, down: true, flags: []), .keyDown(code))
          pause(0.005)
          try post(keyEvent(code, down: false, flags: []), .keyUp(code))
        case .text(let units):
          try post(unicodeEvent(units, down: true), .keyDown(0))
          try post(unicodeEvent(units, down: false), .keyUp(0))
        }
        pause(0.012)
      }
    }
  }

  private func unicodeEvent(_ units: [UniChar], down: Bool) throws -> CGEvent {
    let event = try keyEvent(0, down: down, flags: [])
    units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
    return event
  }

  public func hold(_ stroke: KeyStroke, milliseconds: Int) throws {
    try ready()
    try sequence {
      let flags = try pressModifiers(stroke.modifiers).union(stroke.keyFlags)
      if let code = stroke.keyCode { try post(keyEvent(code, down: true, flags: flags), .keyDown(code)) }
      try wait(milliseconds)
      if let code = stroke.keyCode, condition.withLock({ heldKeys.contains(code) }) {
        try post(keyEvent(code, down: false, flags: flags), .keyUp(code))
      }
      try releaseModifiers(stroke.modifiers)
    }
  }

  /// Waits, cut short by a release (then the keys are already up) or a stop.
  private func wait(_ milliseconds: Int) throws {
    condition.lock()
    defer { condition.unlock() }
    let start = generation
    let deadline = Date().addingTimeInterval(Double(milliseconds) / 1000)
    while !stopped && !terminated && generation == start && Date() < deadline {
      _ = condition.wait(until: deadline)
    }
    if stopped || terminated { throw RPCError.stopped }
  }
}
