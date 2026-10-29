//go:build windows

package win

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/inspect"
	"atelier.dev/computer-windows/internal/rpc"
)

// UI Automation through COM, with the vtables called by hand. Every call can wait on a hung app, so each request runs on
// a worker (a goroutine locked to its own OS thread, COM initialized multithreaded) and gets a 1 s budget; a worker that
// overruns it is abandoned (it exits once its call returns) and the next request gets a new one.

// comObject is a COM interface pointer: its first word is the vtable.
type comObject struct{ vtbl *[128]uintptr }

// call calls a method by its vtable index. uintptrescapes, like LazyProc.Call: pointers converted to uintptr in the
// arguments (out parameters) stay valid through the call.
//
//go:uintptrescapes
func (o *comObject) call(index int, args ...uintptr) uintptr {
	all := append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)
	r, _, _ := syscall.SyscallN(o.vtbl[index], all...)
	return r
}

func (o *comObject) release() {
	if o != nil {
		o.call(2)
	}
}

func succeeded(hr uintptr) bool { return int32(hr) >= 0 }

var (
	clsidCUIAutomation8 = windows.GUID{Data1: 0xe22ad333, Data2: 0xb25f, Data3: 0x460c, Data4: [8]byte{0x83, 0xd0, 0x05, 0x81, 0x10, 0x73, 0x95, 0xc9}}
	clsidCUIAutomation  = windows.GUID{Data1: 0xff48dba4, Data2: 0x60ef, Data3: 0x4201, Data4: [8]byte{0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e}}
	iidIUIAutomation    = windows.GUID{Data1: 0x30cbe57d, Data2: 0xd9d0, Data3: 0x452a, Data4: [8]byte{0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee}}
	iidIUIAutomation2   = windows.GUID{Data1: 0x34723aff, Data2: 0x0c9d, Data3: 0x49d0, Data4: [8]byte{0x98, 0x96, 0x7a, 0xb5, 0x2d, 0xf8, 0xcd, 0x8a}}
)

// vtable indexes (UIAutomationClient.h; IUnknown is 0–2).
const (
	iuaElementFromPoint       = 7
	iuaGetFocusedElement      = 8
	iuaGetControlViewWalker   = 14
	iua2GetConnectionTimeout  = 60
	iua2PutConnectionTimeout  = 61
	iua2PutTransactionTimeout = 63

	elemGetCurrentPropertyValue = 10

	walkerGetParentElement = 3
)

// Property ids.
const (
	propProcessID          = 30002
	propControlType        = 30003
	propName               = 30005
	propIsPassword         = 30019
	propValueValue         = 30045
	propLegacyIAccessValue = 30093
)

const (
	vtI4   = 3
	vtBSTR = 8
	vtBool = 11
)

// variant is a VARIANT (24 bytes on 64-bit Windows).
type variant struct {
	VT   uint16
	_    [3]uint16
	Data [2]uint64
}

func (v *variant) clear() { procVariantClear.Call(uintptr(unsafe.Pointer(v))) }

func (v *variant) int() (int, bool) {
	if v.VT != vtI4 {
		return 0, false
	}
	return int(int32(uint32(v.Data[0]))), true
}

func (v *variant) bool() bool { return v.VT == vtBool && int16(uint16(v.Data[0])) != 0 }

func (v *variant) string() string {
	if v.VT != vtBSTR || v.Data[0] == 0 {
		return ""
	}
	bstr := *(**uint16)(unsafe.Pointer(&v.Data[0]))
	n, _, _ := procSysStringLen.Call(uintptr(unsafe.Pointer(bstr)))
	if n == 0 {
		return ""
	}
	if n > 4096 {
		n = 4096 // A title is at most 200 characters; a link's address isn't longer than this either.
	}
	return windows.UTF16ToString(unsafe.Slice(bstr, n))
}

