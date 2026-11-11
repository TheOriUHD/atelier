import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ObjectiveC

/// Background input through SkyLight, macOS's private window-server framework: how Claude's and ChatGPT's computer use
/// work in an app without activating it, raising its window or moving the pointer (the owner chose this route on
/// 2026-11-11; it was public APIs only before). The recipe follows Cua Driver (MIT, github.com/trycua/cua,
/// libs/cua-driver), checked on this Mac against Chrome kept behind another app:
/// - a focus record (`SLPSPostEventRecordTo`) sent to the target process only makes its window take events as the
///   focused one, while the person's app stays active and keeps its keyboard;
/// - mouse and wheel events posted to the process (`SLEventPostToPid`) carrying the window (fields 51, 91, 92), the
///   process (40, which Chromium's filter for synthetic events looks at), one click-group id (58) and the point inside
///   the window (`CGEventSetWindowLocation`) reach Chrome's pages, which ignore the public `CGEventPostToPid`;
/// - a primer click at (-1, -1) before the real one opens Chromium's user-activation gate without touching the page;
/// - typed characters carry an authentication message (`SLSEventAuthenticationMessage`, macOS 15+), which Chromium
///   wants for keys; shortcuts go without it, so the app's menus see them.
/// Every symbol is looked up at run time: when one is missing (a macOS that changed them), `available` is false and
/// background input falls back to the public route.
enum SkyLight {
  private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
  private typealias PostRecord = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
  private typealias SetField = @convention(c) (CGEvent, UInt32, Int64) -> Void
  private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private typealias SetAuthentication = @convention(c) (CGEvent, AnyObject) -> Void
  private typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
  private typealias SetFrontProcess = @convention(c) (UnsafeRawPointer, UInt32, UInt32) -> Int32
  private typealias AuthenticationFactory =
    @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> Unmanaged<AnyObject>?
  private typealias WindowOfElement = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

  private struct Symbols: @unchecked Sendable {
    let postToPid: PostToPid?
    let postRecord: PostRecord?
    let setField: SetField?
    let setWindowLocation: SetWindowLocation?
    let setAuthentication: SetAuthentication?
    let processForPID: ProcessForPID?
    let setFrontProcess: SetFrontProcess?
    let factory: AuthenticationFactory?
    let windowOfElement: WindowOfElement?
  }

  private static let symbols: Symbols = {
    _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    let all = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
    func find<T>(_ name: String, _: T.Type) -> T? { dlsym(all, name).map { unsafeBitCast($0, to: T.self) } }
    return Symbols(
      postToPid: find("SLEventPostToPid", PostToPid.self),
      postRecord: find("SLPSPostEventRecordTo", PostRecord.self),
      setField: find("SLEventSetIntegerValueField", SetField.self),
      setWindowLocation: find("CGEventSetWindowLocation", SetWindowLocation.self),
      setAuthentication: find("SLEventSetAuthenticationMessage", SetAuthentication.self),
      processForPID: find("GetProcessForPID", ProcessForPID.self),
      setFrontProcess: find("_SLPSSetFrontProcessWithOptions", SetFrontProcess.self),
      factory: find("objc_msgSend", AuthenticationFactory.self),
      windowOfElement: find("_AXUIElementGetWindow", WindowOfElement.self))
  }()

  /// Whether the background route can be used on this Mac.
  static var available: Bool {
    let s = symbols
    return s.postToPid != nil && s.postRecord != nil && s.setField != nil && s.setWindowLocation != nil
      && s.processForPID != nil
  }

  // ---------------------------------------------------------------- the records

  /// The 248-byte focus (direction 1) or defocus (2) record for a window, as yabai and Cua Driver build it.
  static func focusRecord(window: CGWindowID, direction: UInt8) -> [UInt8] {
    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = 0x0D
    withUnsafeBytes(of: window.littleEndian) { for i in 0..<4 { record[0x3C + i] = $0[i] } }
    record[0x8A] = direction
    return record
  }

  /// One of the pair of records (kind 1, then 2) that make a window its app's key window.
  static func makeKeyRecord(window: CGWindowID, kind: UInt8) -> [UInt8] {
    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = kind
    record[0x3A] = 0x10
    for i in 0x20..<0x30 { record[i] = 0xFF }
    withUnsafeBytes(of: window.littleEndian) { for i in 0..<4 { record[0x3C + i] = $0[i] } }
    return record
  }

  /// The process's serial number, which the records are addressed by.
  static func processSerialNumber(_ pid: pid_t) -> [UInt8]? {
    guard let find = symbols.processForPID else { return nil }
    var psn = [UInt8](repeating: 0, count: 8)
    let status = psn.withUnsafeMutableBytes { find(pid, $0.baseAddress!) }
    return status == 0 ? psn : nil
  }

