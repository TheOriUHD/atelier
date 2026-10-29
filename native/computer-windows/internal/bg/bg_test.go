package bg

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

func code(err error) int {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return 0
}

// ---------------------------------------------------------------- packing

func TestPacking(t *testing.T) {
	for _, c := range []struct {
		x, y int
		want uintptr
	}{
		{0, 0, 0},
		{10, 20, 20<<16 | 10},
		{-1, 5, 5<<16 | 0xFFFF},
		{-1920, -8, 0xFFF8<<16 | 0xF880},
		{32767, 1, 1<<16 | 0x7FFF},
	} {
		if got := MakeLParam(c.x, c.y); got != c.want {
			t.Errorf("MakeLParam(%d, %d) = %#x, want %#x", c.x, c.y, got, c.want)
		}
		// GET_X_LPARAM / GET_Y_LPARAM: the low and high words, sign-extended.
		l := MakeLParam(c.x, c.y)
		if x, y := int(int16(uint16(l))), int(int16(uint16(l>>16))); x != c.x || y != c.y {
			t.Errorf("round trip of %d, %d: %d, %d", c.x, c.y, x, y)
		}
	}
	if got := WheelWParam(MK_CONTROL, -120); got != 0xFF88<<16|MK_CONTROL {
		t.Errorf("WheelWParam(ctrl, -120) = %#x", got)
	}
	if got := WheelWParam(0, 240); int16(uint16(got>>16)) != 240 || uint16(got) != 0 {
		t.Errorf("WheelWParam(0, 240) = %#x", got)
	}
	// Return's down: repeat 1, scan 0x1C; up adds the previous-state and transition bits.
	if got := KeyLParam(0x1C, false, false, false); got != 0x001C0001 {
		t.Errorf("Return down: %#x", got)
	}
	if got := KeyLParam(0x1C, false, false, true); got != 0xC01C0001 {
		t.Errorf("Return up: %#x", got)
	}
	// Left arrow is extended (bit 24); alt+F4 has the context bit (29).
	if got := KeyLParam(0x4B, true, false, false); got != 0x014B0001 {
		t.Errorf("left down: %#x", got)
	}
	if got := KeyLParam(0x3E, false, true, false); got != 0x203E0001 {
		t.Errorf("alt+F4 down: %#x", got)
	}
	if got := KeyLParam(0x3E, false, true, true); got != 0xE03E0001 {
		t.Errorf("alt+F4 up: %#x", got)
	}
}

// ---------------------------------------------------------------- mouse

func names(messages []Message) string {
	var out []string
	for _, m := range messages {
		name := map[uint32]string{
			WM_MOUSEMOVE: "move", WM_LBUTTONDOWN: "ldown", WM_LBUTTONUP: "lup", WM_LBUTTONDBLCLK: "ldbl",
			WM_RBUTTONDOWN: "rdown", WM_RBUTTONUP: "rup", WM_RBUTTONDBLCLK: "rdbl", WM_MBUTTONDOWN: "mdown",
			WM_MBUTTONUP: "mup", WM_MBUTTONDBLCLK: "mdbl", WM_MOUSEWHEEL: "wheel", WM_MOUSEHWHEEL: "hwheel",
			WM_KEYDOWN: "keydown", WM_KEYUP: "keyup", WM_SYSKEYDOWN: "syskeydown", WM_SYSKEYUP: "syskeyup", WM_CHAR: "char",
		}[m.Msg]
		if name == "" {
			name = fmt.Sprintf("%#x", m.Msg)
		}
		out = append(out, name)
	}
	return strings.Join(out, " ")
}

