package bg

import (
	"strconv"
	"strings"
)

// ParseWindow reads a window id from window.capture: the window's handle in decimal. ok false for anything else (the
// id is opaque to main: one that doesn't name a window is NotFound, whatever it looks like).
func ParseWindow(id string) (uintptr, bool) {
	if id == "" || len(id) > 20 {
		return 0, false
	}
	n, err := strconv.ParseUint(id, 10, 64)
	if err != nil || n == 0 {
		return 0, false
	}
	return uintptr(n), true
}

// FormatWindow is a window's id for window.capture's answer.
func FormatWindow(hwnd uintptr) string { return strconv.FormatUint(uint64(hwnd), 10) }

// Rect is a rectangle in pixels, half-open: [Left, Right) × [Top, Bottom).
type Rect struct{ Left, Top, Right, Bottom float64 }

func (r Rect) Contains(x, y float64) bool {
	return x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom
}

func (r Rect) Area() float64 {
	if r.Right <= r.Left || r.Bottom <= r.Top {
		return 0
	}
	return (r.Right - r.Left) * (r.Bottom - r.Top)
}

// ---------------------------------------------------------------- which window

// Window is a top-level window, as window.capture chooses among them (in z-order, the topmost first).
type Window struct {
	Hwnd uintptr
	// App is its app's id, lowercase ("" when it couldn't be told).
	App string
	// AltTab: a window the person can switch to (visible, unowned, not a tool window, not cloaked, not the shell's).
	AltTab  bool
	Iconic  bool
	Enabled bool
	// Empty: no size.
	Empty bool
	// Dialog: an owned window on screen (visible, not cloaked, not a tool window), like a dialog; RootOwner is the
	// window at the top of its owner chain.
	Dialog    bool
	RootOwner uintptr
}

// Choice is the window window.capture works with.
type Choice struct {
	Window Window
	// Restore: it is minimized, and is restored (without activating it) first.
	Restore bool
}

// ChooseWindow is the window of an app that window.capture shows: its topmost window the person can switch to that
// isn't minimized. When that one is disabled (a modal dialog of it is open) the topmost such dialog instead, since
// nothing in the window takes a click until it is closed. When all its windows are minimized, the topmost of those, to
// restore. ok false when the app has no window to switch to.
func ChooseWindow(list []Window, app string) (Choice, bool) {
	app = strings.ToLower(app)
	var minimized *Window
	for i := range list {
		w := list[i]
		if w.App != app || !w.AltTab {
			continue
		}
		if w.Iconic {
			if minimized == nil {
				minimized = &list[i]
			}
			continue
		}
		if w.Empty {
			continue
		}
		if !w.Enabled {
			for _, d := range list {
				if d.Dialog && d.RootOwner == w.Hwnd && d.Enabled && !d.Iconic && !d.Empty {
					return Choice{Window: d}, true
				}
			}
		}
		return Choice{Window: w}, true
	}
	if minimized != nil {
		return Choice{Window: *minimized, Restore: true}, true
	}
	return Choice{}, false
}

// ---------------------------------------------------------------- which child window

// Child is a child window, as the system's hit test sees it.
type Child struct {
	Hwnd    uintptr
	Visible bool
	Enabled bool
	// Transparent: WS_EX_TRANSPARENT, which the mouse passes through.
	Transparent bool
	// GroupBox: a group box, which answers the hit test with HTTRANSPARENT (RealChildWindowFromPoint skips it).
	GroupBox bool
	// Rect in screen pixels.
	Rect Rect
}

// PickChild is the index of the child window a click at x, y (screen pixels) goes to, as the mouse finds it: the first
// in z-order (topmost first) that is visible, enabled, not transparent and not a group box, and contains the point; -1
// for none (the click goes to the parent itself). A disabled child doesn't take the mouse: Chromium's compositor
// window, for one, leaves it to its parent.
func PickChild(children []Child, x, y float64) int {
	for i, c := range children {
		if c.Visible && c.Enabled && !c.Transparent && !c.GroupBox && c.Rect.Contains(x, y) {
			return i
		}
	}
	return -1
}

// IsChromium: a Chromium or Electron top-level window (Chrome, Edge, VS Code, Slack…).
func IsChromium(class string) bool { return strings.HasPrefix(class, "Chrome_WidgetWin_") }

// ChromiumContent is the class of the child window a Chromium window's web content takes the mouse on.
const ChromiumContent = "Chrome_RenderWidgetHostHWND"

// CoreWindow is the class of a Store (UWP) app's content window, whose input comes from the system's pointer and
// keyboard, not from window messages.
const CoreWindow = "Windows.UI.Core.CoreWindow"

// ---------------------------------------------------------------- hit test

// Hit-test codes (WM_NCHITTEST).
const (
	HTERROR       = -2
	HTTRANSPARENT = -1
	HTNOWHERE     = 0
	HTCLIENT      = 1
	HTCAPTION     = 2
	HTSYSMENU     = 3
	HTGROWBOX     = 4
	HTMENU        = 5
	HTHSCROLL     = 6
	HTVSCROLL     = 7
	HTMINBUTTON   = 8
	HTMAXBUTTON   = 9
	HTLEFT        = 10
	HTBOTTOMRIGHT = 17
	HTBORDER      = 18
	HTCLOSE       = 20
	HTHELP        = 21
)

// FramePart names the part of a window's frame a hit-test code is ("" for the window's content, where a background
// click goes as client messages). The frame's own handling (moving, sizing, menus, the caption buttons) follows the
// real mouse, so a background click there can't be done.
func FramePart(code int) string {
	switch {
	case code == HTCAPTION:
		return "title bar"
	case code == HTSYSMENU:
		return "window menu"
	case code == HTMENU:
		return "menu bar"
	case code == HTHSCROLL || code == HTVSCROLL:
		return "scroll bar"
	case code == HTMINBUTTON:
		return "minimize button"
	case code == HTMAXBUTTON:
		return "maximize button"
	case code == HTCLOSE:
		return "close button"
	case code == HTHELP:
		return "help button"
	case code == HTGROWBOX || (code >= HTLEFT && code <= HTBOTTOMRIGHT) || code == HTBORDER:
		return "border"
	}
	return ""
}

// EditClass: a window class that takes the edit messages (EM_SETSEL, WM_COPY, WM_PASTE, WM_UNDO…): the edit control,
// RichEdit (every version, Notepad's RichEditD2DPT among them).
func EditClass(class string) bool {
	c := strings.ToLower(class)
	return c == "edit" || strings.HasPrefix(c, "richedit") || c == "tmemo" || c == "tedit"
}
