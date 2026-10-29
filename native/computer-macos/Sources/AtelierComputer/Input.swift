import ApplicationServices
import CoreGraphics
import Foundation

/// Where synthesized input goes: the HID system, as if from the person's own mouse and keyboard (Full control: it moves
/// the cursor and reaches the frontmost app), or straight to one app's process (background: the cursor stays where it
/// is and the app isn't brought forward).
public enum InputRoute: Equatable, Sendable {
  case hid
  case process(pid_t)
}

extension MouseButton {
  init(_ button: CGMouseButton) {
    switch button {
    case .left: self = .left
    case .right: self = .right
    default: self = .middle
    }
  }

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

/// Synthesized mouse and keyboard input. Every event is posted to the HID tap (or, in the background, to one app's
/// process) and tagged 'ATLR' in `kCGEventSourceUserData`, so the control watch can tell it from the person's own input.
/// Keys, modifiers and buttons it presses are tracked, so `releaseAll` (and the Esc stop, and exiting) can let go of
/// them; after a stop both routes are refused alike.
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
  /// Presses posted to an app's process that weren't let go of yet, with the event that does.
  private var heldInProcesses: [ProcessHold] = []
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
      postLocked(.key(code, down: false, flags: flags), .hid)
    }
    let location = CGEvent(source: nil)?.location ?? lastPointer ?? .zero
    for button in heldButtons.reversed() {
      postLocked(.mouse(button.upType, at: location, button: button, clickState: 1, flags: flags), .hid)
    }
    for modifier in heldModifiers.reversed() {
      flags.remove(modifier.flag)
      postLocked(.modifier(modifier, flags: flags), .hid)
    }
    for hold in heldInProcesses.reversed() {
      postLocked(hold.release, .process(hold.pid))
    }
    heldKeys = []
    heldButtons = []
    heldModifiers = []
    heldInProcesses = []
    generation += 1
    condition.broadcast()
  }

  // ---------------------------------------------------------------- posting

  private struct ProcessHold: Equatable {
    var pid: pid_t
    var release: EventSpec
  }

  private enum Change {
    case none, keyDown(CGKeyCode), keyUp(CGKeyCode), modifierDown(Modifier), modifierUp(Modifier)
    case buttonDown(MouseButton), buttonUp(MouseButton)
    case processDown(ProcessHold), processUp(ProcessHold)
  }

  /// Input may go out: not stopped, and Accessibility granted (posting events, and pressing through Accessibility,
  /// need it).
  func ready() throws {
    if condition.withLock({ stopped || terminated }) { throw RPCError.stopped }
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }
  }

  /// Posts one event unless input was stopped meanwhile; the check and the post are atomic with `stop()`.
  private func post(_ spec: EventSpec, _ change: Change = .none, route: InputRoute = .hid) throws {
    let event = try spec.make(source: source)
    condition.lock()
    defer { condition.unlock() }
    if stopped || terminated { throw RPCError.stopped }
    postLocked(event, route)
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
    case .processDown(let hold):
      if !heldInProcesses.contains(hold) { heldInProcesses.append(hold) }
    case .processUp(let hold):
      heldInProcesses.removeAll { $0 == hold }
    }
    // Only an Esc through the HID system shows in the key state the Esc watch polls.
    switch (change, route) {
    case (.keyDown(Self.escape), .hid), (.keyUp(Self.escape), .hid):
      lastEscapeEventAt = DispatchTime.now().uptimeNanoseconds
    default: break
    }
  }

  private func postLocked(_ event: CGEvent, _ route: InputRoute) {
    event.setIntegerValueField(.eventSourceUserData, value: Self.eventTag)
    switch route {
    case .hid:
      event.post(tap: .cghidEventTap)
      switch event.type {
      case .mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp,
        .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel:
        lastPointer = event.location
      default: break
      }
    case .process(let pid):
      // Straight to the app: the window server doesn't move the cursor or bring the app forward for it.
      event.postToPid(pid)
    }
  }

  /// A release or a stop: best effort, an event that can't be made is skipped.
  private func postLocked(_ spec: EventSpec, _ route: InputRoute) {
    if let event = try? spec.make(source: source) { postLocked(event, route) }
  }

  /// What posting a step changes in the held state.
  private func change(for step: EventStep, route: InputRoute) -> Change {
    let down = step.release != nil
    guard down || step.isRelease else { return .none }
    switch route {
    case .process(let pid):
      return down ? .processDown(ProcessHold(pid: pid, release: step.release!)) : .processUp(ProcessHold(pid: pid, release: step.event))
    case .hid:
      switch step.event.kind {
      case .key(let code, _): return down ? .keyDown(code) : .keyUp(code)
      case .text: return down ? .keyDown(0) : .keyUp(0)
      case .mouse(_, let button): return down ? .buttonDown(MouseButton(button)) : .buttonUp(MouseButton(button))
      case .modifier, .scroll: return .none
      }
    }
  }

  /// Posts a sequence of steps, pausing as each says; refused as a whole when stopped, cut short by a stop.
  public func run(_ steps: [EventStep], route: InputRoute) throws {
    try ready()
    try sequence {
      for step in steps {
        try post(step.event, change(for: step, route: route), route: route)
        if step.pause > 0 { pause(step.pause) }
      }
    }
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
      try post(.modifier(modifier, flags: flags), .modifierDown(modifier))
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
      try post(.modifier(modifier, flags: flags), .modifierUp(modifier))
      pause(0.008)
    }
  }

  // ---------------------------------------------------------------- mouse

  /// Moves the pointer; with a button held this is a drag, so `mouse.down`, `mouse.move`, `mouse.up` drags too.
  private func postMove(_ point: CGPoint) throws {
    if let held = condition.withLock({ heldButtons.first }) {
      try post(.mouse(held.dragType, at: point, button: held))
    } else {
      try post(.mouse(.mouseMoved, at: point, button: .left))
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
        try post(.mouse(button.downType, at: point, button: button, clickState: Int64(n), flags: flags), .buttonDown(button))
        pause(0.02)
        try post(.mouse(button.upType, at: point, button: button, clickState: Int64(n), flags: flags), .buttonUp(button))
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
      try post(.mouse(button.downType, at: point, button: button, clickState: 1), .buttonDown(button))
    }
  }

  public func buttonUp(at point: CGPoint, button: MouseButton) throws {
    try ready()
    try sequence {
      try postMove(point)
      pause(0.02)
      try post(.mouse(button.upType, at: point, button: button, clickState: 1), .buttonUp(button))
    }
  }

  public func drag(from start: CGPoint, to end: CGPoint, button: MouseButton) throws {
    try ready()
    try sequence {
      try postMove(start)
      pause(0.03)
      try post(.mouse(button.downType, at: start, button: button, clickState: 1), .buttonDown(button))
      pause(0.05)
      for point in Self.dragPath(from: start, to: end) {
        try post(.mouse(button.dragType, at: point, button: button))
        pause(0.016)
      }
      pause(0.03)
      try post(.mouse(button.upType, at: end, button: button, clickState: 1), .buttonUp(button))
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
      try post(.scroll(at: point, wheel1: wheel1, wheel2: wheel2))
    }
  }

  // ---------------------------------------------------------------- keyboard

  public func press(_ stroke: KeyStroke, repeat count: Int) throws {
    try ready()
    try sequence {
      let flags = try pressModifiers(stroke.modifiers).union(stroke.keyFlags)
      if let code = stroke.keyCode {
        for n in 0..<count {
          try post(.key(code, down: true, flags: flags), .keyDown(code))
          pause(0.01)
          try post(.key(code, down: false, flags: flags), .keyUp(code))
          if n < count - 1 { pause(0.02) }
        }
      }
      pause(0.01)
      try releaseModifiers(stroke.modifiers)
    }
  }

  public func type(_ text: String) throws {
    try run(TypingEvents.steps(text), route: .hid)
  }

  public func hold(_ stroke: KeyStroke, milliseconds: Int) throws {
    try ready()
    try sequence {
      let flags = try pressModifiers(stroke.modifiers).union(stroke.keyFlags)
      if let code = stroke.keyCode { try post(.key(code, down: true, flags: flags), .keyDown(code)) }
      try wait(milliseconds)
      if let code = stroke.keyCode, condition.withLock({ heldKeys.contains(code) }) {
        try post(.key(code, down: false, flags: flags), .keyUp(code))
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
