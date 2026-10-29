//go:build windows

package win

import (
	"math"

	"atelier.dev/computer-windows/internal/inspect"
	"atelier.dev/computer-windows/internal/proto"
)

// InspectPoint is what is under a point: the element UI Automation finds there, else only whose window it is.
func (s *System) InspectPoint(x, y float64) (proto.InspectResult, error) {
	px, py := int32(math.Round(x)), int32(math.Round(y))
	pc := newProcCache()
	el, err := uiaInspect(uiaAtPoint, px, py)
	if err != nil || el == nil || el.PID == 0 {
		// No element (an app without UI Automation, or one that didn't answer in time): still say whose window it is.
		return inspect.Describe(nil, s.appFor(s.windowOwnerAt(px, py), pc)), nil
	}
	// Atelier (this helper's parent) floats a click-through overlay over everything while it has control. Clicks pass
	// through it; if the hit test didn't, say what is under it.
	if uint32(el.PID) == s.parent {
		if under := s.windowOwnerAt(px, py); under != 0 && under != s.parent {
			return inspect.Describe(nil, s.appFor(under, pc)), nil
		}
	}
	return inspect.Describe(el, s.appFor(uint32(el.PID), pc)), nil
}

// windowOwnerAt is the app of the topmost window at a point, looking through Atelier's click-through overlays (its
// normal windows count as Atelier).
func (s *System) windowOwnerAt(x, y int32) uint32 {
	// The mouse's own hit test (WindowFromPoint) passes through click-through windows, as clicks do.
	if hwnd, _, _ := procWindowFromPoint.Call(packPoint(x, y)); hwnd != 0 {
		if pid := effectivePID(hwnd); pid != 0 {
			return pid
		}
	}
	for _, w := range topWindows() {
		if !w.onScreen() || !w.rect.contains(x, y) || w.clickThrough() || w.fullyTransparent() {
			continue
		}
		return w.appPID
	}
	return 0
}

// InspectFocused is the element with the keyboard focus, else the foreground app.
func (s *System) InspectFocused() (proto.InspectResult, error) {
	pc := newProcCache()
	el, err := uiaInspect(uiaFocused, 0, 0)
	if err != nil || el == nil || el.PID == 0 {
		return inspect.Describe(nil, s.appFor(foregroundPID(), pc)), nil
	}
	return inspect.Describe(el, s.appFor(uint32(el.PID), pc)), nil
}
