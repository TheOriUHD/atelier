import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// The Esc hold, from two detectors: the event tap's key events and a poll of the hardware key state (which still
/// works while secure input hides keys from the tap). Times are in milliseconds on one monotonic clock.
public struct EscTracker: Sendable {
  public enum Event: Equatable, Sendable {
    case down
    case up(heldMs: Int)
    case stopped(heldMs: Int)
  }

  public static let holdMs: Double = 1000

  private var downAt: Double?
  private var fired = false
  /// The poll saw this hold's key down, so it works and its "up" can be trusted. A poll that never sees the key
  /// (no access to the key state) can't end a hold the tap started.
  private var pollSawDown = false

  public init() {}

  public var isDown: Bool { downAt != nil }

  /// A key-down from the tap. Only a fresh press starts a hold; autorepeats only advance it.
  public mutating func keyDown(at now: Double, autorepeat: Bool) -> [Event] {
    if downAt != nil { return check(now) }
    if autorepeat { return [] }
    start(now)
    return [.down]
  }

  public mutating func keyUp(at now: Double) -> [Event] {
    guard let start = downAt else { return [] }
    let held = Self.ms(now - start)
    let wasFired = fired
    reset()
    return wasFired ? [] : [.up(heldMs: held)]
  }

  /// The 50 ms poll: `physicallyDown` is the hardware state of Esc, nil when it can't be told (the helper is
  /// pressing Esc itself).
  public mutating func tick(at now: Double, physicallyDown: Bool?) -> [Event] {
    var events: [Event] = []
    if physicallyDown == true {
      if downAt == nil {
        start(now)
        events.append(.down)
      }
      pollSawDown = true
    } else if physicallyDown == false, downAt != nil, pollSawDown {
      return keyUp(at: now)
    }
    return events + check(now)
  }

  public mutating func reset() {
    downAt = nil
    fired = false
    pollSawDown = false
  }

  private mutating func start(_ now: Double) {
    downAt = now
    fired = false
    pollSawDown = false
  }

  private mutating func check(_ now: Double) -> [Event] {
    guard let start = downAt, !fired, now - start >= Self.holdMs else { return [] }
    fired = true
    return [.stopped(heldMs: Self.ms(now - start))]
  }

  private static func ms(_ value: Double) -> Int { max(0, Int(value.rounded())) }
}

/// Throttles `control.userInput`, and decides whether a pointer move was the person's.
public struct UserInputFilter: Sendable {
  public static let intervalMs: Double = 500
  public static let moveTolerance: Double = 24

  private var lastSentAt: Double?

  public init() {}

  /// True when a notification may go out now (at most one per 500 ms).
  public mutating func admit(at now: Double) -> Bool {
    if let last = lastSentAt, now - last < Self.intervalMs { return false }
    lastSentAt = now
    return true
  }

  /// A move more than 24 points from where the helper itself last put the pointer.
  public static func isPersonMove(_ point: CGPoint, helperAt: CGPoint?) -> Bool {
    guard let helperAt else { return false }
    return hypot(point.x - helperAt.x, point.y - helperAt.y) > moveTolerance
  }
}

/// While the helper has control: an active event tap on its own thread watching the person's keys and mouse (it
/// changes nothing and skips the helper's own 'ATLR'-tagged events), a 50 ms poll of Esc's key state, and a 250 ms
/// poll of secure input.
public final class ControlMonitor: @unchecked Sendable {
  private let input: InputController
  private let notify: @Sendable (ComputerNotification) -> Void
  /// Serializes the trackers: tap samples and poll ticks both land here.
  private let queue = DispatchQueue(label: "dev.atelier.computer.control")

  // Guarded by `lock`: begin/end.
  private let lock = NSLock()
  private var active = false
  private var timer: DispatchSourceTimer?

  // Guarded by `tapLock`: shared with the tap thread.
  private let tapLock = NSLock()
  private var tapPort: CFMachPort?
  private var tapLoop: CFRunLoop?
  private var tapRunning = false

  // Only touched on `queue`.
  private var enabled = false
  private var esc = EscTracker()
  private var userInput = UserInputFilter()
  private var secureInput = false
  private var ticks = 0

  public init(input: InputController, notify: @escaping @Sendable (ComputerNotification) -> Void) {
    self.input = input
    self.notify = notify
  }

  public var isActive: Bool { lock.withLock { active } }

  public func begin() throws {
    lock.lock()
    defer { lock.unlock() }
    if active { return }
    guard AXIsProcessTrusted() else { throw RPCError.permission(.accessibility) }

    let started = TapStart()
    let thread = Thread { [self] in runTap(started) }
    thread.name = "dev.atelier.computer.tap"
    thread.start()
    if started.ready.wait(timeout: .now() + 3) == .timedOut || !started.ok {
      stopTap()
      // Creating an active tap fails without Accessibility.
      throw RPCError.permission(.accessibility)
    }

    input.setPointerBaseline(CGEvent(source: nil)?.location ?? .zero)
    queue.sync {
      enabled = true
      esc.reset()
      userInput = UserInputFilter()
      secureInput = false
      ticks = 0
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(5))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    self.timer = timer
    active = true
  }

