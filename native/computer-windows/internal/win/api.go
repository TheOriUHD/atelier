//go:build windows

// Package win is the Windows side of the helper: displays, apps, capture, UI Automation, SendInput and the low-level
// hooks, through user32, gdi32, dwmapi, shcore, ole32 and kernel32 (no cgo).
package win

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	shcore   = windows.NewLazySystemDLL("shcore.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	oleaut32 = windows.NewLazySystemDLL("oleaut32.dll")

	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDpiAwareness        = shcore.NewProc("SetProcessDpiAwareness")
	procGetDpiForMonitor              = shcore.NewProc("GetDpiForMonitor")

	procEnumWindows                 = user32.NewProc("EnumWindows")
	procEnumDisplayMonitors         = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW             = user32.NewProc("GetMonitorInfoW")
	procEnumDisplayDevicesW         = user32.NewProc("EnumDisplayDevicesW")
	procGetDisplayConfigBufferSizes = user32.NewProc("GetDisplayConfigBufferSizes")
	procQueryDisplayConfig          = user32.NewProc("QueryDisplayConfig")
	procDisplayConfigGetDeviceInfo  = user32.NewProc("DisplayConfigGetDeviceInfo")

	procIsWindow                   = user32.NewProc("IsWindow")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")
	procIsIconic                   = user32.NewProc("IsIconic")
	procGetWindow                  = user32.NewProc("GetWindow")
	procGetWindowLongPtrW          = user32.NewProc("GetWindowLongPtrW")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	procGetClassNameW              = user32.NewProc("GetClassNameW")
	procGetWindowRect              = user32.NewProc("GetWindowRect")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop           = user32.NewProc("BringWindowToTop")
	procSetFocus                   = user32.NewProc("SetFocus")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procShowWindowAsync            = user32.NewProc("ShowWindowAsync")
	procAttachThreadInput          = user32.NewProc("AttachThreadInput")
	procAllowSetForegroundWindow   = user32.NewProc("AllowSetForegroundWindow")
	procFindWindowExW              = user32.NewProc("FindWindowExW")
	procWindowFromPoint            = user32.NewProc("WindowFromPoint")
	procGetAncestor                = user32.NewProc("GetAncestor")
	procGetWindowDisplayAffinity   = user32.NewProc("GetWindowDisplayAffinity")
	procGetLayeredWindowAttributes = user32.NewProc("GetLayeredWindowAttributes")

	procDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")

	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procGdiFlush           = gdi32.NewProc("GdiFlush")
	procGetCursorInfo      = user32.NewProc("GetCursorInfo")
	procGetIconInfo        = user32.NewProc("GetIconInfo")
	procDrawIconEx         = user32.NewProc("DrawIconEx")
	procGetCursorPos       = user32.NewProc("GetCursorPos")
	procSetCursorPos       = user32.NewProc("SetCursorPos")

	procSendInput            = user32.NewProc("SendInput")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procMapVirtualKeyExW     = user32.NewProc("MapVirtualKeyExW")
	procVkKeyScanExW         = user32.NewProc("VkKeyScanExW")
	procGetKeyboardLayout    = user32.NewProc("GetKeyboardLayout")
	procGetAsyncKeyState     = user32.NewProc("GetAsyncKeyState")
	procSetWindowsHookExW    = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx  = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx       = user32.NewProc("CallNextHookEx")
	procGetMessageW          = user32.NewProc("GetMessageW")
	procPeekMessageW         = user32.NewProc("PeekMessageW")
	procPostThreadMessageW   = user32.NewProc("PostThreadMessageW")
	procGetPackageFamilyName = kernel32.NewProc("GetPackageFamilyName")
	procGetModuleHandleW     = kernel32.NewProc("GetModuleHandleW")

	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procVariantClear     = oleaut32.NewProc("VariantClear")
	procSysStringLen     = oleaut32.NewProc("SysStringLen")
)

// Constants (WinUser.h, dwmapi.h, wingdi.h).
const (
	GW_OWNER = 4

	GA_ROOT      = 2
	GA_ROOTOWNER = 3

	WS_EX_TOPMOST     = 0x00000008
	WS_EX_TRANSPARENT = 0x00000020
	WS_EX_TOOLWINDOW  = 0x00000080
	WS_EX_LAYERED     = 0x00080000
	WS_EX_NOACTIVATE  = 0x08000000

	SW_MINIMIZE       = 6
	SW_SHOWNOACTIVATE = 4
	SW_RESTORE        = 9
	SW_SHOWNORMAL     = 1

	DWMWA_EXTENDED_FRAME_BOUNDS = 9
	DWMWA_CLOAKED               = 14

	WDA_NONE = 0

	LWA_ALPHA = 0x2

	MONITORINFOF_PRIMARY = 1
	MDT_EFFECTIVE_DPI    = 0

	QDC_ONLY_ACTIVE_PATHS = 2

	SRCCOPY        = 0x00CC0020
	CAPTUREBLT     = 0x40000000
	DIB_RGB_COLORS = 0
	BI_RGB         = 0
	CURSOR_SHOWING = 1
	DI_NORMAL      = 3

	SM_SWAPBUTTON      = 23
	SM_XVIRTUALSCREEN  = 76
	SM_YVIRTUALSCREEN  = 77
	SM_CXVIRTUALSCREEN = 78
	SM_CYVIRTUALSCREEN = 79

	INPUT_MOUSE    = 0
	INPUT_KEYBOARD = 1

	WH_KEYBOARD_LL = 13
	WH_MOUSE_LL    = 14
	HC_ACTION      = 0

	WM_QUIT        = 0x0012
	WM_KEYDOWN     = 0x0100
	WM_KEYUP       = 0x0101
	WM_SYSKEYDOWN  = 0x0104
	WM_SYSKEYUP    = 0x0105
	WM_MOUSEMOVE   = 0x0200
	WM_LBUTTONDOWN = 0x0201
	WM_RBUTTONDOWN = 0x0204
	WM_MBUTTONDOWN = 0x0207
	WM_XBUTTONDOWN = 0x020B
	PM_NOREMOVE    = 0

	ASFW_ANY = 0xFFFFFFFF

	PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

	ERROR_SUCCESS = 0
)

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is ((DPI_AWARENESS_CONTEXT)-4).
var dpiAwarenessPerMonitorV2 = ^uintptr(3)

