// Computer protocol v1: the Swift mirror of packages/protocol/src/computer.ts. Keep both in sync (the parity test in
// Tests/AtelierComputerTests/ProtocolParityTests.swift compares the method names, error codes and version).
//
// JSON-RPC 2.0, one JSON object per line over stdio: requests in on stdin, responses and notifications out on stdout,
// logs on stderr. Coordinates are global points, the space of `CGDisplayBounds`: the top-left of the main display is
// 0,0 and y grows downwards.

import Foundation

public enum ComputerProtocol {
  public static let version = 1
  public static let helperVersion = "0.1.0"
  public static let platform = "darwin"
}

/// JSON-RPC error codes the helper returns.
public enum ComputerErrorCode: Int, Sendable, CaseIterable {
  case parseError = -32700
  case invalidRequest = -32600
  case methodNotFound = -32601
  case invalidParams = -32602
  case `internal` = -32603
  case notInitialized = -32002
  /// The OS permission is missing; `data.permission` is `accessibility` or `screenRecording`.
  case permission = -32030
  /// The person held Esc: input is refused until `control.resume`.
  case stopped = -32031
  /// Not something this OS or helper can do.
  case unsupported = -32032
  /// No such app or display.
  case notFound = -32033

  /// The name in the TypeScript `ComputerErrorCode` object.
  public var name: String {
    switch self {
    case .parseError: "ParseError"
    case .invalidRequest: "InvalidRequest"
    case .methodNotFound: "MethodNotFound"
    case .invalidParams: "InvalidParams"
    case .internal: "Internal"
    case .notInitialized: "NotInitialized"
    case .permission: "Permission"
    case .stopped: "Stopped"
    case .unsupported: "Unsupported"
    case .notFound: "NotFound"
    }
  }
}

/// Every method of computer protocol v1 (`ComputerMethods`).
public enum ComputerMethod: String, Sendable, CaseIterable {
  case initialize
  case permissionsStatus = "permissions.status"
  case permissionsRequest = "permissions.request"
  case displaysList = "displays.list"
  case appsList = "apps.list"
  case appsFrontmost = "apps.frontmost"
  case appsOpen = "apps.open"
  case appsHide = "apps.hide"
  case appsUnhide = "apps.unhide"
  case appsActivate = "apps.activate"
  case captureDisplay = "capture.display"
  case inspectPoint = "inspect.point"
  case inspectFocused = "inspect.focused"
  case mouseMove = "mouse.move"
  case mouseClick = "mouse.click"
  case mouseDown = "mouse.down"
  case mouseUp = "mouse.up"
  case mouseDrag = "mouse.drag"
  case mouseScroll = "mouse.scroll"
  case cursorPosition = "cursor.position"
  case keyPress = "key.press"
  case keyType = "key.type"
  case keyHold = "key.hold"
  case inputReleaseAll = "input.releaseAll"
  case controlBegin = "control.begin"
  case controlEnd = "control.end"
  case controlResume = "control.resume"
  case shutdown
}

// ---------------------------------------------------------------- shared

/// Params for methods that take none (`Record<string, never>`): whatever is sent is ignored.
public struct NoParams: Decodable, Sendable {
  public init() {}
  public init(from decoder: Decoder) throws {}
}

/// An empty result (`Record<string, never>`): `{}`.
public struct Empty: Codable, Sendable, Equatable {
  public init() {}
}

/// A rectangle in global screen coordinates: points, the top-left of the main display at 0,0.
public struct ScreenRect: Codable, Sendable, Equatable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public init(_ rect: CGRect) {
    self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
  }

  public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

public struct Point: Codable, Sendable, Equatable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }

  public init(_ point: CGPoint) {
    self.init(x: point.x, y: point.y)
  }

  public var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

// ---------------------------------------------------------------- initialize, permissions

public struct ComputerInitializeParams: Codable, Sendable {
  public struct Client: Codable, Sendable {
    public var name: String
    public var version: String
  }

  public var protocolVersion: Int
  public var client: Client?
}

public struct ComputerInitializeResult: Codable, Sendable, Equatable {
  public struct Supports: Codable, Sendable, Equatable {
    /// Acting on a window without taking the mouse or keyboard.
    public var background: Bool
    public var fullControl: Bool
    /// Screenshots can leave out apps that weren't allowed (and Atelier itself).
    public var filter: Bool
  }

