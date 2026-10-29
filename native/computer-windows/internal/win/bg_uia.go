//go:build windows

package win

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/bg"
	"atelier.dev/computer-windows/internal/inspect"
)

// UI Automation for Background mode: the element at a point of one window whatever covers it, the element that takes
// that window's typing, and the control patterns a click or typing can be done by. Every function here runs on a UI
// Automation worker (uiaRun), within its budget.

var (
	iidInvokePattern        = windows.GUID{Data1: 0xfb377fbe, Data2: 0x8ea6, Data3: 0x46d5, Data4: [8]byte{0x9c, 0x73, 0x64, 0x99, 0x64, 0x2d, 0x30, 0x59}}
	iidTogglePattern        = windows.GUID{Data1: 0x94cf8058, Data2: 0x9b8d, Data3: 0x4ab9, Data4: [8]byte{0x8b, 0xfd, 0x4c, 0xd0, 0xa3, 0x3c, 0x8c, 0x70}}
	iidSelectionItemPattern = windows.GUID{Data1: 0xa8efa66a, Data2: 0x0fda, Data3: 0x421a, Data4: [8]byte{0x91, 0x94, 0x38, 0x02, 0x1f, 0x35, 0x78, 0xea}}
	iidValuePattern         = windows.GUID{Data1: 0xa94cd8b1, Data2: 0x0844, Data3: 0x4cd6, Data4: [8]byte{0x9d, 0x2d, 0x64, 0x05, 0x37, 0xab, 0x39, 0xe9}}
	iidTextPattern          = windows.GUID{Data1: 0x32eba289, Data2: 0x3583, Data3: 0x42c9, Data4: [8]byte{0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a}}
)

// Pattern ids and the vtable slots used (UIAutomationClient.h; checked against UIAutomationCore.dll's type library).
const (
	patternInvoke        = 10000
	patternValue         = 10002
	patternSelectionItem = 10010
	patternText          = 10014
	patternToggle        = 10015

	valueSetValue        = 3
	textGetDocumentRange = 7
	rangeSelect          = 16
)

var (
	procSysAllocStringLen = oleaut32.NewProc("SysAllocStringLen")
	procSysFreeString     = oleaut32.NewProc("SysFreeString")
)

// patternAs is an element's control pattern as its interface (nil when it doesn't support it).
func patternAs(el *comObject, id int, iid *windows.GUID) *comObject {
	var p *comObject
	if !succeeded(el.call(elemGetCurrentPatternAs, uintptr(id), uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))) {
		return nil
	}
	return p
}

// fromHandle is a window's element.
func (u *uiaSession) fromHandle(hwnd uintptr) (*comObject, error) {
	var el *comObject
	hr := u.automation.call(iuaElementFromHandle, hwnd, uintptr(unsafe.Pointer(&el)))
	if !succeeded(hr) || el == nil {
		return nil, windows.Errno(hr)
	}
	return el, nil
}

func (u *uiaSession) parent(el *comObject) *comObject {
	if u.walker == nil {
		return nil
	}
	var p *comObject
	if !succeeded(u.walker.call(walkerGetParentElement, uintptr(unsafe.Pointer(el)), uintptr(unsafe.Pointer(&p)))) {
		return nil
	}
	return p
}

// uiaTree is bg.Tree over the control view.
type uiaTree struct{ walker *comObject }

func (t uiaTree) FirstChild(n *comObject) (*comObject, bool) {
	var c *comObject
	ok := succeeded(t.walker.call(walkerGetFirstChildElement, uintptr(unsafe.Pointer(n)), uintptr(unsafe.Pointer(&c))))
	return c, ok && c != nil
}

func (t uiaTree) NextSibling(n *comObject) (*comObject, bool) {
	var c *comObject
	ok := succeeded(t.walker.call(walkerGetNextSiblingElement, uintptr(unsafe.Pointer(n)), uintptr(unsafe.Pointer(&c))))
	return c, ok && c != nil
}

func (t uiaTree) Bounds(n *comObject) (bg.Rect, bool) {
	v := property(n, propBoundingRectangle)
	defer v.clear()
	return v.rect()
}

func (t uiaTree) Release(n *comObject) { n.release() }

// safeArray is a SAFEARRAY of one dimension (OAIdl.h).
type safeArray struct {
	Dims       uint16
	Features   uint16
	ElemSize   uint32
	Locks      uint32
	Data       uintptr
	Elements   uint32
	LowerBound int32
}

// rect reads a BoundingRectangle: an array of four doubles, left, top, width, height.
func (v *variant) rect() (bg.Rect, bool) {
	if v.VT != vtArray|vtR8 || v.Data[0] == 0 {
		return bg.Rect{}, false
	}
	sa := ptrAt[safeArray](uintptr(v.Data[0]))
	if sa.Dims != 1 || sa.ElemSize != 8 || sa.Elements < 4 || sa.Data == 0 {
		return bg.Rect{}, false
	}
	d := unsafe.Slice(ptrAt[float64](sa.Data), 4)
	if d[2] <= 0 || d[3] <= 0 {
		return bg.Rect{}, false
	}
	return bg.Rect{Left: d[0], Top: d[1], Right: d[0] + d[2], Bottom: d[1] + d[3]}, true
}

// digest is a string value's length in UTF-16 units and its FNV-1a hash, read in full (not a password field's: the
// caller never reads one); ok false when it isn't a string (the property isn't supported).
func (v *variant) digest() (length int, hash uint64, ok bool) {
	if v.VT != vtBSTR {
		return 0, 0, false
	}
	hash = 14695981039346656037
	if v.Data[0] == 0 {
		return 0, hash, true
	}
	bstr := *(**uint16)(unsafe.Pointer(&v.Data[0]))
	n, _, _ := procSysStringLen.Call(uintptr(unsafe.Pointer(bstr)))
	for _, u := range unsafe.Slice(bstr, n) {
		hash ^= uint64(u)
		hash *= 1099511628211
	}
	return int(n), hash, true
}