  @discardableResult
  private static func post(_ record: [UInt8], to psn: [UInt8]) -> Bool {
    guard let postRecord = symbols.postRecord else { return false }
    let status = psn.withUnsafeBytes { p in record.withUnsafeBufferPointer { postRecord(p.baseAddress!, $0.baseAddress!) } }
    return status == 0
  }

  /// The window takes the next events as its app's focused window; the app is neither activated nor raised, and the
  /// person's front app gets nothing (a defocus sent there would leave their window without its keyboard).
  static func focus(pid: pid_t, window: CGWindowID) throws {
    guard let psn = processSerialNumber(pid) else { throw RPCError.unsupported("the app's process can't be reached") }
    guard post(focusRecord(window: window, direction: 1), to: psn) else {
      throw RPCError.unsupported("the window server refused to focus the app's window")
    }
    if !Recent.key(pid: pid, window: window) { usleep(50_000) }
  }

  /// The window made key a moment ago: the records are sent again (an inactive app may have let go of it), but the
  /// waits that let the window server switch windows aren't needed, which saves 200 ms an action (measured: a background
  /// key press took 340 ms, 211 of them in makeKey's waits).
  enum Recent {
    static let span: UInt64 = 4_000_000_000
    nonisolated(unsafe) private static var last: (pid: pid_t, window: CGWindowID, at: UInt64)?
    private static let lock = NSLock()

    static func key(pid: pid_t, window: CGWindowID, now: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      guard let last, last.pid == pid, last.window == window else { return false }
      return now >= last.at && now - last.at < span
    }

    static func note(pid: pid_t, window: CGWindowID, now: UInt64 = DispatchTime.now().uptimeNanoseconds) {
      lock.lock()
      last = (pid, window, now)
      lock.unlock()
    }

    static func forget() {
      lock.lock()
      last = nil
      lock.unlock()
    }
  }

  /// The window becomes its app's key window, where keys go, without the app becoming active: the app's own key window
  /// is let go of first (nothing is sent to any other app).
  static func makeKey(pid: pid_t, window: CGWindowID) throws {
    guard let psn = processSerialNumber(pid) else { throw RPCError.unsupported("the app's process can't be reached") }
    // Always sent, even when Accessibility names the window as the key one: an inactive app reports its last key window
    // (Chrome does), and a shortcut sent without the records reaches an app whose window isn't key, which makes it bring
    // a window forward itself (Chrome on cmd+L, every time, on a Mac where it had been active before).
    let recent = Recent.key(pid: pid, window: window)
    let current = recent ? window : keyWindow(of: pid)
    if let current, current != window { post(focusRecord(window: current, direction: 2), to: psn); usleep(120_000) }
    guard post(focusRecord(window: window, direction: 1), to: psn) else {
      throw RPCError.unsupported("the window server refused to focus the app's window")
    }
    if !recent { usleep(120_000) }
    post(makeKeyRecord(window: window, kind: 1), to: psn)
    post(makeKeyRecord(window: window, kind: 2), to: psn)
    if !recent { usleep(80_000) }
    Recent.note(pid: pid, window: window)
  }

  /// The window an app's keyboard focus is in, as Accessibility says (nil when it says none, as an inactive Chrome does).
  static func keyWindow(of pid: pid_t) -> CGWindowID? {
    Inspect.copy(Inspect.application(pid), kAXFocusedWindowAttribute).flatMap(Inspect.asElement).flatMap(windowNumber(of:))
  }

  /// The window server's number for an accessibility window element.
  static func windowNumber(of window: AXUIElement) -> CGWindowID? {
    guard let windowOf = symbols.windowOfElement else { return nil }
    var id: CGWindowID = 0
    return windowOf(window, &id) == .success && id != 0 ? id : nil
  }

  /// Brings an app to the front with its window, as yabai does from a background process (macOS ignores activation that
  /// a background process asks for through AppKit): front process, user generated, then that window made key.
  @discardableResult
  static func bringToFront(pid: pid_t, window: CGWindowID?) -> Bool {
    guard let setFront = symbols.setFrontProcess, let psn = processSerialNumber(pid) else { return false }
    let status = psn.withUnsafeBytes { setFront($0.baseAddress!, window ?? 0, 0x200) }  // kCPSUserGenerated
    if let window {
      post(makeKeyRecord(window: window, kind: 1), to: psn)
      post(makeKeyRecord(window: window, kind: 2), to: psn)
    }
    return status == 0
  }

  // ---------------------------------------------------------------- the events

  /// The point the window server hands the app: inside the window on macOS 27 and later, the screen point before
  /// (Cua Driver measured both).
  static func stampedPoint(_ screen: CGPoint, window: CGRect, major: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion) -> CGPoint {
    major >= 27 ? CGPoint(x: screen.x - window.minX, y: screen.y - window.minY) : screen
  }

