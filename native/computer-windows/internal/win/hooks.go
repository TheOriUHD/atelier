//go:build windows

package win

import (
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/control"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
)

// The control watch's low-level keyboard and mouse hooks: installed on their own OS thread with a message loop. The
// callbacks only read the event, hand it on and call the next hook; the helper's own events (tagged) are skipped.

type kbdLLHook struct {
	VK        uint32
	Scan      uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

type msLLHook struct {
	Pt        point
	MouseData uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

var (
	// hookSink is where the installed hooks hand their samples (one set of hooks at a time).
	hookSink atomic.Pointer[func(control.Sample)]
	// escHeld: the person's Esc is down (its next key-downs are autorepeats).
	escHeld atomic.Bool

	keyboardHookProc = windows.NewCallback(func(code, wparam, lparam uintptr) uintptr {
		if int32(code) == HC_ACTION {
			if sink := hookSink.Load(); sink != nil {
				ev := ptrAt[kbdLLHook](lparam)
				if ev.ExtraInfo != input.Tag {
					switch wparam {
					case WM_KEYDOWN, WM_SYSKEYDOWN:
						if ev.VK == keys.VK_ESCAPE {
							(*sink)(control.Sample{Kind: control.SampleEscDown, Autorepeat: escHeld.Swap(true)})
						} else if !keys.IsModifierVK(ev.VK) {
							(*sink)(control.Sample{Kind: control.SampleKeyDown})
						}
					case WM_KEYUP, WM_SYSKEYUP:
						if ev.VK == keys.VK_ESCAPE {
							escHeld.Store(false)
							(*sink)(control.Sample{Kind: control.SampleEscUp})
						}
					}
				}
			}
		}
		r, _, _ := procCallNextHookEx.Call(0, code, wparam, lparam)
		return r
	})

	mouseHookProc = windows.NewCallback(func(code, wparam, lparam uintptr) uintptr {
		if int32(code) == HC_ACTION {
			if sink := hookSink.Load(); sink != nil {
				ev := ptrAt[msLLHook](lparam)
				if ev.ExtraInfo != input.Tag {
					switch wparam {
					case WM_MOUSEMOVE:
						(*sink)(control.Sample{Kind: control.SampleMoved, At: proto.Point{X: float64(ev.Pt.X), Y: float64(ev.Pt.Y)}})
					case WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN, WM_XBUTTONDOWN:
						(*sink)(control.Sample{Kind: control.SampleMouseDown})
					}
				}
			}
		}
		r, _, _ := procCallNextHookEx.Call(0, code, wparam, lparam)
		return r
	})
)

// hooks is control.Hooks.
type hooks struct {
	mu     sync.Mutex
	thread uint32
	done   chan struct{}
}

func (h *hooks) Start(sink func(control.Sample)) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done != nil {
		return nil
	}
	ready := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		// The thread stays locked: it ends with the goroutine, and the hooks with it.
		runtime.LockOSThread()
		defer close(done)
		thread := windows.GetCurrentThreadId()
		var m msg
		procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, PM_NOREMOVE) // Makes the thread's message queue.
		module, _, _ := procGetModuleHandleW.Call(0)
		kb, _, kbErr := procSetWindowsHookExW.Call(WH_KEYBOARD_LL, keyboardHookProc, module, 0)
		ms, _, msErr := procSetWindowsHookExW.Call(WH_MOUSE_LL, mouseHookProc, module, 0)
		if kb == 0 || ms == 0 {
			if kb != 0 {
				procUnhookWindowsHookEx.Call(kb)
			}
			if ms != 0 {
				procUnhookWindowsHookEx.Call(ms)
			}
			err := kbErr
			if kb != 0 {
				err = msErr
			}
			ready <- errors.New("SetWindowsHookEx: " + err.Error())
			return
		}
		escHeld.Store(false)
		hookSink.Store(&sink)
		h.thread = thread
		ready <- nil
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 { // WM_QUIT, or an error
				break
			}
		}
		hookSink.Store(nil)
		procUnhookWindowsHookEx.Call(kb)
		procUnhookWindowsHookEx.Call(ms)
	}()
	select {
	case err := <-ready:
		if err != nil {
			return err
		}
		h.done = done
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("the keyboard and mouse hooks didn't start within 3 s")
	}
}

func (h *hooks) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done == nil {
		return
	}
	hookSink.Store(nil)
	procPostThreadMessageW.Call(uintptr(h.thread), WM_QUIT, 0, 0)
	select {
	case <-h.done:
	case <-time.After(2 * time.Second):
	}
	h.done = nil
}
