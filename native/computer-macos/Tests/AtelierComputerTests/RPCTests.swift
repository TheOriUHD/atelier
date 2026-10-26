import XCTest

@testable import AtelierComputer

/// Lines written to the fake stdout.
private final class Lines: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []

  func append(_ data: Data) {
    let text = String(decoding: data, as: UTF8.self)
    lock.withLock { items.append(text) }
  }

  var all: [String] { lock.withLock { items } }
}

final class RPCTests: XCTestCase {
  private var lines = Lines()
  private var output: Output!

  override func setUp() {
    lines = Lines()
    let lines = self.lines
    output = Output { lines.append($0) }
  }

  private func messages(waitingFor count: Int = 0, timeout: TimeInterval = 5) -> [[String: Any]] {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
      output.flush()
      if lines.all.count >= count || Date() > deadline { break }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return lines.all.map { line in
      XCTAssertTrue(line.hasSuffix("\n"), "one object per line")
      XCTAssertEqual(line.filter { $0 == "\n" }.count, 1, "no newline inside a message")
      return (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
    }
  }

  private func error(_ message: [String: Any]) -> (code: Int, message: String, data: [String: Any]?)? {
    guard let error = message["error"] as? [String: Any], let code = error["code"] as? Int else { return nil }
    return (code, error["message"] as? String ?? "", error["data"] as? [String: Any])
  }

  private let initialize = #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"test","version":"0"}}}"#

  // ---------------------------------------------------------------- with the real method table (read-only methods only)

  func testNothingBeforeInitialize() {
    let helper = Helper(output: output)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":7,"method":"displays.list"}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":8,"method":"nope"}"#)
    let all = messages(waitingFor: 2)
    XCTAssertEqual(all.count, 2)
    XCTAssertEqual(all[0]["id"] as? Int, 7)
    XCTAssertEqual(error(all[0])?.code, -32002)
    XCTAssertEqual(error(all[1])?.code, -32002)
  }

  func testInitialize() {
    let helper = Helper(output: output)
    XCTAssertEqual(helper.server.receive(initialize), .proceed)
    let reply = messages(waitingFor: 1)[0]
    XCTAssertEqual(reply["jsonrpc"] as? String, "2.0")
    XCTAssertEqual(reply["id"] as? Int, 1)
    let result = reply["result"] as? [String: Any]
    XCTAssertEqual(result?["protocolVersion"] as? Int, 1)
    XCTAssertEqual(result?["helperVersion"] as? String, ComputerProtocol.helperVersion)
    XCTAssertEqual(result?["platform"] as? String, "darwin")
    let supports = result?["supports"] as? [String: Any]
    XCTAssertEqual(supports?["background"] as? Bool, false)
    XCTAssertEqual(supports?["fullControl"] as? Bool, true)
    XCTAssertEqual(supports?["filter"] as? Bool, true)
  }