  public var protocolVersion: Int
  public var helperVersion: String
  public var platform: String
  public var supports: Supports
}

/// Both true where the OS doesn't ask (Windows, X11).
public struct PermissionsStatus: Codable, Sendable, Equatable {
  public var accessibility: Bool
  public var screenRecording: Bool
}

public enum PermissionKind: String, Codable, Sendable {
  case accessibility
  case screenRecording
}

public struct PermissionsRequestParams: Codable, Sendable {
  public var kind: PermissionKind
}

// ---------------------------------------------------------------- displays, apps

public struct HelperDisplay: Codable, Sendable, Equatable {
  public var id: String
  public var name: String
  /// Pixels per point.
  public var scale: Double
  public var primary: Bool
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
}

public struct DisplaysListResult: Codable, Sendable {
  public var displays: [HelperDisplay]
}

public struct HelperApp: Codable, Sendable, Equatable {
  /// The bundle id.
  public var id: String
  public var name: String
  public var path: String?
  public var pid: Int?
  public var running: Bool
  /// It is the frontmost app.
  public var active: Bool
  public var hidden: Bool
  /// The app's own category where it declares one (`LSApplicationCategoryType`).
  public var category: String?

  public init(
    id: String, name: String, path: String?, pid: Int?, running: Bool, active: Bool, hidden: Bool, category: String?
  ) {
    self.id = id
    self.name = name
    self.path = path
    self.pid = pid
    self.running = running
    self.active = active
    self.hidden = hidden
    self.category = category
  }

  enum CodingKeys: String, CodingKey { case id, name, path, pid, running, active, hidden, category }

  // `path`, `pid` and `category` are `T | null` in the contract: written as null, not left out.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(path, forKey: .path)
    try c.encode(pid, forKey: .pid)
    try c.encode(running, forKey: .running)
    try c.encode(active, forKey: .active)
    try c.encode(hidden, forKey: .hidden)
    try c.encode(category, forKey: .category)
  }
}

public struct AppsListParams: Codable, Sendable {
  /// Installed apps too (the standard application folders), not only running ones.
  public var installed: Bool
}

public struct AppsListResult: Codable, Sendable {
  public var apps: [HelperApp]
}

public struct AppResult: Codable, Sendable {
  public var app: HelperApp?

  enum CodingKeys: String, CodingKey { case app }

  /// `apps.frontmost` answers `{app: null}` when there's none.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(app, forKey: .app)
  }
}

public struct AppsOpenParams: Codable, Sendable {
  public var id: String
  /// Bring it to the front (full control), or open it without taking the focus.
  public var activate: Bool
}

public struct AppsHideParams: Codable, Sendable {
  public var ids: [String]
}

/// A running app by its process: Atelier itself (main's pid), which has no bundle id worth trusting in development.
public struct AppsActivateParams: Codable, Sendable {
  public var pid: Int
}

public struct AppsActivateResult: Codable, Sendable, Equatable {
  /// It is the active app now.
  public var activated: Bool
}

/// `ids`: the apps this call hid (not those already hidden), for `apps.unhide` afterwards.
public struct AppsHideResult: Codable, Sendable, Equatable {
  public var ids: [String]
}

// ---------------------------------------------------------------- capture, inspect

public enum ImageFormat: String, Codable, Sendable {
  case jpeg
  case png

  public var mime: String { self == .png ? "image/png" : "image/jpeg" }
}

public struct CaptureDisplayParams: Codable, Sendable {
  public var display: String
  /// Only these apps' windows (and the desktop); absent: everything but Atelier's own windows.
  public var apps: [String]?
  /// Everything but these apps' windows, Atelier's own included (never its floating overlay); when `apps` is absent.
  public var exclude: [String]?
  /// Part of the display, in global points; the whole display when absent.
  public var region: ScreenRect?
  /// The image is scaled down to fit these, keeping its aspect ratio.
  public var maxWidth: Double
  public var maxHeight: Double
  public var format: ImageFormat
  /// JPEG quality, 0–1.
  public var quality: Double?
}

