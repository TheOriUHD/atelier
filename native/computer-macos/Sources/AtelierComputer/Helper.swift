import CoreGraphics
import Foundation

/// The helper: every method of computer protocol v1 wired to the OS, plus its lifecycle (stdin's EOF, `shutdown` and
/// termination signals let go of held input and exit 0). Policy (which apps, tiers, password fields) lives in main;
/// the one rule here is the Esc-hold stop.
public final class Helper: @unchecked Sendable {
  public let output: Output
  public let server: RPCServer
  let input: InputController
  let control: ControlMonitor
  private let lifecycle = NSLock()
  private var signalSources: [DispatchSourceSignal] = []

  public init(output: Output) {
    self.output = output
    let server = RPCServer(output: output)
    self.server = server
    input = InputController()
    control = ControlMonitor(input: input, notify: { server.notify($0) })
    register()
  }

  /// Reads requests from stdin until EOF or `shutdown`, then exits.
  public func runStdin() -> Never {
    while let line = readLine(strippingNewline: true) {
      if server.receive(line) == .stop { break }
    }
    finish()
  }

  /// Lets go of held input, stops the control watch, writes what's pending and exits 0.
  public func finish() -> Never {
    lifecycle.lock()  // Never unlocked: a second caller waits here for the exit.
    control.end()
    input.terminate()
    output.flush()
    exit(0)
  }