func TestClickMessages(t *testing.T) {
	for _, c := range []struct {
		button input.Button
		count  int
		dbl    bool
		want   string
	}{
		{input.Left, 1, true, "move ldown lup"},
		{input.Left, 2, true, "move ldown lup ldbl lup"},
		{input.Left, 2, false, "move ldown lup ldown lup"},
		{input.Left, 3, true, "move ldown lup ldbl lup ldown lup"},
		{input.Right, 1, true, "move rdown rup"},
		{input.Right, 2, true, "move rdown rup rdbl rup"},
		{input.Middle, 1, true, "move mdown mup"},
	} {
		got := ClickMessages(c.button, c.count, 0, 5, 6, c.dbl)
		if names(got) != c.want {
			t.Errorf("%s ×%d (dblclks %v): %s, want %s", c.button, c.count, c.dbl, names(got), c.want)
		}
		for _, m := range got {
			if m.LParam != MakeLParam(5, 6) {
				t.Errorf("%s: lParam %#x", names([]Message{m}), m.LParam)
			}
		}
	}
	// The button's flag is set while it is down, the modifiers' throughout.
	got := ClickMessages(input.Left, 2, MK_CONTROL|MK_SHIFT, 1, 2, true)
	want := []uintptr{MK_CONTROL | MK_SHIFT, MK_CONTROL | MK_SHIFT | MK_LBUTTON, MK_CONTROL | MK_SHIFT, MK_CONTROL | MK_SHIFT | MK_LBUTTON, MK_CONTROL | MK_SHIFT}
	for i, m := range got {
		if m.WParam != want[i] {
			t.Errorf("message %d (%s): wParam %#x, want %#x", i, names([]Message{m}), m.WParam, want[i])
		}
	}
	if r := ClickMessages(input.Right, 1, 0, 0, 0, true); r[1].WParam != MK_RBUTTON || r[2].WParam != 0 {
		t.Errorf("right: %v", r)
	}
	if m := ClickMessages(input.Middle, 1, 0, 0, 0, true); m[1].WParam != MK_MBUTTON {
		t.Errorf("middle: %v", m)
	}
}

func TestMouseKeys(t *testing.T) {
	if mk, err := MouseKeys(nil); mk != 0 || err != nil {
		t.Errorf("none: %#x %v", mk, err)
	}
	if mk, err := MouseKeys([]keys.Modifier{keys.Ctrl, keys.Shift}); mk != MK_CONTROL|MK_SHIFT || err != nil {
		t.Errorf("ctrl+shift: %#x %v", mk, err)
	}
	for _, m := range []keys.Modifier{keys.Alt, keys.Win} {
		if _, err := MouseKeys([]keys.Modifier{keys.Ctrl, m}); code(err) != proto.Unsupported || !strings.Contains(err.Error(), m.String()) {
			t.Errorf("%s: %v", m, err)
		}
	}
}

func TestWheelMessages(t *testing.T) {
	// Positive dy scrolls down: a negative delta; one line is 40.
	got := WheelMessages(0, 3, 0, -100, 50)
	if names(got) != "wheel" || int16(uint16(got[0].WParam>>16)) != -120 || got[0].LParam != MakeLParam(-100, 50) {
		t.Errorf("dy 3: %v", got)
	}
	got = WheelMessages(0, -5, 0, 0, 0)
	if names(got) != "wheel wheel" || int16(uint16(got[0].WParam>>16)) != 120 || int16(uint16(got[1].WParam>>16)) != 80 {
		t.Errorf("dy -5: %v", got)
	}
	got = WheelMessages(2, 1, 0, 0, 0)
	if names(got) != "wheel hwheel" || int16(uint16(got[0].WParam>>16)) != -40 || int16(uint16(got[1].WParam>>16)) != 80 {
		t.Errorf("dx 2, dy 1: %v", got)
	}
	if got := WheelMessages(0, 0, 0, 0, 0); len(got) != 0 {
		t.Errorf("nothing: %v", got)
	}
}

// ---------------------------------------------------------------- keys

// usLayout is a US keyboard: shifted punctuation and capitals need shift.
type usLayout struct{}

func (usLayout) VkKeyScan(r rune) (uint8, uint8, bool) {
	switch {
	case r >= 'a' && r <= 'z':
		return uint8(r - 'a' + 'A'), 0, true
	case r >= 'A' && r <= 'Z':
		return uint8(r), 1, true
	case r == '!':
		return '1', 1, true
	case r == '€':
		return 'E', 6, true // AltGr+E on many layouts
	}
	return 0, 0, false
}