func property(el *comObject, id int) variant {
	var v variant
	if !succeeded(el.call(elemGetCurrentPropertyValue, uintptr(id), uintptr(unsafe.Pointer(&v)))) {
		return variant{}
	}
	return v
}

func propInt(el *comObject, id int) int {
	v := property(el, id)
	defer v.clear()
	n, _ := v.int()
	return n
}

func propBool(el *comObject, id int) bool {
	v := property(el, id)
	defer v.clear()
	return v.bool()
}

func propString(el *comObject, id int) string {
	v := property(el, id)
	defer v.clear()
	return v.string()
}

// ---------------------------------------------------------------- the worker

type uiaKind int

const (
	uiaAtPoint uiaKind = iota
	uiaFocused
)

type uiaRequest struct {
	kind  uiaKind
	x, y  int32
	reply chan uiaReply
}

type uiaReply struct {
	el  *inspect.Element
	err error
}

type uiaWorker struct {
	requests  chan uiaRequest
	abandoned atomic.Bool
	// counted: it overran a budget and counts as stuck until it exits.
	counted atomic.Bool
}

var (
	uiaMu    sync.Mutex
	uiaIdle  *uiaWorker
	uiaStuck int
	debug    = os.Getenv("ATELIER_COMPUTER_DEBUG") == "1"
)

const (
	uiaBudget   = time.Second
	uiaMaxStuck = 4
)

var errUIATimeout = errors.New("UI Automation didn't answer within 1 s")

// uiaInspect asks UI Automation for the element at a point, or the focused one, within the budget.
func uiaInspect(kind uiaKind, x, y int32) (*inspect.Element, error) {
	w, err := takeWorker()
	if err != nil {
		return nil, err
	}
	req := uiaRequest{kind: kind, x: x, y: y, reply: make(chan uiaReply, 1)}
	w.requests <- req
	select {
	case r := <-req.reply:
		putWorker(w)
		return r.el, r.err
	case <-time.After(uiaBudget):
		uiaMu.Lock()
		uiaStuck++
		uiaMu.Unlock()
		w.counted.Store(true)
		w.abandoned.Store(true)
		close(w.requests) // It exits after the call in progress.
		return nil, errUIATimeout
	}
}

func takeWorker() (*uiaWorker, error) {
	uiaMu.Lock()
	if w := uiaIdle; w != nil {
		uiaIdle = nil
		uiaMu.Unlock()
		return w, nil
	}
	if uiaStuck >= uiaMaxStuck {
		uiaMu.Unlock()
		return nil, errors.New("UI Automation is stuck on unresponsive apps")
	}
	uiaMu.Unlock()
	w := &uiaWorker{requests: make(chan uiaRequest, 1)}
	ready := make(chan error, 1)
	go w.run(ready)
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
		return w, nil
	case <-time.After(3 * time.Second):
		w.abandoned.Store(true)
		close(w.requests)
		return nil, errors.New("UI Automation didn't start within 3 s")
	}
}

func putWorker(w *uiaWorker) {
	uiaMu.Lock()
	defer uiaMu.Unlock()
	if uiaIdle == nil {
		uiaIdle = w
		return
	}
	close(w.requests)
}

func (w *uiaWorker) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		if w.counted.Load() {
			uiaMu.Lock()
			uiaStuck--
			uiaMu.Unlock()
		}
	}()
	if err := windows.CoInitializeEx(0, windows.COINIT_MULTITHREADED); err == nil {
		defer windows.CoUninitialize()
	}
	automation, err := createAutomation()
	if err != nil {
		ready <- err
		return
	}
	defer automation.release()
	var walker *comObject
	if !succeeded(automation.call(iuaGetControlViewWalker, uintptr(unsafe.Pointer(&walker)))) {
		walker = nil
	}
	defer walker.release()
	ready <- nil
	for req := range w.requests {
		el, err := readRequest(automation, walker, req)
		req.reply <- uiaReply{el: el, err: err}
		if w.abandoned.Load() {
			return
		}
	}
}