  func testInitializeOnce() {
    let helper = Helper(output: output)
    _ = helper.server.receive(initialize)
    _ = helper.server.receive(initialize.replacingOccurrences(of: #""id":1"#, with: #""id":2"#))
    let all = messages(waitingFor: 2)
    XCTAssertEqual(error(all[1])?.code, -32600)
  }

  func testWrongProtocolVersionLeavesItUninitialized() {
    let helper = Helper(output: output)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":2,"method":"permissions.status"}"#)
    let all = messages(waitingFor: 2)
    XCTAssertEqual(error(all[0])?.code, ComputerErrorCode.unsupported.rawValue)
    XCTAssertEqual(error(all[0])?.data?["protocolVersion"] as? Int, 1)
    XCTAssertEqual(error(all[1])?.code, -32002)
  }

  func testInitializeNeedsItsParams() {
    let helper = Helper(output: output)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#)
    XCTAssertEqual(error(messages(waitingFor: 1)[0])?.code, -32602)
  }

  func testUnknownMethodAndBadParams() {
    let helper = Helper(output: output)
    _ = helper.server.receive(initialize)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"a","method":"no.such.method"}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"b","method":"apps.list","params":{}}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"c","method":"inspect.point","params":{"x":"left","y":1}}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"d","method":"capture.display","params":{"display":"1","maxWidth":0,"maxHeight":10,"format":"jpeg"}}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"e","method":"capture.display","params":{"display":"1","maxWidth":10,"maxHeight":10,"format":"gif"}}"#)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":"f","method":"permissions.status","params":[1,2]}"#)
    let all = messages(waitingFor: 7)
    let byID = Dictionary(all.compactMap { m in (m["id"] as? String).map { ($0, m) } }, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(error(byID["a"]!)?.code, -32601)
    XCTAssertEqual(error(byID["b"]!)?.code, -32602)
    XCTAssertTrue(error(byID["b"]!)?.message.contains("installed") == true, error(byID["b"]!)?.message ?? "")
    XCTAssertEqual(error(byID["c"]!)?.code, -32602)
    XCTAssertEqual(error(byID["d"]!)?.code, -32602)
    XCTAssertEqual(error(byID["e"]!)?.code, -32602)
    XCTAssertEqual(error(byID["f"]!)?.code, -32602)
  }

  func testPermissionsStatusShape() {
    let helper = Helper(output: output)
    _ = helper.server.receive(initialize)
    _ = helper.server.receive(#"{"jsonrpc":"2.0","id":2,"method":"permissions.status","params":{}}"#)
    let result = messages(waitingFor: 2)[1]["result"] as? [String: Any]
    XCTAssertNotNil(result?["accessibility"] as? Bool)
    XCTAssertNotNil(result?["screenRecording"] as? Bool)
  }

  func testShutdownAnswersThenStops() {
    let helper = Helper(output: output)
    _ = helper.server.receive(initialize)
    XCTAssertEqual(helper.server.receive(#"{"jsonrpc":"2.0","id":9,"method":"shutdown"}"#), .stop)
    let reply = messages(waitingFor: 2)[1]
    XCTAssertEqual(reply["id"] as? Int, 9)
    XCTAssertEqual((reply["result"] as? [String: Any])?.count, 0)
  }

  func testEveryContractMethodIsAnswered() {
    let helper = Helper(output: output)
    XCTAssertEqual(Set(helper.server.registeredMethods), Set(ComputerMethod.allCases.map(\.rawValue)))
  }

  // ---------------------------------------------------------------- framing, with fake methods

  private func fakeServer() -> RPCServer {
    let server = RPCServer(output: output)
    server.onInitialize { _ in Empty() }
    _ = server.receive(#"{"id":0,"method":"initialize"}"#)
    return server
  }

  func testFraming() {
    let server = fakeServer()
    server.register("echo", .inline { raw in raw ?? .null })
    _ = server.receive("this is not json")
    _ = server.receive("[1,2]")
    _ = server.receive(#"{"id":{"x":1},"method":"echo"}"#)
    _ = server.receive(#"{"id":3}"#)
    _ = server.receive(#"{"method":"echo","params":{}}"#)  // A notification: no answer.
    _ = server.receive(#"{"id":null,"method":"echo"}"#)  // Also treated as a notification.
    _ = server.receive("   ")
    _ = server.receive(#"{"id":"s-1","method":"echo","params":{"a":[1,2.5,"x",true,null]}}"#)
    let all = messages(waitingFor: 6)
    XCTAssertEqual(all.count, 6)  // initialize + 5
    XCTAssertEqual(error(all[1])?.code, -32700)
    XCTAssertTrue(all[1]["id"] is NSNull)
    XCTAssertEqual(error(all[2])?.code, -32600)
    XCTAssertEqual(error(all[3])?.code, -32600)
    XCTAssertEqual(error(all[4])?.code, -32600)
    XCTAssertEqual(all[4]["id"] as? Int, 3)
    XCTAssertEqual(all[5]["id"] as? String, "s-1")
    let echoed = (all[5]["result"] as? [String: Any])?["a"] as? [Any]
    XCTAssertEqual(echoed?.count, 5)
    XCTAssertEqual(echoed?[1] as? Double, 2.5)
  }

  func testHandlerErrors() {
    let server = fakeServer()
    server.register("denied", .inline { _ in throw RPCError.permission(.screenRecording) })
    server.register("stopped", .inline { _ in throw RPCError.stopped })
    server.register("boom", .inline { _ in throw NSError(domain: "x", code: 1) })
    _ = server.receive(#"{"id":1,"method":"denied"}"#)
    _ = server.receive(#"{"id":2,"method":"stopped"}"#)
    _ = server.receive(#"{"id":3,"method":"boom"}"#)
    let all = messages(waitingFor: 4)
    XCTAssertEqual(error(all[1])?.code, -32030)
    XCTAssertEqual(error(all[1])?.data?["permission"] as? String, "screenRecording")
    XCTAssertEqual(error(all[2])?.code, -32031)
    XCTAssertNil(error(all[2])?.data)
    XCTAssertEqual(error(all[3])?.code, -32603)
  }

  func testQueuedMethodsRunInOrderAndAsyncOnesAnswer() {
    let server = fakeServer()
    let order = Lines()
    server.register(
      "slow",
      .queued { raw in
        Thread.sleep(forTimeInterval: 0.05)
        order.append(Data("slow".utf8))
        return Empty()
      })
    server.register(
      "fast",
      .queued { _ in
        order.append(Data("fast".utf8))
        return Empty()
      })
    server.register(
      "later",
      .async { _ in
        try await Task.sleep(nanoseconds: 10_000_000)
        return Point(x: 1.5, y: -2)
      })
    _ = server.receive(#"{"id":1,"method":"slow"}"#)
    _ = server.receive(#"{"id":2,"method":"fast"}"#)
    _ = server.receive(#"{"id":3,"method":"later"}"#)
    let all = messages(waitingFor: 4)
    XCTAssertEqual(all.count, 4)
    XCTAssertEqual(order.all, ["slow", "fast"])
    let later = all.first { $0["id"] as? Int == 3 }
    XCTAssertEqual((later?["result"] as? [String: Any])?["x"] as? Double, 1.5)
  }

  func testNotifications() throws {
    let server = fakeServer()
    server.notify(.esc(phase: .stopped, heldMs: 1003))
    server.notify(.userInput(kind: .mouse))
    server.notify(.secureInput(on: true))
    let all = messages(waitingFor: 4)
    XCTAssertEqual(all[1]["method"] as? String, "control.esc")
    XCTAssertNil(all[1]["id"])
    XCTAssertEqual((all[1]["params"] as? [String: Any])?["phase"] as? String, "stopped")
    XCTAssertEqual((all[1]["params"] as? [String: Any])?["heldMs"] as? Int, 1003)
    XCTAssertEqual(all[2]["method"] as? String, "control.userInput")
    XCTAssertEqual((all[2]["params"] as? [String: Any])?["kind"] as? String, "mouse")
    XCTAssertEqual(all[3]["method"] as? String, "control.secureInput")
    XCTAssertEqual((all[3]["params"] as? [String: Any])?["on"] as? Bool, true)
  }

  // ---------------------------------------------------------------- encoding

  func testNullableFieldsAreWrittenAsNull() throws {
    let app = HelperApp(id: "a.b", name: "B", path: nil, pid: nil, running: false, active: false, hidden: false, category: nil)
    let object = try JSONSerialization.jsonObject(with: JSON.encoder().encode(app)) as? [String: Any]
    XCTAssertTrue(object?["path"] is NSNull)
    XCTAssertTrue(object?["pid"] is NSNull)
    XCTAssertTrue(object?["category"] is NSNull)
    let inspect = InspectPointResult(app: nil, role: nil, title: nil, secure: false, link: nil)
    let inspected = try JSONSerialization.jsonObject(with: JSON.encoder().encode(inspect)) as? [String: Any]
    XCTAssertEqual(inspected?.count, 5)
    XCTAssertTrue(inspected?["app"] is NSNull)
    XCTAssertTrue(inspected?["link"] is NSNull)
    let none = try JSONSerialization.jsonObject(with: JSON.encoder().encode(AppResult(app: nil))) as? [String: Any]
    XCTAssertTrue(none?["app"] is NSNull)
  }

  func testSlashesAreNotEscaped() throws {
    let text = String(decoding: try JSON.encoder().encode(["path": "/Applications/Safari.app"]), as: UTF8.self)
    XCTAssertTrue(text.contains("/Applications/Safari.app"))
  }

  func testParamsDecoding() throws {
    let click = try JSON.decode(
      MouseClickParams.self,
      from: .object([
        "x": .int(10), "y": .double(20.5), "button": .string("right"), "count": .int(2), "modifiers": .array([.string("cmd")]),
      ]))
    XCTAssertEqual(click.button, .right)
    XCTAssertEqual(click.y, 20.5)
    XCTAssertThrowsError(try JSON.decode(MouseClickParams.self, from: .object(["x": .int(1), "y": .int(1)])))
    XCTAssertThrowsError(
      try JSON.decode(MouseButtonParams.self, from: .object(["x": .int(1), "y": .int(1), "button": .string("fourth")])))
    let press = try JSON.decode(KeyPressParams.self, from: .object(["keys": .array([.string("return")])]))
    XCTAssertNil(press.repeat)
    let capture = try JSON.decode(
      CaptureDisplayParams.self,
      from: .object([
        "display": .string("1"), "maxWidth": .int(1280), "maxHeight": .int(800), "format": .string("png"),
        "region": .object(["x": .int(0), "y": .int(0), "width": .int(10), "height": .int(10)]),
      ]))
    XCTAssertNil(capture.apps)
    XCTAssertEqual(capture.region?.width, 10)
    XCTAssertNoThrow(try JSON.decode(NoParams.self, from: nil))
    XCTAssertNoThrow(try JSON.decode(NoParams.self, from: .object(["anything": .bool(true)])))
  }

  func testJSONValueKeepsIntegers() throws {
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"id":12345678901,"b":true,"d":1.25,"n":null}"#.utf8))
    XCTAssertEqual(value["id"], .int(12_345_678_901))
    XCTAssertEqual(value["b"], .bool(true))
    XCTAssertEqual(value["d"], .double(1.25))
    XCTAssertEqual(value["n"], .null)
    XCTAssertEqual(String(decoding: try JSON.encoder().encode(JSONValue.int(7)), as: UTF8.self), "7")
  }
}
