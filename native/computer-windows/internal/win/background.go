//go:build windows

package win

import (
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"math"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/bg"
	"atelier.dev/computer-windows/internal/helper"
	"atelier.dev/computer-windows/internal/imaging"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/inspect"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// Background mode: one app's window, worked in without the person's mouse and keyboard. The window is captured with
// PrintWindow (covered or not), clicks are UI Automation patterns or posted mouse messages, keys and typing are posted
// to its thread's focus. Nothing here calls SendInput, SetCursorPos, SetForegroundWindow or SetFocus.

var (
	procPostMessageW        = user32.NewProc("PostMessageW")
	procSendMessageTimeoutW = user32.NewProc("SendMessageTimeoutW")
	procScreenToClient      = user32.NewProc("ScreenToClient")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procIsWindowEnabled     = user32.NewProc("IsWindowEnabled")
	procIsHungAppWindow     = user32.NewProc("IsHungAppWindow")
	procPrintWindow         = user32.NewProc("PrintWindow")
	procSetWindowPos        = user32.NewProc("SetWindowPos")
	procGetClassLongPtrW    = user32.NewProc("GetClassLongPtrW")
	procEnumChildWindows    = user32.NewProc("EnumChildWindows")
	procGetParent           = user32.NewProc("GetParent")
	procGetDlgCtrlID        = user32.NewProc("GetDlgCtrlID")
)

const (
	GW_HWNDNEXT = 2
	GW_CHILD    = 5

	GWL_STYLE = -16
	GCL_STYLE = -26

	CS_DBLCLKS  = 0x0008
	WS_DISABLED = 0x08000000

	BS_TYPEMASK       = 0xF
	BS_PUSHBUTTON     = 0x0
	BS_DEFPUSHBUTTON  = 0x1
	BS_AUTOCHECKBOX   = 0x3
	BS_GROUPBOX       = 0x7
	BM_GETCHECK       = 0x00F0
	BM_SETCHECK       = 0x00F1
	BST_UNCHECKED     = 0
	BST_CHECKED       = 1
	BN_CLICKED        = 0
	WM_COMMAND        = 0x0111
	PW_RENDERFULLCONT = 0x2

	HWND_BOTTOM         = 1
	SWP_NOSIZE          = 0x0001
	SWP_NOMOVE          = 0x0002
	SWP_NOACTIVATE      = 0x0010
	SWP_NOOWNERZORDER   = 0x0200
	SWP_ASYNCWINDOWPOS  = 0x4000
	SMTO_ABORTIFHUNG    = 0x0002
	SMTO_ERRORONEXIT    = 0x0020
	ERROR_TIMEOUT       = 1460
	ERROR_QUOTA         = 1816 // ERROR_NOT_ENOUGH_QUOTA: the thread's message queue is full
	ERROR_INVALID_HWND  = 1400
	ERROR_ACCESS_DENIED = 5

	uiaTimeoutHR = 0x80131505 // UIA_E_TIMEOUT
)

// bgState is what Background mode remembers between calls.
type bgState struct {
	mu sync.Mutex
	// clicked: the child window a window's last posted click went to, where its typing goes when its thread tells no
	// focus (a background thread often has none).
	clicked map[uintptr]uintptr
	// selected: a select all in a window's text field, and what the field held then: typing that doesn't reach the field
	// may then set its value instead, since it would have replaced everything.
	selected *selection
}

type selection struct {
	window, target uintptr
	field          fieldState
}

func (b *bgState) rememberClick(window, target uintptr) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.clicked == nil {
		b.clicked = map[uintptr]uintptr{}
	}
	b.clicked[window] = target
	b.selected = nil
}

func (b *bgState) lastClick(window uintptr) uintptr {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.clicked[window]
}

func (b *bgState) setSelection(s *selection) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.selected = s
}

// takeSelection is the select all of that window's field, if it was the last thing done there; it is forgotten either
// way.
func (b *bgState) takeSelection(window, target uintptr) *selection {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.selected
	b.selected = nil
	if s == nil || s.window != window || s.target != target {
		return nil
	}
	return s
}

// ---------------------------------------------------------------- the window

// bgWindow is a window a bg.* call names, as it is now.
type bgWindow struct {
	id    string
	hwnd  uintptr
	class string
	// pid owns the window; appPID is the app it shows (a Store app's frame: its CoreWindow's process).
	pid    uint32
	appPID uint32
	frame  rect
}

func (w bgWindow) owns(pid uint32) bool { return pid != 0 && (pid == w.pid || pid == w.appPID) }

// resolveWindow is the top-level window an id from window.capture names; NotFound when there's none (anymore).
func (s *System) resolveWindow(id string) (bgWindow, error) {
	hwnd, ok := bg.ParseWindow(id)
	if !ok || !boolCall(procIsWindow, hwnd) {
		return bgWindow{}, rpc.NotFound("no window %s: it was closed (take a new window.capture)", id)
	}
	if root, _, _ := procGetAncestor.Call(hwnd, GA_ROOT); root != hwnd {
		return bgWindow{}, rpc.NotFound("no window %s: it isn't a top-level window", id)
	}
	w := bgWindow{id: id, hwnd: hwnd, class: className(hwnd), frame: frameRect(hwnd)}
	w.pid, _ = windowPID(hwnd)
	w.appPID = appPIDOf(hwnd, w.class, w.pid)
	return w, nil
}

