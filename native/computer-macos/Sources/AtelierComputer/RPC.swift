import Foundation

/// A JSON-RPC error object.
public struct RPCError: Error, Encodable, Sendable, Equatable {
  public let code: Int
  public let message: String
  public let data: JSONValue?

  public init(_ code: ComputerErrorCode, _ message: String, data: JSONValue? = nil) {
    self.code = code.rawValue
    self.message = message
    self.data = data
  }

  enum CodingKeys: String, CodingKey { case code, message, data }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(code, forKey: .code)
    try c.encode(message, forKey: .message)
    try c.encodeIfPresent(data, forKey: .data)
  }

  public static let parse = RPCError(.parseError, "parse error")
  public static let notInitialized = RPCError(.notInitialized, "initialize must be the first call")
  public static let stopped = RPCError(.stopped, "stopped: the person held Esc; input is refused until control.resume")

  public static func invalidRequest(_ message: String) -> RPCError { RPCError(.invalidRequest, message) }
  public static func methodNotFound(_ method: String) -> RPCError { RPCError(.methodNotFound, "unknown method \(method)") }
  public static func invalidParams(_ message: String) -> RPCError { RPCError(.invalidParams, message) }
  public static func `internal`(_ message: String) -> RPCError { RPCError(.internal, message) }
  public static func unsupported(_ message: String) -> RPCError { RPCError(.unsupported, message) }
  public static func notFound(_ message: String) -> RPCError { RPCError(.notFound, message) }

  public static func permission(_ kind: PermissionKind) -> RPCError {
    let what = kind == .accessibility ? "Accessibility" : "Screen Recording"
    return RPCError(.permission, "\(what) permission is missing", data: .object(["permission": .string(kind.rawValue)]))
  }

  public var isStopped: Bool { code == ComputerErrorCode.stopped.rawValue }
}

/// Where lines go. Writes are serialized on one queue: responses come from many threads, notifications from the
/// event-tap thread.
public final class Output: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.atelier.computer.output")
  private let sink: @Sendable (Data) -> Void

  public init(sink: @escaping @Sendable (Data) -> Void) {
    self.sink = sink
  }

  /// stdout, written with write(2) so nothing sits in a buffer.
  public static func standardOutput() -> Output {
    Output { data in
      data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else { return }
        var offset = 0
        while offset < buffer.count {
          let n = write(STDOUT_FILENO, base + offset, buffer.count - offset)
          if n < 0 {
            if errno == EINTR { continue }
            return  // EPIPE: main is gone, and stdin's EOF follows.
          }
          offset += n
        }
      }
    }
  }

  /// Encodes on the calling thread, writes in order.
  func send<T: Encodable>(_ message: T) throws {
    var data = try JSON.encoder().encode(message)
    data.append(0x0A)
    let line = data
    queue.async { self.sink(line) }
  }

  /// Waits until everything sent so far is written.
  public func flush() {
    queue.sync {}
  }
}

/// How a method runs. `inline` methods are quick and run on the reader thread, in order (state changes such as
/// `control.resume` take effect before the next line is read). `queued` methods (mouse and keys) run one at a time,
/// in order, on the input queue. `async` methods (apps, screenshots, inspection) run concurrently.
public enum MethodBody: Sendable {
  case inline(@Sendable (JSONValue?) throws -> any Encodable & Sendable)
  case queued(@Sendable (JSONValue?) throws -> any Encodable & Sendable)
  case async(@Sendable (JSONValue?) async throws -> any Encodable & Sendable)
}

/// Newline-delimited JSON-RPC 2.0: framing, the initialize gate, dispatch and replies.
public final class RPCServer: @unchecked Sendable {
  public enum Outcome: Sendable { case proceed, stop }

  public let output: Output
  private let inputQueue = DispatchQueue(label: "dev.atelier.computer.input")
  // Set up before the first line is read, then only touched by the reader thread.
  private var methods: [String: MethodBody] = [:]
  private var initializeBody: (@Sendable (JSONValue?) throws -> any Encodable & Sendable)?
  private var initialized = false

  public init(output: Output) {
    self.output = output
  }

  public func register(_ method: String, _ body: MethodBody) {
    methods[method] = body
  }

