//go:build windows

package win

// Read-only checks of Background mode's Windows layer, like win_test.go's: nothing here posts a message, clicks,
// types, restores or captures another app's window.

import (
	"errors"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/bg"
	"atelier.dev/computer-windows/internal/helper"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

func TestBackgroundStructLayouts(t *testing.T) {
	if n := unsafe.Sizeof(windows.GUIThreadInfo{}); n != 72 {
		t.Errorf("GUITHREADINFO is %d bytes, Windows says 72", n)
	}
	if n := unsafe.Sizeof(safeArray{}); n != 32 {
		t.Errorf("SAFEARRAY (one dimension) is %d bytes, Windows says 32", n)
	}
	if off := unsafe.Offsetof(safeArray{}.Data); off != 16 {
		t.Errorf("SAFEARRAY.pvData at %d", off)
	}
}

func errorCode(err error) int {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return 0
}

func TestBackgroundWindowsThatArentThere(t *testing.T) {
	s := NewSystem()
	for _, id := range []string{"1", "abc", "0", "18446744073709551615"} {
		if _, err := s.resolveWindow(id); errorCode(err) != proto.NotFound {
			t.Errorf("window %q: %v", id, err)
		}
		if _, err := s.BgInspect(id, 0, 0); errorCode(err) != proto.NotFound {
			t.Errorf("bg.inspect %q: %v", id, err)
		}
		if _, err := s.BgFocused(id); errorCode(err) != proto.NotFound {
			t.Errorf("bg.focused %q: %v", id, err)
		}
	}
	never := func() error { t.Fatal("ready was asked for a window that isn't there"); return nil }
	if err := s.BgClick(never, helper.BgClickRequest{Window: "1", Button: "left", Count: 1}); errorCode(err) != proto.NotFound {
		t.Errorf("bg.click: %v", err)
	}
	if err := s.BgType(never, "1", "x"); errorCode(err) != proto.NotFound {
		t.Errorf("bg.type: %v", err)
	}
	_, err := s.WindowCapture(helper.WindowCaptureRequest{App: "no-such-app-atelier-test.exe", MaxWidth: 10, MaxHeight: 10, Format: "png", Quality: 0.8})
	if errorCode(err) != proto.NotFound {
		t.Errorf("window.capture of no app: %v", err)
	}
}

func TestIntegrityLevels(t *testing.T) {
	level, ok := integrityLevel(windows.GetCurrentProcessToken())
	if !ok || level < 0x1000 {
		t.Fatalf("this process's integrity level: %#x %v", level, ok)
	}
	t.Logf("integrity level %#x", level)
	if aboveUs(uint32(os.Getpid())) {
		t.Error("this process is above itself")
	}
}

// TestUIAutomationReadsTheDesktop reads the desktop window's element: ElementFromHandle, BoundingRectangle (a SAFEARRAY
// of doubles) and the control view walk, all read-only.
func TestUIAutomationReadsTheDesktop(t *testing.T) {
	desktop := windows.GetDesktopWindow()
	type read struct {
		rect     bg.Rect
		hasRect  bool
		kind     int
		patterns bool
		children int
	}
	v, err := uiaRun(3*time.Second, func(u *uiaSession) (any, error) {
		el, err := u.fromHandle(uintptr(desktop))
		if err != nil {
			return nil, err
		}
		defer el.release()
		var r read
		r.rect, r.hasRect = uiaTree{}.Bounds(el)
		r.kind = propInt(el, propControlType)
		r.patterns = u.patterns
		if u.walker != nil {
			tree := uiaTree{u.walker}
			child, ok := tree.FirstChild(el)
			for ok && r.children < 50 {
				r.children++
				next, more := tree.NextSibling(child)
				tree.Release(child)
				child, ok = next, more
			}
		}
		return r, nil
	})
	if err != nil {
		t.Skipf("UI Automation: %v (no desktop?)", err)
	}
	r := v.(read)
	t.Logf("desktop: %+v", r)
	if r.kind != 50033 { // Pane
		t.Errorf("the desktop's control type: %d", r.kind)
	}
	if !r.patterns {
		t.Error("AutoSetFocus couldn't be turned off: Background mode would use no control patterns")
	}
}
