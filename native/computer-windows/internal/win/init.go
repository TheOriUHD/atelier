//go:build windows

package win

import "unsafe"

// Init readies the process before anything else touches the screen: per-monitor DPI awareness (v2), so every
// coordinate is a physical pixel, and a first look at the message queue, which ends the "app starting" pointer
// Windows shows after it starts a GUI program that opens no window.
func Init() {
	if procSetProcessDpiAwarenessContext.Find() == nil {
		procSetProcessDpiAwarenessContext.Call(dpiAwarenessPerMonitorV2)
	} else if procSetProcessDpiAwareness.Find() == nil {
		procSetProcessDpiAwareness.Call(2) // PROCESS_PER_MONITOR_DPI_AWARE (Windows 8.1)
	}
	var m msg
	procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, PM_NOREMOVE)
}