func scan(vk uint16) uint16 { return vk + 0x100 } // Recognizable, not real.

func TestPlanKeys(t *testing.T) {
	cases := []struct {
		keys   []string
		repeat int
		action KeyAction
		want   string // the messages' names, for KeyPost
		code   int
	}{
		{[]string{"return"}, 1, KeyPost, "keydown keyup", 0},
		{[]string{"tab"}, 2, KeyPost, "keydown keyup keydown keyup", 0},
		{[]string{"left"}, 1, KeyPost, "keydown keyup", 0},
		{[]string{"escape"}, 1, KeyPost, "keydown keyup", 0},
		{[]string{"f5"}, 1, KeyPost, "keydown keyup", 0},
		{[]string{"a"}, 1, KeyPost, "keydown keyup", 0},
		{[]string{"!"}, 1, KeyPost, "char", 0},
		{[]string{"€"}, 3, KeyPost, "char char char", 0},
		{[]string{"shift", "a"}, 1, KeyPost, "char", 0},
		{[]string{"alt", "f4"}, 1, KeyPost, "syskeydown syskeyup", 0},
		{[]string{"option", "f"}, 1, KeyPost, "syskeydown syskeyup", 0},
		{[]string{"cmd", "a"}, 1, KeySelectAll, "", 0},
		{[]string{"ctrl", "A"}, 5, KeySelectAll, "", 0},
		{[]string{"ctrl", "c"}, 1, KeyCopy, "", 0},
		{[]string{"cmd", "x"}, 1, KeyCut, "", 0},
		{[]string{"ctrl", "v"}, 2, KeyPaste, "", 0},
		{[]string{"command", "z"}, 3, KeyUndo, "", 0},
		{[]string{"fn", "return"}, 1, KeyPost, "keydown keyup", 0},
		// What a background window can't take.
		{[]string{"ctrl", "s"}, 1, 0, "", proto.Unsupported},
		{[]string{"ctrl", "shift", "z"}, 1, 0, "", proto.Unsupported},
		{[]string{"shift", "tab"}, 1, 0, "", proto.Unsupported},
		{[]string{"shift", "left"}, 1, 0, "", proto.Unsupported},
		{[]string{"shift", "1"}, 1, 0, "", proto.Unsupported},
		{[]string{"alt", "tab"}, 1, 0, "", proto.Unsupported},
		{[]string{"alt", "shift", "f"}, 1, 0, "", proto.Unsupported},
		{[]string{"win", "d"}, 1, 0, "", proto.Unsupported},
		{[]string{"ctrl"}, 1, 0, "", proto.Unsupported},
		{[]string{"ctrl", "!"}, 1, 0, "", proto.Unsupported},
		// Bad names are bad params.
		{[]string{}, 1, 0, "", proto.InvalidParams},
		{[]string{"ctrl", "nosuchkey"}, 1, 0, "", proto.InvalidParams},
		{[]string{"a", "b"}, 1, 0, "", proto.InvalidParams},
	}
	for _, c := range cases {
		plan, err := PlanKeys(c.keys, usLayout{}, scan, c.repeat)
		label := strings.Join(c.keys, "+")
		if c.code != 0 {
			if code(err) != c.code {
				t.Errorf("%s: %v, want code %d", label, err, c.code)
			} else if c.code == proto.Unsupported && !strings.Contains(err.Error(), strings.ToLower(label)) {
				t.Errorf("%s: the message should name the keys: %v", label, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", label, err)
			continue
		}
		if plan.Action != c.action || names(plan.Messages) != c.want {
			t.Errorf("%s: %s %q, want %s %q", label, plan.Action, names(plan.Messages), c.action, c.want)
		}
	}

	// The details: VK, scan code and extended bit; the character; the repeat of a shortcut.
	plan, _ := PlanKeys([]string{"left"}, usLayout{}, scan, 1)
	if m := plan.Messages[0]; m.WParam != keys.VK_LEFT || m.LParam != KeyLParam(keys.VK_LEFT+0x100, true, false, false) {
		t.Errorf("left: %+v", m)
	}
	plan, _ = PlanKeys([]string{"shift", "q"}, usLayout{}, scan, 1)
	if plan.Messages[0].WParam != 'Q' {
		t.Errorf("shift+q: %+v", plan.Messages)
	}
	plan, _ = PlanKeys([]string{"!"}, usLayout{}, scan, 1)
	if plan.Messages[0].WParam != '!' {
		t.Errorf("!: %+v", plan.Messages)
	}
	plan, _ = PlanKeys([]string{"alt", "f4"}, usLayout{}, scan, 1)
	if plan.Messages[0].WParam != keys.VK_F1+3 || plan.Messages[0].LParam&(1<<29) == 0 {
		t.Errorf("alt+f4: %+v", plan.Messages)
	}
	if plan, _ := PlanKeys([]string{"ctrl", "z"}, usLayout{}, scan, 4); plan.Times != 4 {
		t.Errorf("undo ×4: %+v", plan)
	}
	if plan, _ := PlanKeys([]string{"ctrl", "c"}, usLayout{}, scan, 4); plan.Times != 1 {
		t.Errorf("copy is once: %+v", plan)
	}
}

func TestTypeMessages(t *testing.T) {
	pieces := TypeMessages("hi\r\n😀\tx", scan)
	var all []Message
	for _, p := range pieces {
		all = append(all, p...)
	}
	if got := names(all); got != "char char keydown keyup char char keydown keyup char" {
		t.Errorf("messages: %s", got)
	}
	// 😀 is a surrogate pair: two WM_CHARs.
	if all[4].WParam != 0xD83D || all[5].WParam != 0xDE00 {
		t.Errorf("surrogates: %#x %#x", all[4].WParam, all[5].WParam)
	}
	if all[2].WParam != keys.VK_RETURN || all[6].WParam != keys.VK_TAB || all[2].LParam != KeyLParam(keys.VK_RETURN+0x100, false, false, false) {
		t.Errorf("return and tab: %+v %+v", all[2], all[6])
	}
	if !HasKeyPresses("a\nb") || !HasKeyPresses("\t") || HasKeyPresses("plain text") {
		t.Error("HasKeyPresses")
	}
	if got := CharMessages('😀'); len(got) != 2 {
		t.Errorf("CharMessages: %v", got)
	}
}

// ---------------------------------------------------------------- windows

func TestParseWindow(t *testing.T) {
	for _, c := range []struct {
		id   string
		want uintptr
		ok   bool
	}{
		{"4242", 4242, true}, {"0", 0, false}, {"", 0, false}, {"-5", 0, false}, {"+5", 0, false}, {"0x10", 0, false},
		{"abc", 0, false}, {"12 ", 0, false}, {"99999999999999999999999", 0, false},
	} {
		got, ok := ParseWindow(c.id)
		if got != c.want || ok != c.ok {
			t.Errorf("%q: %d %v", c.id, got, ok)
		}
	}
	if got, ok := ParseWindow(FormatWindow(0x3A0B1C)); !ok || got != 0x3A0B1C {
		t.Errorf("round trip: %d", got)
	}
}

func TestChooseWindow(t *testing.T) {
	main := Window{Hwnd: 1, App: "notepad.exe", AltTab: true, Enabled: true}
	other := Window{Hwnd: 2, App: "notepad.exe", AltTab: true, Enabled: true}
	minimized := Window{Hwnd: 3, App: "notepad.exe", AltTab: true, Iconic: true, Enabled: true}
	tooltip := Window{Hwnd: 4, App: "notepad.exe", Enabled: true}
	chrome := Window{Hwnd: 5, App: "chrome.exe", AltTab: true, Enabled: true}
	for _, c := range []struct {
		name    string
		list    []Window
		app     string
		want    uintptr
		restore bool
		ok      bool
	}{
		{"the topmost of the app's", []Window{chrome, tooltip, main, other}, "notepad.exe", 1, false, true},
		{"ids are case-insensitive", []Window{main}, "Notepad.EXE", 1, false, true},
		{"minimized ones only when there's nothing else", []Window{minimized, other}, "notepad.exe", 2, false, true},
		{"else the topmost minimized, restored", []Window{chrome, minimized, {Hwnd: 6, App: "notepad.exe", AltTab: true, Iconic: true}}, "notepad.exe", 3, true, true},
		{"not a tool window or popup", []Window{tooltip}, "notepad.exe", 0, false, false},
		{"not a window of no size", []Window{{Hwnd: 7, App: "notepad.exe", AltTab: true, Enabled: true, Empty: true}, other}, "notepad.exe", 2, false, true},
		{"no such app", []Window{main, chrome}, "word.exe", 0, false, false},
		{"nothing at all", nil, "notepad.exe", 0, false, false},
	} {
		got, ok := ChooseWindow(c.list, c.app)
		if ok != c.ok || got.Window.Hwnd != c.want || got.Restore != c.restore {
			t.Errorf("%s: %+v %v", c.name, got, ok)
		}
	}
	// A window with a modal dialog open: the dialog, which is what takes clicks.
	disabled := Window{Hwnd: 10, App: "notepad.exe", AltTab: true}
	dialog := Window{Hwnd: 11, App: "notepad.exe", Enabled: true, Dialog: true, RootOwner: 10}
	strayDialog := Window{Hwnd: 12, App: "notepad.exe", Enabled: true, Dialog: true, RootOwner: 99}
	if got, _ := ChooseWindow([]Window{strayDialog, dialog, disabled}, "notepad.exe"); got.Window.Hwnd != 11 {
		t.Errorf("modal dialog: %+v", got)
	}
	if got, _ := ChooseWindow([]Window{strayDialog, disabled}, "notepad.exe"); got.Window.Hwnd != 10 {
		t.Errorf("disabled without a dialog of its own: %+v", got)
	}
}

func TestPickChild(t *testing.T) {
	r := Rect{Left: 0, Top: 0, Right: 100, Bottom: 100}
	inner := Rect{Left: 10, Top: 10, Right: 50, Bottom: 50}
	children := []Child{
		{Hwnd: 1, Visible: true, Enabled: true, GroupBox: true, Rect: r},    // a group box over its buttons
		{Hwnd: 2, Visible: false, Enabled: true, Rect: r},                   // hidden
		{Hwnd: 3, Visible: true, Enabled: false, Rect: r},                   // disabled (Chromium's compositor window)
		{Hwnd: 4, Visible: true, Enabled: true, Transparent: true, Rect: r}, // click-through
		{Hwnd: 5, Visible: true, Enabled: true, Rect: inner},                // the button
		{Hwnd: 6, Visible: true, Enabled: true, Rect: r},                    // the pane below
	}
	for _, c := range []struct {
		x, y float64
		want int
	}{{20, 20, 4}, {80, 80, 5}, {100, 100, -1}, {-1, 5, -1}, {50, 20, 5}, {49.5, 20, 4}} {
		if got := PickChild(children, c.x, c.y); got != c.want {
			t.Errorf("%v, %v: %d, want %d", c.x, c.y, got, c.want)
		}
	}
}

func TestFramePartsAndClasses(t *testing.T) {
	for code, want := range map[int]string{
		HTCLIENT: "", HTNOWHERE: "", HTTRANSPARENT: "", HTERROR: "", HTCAPTION: "title bar", HTMENU: "menu bar",
		HTVSCROLL: "scroll bar", HTHSCROLL: "scroll bar", HTCLOSE: "close button", HTMINBUTTON: "minimize button",
		HTMAXBUTTON: "maximize button", HTSYSMENU: "window menu", HTLEFT: "border", HTBOTTOMRIGHT: "border", 13: "border",
		HTBORDER: "border", HTGROWBOX: "border", HTHELP: "help button",
	} {
		if got := FramePart(code); got != want {
			t.Errorf("%d: %q, want %q", code, got, want)
		}
	}
	for class, want := range map[string]bool{
		"Edit": true, "RichEdit20W": true, "RICHEDIT50W": true, "RichEditD2DPT": true, "Chrome_WidgetWin_1": false,
		"Button": false, "Scintilla": false,
	} {
		if EditClass(class) != want {
			t.Errorf("EditClass(%s)", class)
		}
	}
	if !IsChromium("Chrome_WidgetWin_1") || !IsChromium("Chrome_WidgetWin_0") || IsChromium("Chrome_RenderWidgetHostHWND") {
		t.Error("IsChromium")
	}
}

func TestClickPatterns(t *testing.T) {
	for ct, want := range map[int][]Pattern{
		CTButton: {Invoke, Toggle}, CTHyperlink: {Invoke}, CTMenuItem: {Invoke}, CTCheckBox: {Toggle},
		CTTabItem: {SelectItem}, CTListItem: {SelectItem}, CTRadioButton: {SelectItem},
		50004 /* Edit */ : nil, 50024 /* TreeItem */ : nil, CTText: nil, 50033 /* Pane */ : nil,
	} {
		if got := ClickPatterns(ct); !slices.Equal(got, want) {
			t.Errorf("%d: %v, want %v", ct, got, want)
		}
	}
	if !PassThrough(CTText) || !PassThrough(CTImage) || PassThrough(CTButton) || PassThrough(50004) {
		t.Error("PassThrough")
	}
}

// ---------------------------------------------------------------- the bounded walk

// fakeTree is a UI Automation tree whose elements are handed out as fresh handles, so the walk's releases can be
// counted: every handle the walk got and doesn't return is released exactly once.
type fakeTree struct {
	nodes    map[string]fakeNode
	next     int
	live     map[int]string // handle → node
	released map[int]int
	reads    int
}

type fakeNode struct {
	rect     Rect
	children []string
}

type handle int

func newFakeTree(nodes map[string]fakeNode) *fakeTree {
	return &fakeTree{nodes: nodes, live: map[int]string{}, released: map[int]int{}}
}

func (f *fakeTree) give(name string) handle {
	f.next++
	f.live[f.next] = name
	return handle(f.next)
}

func (f *fakeTree) root(name string) handle { return f.give(name) }

func (f *fakeTree) FirstChild(n handle) (handle, bool) {
	kids := f.nodes[f.live[int(n)]].children
	if len(kids) == 0 {
		return 0, false
	}
	return f.give(kids[0]), true
}

func (f *fakeTree) NextSibling(n handle) (handle, bool) {
	name := f.live[int(n)]
	for _, node := range f.nodes {
		for i, k := range node.children {
			if k == name && i+1 < len(node.children) {
				return f.give(node.children[i+1]), true
			}
		}
	}
	return 0, false
}

func (f *fakeTree) Bounds(n handle) (Rect, bool) {
	f.reads++
	node, ok := f.nodes[f.live[int(n)]]
	return node.rect, ok && node.rect.Area() > 0
}

func (f *fakeTree) Release(n handle) { f.released[int(n)]++ }

// leaks: handles neither released nor kept; double: released more than once.
func (f *fakeTree) check(t *testing.T, root, kept handle) {
	t.Helper()
	for h := range f.live {
		n := f.released[h]
		switch {
		case n > 1:
			t.Errorf("%s (%d) released %d times", f.live[h], h, n)
		case (handle(h) == root || handle(h) == kept) && n != 0:
			t.Errorf("%s (%d) released, but it is the caller's", f.live[h], h)
		case handle(h) != root && handle(h) != kept && n != 1:
			t.Errorf("%s (%d) leaked", f.live[h], h)
		}
	}
}

func rect(l, t, r, b float64) Rect { return Rect{Left: l, Top: t, Right: r, Bottom: b} }

func TestDescendFindsTheDeepestElementAtThePoint(t *testing.T) {
	tree := newFakeTree(map[string]fakeNode{
		"window":  {rect(0, 0, 800, 600), []string{"title", "body", "overlay"}},
		"title":   {rect(0, 0, 800, 30), nil},
		"body":    {rect(0, 30, 800, 600), []string{"list", "toolbar"}},
		"overlay": {rect(0, 0, 800, 600), nil}, // bigger than body: body is the more specific
		"list":    {rect(0, 60, 400, 600), []string{"item1", "item2"}},
		"toolbar": {rect(0, 30, 800, 60), []string{"button"}},
		"item1":   {rect(0, 60, 400, 90), []string{"text1"}},
		"item2":   {rect(0, 90, 400, 120), []string{"text2"}},
		"text1":   {rect(10, 65, 100, 85), nil},
		"text2":   {rect(10, 95, 100, 115), nil},
		"button":  {rect(10, 35, 40, 55), nil},
	})
	for _, c := range []struct {
		x, y  float64
		want  string
		depth int
	}{
		{50, 100, "text2", 4},
		{200, 100, "item2", 3}, // right of the text: the item
		{20, 40, "button", 3},
		{600, 300, "body", 1}, // body has nothing there; the overlay is bigger
		{900, 900, "window", 0},
	} {
		tree.live, tree.released = map[int]string{}, map[int]int{}
		root := tree.root("window")
		got, depth := Descend[handle](tree, root, c.x, c.y, WalkLimits)
		if tree.live[int(got)] != c.want || depth != c.depth {
			t.Errorf("%v, %v: %s at depth %d, want %s at %d", c.x, c.y, tree.live[int(got)], depth, c.want, c.depth)
		}
		tree.check(t, root, got)
	}
}

func TestDescendIsBounded(t *testing.T) {
	// A chain 40 deep: the walk stops at 25 levels.
	nodes := map[string]fakeNode{}
	for i := 0; i < 40; i++ {
		var kids []string
		if i < 39 {
			kids = []string{fmt.Sprint(i + 1)}
		}
		nodes[fmt.Sprint(i)] = fakeNode{rect(0, 0, 100, 100), kids}
	}
	tree := newFakeTree(nodes)
	root := tree.root("0")
	got, depth := Descend[handle](tree, root, 5, 5, WalkLimits)
	if depth != 25 || tree.live[int(got)] != "25" {
		t.Errorf("deep chain: %s at %d", tree.live[int(got)], depth)
	}
	tree.check(t, root, got)

	// 1000 children, the one at the point last: only the first 300 are looked at.
	kids := make([]string, 1000)
	nodes = map[string]fakeNode{"root": {rect(0, 0, 1000, 10), kids}}
	for i := range kids {
		kids[i] = fmt.Sprintf("c%d", i)
		nodes[kids[i]] = fakeNode{rect(float64(i), 0, float64(i+1), 10), nil}
	}
	tree = newFakeTree(nodes)
	root = tree.root("root")
	got, depth = Descend[handle](tree, root, 999.5, 5, WalkLimits)
	if depth != 0 || got != root || tree.reads != 300 {
		t.Errorf("wide: %s at %d after %d reads", tree.live[int(got)], depth, tree.reads)
	}
	tree.check(t, root, got)
	tree.live, tree.released, tree.reads = map[int]string{}, map[int]int{}, 0
	root = tree.root("root")
	if got, _ := Descend[handle](tree, root, 120.5, 5, WalkLimits); tree.live[int(got)] != "c120" {
		t.Errorf("wide, within the first 300: %s", tree.live[int(got)])
	}

	// Out of time: what was found so far.
	tree = newFakeTree(map[string]fakeNode{
		"a": {rect(0, 0, 10, 10), []string{"b"}}, "b": {rect(0, 0, 10, 10), []string{"c"}}, "c": {rect(0, 0, 10, 10), nil},
	})
	calls := 0
	limits := WalkLimits
	limits.Expired = func() bool { calls++; return calls > 2 }
	root = tree.root("a")
	got, depth = Descend[handle](tree, root, 5, 5, limits)
	if depth != 1 || tree.live[int(got)] != "b" {
		t.Errorf("expired: %s at %d", tree.live[int(got)], depth)
	}
	tree.check(t, root, got)
	limits.Expired = func() bool { return true }
	root = tree.root("a")
	if got, depth := Descend[handle](tree, root, 5, 5, limits); got != root || depth != 0 {
		t.Errorf("no time at all: %d", depth)
	}
}