public struct CaptureResult: Codable, Sendable {
  /// Base64.
  public var data: String
  public var mime: String
  /// The image's size in pixels.
  public var width: Int
  public var height: Int
  /// What the image covers, in global points.
  public var rect: ScreenRect
}

public struct InspectPointParams: Codable, Sendable {
  public var x: Double
  public var y: Double
}

/// What is under a point (or has the keyboard focus): the app, and the element where the OS tells.
public struct InspectPointResult: Codable, Sendable, Equatable {
  public var app: HelperApp?
  public var role: String?
  public var title: String?
  /// A password field (`AXSecureTextField`).
  public var secure: Bool
  /// A link's address ('' for a link without one), or null.
  public var link: String?

  public init(app: HelperApp?, role: String?, title: String?, secure: Bool, link: String?) {
    self.app = app
    self.role = role
    self.title = title
    self.secure = secure
    self.link = link
  }

  enum CodingKeys: String, CodingKey { case app, role, title, secure, link }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(app, forKey: .app)
    try c.encode(role, forKey: .role)
    try c.encode(title, forKey: .title)
    try c.encode(secure, forKey: .secure)
    try c.encode(link, forKey: .link)
  }
}

// ---------------------------------------------------------------- input

public enum MouseButton: String, Codable, Sendable, CaseIterable {
  case left
  case right
  case middle
}

public struct MouseClickParams: Codable, Sendable {
  public var x: Double
  public var y: Double
  public var button: MouseButton
  /// 1, 2 or 3 clicks.
  public var count: Int
  /// Held during the click: `cmd`, `shift`, `alt`, `ctrl`.
  public var modifiers: [String]
}

public struct MouseButtonParams: Codable, Sendable {
  public var x: Double
  public var y: Double
  public var button: MouseButton
}

public struct MouseDragParams: Codable, Sendable {
  public var from: Point
  public var to: Point
  public var button: MouseButton
}

/// Lines to scroll: positive `dy` scrolls down, positive `dx` right.
public struct MouseScrollParams: Codable, Sendable {
  public var x: Double
  public var y: Double
  public var dx: Double
  public var dy: Double
}

/// Keys pressed together, modifiers first, then one key: `['cmd', 'shift', 't']`, `['return']`, `['f5']`.
public struct KeyPressParams: Codable, Sendable {
  public var keys: [String]
  public var `repeat`: Int?
}

public struct KeyTypeParams: Codable, Sendable {
  public var text: String
}

public struct KeyHoldParams: Codable, Sendable {
  public var keys: [String]
  /// At most 10 000.
  public var ms: Double
}

// ---------------------------------------------------------------- notifications

public enum EscPhase: String, Codable, Sendable {
  case down
  case up
  case stopped
}

public enum UserInputKind: String, Codable, Sendable {
  case mouse
  case key
}

/// Notifications from the helper while it has control (`control.begin` … `control.end`). `control.esc`: the person
/// pressed Esc (`down`), let go early (`up`), or held it a second (`stopped`: input is refused until
/// `control.resume`). `control.userInput`: the person used the mouse or keyboard themselves. `control.secureInput`: a
/// password field anywhere turned secure input on (the Esc watch can't see keys then).
public enum ComputerNotification: Sendable, Equatable, Encodable {
  case esc(phase: EscPhase, heldMs: Int)
  case userInput(kind: UserInputKind)
  case secureInput(on: Bool)

  public static let methods = ["control.esc", "control.userInput", "control.secureInput"]

  public var method: String {
    switch self {
    case .esc: "control.esc"
    case .userInput: "control.userInput"
    case .secureInput: "control.secureInput"
    }
  }

  enum CodingKeys: String, CodingKey { case jsonrpc, method, params }
  enum ParamKeys: String, CodingKey { case phase, heldMs, kind, on }

  /// The whole JSON-RPC notification.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("2.0", forKey: .jsonrpc)
    try c.encode(method, forKey: .method)
    var p = c.nestedContainer(keyedBy: ParamKeys.self, forKey: .params)
    switch self {
    case .esc(let phase, let heldMs):
      try p.encode(phase, forKey: .phase)
      try p.encode(heldMs, forKey: .heldMs)
    case .userInput(let kind):
      try p.encode(kind, forKey: .kind)
    case .secureInput(let on):
      try p.encode(on, forKey: .on)
    }
  }
}