  public func installSignalHandlers() {
    for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
      source.setEventHandler { [self] in finish() }
      source.resume()
      signalSources.append(source)
    }
  }

  // ---------------------------------------------------------------- methods

  private func inline<P: Decodable & Sendable, R: Encodable & Sendable>(
    _ method: ComputerMethod, _ handler: @escaping @Sendable (P) throws -> R
  ) {
    server.register(method.rawValue, .inline { raw in try handler(JSON.decode(P.self, from: raw)) })
  }

  private func queued<P: Decodable & Sendable, R: Encodable & Sendable>(
    _ method: ComputerMethod, _ handler: @escaping @Sendable (P) throws -> R
  ) {
    server.register(method.rawValue, .queued { raw in try handler(JSON.decode(P.self, from: raw)) })
  }

  private func async<P: Decodable & Sendable, R: Encodable & Sendable>(
    _ method: ComputerMethod, _ handler: @escaping @Sendable (P) async throws -> R
  ) {
    server.register(method.rawValue, .async { raw in try await handler(JSON.decode(P.self, from: raw)) })
  }

  private func register() {
    let input = self.input
    let control = self.control

    server.onInitialize { raw in
      let params = try JSON.decode(ComputerInitializeParams.self, from: raw)
      guard params.protocolVersion == ComputerProtocol.version else {
        throw RPCError(
          .unsupported, "computer protocol \(params.protocolVersion) isn't supported (this helper speaks \(ComputerProtocol.version))",
          data: .object([
            "protocolVersion": .int(Int64(ComputerProtocol.version)), "helperVersion": .string(ComputerProtocol.helperVersion),
          ]))
      }
      return ComputerInitializeResult(
        protocolVersion: ComputerProtocol.version, helperVersion: ComputerProtocol.helperVersion,
        platform: ComputerProtocol.platform, supports: .init(background: false, fullControl: true, filter: true))
    }

    inline(.permissionsStatus) { (_: NoParams) in Permissions.status() }
    async(.permissionsRequest) { (params: PermissionsRequestParams) in
      await MainActor.run { Permissions.request(params.kind) }
    }

    async(.displaysList) { (_: NoParams) in DisplaysListResult(displays: await MainActor.run { Displays.list() }) }
    async(.appsList) { (params: AppsListParams) in AppsListResult(apps: await Apps.list(installed: params.installed)) }
    async(.appsFrontmost) { (_: NoParams) in AppResult(app: await Apps.frontmostApp()) }
    async(.appsOpen) { (params: AppsOpenParams) in
      AppResult(app: try await Apps.open(id: params.id, activate: params.activate))
    }
    async(.appsHide) { (params: AppsHideParams) in
      try Self.validate(ids: params.ids)
      return AppsHideResult(ids: await MainActor.run { Apps.hide(ids: params.ids) })
    }
    async(.appsActivate) { (params: AppsActivateParams) in
      guard params.pid > 0, params.pid <= Int(Int32.max) else { throw RPCError.invalidParams("pid must be a process id") }
      return AppsActivateResult(activated: await Apps.bringToFront(pid: pid_t(params.pid)))
    }
    async(.appsUnhide) { (params: AppsHideParams) in
      try Self.validate(ids: params.ids)
      await MainActor.run { Apps.unhide(ids: params.ids) }
      return Empty()
    }

    async(.captureDisplay) { (params: CaptureDisplayParams) in try await Capture.display(params) }
    async(.inspectPoint) { (params: InspectPointParams) in try await Inspect.point(params) }
    async(.inspectFocused) { (_: NoParams) in try await Inspect.focused() }

    queued(.mouseMove) { (params: Point) in
      try input.move(to: Self.point(params.x, params.y))
      return Empty()
    }
    queued(.mouseClick) { (params: MouseClickParams) in
      guard (1...3).contains(params.count) else { throw RPCError.invalidParams("count must be 1, 2 or 3") }
      let modifiers = try Self.modifiers(params.modifiers)
      try input.click(at: Self.point(params.x, params.y), button: params.button, count: params.count, modifiers: modifiers)
      return Empty()
    }
    queued(.mouseDown) { (params: MouseButtonParams) in
      try input.buttonDown(at: Self.point(params.x, params.y), button: params.button)
      return Empty()
    }
    queued(.mouseUp) { (params: MouseButtonParams) in
      try input.buttonUp(at: Self.point(params.x, params.y), button: params.button)
      return Empty()
    }
    queued(.mouseDrag) { (params: MouseDragParams) in
      try input.drag(
        from: Self.point(params.from.x, params.from.y), to: Self.point(params.to.x, params.to.y), button: params.button)
      return Empty()
    }
    queued(.mouseScroll) { (params: MouseScrollParams) in
      guard params.dx.isFinite, params.dy.isFinite, abs(params.dx) <= 10_000, abs(params.dy) <= 10_000 else {
        throw RPCError.invalidParams("dx and dy must be numbers of lines, at most 10000")
      }
      try input.scroll(at: Self.point(params.x, params.y), dx: params.dx, dy: params.dy)
      return Empty()
    }
    inline(.cursorPosition) { (_: NoParams) in input.cursorPosition() }

    queued(.keyPress) { (params: KeyPressParams) in
      let count = params.repeat ?? 1
      guard (1...100).contains(count) else { throw RPCError.invalidParams("repeat must be 1–100") }
      let stroke = try KeyMap.resolve(params.keys, layout: Self.currentLayout())
      try input.press(stroke, repeat: count)
      return Empty()
    }
    queued(.keyType) { (params: KeyTypeParams) in
      guard params.text.utf16.count <= 100_000 else { throw RPCError.invalidParams("text is longer than 100000") }
      try input.type(params.text)
      return Empty()
    }
    queued(.keyHold) { (params: KeyHoldParams) in
      guard params.ms.isFinite, (0...10_000).contains(params.ms) else {
        throw RPCError.invalidParams("ms must be 0–10000")
      }
      let stroke = try KeyMap.resolve(params.keys, layout: Self.currentLayout())
      try input.hold(stroke, milliseconds: Int(params.ms.rounded()))
      return Empty()
    }
    inline(.inputReleaseAll) { (_: NoParams) in
      input.releaseAll()
      return Empty()
    }

    inline(.controlBegin) { (_: NoParams) in
      try control.begin()
      return Empty()
    }
    inline(.controlEnd) { (_: NoParams) in
      control.end()
      return Empty()
    }
    inline(.controlResume) { (_: NoParams) in
      input.resume()
      return Empty()
    }
  }

  private static func point(_ x: Double, _ y: Double) throws -> CGPoint {
    guard x.isFinite, y.isFinite, abs(x) < 1_000_000, abs(y) < 1_000_000 else {
      throw RPCError.invalidParams("x and y must be screen coordinates")
    }
    return CGPoint(x: x, y: y)
  }

  static func modifiers(_ names: [String]) throws -> [Modifier] {
    var modifiers: [Modifier] = []
    for name in names {
      guard let modifier = Modifier.named(name) else { throw RPCError.invalidParams("unknown modifier \"\(name)\"") }
      if !modifiers.contains(modifier) { modifiers.append(modifier) }
    }
    return modifiers
  }

  private static func validate(ids: [String]) throws {
    guard ids.count <= 500, ids.allSatisfy({ !$0.isEmpty }) else {
      throw RPCError.invalidParams("ids must be at most 500 bundle ids")
    }
  }

  /// The keyboard layout, read on the main thread (the input queue waits for it).
  private static func currentLayout() -> KeyboardLayoutMap? {
    if Thread.isMainThread { return MainActor.assumeIsolated { KeyboardLayout.current() } }
    return DispatchQueue.main.sync { MainActor.assumeIsolated { KeyboardLayout.current() } }
  }
}