func createAutomation() (*comObject, error) {
	var automation *comObject
	hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidCUIAutomation8)), 0, 1 /* CLSCTX_INPROC_SERVER */, uintptr(unsafe.Pointer(&iidIUIAutomation)), uintptr(unsafe.Pointer(&automation)))
	if !succeeded(hr) || automation == nil {
		hr, _, _ = procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidCUIAutomation)), 0, 1, uintptr(unsafe.Pointer(&iidIUIAutomation)), uintptr(unsafe.Pointer(&automation)))
		if !succeeded(hr) || automation == nil {
			return nil, windows.Errno(hr)
		}
		return automation, nil
	}
	// IUIAutomation2 (Windows 8+): UI Automation's own timeouts, so a hung app frees the thread sooner.
	var automation2 *comObject
	if succeeded(automation.call(0, uintptr(unsafe.Pointer(&iidIUIAutomation2)), uintptr(unsafe.Pointer(&automation2)))) && automation2 != nil {
		var connection uint32
		// A sanity check of the vtable index before writing through it: the default is a few seconds.
		if succeeded(automation2.call(iua2GetConnectionTimeout, uintptr(unsafe.Pointer(&connection)))) && connection > 0 && connection <= 600_000 {
			automation2.call(iua2PutConnectionTimeout, 1000)
			automation2.call(iua2PutTransactionTimeout, 1000)
			if debug {
				rpc.Logf("UI Automation: connection timeout was %d ms, now 1000", connection)
			}
		} else if debug {
			rpc.Logf("UI Automation: unexpected connection timeout %d, left as it is", connection)
		}
		automation2.release()
	}
	return automation, nil
}

func readRequest(automation, walker *comObject, req uiaRequest) (*inspect.Element, error) {
	var el *comObject
	var hr uintptr
	if req.kind == uiaAtPoint {
		hr = automation.call(iuaElementFromPoint, packPoint(req.x, req.y), uintptr(unsafe.Pointer(&el)))
	} else {
		hr = automation.call(iuaGetFocusedElement, uintptr(unsafe.Pointer(&el)))
	}
	if !succeeded(hr) || el == nil {
		return nil, windows.Errno(hr)
	}
	defer el.release()
	return readElement(el, walker), nil
}

// readElement reads what inspect.* reports: never a password field's value.
func readElement(el, walker *comObject) *inspect.Element {
	e := &inspect.Element{
		PID:         propInt(el, propProcessID),
		ControlType: propInt(el, propControlType),
		Name:        propString(el, propName),
		Password:    propBool(el, propIsPassword),
	}
	if !e.Password {
		e.Value = propString(el, propValueValue)
	}
	e.Link = linkOf(el, e.ControlType, walker)
	return e
}

// linkOf: when the element or one of its 3 nearest ancestors is a hyperlink, its address (its value, else the legacy
// accessible value; ” when it has none); nil when it isn't in a link.
func linkOf(el *comObject, controlType int, walker *comObject) *string {
	if controlType == inspect.Hyperlink {
		link := linkValue(el)
		return &link
	}
	if walker == nil {
		return nil
	}
	current := el
	for depth := 1; depth <= 3; depth++ {
		var parent *comObject
		if !succeeded(walker.call(walkerGetParentElement, uintptr(unsafe.Pointer(current)), uintptr(unsafe.Pointer(&parent)))) || parent == nil {
			break
		}
		if current != el {
			current.release()
		}
		current = parent
		if propInt(current, propControlType) == inspect.Hyperlink {
			link := linkValue(current)
			current.release()
			return &link
		}
	}
	if current != el {
		current.release()
	}
	return nil
}

func linkValue(el *comObject) string {
	if v := strings.TrimSpace(propString(el, propValueValue)); v != "" {
		return v
	}
	return strings.TrimSpace(propString(el, propLegacyIAccessValue))
}
