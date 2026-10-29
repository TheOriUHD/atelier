// Package proto is computer protocol v1 as the Windows helper speaks it: the Go mirror of
// packages/protocol/src/computer.ts (and of native/computer-macos/Sources/AtelierComputer/Protocol.swift). Keep them in
// sync; parity_test.go compares the method names, error codes, version and notification names with the TypeScript.
//
// JSON-RPC 2.0, one JSON object per line over stdio: requests in on stdin, responses and notifications out on stdout,
// logs on stderr. On Windows every coordinate is a physical pixel of the virtual screen: the primary monitor's top-left
// is 0,0 and other monitors may sit at negative coordinates.
package proto

// ProtocolVersion is COMPUTER_PROTOCOL_VERSION.
const ProtocolVersion = 1

// HelperVersion is this helper's own version, reported by initialize.
const HelperVersion = "0.1.0"

// Platform is what initialize reports.
const Platform = "win32"

// JSON-RPC error codes the helper returns (ComputerErrorCode).
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	Internal       = -32603
	NotInitialized = -32002
	// Permission: the OS permission is missing. Never returned on Windows, which doesn't ask.
	Permission = -32030
	// Stopped: the person held Esc; input is refused until control.resume.
	Stopped = -32031
	// Unsupported: not something this OS or helper can do.
	Unsupported = -32032
	// NotFound: no such app or display.
	NotFound = -32033
)

// ErrorCodes are the codes by their name in the TypeScript ComputerErrorCode object.
var ErrorCodes = map[string]int{
	"ParseError":     ParseError,
	"InvalidRequest": InvalidRequest,
	"MethodNotFound": MethodNotFound,
	"InvalidParams":  InvalidParams,
	"Internal":       Internal,
	"NotInitialized": NotInitialized,
	"Permission":     Permission,
	"Stopped":        Stopped,
	"Unsupported":    Unsupported,
	"NotFound":       NotFound,
}

// Every method of computer protocol v1 (ComputerMethods).
const (
	MInitialize         = "initialize"
	MPermissionsStatus  = "permissions.status"
	MPermissionsRequest = "permissions.request"
	MDisplaysList       = "displays.list"
	MAppsList           = "apps.list"
	MAppsFrontmost      = "apps.frontmost"
	MAppsOpen           = "apps.open"
	MAppsHide           = "apps.hide"
	MAppsUnhide         = "apps.unhide"
	MAppsActivate       = "apps.activate"
	MCaptureDisplay     = "capture.display"
	MInspectPoint       = "inspect.point"
	MInspectFocused     = "inspect.focused"
	MMouseMove          = "mouse.move"
	MMouseClick         = "mouse.click"
	MMouseDown          = "mouse.down"
	MMouseUp            = "mouse.up"
	MMouseDrag          = "mouse.drag"
	MMouseScroll        = "mouse.scroll"
	MCursorPosition     = "cursor.position"
	MKeyPress           = "key.press"
	MKeyType            = "key.type"
	MKeyHold            = "key.hold"
	MInputReleaseAll    = "input.releaseAll"
	MControlBegin       = "control.begin"
	MControlEnd         = "control.end"
	MControlResume      = "control.resume"
	MShutdown           = "shutdown"
)

// Methods lists every method of ComputerMethods.
var Methods = []string{
	MInitialize, MPermissionsStatus, MPermissionsRequest, MDisplaysList, MAppsList, MAppsFrontmost, MAppsOpen,
	MAppsHide, MAppsUnhide, MAppsActivate, MCaptureDisplay, MInspectPoint, MInspectFocused, MMouseMove, MMouseClick,
	MMouseDown, MMouseUp, MMouseDrag, MMouseScroll, MCursorPosition, MKeyPress, MKeyType, MKeyHold, MInputReleaseAll,
	MControlBegin, MControlEnd, MControlResume, MShutdown,
}

// Notifications the helper may send while it has control (ComputerNotification).
const (
	NControlEsc         = "control.esc"
	NControlUserInput   = "control.userInput"
	NControlSecureInput = "control.secureInput"
)

// Notifications lists every notification of the contract. control.secureInput is never sent on Windows (it has no
// secure input mode that hides keys from the hooks), but it is part of the contract.
var Notifications = []string{NControlEsc, NControlUserInput, NControlSecureInput}

// ---------------------------------------------------------------- shared

// Empty is `Record<string, never>`: `{}`.
type Empty struct{}

// Rect is a rectangle in global screen coordinates (physical pixels of the virtual screen on Windows).
type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Point is a point in global screen coordinates.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// ---------------------------------------------------------------- initialize, permissions

type Supports struct {
	Background  bool `json:"background"`
	FullControl bool `json:"fullControl"`
	Filter      bool `json:"filter"`
}

type InitializeResult struct {
	ProtocolVersion int      `json:"protocolVersion"`
	HelperVersion   string   `json:"helperVersion"`
	Platform        string   `json:"platform"`
	Supports        Supports `json:"supports"`
}

// PermissionsStatus is always both true on Windows, which doesn't ask.
type PermissionsStatus struct {
	Accessibility   bool `json:"accessibility"`
	ScreenRecording bool `json:"screenRecording"`
}

// ---------------------------------------------------------------- displays, apps

type Display struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Scale is the monitor's DPI / 96.
	Scale   float64 `json:"scale"`
	Primary bool    `json:"primary"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
}

// App is HelperApp. Path, PID and Category are `T | null`: written as null, never left out.
type App struct {
	// ID: the package family name of a packaged app, else the lowercase exe file name.
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Path     *string `json:"path"`
	PID      *int    `json:"pid"`
	Running  bool    `json:"running"`
	Active   bool    `json:"active"`
	Hidden   bool    `json:"hidden"`
	Category *string `json:"category"`
}

type DisplaysListResult struct {
	Displays []Display `json:"displays"`
}

type AppsListResult struct {
	Apps []App `json:"apps"`
}

// AppResult answers apps.frontmost (`{app: null}` when there's none) and apps.open.
type AppResult struct {
	App *App `json:"app"`
}

type AppsHideResult struct {
	IDs []string `json:"ids"`
}

type AppsActivateResult struct {
	Activated bool `json:"activated"`
}

// ---------------------------------------------------------------- capture, inspect

type CaptureResult struct {
	// Data is base64.
	Data   string `json:"data"`
	Mime   string `json:"mime"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Rect   Rect   `json:"rect"`
}

// InspectResult answers inspect.point and inspect.focused; every field is always written.
type InspectResult struct {
	App    *App    `json:"app"`
	Role   *string `json:"role"`
	Title  *string `json:"title"`
	Secure bool    `json:"secure"`
	Link   *string `json:"link"`
}

// ---------------------------------------------------------------- notifications

type EscParams struct {
	Phase  string `json:"phase"`
	HeldMs int    `json:"heldMs"`
}

type UserInputParams struct {
	Kind string `json:"kind"`
}

// Notification is a whole JSON-RPC notification: no id.
type Notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// Ptr returns a pointer to v, for the nullable fields.
func Ptr[T any](v T) *T { return &v }