// inside checks that a point is in the window as it is on screen now.
func (w bgWindow) inside(x, y int32) error {
	if boolCall(procIsIconic, w.hwnd) {
		return rpc.InvalidParams("window %s is minimized (window.capture restores it)", w.id)
	}
	if !w.frame.contains(x, y) {
		return rpc.InvalidParams("%d, %d is outside window %s (%d, %d, %d×%d)", x, y, w.id, w.frame.Left, w.frame.Top,
			w.frame.Right-w.frame.Left, w.frame.Bottom-w.frame.Top)
	}
	return nil
}

// name is what messages call the window's app.
func (s *System) name(w bgWindow) string {
	if app := s.appFor(w.appPID, newProcCache()); app != nil {
		return app.Name
	}
	if t := windowTitle(w.hwnd); t != "" {
		return t
	}
	return "the app"
}

func windowTitle(hwnd uintptr) string {
	// GetWindowText doesn't send WM_GETTEXT to another process's window: a hung app can't hold it up.
	var buf [512]uint16
	n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return strings.TrimSpace(windows.UTF16ToString(buf[:n]))
}

// inFront: the window, or one it owns (its dialog), is the foreground window.
func (w bgWindow) inFront() bool {
	fg := foregroundWindow()
	if fg == 0 {
		return false
	}
	if fg == w.hwnd {
		return true
	}
	owner, _, _ := procGetAncestor.Call(fg, GA_ROOTOWNER)
	return owner == w.hwnd
}

// content is the window that shows the app: a Store app's CoreWindow inside its frame, else the window itself.
func (w bgWindow) content() uintptr {
	if w.class == "ApplicationFrameWindow" {
		if core, _, _ := procFindWindowExW.Call(w.hwnd, 0, uintptr(unsafe.Pointer(coreWindowClass)), 0); core != 0 {
			return core
		}
	}
	return w.hwnd
}

// reachable: the app takes posted messages: it is responding, and doesn't run at a higher integrity level than this
// helper (Windows drops messages to an app run as administrator).
func (s *System) reachable(w bgWindow) error {
	if boolCall(procIsHungAppWindow, w.hwnd) {
		return rpc.Unsupported("%s isn't responding", s.name(w))
	}
	if aboveUs(w.pid) || (w.appPID != w.pid && aboveUs(w.appPID)) {
		return rpc.Unsupported("%s runs as administrator: Windows doesn't let Atelier send it clicks or keys", s.name(w))
	}
	return nil
}

// aboveUs: a process runs at a higher integrity level than this one (or its token can't even be read, as for an
// elevated process).
func aboveUs(pid uint32) bool {
	mine, ok := integrityLevel(windows.GetCurrentProcessToken())
	if !ok {
		return false
	}
	h, err := windows.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false // Not even limited information: a protected process; posting tells.
	}
	defer windows.CloseHandle(h)
	var token windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &token); err != nil {
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer token.Close()
	theirs, ok := integrityLevel(token)
	return ok && theirs > mine
}

func integrityLevel(token windows.Token) (uint32, bool) {
	var n uint32
	_ = windows.GetTokenInformation(token, windows.TokenIntegrityLevel, nil, 0, &n)
	if n == 0 || n > 1024 {
		return 0, false
	}
	buf := make([]byte, n)
	if windows.GetTokenInformation(token, windows.TokenIntegrityLevel, &buf[0], n, &n) != nil {
		return 0, false
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&buf[0]))
	sid := label.Label.Sid
	count := sid.SubAuthorityCount()
	if count == 0 {
		return 0, false
	}
	return sid.SubAuthority(uint32(count - 1)), true
}

// ---------------------------------------------------------------- window.capture

