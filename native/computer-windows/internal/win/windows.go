//go:build windows

package win

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// window is one top-level window as the helper sees it.
type window struct {
	hwnd    uintptr
	visible bool
	iconic  bool
	cloaked bool
	owner   uintptr
	exStyle uint32
	class   string
	// pid owns the window; appPID is the app it shows: for a UWP app's frame (ApplicationFrameHost's
	// ApplicationFrameWindow) the process of the CoreWindow inside it.
	pid    uint32
	appPID uint32
	rect   rect
	// affinity is the display affinity: not WDA_NONE when it is kept out of captures.
	affinity uint32
}

var coreWindowClass, _ = windows.UTF16PtrFromString("Windows.UI.Core.CoreWindow")

// topWindows are the visible top-level windows, in z-order from the top. Invisible ones are left out early.
func topWindows() []window {
	var list []window
	enumWindows(func(hwnd uintptr) bool {
		if !boolCall(procIsWindowVisible, hwnd) {
			return true
		}
		list = append(list, describeWindow(hwnd))
		return true
	})
	return list
}

func describeWindow(hwnd uintptr) window {
	w := window{hwnd: hwnd, visible: boolCall(procIsWindowVisible, hwnd)}
	w.iconic = boolCall(procIsIconic, hwnd)
	w.cloaked = isCloaked(hwnd)
	w.owner, _, _ = procGetWindow.Call(hwnd, GW_OWNER)
	w.exStyle = exStyle(hwnd)
	w.class = className(hwnd)
	w.pid, _ = windowPID(hwnd)
	w.appPID = appPIDOf(hwnd, w.class, w.pid)
	w.rect = frameRect(hwnd)
	procGetWindowDisplayAffinity.Call(hwnd, uintptr(unsafe.Pointer(&w.affinity)))
	return w
}

// appPIDOf is the app a top-level window shows: its own process, but for a UWP app's frame (ApplicationFrameHost's
// ApplicationFrameWindow) the process of the CoreWindow inside it.
func appPIDOf(hwnd uintptr, class string, pid uint32) uint32 {
	if class == "ApplicationFrameWindow" {
		if core, _, _ := procFindWindowExW.Call(hwnd, 0, uintptr(unsafe.Pointer(coreWindowClass)), 0); core != 0 {
			if corePID, _ := windowPID(core); corePID != 0 {
				return corePID
			}
		}
	}
	return pid
}

// isShellClass: the desktop (wallpaper and icons) and the taskbars, which are explorer's but not an app's windows.
func isShellClass(class string) bool {
	switch class {
	case "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd":
		return true
	}
	return false
}

// isDesktopClass: the wallpaper and desktop icons, kept in a screenshot of only some apps.
func isDesktopClass(class string) bool { return class == "Progman" || class == "WorkerW" }

// altTab: a window the person can switch to: visible, unowned, not a tool window, not cloaked (on another virtual
// desktop, or a suspended UWP app), and not the shell's own.
func (w window) altTab() bool {
	return w.visible && w.owner == 0 && w.exStyle&WS_EX_TOOLWINDOW == 0 && !w.cloaked && !isShellClass(w.class)
}

// clickThrough: a layered, transparent window (an overlay that clicks pass through, like Atelier's while it has
// control). It isn't hit by the mouse and doesn't hide what is under it.
func (w window) clickThrough() bool {
	return w.exStyle&WS_EX_TRANSPARENT != 0 && w.exStyle&WS_EX_LAYERED != 0
}

// fullyTransparent: a layered window drawn with alpha 0.
func (w window) fullyTransparent() bool {
	if w.exStyle&WS_EX_LAYERED == 0 {
		return false
	}
	var key uint32
	var alpha uint8
	var flags uint32
	if !boolCall(procGetLayeredWindowAttributes, w.hwnd, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&alpha)), uintptr(unsafe.Pointer(&flags))) {
		return false // Per-pixel alpha (UpdateLayeredWindow): taken as drawn.
	}
	return flags&LWA_ALPHA != 0 && alpha == 0
}

// onScreen: drawn on screen now: visible, not minimized, not cloaked, with a size.
func (w window) onScreen() bool {
	return w.visible && !w.iconic && !w.cloaked && !w.rect.empty()
}

// effectivePID is the app a window (any, not only a top-level one) shows: its root's appPID.
func effectivePID(hwnd uintptr) uint32 {
	if hwnd == 0 {
		return 0
	}
	root, _, _ := procGetAncestor.Call(hwnd, GA_ROOT)
	if root == 0 {
		root = hwnd
	}
	pid, _ := windowPID(root)
	return appPIDOf(root, className(root), pid)
}

// foregroundPID is the app of the foreground window (0 when there is none).
func foregroundPID() uint32 { return effectivePID(foregroundWindow()) }