// elementInWindow is the element at x, y of a window, whatever covers it: where the window is what is on screen there,
// UI Automation's own hit test; else a walk down from the window's element (bg.Descend, until deadline). The caller
// releases it.
func (u *uiaSession) elementInWindow(w bgWindow, x, y int32, deadline time.Time) (*comObject, error) {
	if hit, _, _ := procWindowFromPoint.Call(packPoint(x, y)); hit != 0 {
		if root, _, _ := procGetAncestor.Call(hit, GA_ROOT); root == w.hwnd {
			var el *comObject
			if succeeded(u.automation.call(iuaElementFromPoint, packPoint(x, y), uintptr(unsafe.Pointer(&el)))) && el != nil {
				if w.owns(uint32(propInt(el, propProcessID))) {
					return el, nil
				}
				el.release() // Atelier's overlay, say: walk instead.
			}
		}
	}
	root, err := u.fromHandle(w.hwnd)
	if err != nil {
		return nil, err
	}
	if u.walker == nil {
		return root, nil
	}
	limits := bg.WalkLimits
	limits.Expired = func() bool { return time.Now().After(deadline) }
	found, _ := bg.Descend[*comObject](uiaTree{u.walker}, root, float64(x), float64(y), limits)
	if found != root {
		root.release()
	}
	return found, nil
}

// focusIn is the element of the window's app that takes typing: UI Automation's focused element when the window is
// in front (then it is that window's), else the element of target, its thread's focus window (focusTarget).
func (u *uiaSession) focusIn(w bgWindow, target uintptr, front bool) (*comObject, error) {
	if front {
		var el *comObject
		if succeeded(u.automation.call(iuaGetFocusedElement, uintptr(unsafe.Pointer(&el)))) && el != nil {
			if w.owns(uint32(propInt(el, propProcessID))) {
				return el, nil
			}
			el.release()
		}
	}
	return u.fromHandle(target)
}

// clickPattern is the control pattern a plain left click on el amounts to (bg.ClickPatterns), on el or, through the
// text or image there, the button or link around it; nil when there is none, or the element is disabled.
func (u *uiaSession) clickPattern(el *comObject) (*comObject, bg.Pattern) {
	current := el
	defer func() {
		if current != el {
			current.release()
		}
	}()
	for level := 0; level <= bg.ClickAncestors; level++ {
		ct := propInt(current, propControlType)
		if candidates := bg.ClickPatterns(ct); len(candidates) > 0 {
			if !propBool(current, propIsEnabled) {
				return nil, 0
			}
			for _, p := range candidates {
				var obj *comObject
				switch p {
				case bg.Invoke:
					obj = patternAs(current, patternInvoke, &iidInvokePattern)
				case bg.Toggle:
					obj = patternAs(current, patternToggle, &iidTogglePattern)
				case bg.SelectItem:
					obj = patternAs(current, patternSelectionItem, &iidSelectionItemPattern)
				}
				if obj != nil {
					return obj, p
				}
			}
			return nil, 0
		}
		if !bg.PassThrough(ct) {
			return nil, 0
		}
		parent := u.parent(current)
		if parent == nil {
			return nil, 0
		}
		if current != el {
			current.release()
		}
		current = parent
	}
	return nil, 0
}

// selectAllText selects all of an element's text (its TextPattern's document range).
func (u *uiaSession) selectAllText(el *comObject) bool {
	if !u.patterns {
		return false
	}
	text := patternAs(el, patternText, &iidTextPattern)
	if text == nil {
		return false
	}
	defer text.release()
	var all *comObject
	if !succeeded(text.call(textGetDocumentRange, uintptr(unsafe.Pointer(&all)))) || all == nil {
		return false
	}
	defer all.release()
	return succeeded(all.call(rangeSelect))
}

// field reads the text field bg.type checks: an Edit, or the Document of a RichEdit window (Notepad's text). Any other
// Document is left out (a web page's value is its address), and so is a password field.
func (u *uiaSession) field(el *comObject, target uintptr) fieldState {
	if propBool(el, propIsPassword) {
		return fieldState{}
	}
	switch propInt(el, propControlType) {
	case inspect.Edit:
	case inspect.Document:
		if uintptr(uint32(propInt(el, propNativeWindowHandle))) != target || !bg.EditClass(className(target)) {
			return fieldState{}
		}
	default:
		return fieldState{}
	}
	v := property(el, propValueValue)
	length, hash, ok := v.digest()
	v.clear()
	if !ok {
		return fieldState{}
	}
	return fieldState{known: true, writable: !propBool(el, propValueIsReadOnly), empty: length == 0, length: length, hash: hash}
}

// setValue sets an element's value (ValuePattern), which replaces all of it.
func (u *uiaSession) setValue(el *comObject, text string) bool {
	value := patternAs(el, patternValue, &iidValuePattern)
	if value == nil {
		return false
	}
	defer value.release()
	units, err := windows.UTF16FromString(text)
	if err != nil {
		return false // A NUL in the text.
	}
	units = units[:len(units)-1]
	var first *uint16
	if len(units) > 0 {
		first = &units[0]
	}
	bstr, _, _ := procSysAllocStringLen.Call(uintptr(unsafe.Pointer(first)), uintptr(len(units)))
	if bstr == 0 {
		return false
	}
	defer procSysFreeString.Call(bstr)
	return succeeded(value.call(valueSetValue, bstr))
}