  public func onInitialize(_ body: @escaping @Sendable (JSONValue?) throws -> any Encodable & Sendable) {
    initializeBody = body
  }

  public var registeredMethods: [String] {
    (Array(methods.keys) + ["initialize", "shutdown"]).sorted()
  }

  public func notify(_ notification: ComputerNotification) {
    do {
      try output.send(notification)
    } catch {
      Log.error("notification \(notification.method): \(error)")
    }
  }

  /// Handles one line. `.stop` after `shutdown` has been answered.
  public func receive(_ line: String) -> Outcome {
    let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return .proceed }
    let message: JSONValue
    do {
      message = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    } catch {
      reply(.null, error: .parse)
      return .proceed
    }
    guard case .object(let fields) = message else {
      reply(.null, error: .invalidRequest("a request must be an object (batches aren't supported)"))
      return .proceed
    }
    let id: JSONValue
    switch fields["id"] {
    case nil, .null?:
      return .proceed  // A notification: main sends none, and none needs an answer.
    case .string?, .int?, .double?:
      id = fields["id"]!
    default:
      reply(.null, error: .invalidRequest("id must be a string or a number"))
      return .proceed
    }
    guard case .string(let method)? = fields["method"] else {
      reply(id, error: .invalidRequest("missing method"))
      return .proceed
    }
    let params = fields["params"]
    switch params {
    case nil, .null?, .object?: break
    default:
      reply(id, error: .invalidParams("params must be an object"))
      return .proceed
    }

    if method == ComputerMethod.initialize.rawValue {
      if initialized {
        reply(id, error: .invalidRequest("already initialized"))
        return .proceed
      }
      guard let initializeBody else {
        reply(id, error: .internal("initialize isn't set up"))
        return .proceed
      }
      let ok = run(id) { try initializeBody(params) }
      if ok { initialized = true }
      return .proceed
    }
    guard initialized else {
      reply(id, error: .notInitialized)
      return .proceed
    }
    if method == ComputerMethod.shutdown.rawValue {
      reply(id, result: Empty())
      return .stop
    }
    guard let body = methods[method] else {
      reply(id, error: .methodNotFound(method))
      return .proceed
    }
    switch body {
    case .inline(let handler):
      run(id) { try handler(params) }
    case .queued(let handler):
      inputQueue.async { self.run(id) { try handler(params) } }
    case .async(let handler):
      Task.detached {
        do {
          self.reply(id, result: try await handler(params))
        } catch {
          self.reply(id, error: Self.wire(error))
        }
      }
    }
    return .proceed
  }

  /// Runs a handler and answers; true when it succeeded.
  @discardableResult
  private func run(_ id: JSONValue, _ handler: () throws -> any Encodable & Sendable) -> Bool {
    do {
      reply(id, result: try handler())
      return true
    } catch {
      reply(id, error: Self.wire(error))
      return false
    }
  }

  static func wire(_ error: Error) -> RPCError {
    if let error = error as? RPCError { return error }
    return .internal("internal error: \(error.localizedDescription)")
  }

  private struct Response: Encodable {
    let id: JSONValue
    let result: AnyEncodable?
    let error: RPCError?

    enum CodingKeys: String, CodingKey { case jsonrpc, id, result, error }

    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode("2.0", forKey: .jsonrpc)
      try c.encode(id, forKey: .id)
      if let error {
        try c.encode(error, forKey: .error)
      } else if let result {
        try c.encode(result, forKey: .result)
      } else {
        try c.encodeNil(forKey: .result)
      }
    }
  }

  private func reply(_ id: JSONValue, result: any Encodable) {
    do {
      try output.send(Response(id: id, result: AnyEncodable(value: result), error: nil))
    } catch {
      reply(id, error: .internal("could not encode the result: \(error)"))
    }
  }

  private func reply(_ id: JSONValue, error: RPCError) {
    do {
      try output.send(Response(id: id, result: nil, error: error))
    } catch {
      Log.error("could not encode an error: \(error)")
    }
  }
}

enum Log {
  static func info(_ message: String) {
    write("atelier-computer: \(message)\n")
  }

  static func error(_ message: String) {
    write("atelier-computer: error: \(message)\n")
  }

  private static func write(_ text: String) {
    FileHandle.standardError.write(Data(text.utf8))
  }
}