// WindowCapture is an app's window as it is, whatever covers it: PrintWindow, cropped to the window's visible frame.
func (s *System) WindowCapture(req helper.WindowCaptureRequest) (proto.WindowCaptureResult, error) {
	pc := newProcCache()
	var list []bg.Window
	for _, w := range topWindows() {
		if w.pid == s.self {
			continue
		}
		app := ""
		if info := pc.get(w.appPID); info.ok {
			app = strings.ToLower(info.id)
		}
		var rootOwner uintptr
		if w.owner != 0 {
			rootOwner, _, _ = procGetAncestor.Call(w.hwnd, GA_ROOTOWNER)
		}
		list = append(list, bg.Window{
			Hwnd: w.hwnd, App: app, AltTab: w.altTab(), Iconic: w.iconic, Enabled: boolCall(procIsWindowEnabled, w.hwnd),
			Empty:  w.rect.empty(),
			Dialog: w.owner != 0 && w.visible && !w.cloaked && w.exStyle&WS_EX_TOOLWINDOW == 0, RootOwner: rootOwner,
		})
	}
	choice, ok := bg.ChooseWindow(list, req.App)
	if !ok {
		return proto.WindowCaptureResult{}, rpc.NotFound("%s has no window on this desktop (it isn't running, or its windows are on another desktop)", req.App)
	}
	hwnd := choice.Window.Hwnd
	if choice.Restore {
		restoreQuietly(hwnd)
	}
	if boolCall(procIsHungAppWindow, hwnd) {
		return proto.WindowCaptureResult{}, rpc.Unsupported("%s isn't responding, so its window can't be drawn", req.App)
	}
	frame := frameRect(hwnd)
	if frame.empty() {
		return proto.WindowCaptureResult{}, rpc.NotFound("%s's window has no size", req.App)
	}
	img, at, err := printWindow(hwnd, frame)
	if err != nil {
		return proto.WindowCaptureResult{}, err
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	fw, fh := imaging.Fit(float64(w), float64(h), req.MaxWidth, req.MaxHeight)
	scaled := imaging.Downscale(img, fw, fh)
	data, err := imaging.Encode(scaled, req.Format, req.Quality)
	if err != nil {
		return proto.WindowCaptureResult{}, rpc.Internal("could not encode the window as %s: %v", req.Format, err)
	}
	var title *string
	if t := windowTitle(hwnd); t != "" {
		title = &t
	}
	return proto.WindowCaptureResult{
		CaptureResult: proto.CaptureResult{
			Data: base64.StdEncoding.EncodeToString(data), Mime: imaging.Mime(req.Format), Width: scaled.Rect.Dx(), Height: scaled.Rect.Dy(),
			Rect: proto.Rect{X: float64(at.X), Y: float64(at.Y), Width: float64(w), Height: float64(h)},
		},
		Window: bg.FormatWindow(hwnd),
		Title:  title,
	}, nil
}

// restoreQuietly restores a minimized window without activating it, under every other window (it is there to be
// captured and clicked in, not to cover what the person is doing), and waits for it to settle at its size.
func restoreQuietly(hwnd uintptr) {
	procShowWindowAsync.Call(hwnd, SW_SHOWNOACTIVATE)
	if exStyle(hwnd)&WS_EX_TOPMOST == 0 {
		// Async, after the restore in the window's own queue: a hung app can't hold this up.
		procSetWindowPos.Call(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER|SWP_ASYNCWINDOWPOS)
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	var last rect
	stable := 0
	for time.Now().Before(deadline) && stable < 2 {
		time.Sleep(50 * time.Millisecond)
		if boolCall(procIsIconic, hwnd) {
			continue
		}
		if r := frameRect(hwnd); r == last {
			stable++
		} else {
			last, stable = r, 0
		}
	}
}

// printWindow draws a window with PrintWindow (PW_RENDERFULLCONTENT: DirectComposition and GPU content too, and
// covered parts as they are) and returns the part inside its visible frame, and where that part's top-left is on
// screen. At most 5 s: a window that doesn't draw by then is left to its goroutine, which frees what it made when
// PrintWindow returns.
func printWindow(hwnd uintptr, frame rect) (*image.RGBA, point, error) {
	var wr rect
	if !boolCall(procGetWindowRect, hwnd, uintptr(unsafe.Pointer(&wr))) || wr.empty() {
		return nil, point{}, rpc.NotFound("the window was closed")
	}
	w, h := int(wr.Right-wr.Left), int(wr.Bottom-wr.Top)
	if w > 16384 || h > 16384 {
		return nil, point{}, rpc.Unsupported("the window is %d×%d pixels, too big to capture", w, h)
	}
	// The frame, in the window rectangle's own pixels (the rest is the invisible resize border and the shadow).
	cx0, cy0 := max(int(frame.Left-wr.Left), 0), max(int(frame.Top-wr.Top), 0)
	cx1, cy1 := min(int(frame.Right-wr.Left), w), min(int(frame.Bottom-wr.Top), h)
	if cx1 <= cx0 || cy1 <= cy0 {
		cx0, cy0, cx1, cy1 = 0, 0, w, h
	}
	at := point{X: wr.Left + int32(cx0), Y: wr.Top + int32(cy0)}
	type result struct {
		img *image.RGBA
		err error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		mem, _, _ := procCreateCompatibleDC.Call(0)
		if mem == 0 {
			done <- result{err: rpc.Internal("window capture failed: no memory device context")}
			return
		}
		defer procDeleteDC.Call(mem)
		info := bitmapInfo{Header: bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32, Compression: BI_RGB}}
		info.Header.Size = uint32(unsafe.Sizeof(info.Header))
		var bits *byte
		bitmap, _, _ := procCreateDIBSection.Call(mem, uintptr(unsafe.Pointer(&info)), DIB_RGB_COLORS, uintptr(unsafe.Pointer(&bits)), 0, 0)
		if bitmap == 0 || bits == nil {
			done <- result{err: rpc.Internal("window capture failed: could not make a %dx%d bitmap", w, h)}
			return
		}
		defer procDeleteObject.Call(bitmap)
		old, _, _ := procSelectObject.Call(mem, bitmap)
		defer procSelectObject.Call(mem, old)
		if !boolCall(procPrintWindow, hwnd, mem, PW_RENDERFULLCONT) && !boolCall(procPrintWindow, hwnd, mem, 0) {
			done <- result{err: rpc.Unsupported("the window couldn't be drawn (PrintWindow failed)")}
			return
		}
		procGdiFlush.Call()
		pixels := unsafe.Slice(bits, w*h*4)
		stride := w * 4
		done <- result{img: imaging.FromBGRA(pixels[cy0*stride+cx0*4:], cx1-cx0, cy1-cy0, stride)}
	}()
	select {
	case r := <-done:
		return r.img, at, r.err
	case <-time.After(5 * time.Second):
		return nil, point{}, rpc.Unsupported("the window didn't draw within 5 s (its app may not be responding)")
	}
}

// ---------------------------------------------------------------- bg.inspect, bg.focused

// BgInspect is what is at a point of the window, whatever covers it there.
func (s *System) BgInspect(id string, x, y float64) (proto.InspectResult, error) {
	w, err := s.resolveWindow(id)
	if err != nil {
		return proto.InspectResult{}, err
	}
	px, py := int32(math.Round(x)), int32(math.Round(y))
	if err := w.inside(px, py); err != nil {
		return proto.InspectResult{}, err
	}
	pc := newProcCache()
	v, err := uiaRun(uiaBudget, func(u *uiaSession) (any, error) {
		el, err := u.elementInWindow(w, px, py, time.Now().Add(700*time.Millisecond))
		if err != nil {
			return nil, err
		}
		defer el.release()
		return readElement(el, u.walker), nil
	})
	el, _ := v.(*inspect.Element)
	if err != nil || el == nil || el.PID == 0 {
		return inspect.Describe(nil, s.appFor(w.appPID, pc)), nil
	}
	return inspect.Describe(el, s.appFor(uint32(el.PID), pc)), nil
}

// BgFocused is the element of the window's app that takes typing, whether or not the app is in front.
func (s *System) BgFocused(id string) (proto.InspectResult, error) {
	w, err := s.resolveWindow(id)
	if err != nil {
		return proto.InspectResult{}, err
	}
	target := s.focusTarget(w)
	front := w.inFront()
	pc := newProcCache()
	v, err := uiaRun(uiaBudget, func(u *uiaSession) (any, error) {
		el, err := u.focusIn(w, target, front)
		if err != nil {
			return nil, err
		}
		defer el.release()
		return readElement(el, u.walker), nil
	})
	el, _ := v.(*inspect.Element)
	if err != nil || el == nil || el.PID == 0 {
		return inspect.Describe(nil, s.appFor(w.appPID, pc)), nil
	}
	return inspect.Describe(el, s.appFor(uint32(el.PID), pc)), nil
}

// inputThread is the thread that takes the window's input: a Store app's CoreWindow's, else the window's.
func (w bgWindow) inputThread() uint32 {
	_, thread := windowPID(w.content())
	return thread
}

// focusTarget is the window keys and typing are posted to: its input thread's focus window (GetGUIThreadInfo); else,
// since a thread in the background often has none, the child window its last background click went to; else the
// window (a Store app's CoreWindow).
func (s *System) focusTarget(w bgWindow) uintptr {
	var gui windows.GUIThreadInfo
	gui.Size = uint32(unsafe.Sizeof(gui))
	if thread := w.inputThread(); thread != 0 && windows.GetGUIThreadInfo(thread, &gui) == nil && gui.Focus != 0 {
		return uintptr(gui.Focus)
	}
	if c := s.bg.lastClick(w.hwnd); c != 0 && boolCall(procIsWindow, c) {
		if root, _, _ := procGetAncestor.Call(c, GA_ROOT); root == w.hwnd {
			return c
		}
	}
	return w.content()
}

// ---------------------------------------------------------------- posting

var (
	errNotResponding = errors.New("not responding")
	errElevated      = errors.New("elevated")
	errGone          = errors.New("gone")
)

func postMessage(hwnd uintptr, m bg.Message) error {
	for attempt := 0; ; attempt++ {
		r, _, err := procPostMessageW.Call(hwnd, uintptr(m.Msg), m.WParam, m.LParam)
		if r != 0 {
			return nil
		}
		switch {
		case errors.Is(err, windows.Errno(ERROR_QUOTA)) && attempt < 40:
			time.Sleep(25 * time.Millisecond) // The queue is full: the app is busy with what came before.
			continue
		case errors.Is(err, windows.Errno(ERROR_ACCESS_DENIED)):
			return errElevated
		case errors.Is(err, windows.Errno(ERROR_INVALID_HWND)):
			return errGone
		}
		return fmt.Errorf("PostMessage: %v", err)
	}
}

// sendMessage sends a message and waits for the answer, at most a second (none from a hung app).
func sendMessage(hwnd uintptr, msg uint32, wparam, lparam uintptr) (uintptr, error) {
	var result uintptr
	r, _, err := procSendMessageTimeoutW.Call(hwnd, uintptr(msg), wparam, lparam, SMTO_ABORTIFHUNG|SMTO_ERRORONEXIT, 1000, uintptr(unsafe.Pointer(&result)))
	if r != 0 {
		return result, nil
	}
	switch {
	case errors.Is(err, windows.Errno(ERROR_ACCESS_DENIED)):
		return 0, errElevated
	case errors.Is(err, windows.Errno(ERROR_INVALID_HWND)):
		return 0, errGone
	}
	return 0, errNotResponding
}

// settle waits until the window's thread has taken n messages posted to it: a thread takes sent messages before each
// posted one it retrieves, so each WM_NULL that comes back means one more went through. It keeps the order between a
// call's posted messages and the next call's (sent messages, UI Automation), and paces long typing.
func settle(hwnd uintptr, n int) error {
	for i := 0; i <= n; i++ {
		if _, err := sendMessage(hwnd, bg.WM_NULL, 0, 0); err != nil {
			return err
		}
	}
	return nil
}

// post posts messages to a window in order, in chunks of 50 after each of which it settles; ready is checked before
// each chunk (an Esc stop ends a long one).
func (s *System) post(ready func() error, w bgWindow, target uintptr, messages []bg.Message, pause time.Duration) error {
	const chunk = 50
	for start := 0; start < len(messages); start += chunk {
		if err := ready(); err != nil {
			return err
		}
		end := min(start+chunk, len(messages))
		for i, m := range messages[start:end] {
			if i > 0 && pause > 0 {
				time.Sleep(pause)
			}
			if err := postMessage(target, m); err != nil {
				return s.deliveryError(w, err)
			}
		}
		if err := settle(target, end-start); err != nil {
			return s.deliveryError(w, err)
		}
	}
	return nil
}

func (s *System) deliveryError(w bgWindow, err error) error {
	switch {
	case errors.Is(err, errElevated):
		return rpc.Unsupported("%s runs as administrator: Windows doesn't let Atelier send it clicks or keys", s.name(w))
	case errors.Is(err, errGone):
		return rpc.NotFound("no window %s: it was closed (take a new window.capture)", w.id)
	case errors.Is(err, errNotResponding):
		return rpc.Unsupported("%s didn't take the input within a second: it isn't responding", s.name(w))
	}
	return rpc.Internal("could not send to %s: %v", s.name(w), err)
}

// ---------------------------------------------------------------- bg.click

// BgClick clicks at a point of the window without the mouse. A plain left click on a classic push button or checkbox
// is the notification the button would send; on a button, link, menu item, checkbox, tab, list item or radio button
// UI Automation knows, its pattern (Invoke, Toggle, Select); anything else is mouse messages posted to the child window
// at the point, in its client coordinates.
func (s *System) BgClick(ready func() error, req helper.BgClickRequest) error {
	w, err := s.resolveWindow(req.Window)
	if err != nil {
		return err
	}
	px, py := int32(math.Round(req.At.X)), int32(math.Round(req.At.Y))
	if err := w.inside(px, py); err != nil {
		return err
	}
	if err := s.reachable(w); err != nil {
		return err
	}
	target := mouseTarget(w, px, py)
	plain := req.Button == input.Left && req.Count == 1 && len(req.Modifiers) == 0
	if plain {
		if done, err := s.buttonClick(ready, w, target); done || err != nil {
			return err
		}
		if done, err := s.uiaClick(ready, w, px, py); done || err != nil {
			return err
		}
	}
	class := className(target)
	if class == bg.CoreWindow {
		return rpc.Unsupported("%s (a Store app) takes clicks in the background only on buttons, links, checkboxes, tabs and list items; what is at %d, %d isn't one", s.name(w), px, py)
	}
	// The frame (title bar, menu bar, scroll bars, caption buttons) follows the real mouse once pressed: only the
	// window's content takes a posted click. A transparent child (a label) leaves the point to its parent.
	for i := 0; i < 8; i++ {
		code, err := sendMessage(target, bg.WM_NCHITTEST, 0, bg.MakeLParam(int(px), int(py)))
		if err != nil {
			return s.deliveryError(w, err)
		}
		hit := int(int32(code))
		if hit == bg.HTTRANSPARENT && target != w.hwnd {
			if parent, _, _ := procGetParent.Call(target); parent != 0 {
				target = parent
				continue
			}
		}
		if part := bg.FramePart(hit); part != "" {
			return rpc.Unsupported("%d, %d is on %s's %s: in the background, clicks only reach what is inside a window", px, py, s.name(w), part)
		}
		break
	}
	p := point{X: px, Y: py}
	procScreenToClient.Call(target, uintptr(unsafe.Pointer(&p)))
	messages := bg.ClickMessages(req.Button, req.Count, req.MK, int(p.X), int(p.Y), classStyle(target)&CS_DBLCLKS != 0)
	if err := s.post(ready, w, target, messages, 15*time.Millisecond); err != nil {
		return err
	}
	s.bg.rememberClick(w.hwnd, target)
	return nil
}

// classStyle is a window's class style (CS_*).
func classStyle(hwnd uintptr) uint32 {
	index := int32(GCL_STYLE)
	r, _, _ := procGetClassLongPtrW.Call(hwnd, uintptr(index))
	return uint32(r)
}

// mouseTarget is the child window a click at a point goes to (as the mouse's hit test finds it, through disabled and
// transparent children and group boxes); for Chromium and Electron, the web content's Chrome_RenderWidgetHostHWND when
// the point is in it.
func mouseTarget(w bgWindow, x, y int32) uintptr {
	target := w.hwnd
	for depth := 0; depth < 32; depth++ {
		children := childWindows(target)
		i := bg.PickChild(children, float64(x), float64(y))
		if i < 0 {
			break
		}
		target = children[i].Hwnd
	}
	if bg.IsChromium(w.class) && className(target) != bg.ChromiumContent {
		var found uintptr
		enumChildren(w.hwnd, func(child uintptr) bool {
			if className(child) != bg.ChromiumContent || !boolCall(procIsWindowVisible, child) {
				return true
			}
			var r rect
			if boolCall(procGetWindowRect, child, uintptr(unsafe.Pointer(&r))) && r.contains(x, y) {
				found = child
				return false
			}
			return true
		})
		if found != 0 {
			target = found
		}
	}
	return target
}

// childWindows are a window's direct children in z-order, the topmost first (at most 500).
func childWindows(parent uintptr) []bg.Child {
	var out []bg.Child
	child, _, _ := procGetWindow.Call(parent, GW_CHILD)
	for child != 0 && len(out) < 500 {
		c := bg.Child{Hwnd: child, Visible: boolCall(procIsWindowVisible, child), Enabled: boolCall(procIsWindowEnabled, child)}
		c.Transparent = exStyle(child)&WS_EX_TRANSPARENT != 0
		c.GroupBox = strings.EqualFold(className(child), "Button") && windowLong(child, GWL_STYLE)&BS_TYPEMASK == BS_GROUPBOX
		var r rect
		if boolCall(procGetWindowRect, child, uintptr(unsafe.Pointer(&r))) {
			c.Rect = bg.Rect{Left: float64(r.Left), Top: float64(r.Top), Right: float64(r.Right), Bottom: float64(r.Bottom)}
		}
		out = append(out, c)
		child, _, _ = procGetWindow.Call(child, GW_HWNDNEXT)
	}
	return out
}

// enumChildren calls f for every descendant of a window until it returns false.
func enumChildren(parent uintptr, f func(hwnd uintptr) bool) {
	key := registerCallback(f)
	defer unregisterCallback(key)
	procEnumChildWindows.Call(parent, enumWindowsCallback, key)
}

// buttonClick: a plain left click on a classic push button or two-state checkbox is what the button itself does on a
// click: an auto checkbox flips its check, then the button tells its parent BN_CLICKED. That works in a window that
// isn't active, where the button's own mouse handling may not (it sets the focus, which activates the dialog and can
// take the press back).
func (s *System) buttonClick(ready func() error, w bgWindow, target uintptr) (bool, error) {
	if target == w.hwnd || !strings.EqualFold(className(target), "Button") || !boolCall(procIsWindowEnabled, target) {
		return false, nil
	}
	kind := windowLong(target, GWL_STYLE) & BS_TYPEMASK
	if kind != BS_PUSHBUTTON && kind != BS_DEFPUSHBUTTON && kind != BS_AUTOCHECKBOX {
		return false, nil
	}
	parent, _, _ := procGetParent.Call(target)
	id, _, _ := procGetDlgCtrlID.Call(target)
	if parent == 0 {
		return false, nil
	}
	if err := ready(); err != nil {
		return false, err
	}
	type addressed struct {
		to uintptr
		m  bg.Message
	}
	var messages []addressed
	if kind == BS_AUTOCHECKBOX {
		state, err := sendMessage(target, BM_GETCHECK, 0, 0)
		if err != nil {
			return false, s.deliveryError(w, err)
		}
		next := uintptr(BST_CHECKED)
		if state == BST_CHECKED {
			next = BST_UNCHECKED
		}
		messages = append(messages, addressed{target, bg.Message{Msg: BM_SETCHECK, WParam: next}})
	}
	notify := uintptr(uint32(id)&0xFFFF | BN_CLICKED<<16)
	messages = append(messages, addressed{parent, bg.Message{Msg: WM_COMMAND, WParam: notify, LParam: target}})
	for _, m := range messages {
		if err := postMessage(m.to, m.m); err != nil {
			return false, s.deliveryError(w, err)
		}
	}
	if err := settle(parent, len(messages)); err != nil {
		return true, s.deliveryError(w, err)
	}
	s.bg.rememberClick(w.hwnd, target)
	return true, nil
}

// uiaClick does a plain left click by the control pattern it amounts to (bg.ClickPatterns) on the element at the
// point, or the button or link around the text or image there. done false: there is none, or calling it failed, and
// the click goes as mouse messages. A pattern call that overruns the budget counts as done (it was made: its app is
// busy with what it started); one not started by then never is.
func (s *System) uiaClick(ready func() error, w bgWindow, x, y int32) (bool, error) {
	if err := ready(); err != nil {
		return false, err
	}
	const (
		pending = iota
		calling
		abandoned
	)
	var state syncState
	v, err := uiaRun(2*time.Second, func(u *uiaSession) (any, error) {
		if !u.patterns {
			return false, nil
		}
		el, err := u.elementInWindow(w, x, y, time.Now().Add(700*time.Millisecond))
		if err != nil {
			return false, nil
		}
		defer el.release()
		p, which := u.clickPattern(el)
		if p == nil {
			return false, nil
		}
		defer p.release()
		if !state.swap(pending, calling) {
			return false, nil
		}
		hr := p.call(3) // Invoke, Toggle and Select are each the first method after IUnknown's.
		if debug {
			rpc.Logf("background click: %s → %#x", which, uint32(hr))
		}
		return succeeded(hr) || uint32(hr) == uiaTimeoutHR, nil
	})
	if errors.Is(err, errUIATimeout) {
		return !state.swap(pending, abandoned), nil
	}
	done, _ := v.(bool)
	if done {
		s.bg.setSelection(nil)
	}
	return done, nil
}

// syncState is a small state machine shared with a UI Automation job that may outlive its caller.
type syncState struct {
	mu    sync.Mutex
	value int
}

func (s *syncState) swap(from, to int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.value != from {
		return false
	}
	s.value = to
	return true
}

// ---------------------------------------------------------------- bg.scroll

// BgScroll scrolls at a point of the window: WM_MOUSEWHEEL and WM_MOUSEHWHEEL posted to the child window there (the
// point in screen coordinates, as Windows sends it).
func (s *System) BgScroll(ready func() error, id string, at proto.Point, dx, dy float64) error {
	w, err := s.resolveWindow(id)
	if err != nil {
		return err
	}
	px, py := int32(math.Round(at.X)), int32(math.Round(at.Y))
	if err := w.inside(px, py); err != nil {
		return err
	}
	if err := s.reachable(w); err != nil {
		return err
	}
	target := mouseTarget(w, px, py)
	if className(target) == bg.CoreWindow {
		return rpc.Unsupported("%s (a Store app) doesn't take scrolling in the background", s.name(w))
	}
	return s.post(ready, w, target, bg.WheelMessages(dx, dy, 0, int(px), int(py)), 10*time.Millisecond)
}

// ---------------------------------------------------------------- bg.key

func layoutOf(thread uint32) uintptr {
	hkl, _, _ := procGetKeyboardLayout.Call(uintptr(thread))
	if hkl == 0 {
		hkl, _, _ = procGetKeyboardLayout.Call(0)
	}
	return hkl
}

func scanCodes(hkl uintptr) func(vk uint16) uint16 {
	return func(vk uint16) uint16 {
		r, _, _ := procMapVirtualKeyExW.Call(uintptr(vk), 0 /* MAPVK_VK_TO_VSC */, hkl)
		return uint16(r)
	}
}

// BgKey presses keys in the window: posted to its focus, on its own keyboard layout. Shortcuts with modifiers mostly
// can't be (bg.PlanKeys); select all, copy, cut, paste and undo are their own messages in a text field, select all
// UI Automation's text selection elsewhere.
func (s *System) BgKey(ready func() error, id string, names []string, repeat int) error {
	w, err := s.resolveWindow(id)
	if err != nil {
		return err
	}
	if err := s.reachable(w); err != nil {
		return err
	}
	target := s.focusTarget(w)
	_, thread := windowPID(target)
	hkl := layoutOf(thread)
	plan, err := bg.PlanKeys(names, layout{hkl: hkl}, scanCodes(hkl), repeat)
	if err != nil {
		return err
	}
	edit := bg.EditClass(className(target))
	switch plan.Action {
	case bg.KeyPost:
		s.bg.setSelection(nil)
		return s.post(ready, w, target, plan.Messages, 10*time.Millisecond)
	case bg.KeySelectAll:
		return s.selectAll(ready, w, target, edit)
	}
	if !edit {
		return rpc.Unsupported("%s (%s) can't be pressed in %s in the background: it works only in a classic text field, and the keyboard focus there isn't one", plan.Label, plan.Action, s.name(w))
	}
	s.bg.setSelection(nil)
	var m uint32
	switch plan.Action {
	case bg.KeyCopy:
		m = bg.WM_COPY
	case bg.KeyCut:
		m = bg.WM_CUT
	case bg.KeyPaste:
		m = bg.WM_PASTE
	case bg.KeyUndo:
		m = bg.EM_UNDO
	}
	messages := make([]bg.Message, plan.Times)
	for i := range messages {
		messages[i] = bg.Message{Msg: m}
	}
	return s.post(ready, w, target, messages, 10*time.Millisecond)
}

// selectAll selects everything in the focused text field: EM_SETSEL in a classic one, else the focused element's UI
// Automation text, and remembers what the field held, for bg.type.
func (s *System) selectAll(ready func() error, w bgWindow, target uintptr, edit bool) error {
	front := w.inFront()
	if edit {
		if err := s.post(ready, w, target, []bg.Message{{Msg: bg.EM_SETSEL, WParam: 0, LParam: ^uintptr(0)}}, 0); err != nil {
			return err
		}
	} else {
		if err := ready(); err != nil {
			return err
		}
		v, err := uiaRun(uiaBudget, func(u *uiaSession) (any, error) {
			el, err := u.focusIn(w, target, front)
			if err != nil {
				return false, nil
			}
			defer el.release()
			return u.selectAllText(el), nil
		})
		if ok, _ := v.(bool); err != nil || !ok {
			return rpc.Unsupported("select all can't be done in %s in the background: the keyboard focus there isn't a text field it can select in", s.name(w))
		}
	}
	field, _ := s.readField(w, target, front)
	s.bg.setSelection(&selection{window: w.hwnd, target: target, field: field})
	return nil
}

// ---------------------------------------------------------------- bg.type

// BgType types text into the window's focus: WM_CHAR per UTF-16 unit (line breaks and tabs as Return and Tab). When
// the focused element is a text field UI Automation reads, typing is checked: if the field didn't change, its value is
// set instead when that is the same thing (it was empty, or everything in it was just selected), else -32032.
func (s *System) BgType(ready func() error, id string, text string) error {
	w, err := s.resolveWindow(id)
	if err != nil {
		return err
	}
	if err := s.reachable(w); err != nil {
		return err
	}
	target := s.focusTarget(w)
	front := w.inFront()
	before, _ := s.readField(w, target, front)
	selected := s.bg.takeSelection(w.hwnd, target)
	_, thread := windowPID(target)
	var messages []bg.Message
	for _, piece := range bg.TypeMessages(text, scanCodes(layoutOf(thread))) {
		messages = append(messages, piece...)
	}
	if err := s.post(ready, w, target, messages, 0); err != nil {
		return err
	}
	if !before.known {
		return nil // Not a field UI Automation reads (or a password field): what was posted is all there is to do.
	}
	// The characters went through the app's queue (post settles); the field's value follows, Chromium's a little later.
	for wait := 0; wait < 12; wait++ {
		if after, ok := s.readField(w, target, front); !ok || after.changedFrom(before) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	name := s.name(w)
	switch {
	case !before.writable:
		return rpc.Unsupported("typing didn't reach the text field in %s in the background", name)
	case bg.HasKeyPresses(text):
		return rpc.Unsupported("typing didn't reach the text field in %s in the background (its value could be set instead, but not with line breaks or tabs)", name)
	case !before.empty && (selected == nil || selected.field.changedFrom(before)):
		return rpc.Unsupported("typing didn't reach the text field in %s in the background; setting its value instead would replace what it holds (select all first to replace it)", name)
	}
	if err := ready(); err != nil {
		return err
	}
	if !s.setField(w, target, front, text) {
		return rpc.Unsupported("typing didn't reach the text field in %s in the background, and setting its value didn't either", name)
	}
	return nil
}

// fieldState is what bg.type checks of the focused text field: its value's length and hash (never a password
// field's), whether it can be set, whether it is empty. known false: not a text field UI Automation reads.
type fieldState struct {
	known    bool
	writable bool
	empty    bool
	length   int
	hash     uint64
}

func (f fieldState) changedFrom(g fieldState) bool {
	return f.known != g.known || f.length != g.length || f.hash != g.hash
}

func (s *System) readField(w bgWindow, target uintptr, front bool) (fieldState, bool) {
	v, err := uiaRun(uiaBudget, func(u *uiaSession) (any, error) {
		el, err := u.focusIn(w, target, front)
		if err != nil {
			return fieldState{}, nil
		}
		defer el.release()
		return u.field(el, target), nil
	})
	f, ok := v.(fieldState)
	return f, err == nil && ok
}

func (s *System) setField(w bgWindow, target uintptr, front bool, text string) bool {
	v, err := uiaRun(uiaBudget, func(u *uiaSession) (any, error) {
		el, err := u.focusIn(w, target, front)
		if err != nil {
			return false, nil
		}
		defer el.release()
		if !u.patterns || !u.field(el, target).known {
			return false, nil
		}
		return u.setValue(el, text), nil
	})
	ok, _ := v.(bool)
	if err != nil || !ok {
		return false
	}
	after, _ := s.readField(w, target, front)
	return after.known && after.length == len(utf16.Encode([]rune(text)))
}