  public func end() {
    lock.lock()
    defer { lock.unlock() }
    guard active else { return }
    active = false
    timer?.cancel()
    timer = nil
    stopTap()
    queue.sync {
      enabled = false
      esc.reset()
    }
  }

  // ---------------------------------------------------------------- tap thread

  private final class TapStart: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    var ok = false
  }

  private static let watched: [CGEventType] = [
    .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown,
    .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  ]

  private func runTap(_ started: TapStart) {
    let mask = Self.watched.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    let info = Unmanaged.passUnretained(self).toOpaque()
    guard
      let port = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
        callback: { _, type, event, info in
          if let info { Unmanaged<ControlMonitor>.fromOpaque(info).takeUnretainedValue().observe(type, event) }
          return Unmanaged.passUnretained(event)
        }, userInfo: info),
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    else {
      started.ok = false
      started.ready.signal()
      return
    }
    let loop = CFRunLoopGetCurrent()!
    CFRunLoopAddSource(loop, source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    tapLock.withLock {
      tapPort = port
      tapLoop = loop
      tapRunning = true
    }
    started.ok = true
    started.ready.signal()
    while tapLock.withLock({ tapRunning }) {
      _ = CFRunLoopRunInMode(.defaultMode, 0.5, false)
    }
    CGEvent.tapEnable(tap: port, enable: false)
    CFRunLoopRemoveSource(loop, source, .commonModes)
    CFMachPortInvalidate(port)
    tapLock.withLock {
      tapPort = nil
      tapLoop = nil
    }
  }

  private func stopTap() {
    tapLock.withLock {
      tapRunning = false
      if let tapLoop { CFRunLoopStop(tapLoop) }
    }
  }

  private enum Sample: Sendable {
    case escDown(autorepeat: Bool)
    case escUp
    case keyDown
    case mouseDown
    case moved(CGPoint)
  }

  /// On the tap thread: as little as possible, then on to the queue. The event passes through unchanged.
  private func observe(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let port = tapLock.withLock({ tapPort }) { CGEvent.tapEnable(tap: port, enable: true) }
      return
    }
    if event.getIntegerValueField(.eventSourceUserData) == InputController.eventTag { return }
    let sample: Sample
    switch type {
    case .keyDown:
      if CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)) == InputController.escape {
        sample = .escDown(autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
      } else {
        sample = .keyDown
      }
    case .keyUp:
      guard CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)) == InputController.escape else { return }
      sample = .escUp
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      sample = .mouseDown
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
      sample = .moved(event.location)
    default:
      return
    }
    let now = Self.now()
    queue.async { [self] in handle(sample, at: now) }
  }

  // ---------------------------------------------------------------- queue

  private func handle(_ sample: Sample, at now: Double) {
    guard enabled else { return }
    switch sample {
    case .escDown(let autorepeat):
      emit(esc.keyDown(at: now, autorepeat: autorepeat))
    case .escUp:
      emit(esc.keyUp(at: now))
    case .keyDown:
      if userInput.admit(at: now) { notify(.userInput(kind: .key)) }
    case .mouseDown:
      if userInput.admit(at: now) { notify(.userInput(kind: .mouse)) }
    case .moved(let point):
      if UserInputFilter.isPersonMove(point, helperAt: input.lastPointerPosition), userInput.admit(at: now) {
        notify(.userInput(kind: .mouse))
      }
    }
  }

  private func tick() {
    guard enabled else { return }
    let nanos = DispatchTime.now().uptimeNanoseconds
    let physical: Bool? =
      input.ownsEscape(now: nanos) ? nil : CGEventSource.keyState(.hidSystemState, key: InputController.escape)
    emit(esc.tick(at: Double(nanos) / 1_000_000, physicallyDown: physical))
    ticks += 1
    if ticks % 5 == 1 {
      let on = IsSecureEventInputEnabled()
      if on != secureInput {
        secureInput = on
        notify(.secureInput(on: on))
      }
    }
  }

  private func emit(_ events: [EscTracker.Event]) {
    for event in events {
      switch event {
      case .down:
        notify(.esc(phase: .down, heldMs: 0))
      case .up(let held):
        notify(.esc(phase: .up, heldMs: held))
      case .stopped(let held):
        // Latch first, so no input slips out after the release; then tell main.
        input.stop()
        notify(.esc(phase: .stopped, heldMs: held))
      }
    }
  }

  private static func now() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
  }
}