type rect struct{ Left, Top, Right, Bottom int32 }

func (r rect) empty() bool { return r.Right <= r.Left || r.Bottom <= r.Top }

func (r rect) contains(x, y int32) bool {
	return x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom
}

type point struct{ X, Y int32 }

// packPoint passes a POINT by value: an 8-byte struct goes in one register on x64 and arm64, x in the low half.
func packPoint(x, y int32) uintptr { return uintptr(uint32(x)) | uintptr(uint32(y))<<32 }

type msg struct {
	Hwnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       point
	LPrivate uint32
}

// ptrAt reinterprets an address the OS handed over (a hook's lParam, a VARIANT's BSTR: not Go memory) as a pointer.
func ptrAt[T any](addr uintptr) *T { return *(**T)(unsafe.Pointer(&addr)) }

// boolCall calls a function that returns a BOOL. Like LazyProc.Call it is uintptrescapes: a pointer converted to
// uintptr in its arguments stays valid through the call (the object is kept alive and doesn't move with the stack).
//
//go:uintptrescapes
func boolCall(p *windows.LazyProc, args ...uintptr) bool {
	r, _, _ := p.Call(args...)
	return r != 0
}

// ---------------------------------------------------------------- callbacks

// Go callbacks are a limited resource (windows.NewCallback), so there is one per kind, and each call's own function is
// looked up by the LPARAM it was given.
var (
	callbacksMu sync.Mutex
	callbacks   = map[uintptr]func(uintptr) bool{}
	nextKey     uintptr

	enumWindowsCallback = windows.NewCallback(func(hwnd, lparam uintptr) uintptr {
		if f := lookupCallback(lparam); f != nil && f(hwnd) {
			return 1
		}
		return 0
	})
	enumMonitorsCallback = windows.NewCallback(func(hmonitor, hdc, lprc, lparam uintptr) uintptr {
		if f := lookupCallback(lparam); f != nil && f(hmonitor) {
			return 1
		}
		return 0
	})
)

func registerCallback(f func(uintptr) bool) uintptr {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	nextKey++
	callbacks[nextKey] = f
	return nextKey
}

func unregisterCallback(key uintptr) {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	delete(callbacks, key)
}

func lookupCallback(key uintptr) func(uintptr) bool {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	return callbacks[key]
}

// enumWindows calls f for every top-level window, in z-order from the top, until it returns false.
func enumWindows(f func(hwnd uintptr) bool) {
	key := registerCallback(f)
	defer unregisterCallback(key)
	procEnumWindows.Call(enumWindowsCallback, key)
}

func enumMonitors(f func(hmonitor uintptr) bool) {
	key := registerCallback(f)
	defer unregisterCallback(key)
	procEnumDisplayMonitors.Call(0, 0, enumMonitorsCallback, key)
}

// ---------------------------------------------------------------- small wrappers

func windowPID(hwnd uintptr) (pid uint32, thread uint32) {
	r, _, _ := procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid, uint32(r)
}

func className(hwnd uintptr) string {
	var buf [256]uint16
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

func windowLong(hwnd uintptr, index int32) uint32 {
	r, _, _ := procGetWindowLongPtrW.Call(hwnd, uintptr(index))
	return uint32(r)
}

func exStyle(hwnd uintptr) uint32 { return windowLong(hwnd, -20) } // GWL_EXSTYLE

func isCloaked(hwnd uintptr) bool {
	var cloaked uint32
	r, _, _ := procDwmGetWindowAttribute.Call(hwnd, DWMWA_CLOAKED, uintptr(unsafe.Pointer(&cloaked)), 4)
	return r == 0 && cloaked != 0
}

// frameRect is the window's visible frame (DWM's extended frame bounds, without the invisible resize borders), else its
// window rectangle. Physical pixels for this per-monitor aware process.
func frameRect(hwnd uintptr) rect {
	var r rect
	if res, _, _ := procDwmGetWindowAttribute.Call(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, uintptr(unsafe.Pointer(&r)), unsafe.Sizeof(r)); res == 0 && !r.empty() {
		return r
	}
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func foregroundWindow() uintptr {
	r, _, _ := procGetForegroundWindow.Call()
	return r
}

func systemMetric(index int) int {
	r, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(r))
}

func cursorPos() (point, bool) {
	var p point
	ok := boolCall(procGetCursorPos, uintptr(unsafe.Pointer(&p)))
	return p, ok
}