  /// The fields a mouse or wheel event carries to reach one window of one process.
  struct Stamp: Equatable, Sendable {
    var pid: pid_t
    var window: CGWindowID
    var point: CGPoint
    /// 0 for a wheel event (no gesture fields).
    var group: Int64
    var phase: Int64 = 0
    var clickState: Int64 = 0
    var button: Int64 = 0

    /// Field number and value, in the order they are set.
    var fields: [(UInt32, Int64)] {
      var fields: [(UInt32, Int64)] = []
      if group != 0 { fields += [(0, phase), (1, clickState), (3, button), (7, 3)] }
      fields += [(40, Int64(pid)), (51, Int64(window)), (91, Int64(window)), (92, Int64(window))]
      if group != 0 { fields.append((58, group)) }
      return fields
    }
  }

  static func apply(_ stamp: Stamp, to event: CGEvent) {
    guard let setField = symbols.setField else { return }
    for (field, value) in stamp.fields { setField(event, field, value) }
    symbols.setWindowLocation?(event, stamp.point)
  }

  /// Posts to the process; `authenticate` attaches the message Chromium wants on keys it types (not on shortcuts,
  /// which then wouldn't reach the app's menus).
  static func post(_ event: CGEvent, to pid: pid_t, authenticate: Bool) {
    if authenticate { attachAuthentication(event, pid: pid) }
    if let postToPid = symbols.postToPid { postToPid(pid, event) } else { event.postToPid(pid) }
  }

  private static func attachAuthentication(_ event: CGEvent, pid: pid_t) {
    guard let setAuthentication = symbols.setAuthentication, let factory = symbols.factory,
      let type = NSClassFromString("SLSEventAuthenticationMessage")
    else { return }
    let selector = NSSelectorFromString("messageWithEventRecord:pid:version:")
    // macOS 14 has the class without the factory: the event goes without the message.
    guard class_respondsToSelector(object_getClass(type), selector) else { return }
    // The event's record follows the CFRuntimeBase and a 32-bit field: at 24 on this Mac, 32 or 16 on others.
    let raw = Unmanaged.passUnretained(event).toOpaque()
    for offset in [24, 32, 16] {
      guard let record = raw.load(fromByteOffset: offset, as: UnsafeMutableRawPointer?.self) else { continue }
      if let message = factory(type, selector, record, pid, 0) {
        setAuthentication(event, message.takeUnretainedValue())
        return
      }
    }
  }

  // ---------------------------------------------------------------- what a click, a scroll and typing are

  /// One posted mouse event of a click.
  struct MouseStep: Equatable {
    var type: CGEventType
    /// Where the event says it is (the screen point; (-1, -1) for the primer).
    var at: CGPoint
    var stamp: Stamp
    /// Milliseconds after it.
    var pause: UInt32
  }

  /// A click as Cua Driver posts it to a background window: a move to the point, a primer click off every window (for
  /// Chromium's user-activation gate; a right or middle click has none, and other apps don't need it), then the presses,
  /// numbered.
  static func click(
    at screen: CGPoint, stamped: CGPoint, pid: pid_t, window: CGWindowID, button: MouseButton, count: Int, group: Int64,
    primer: Bool = true
  ) -> [MouseStep] {
    let number: Int64 = button == .left ? 0 : button == .right ? 1 : 2
    func stamp(_ point: CGPoint, phase: Int64, state: Int64) -> Stamp {
      Stamp(pid: pid, window: window, point: point, group: group, phase: phase, clickState: state, button: number)
    }
    let off = CGPoint(x: -1, y: -1)
    var steps = [MouseStep(type: .mouseMoved, at: screen, stamp: stamp(stamped, phase: 2, state: 0), pause: 15)]
    if button == .left, primer {
      steps += [
        MouseStep(type: .leftMouseDown, at: off, stamp: stamp(off, phase: 1, state: 1), pause: 1),
        MouseStep(type: .leftMouseUp, at: off, stamp: stamp(off, phase: 2, state: 1), pause: 100),
      ]
    }
    for n in 1...max(1, min(3, count)) {
      let state = Int64(n)
      steps += [
        MouseStep(type: button.downType, at: screen, stamp: stamp(stamped, phase: 3, state: state), pause: 28),
        MouseStep(type: button.upType, at: screen, stamp: stamp(stamped, phase: 3, state: state), pause: n < count ? 80 : 0),
      ]
    }
    return steps
  }

  /// Typing a character at a time: Return and Tab as their keys, anything else carried by a key event of its own.
  enum TypedKey: Equatable {
    case key(CGKeyCode)
    case text([UniChar])
  }

  static func typing(_ text: String) -> [TypedKey] {
    text.map { character in
      switch character {
      case "\n", "\r", "\r\n": .key(36)
      case "\t": .key(48)
      default: .text(Array(String(character).utf16))
      }
    }
  }
}
