// Package bg is Background mode's arithmetic: one app's window worked in without the person's mouse and keyboard. It
// decides which window, which window messages in which order, which keys can be delivered at all, and how far a UI
// Automation walk goes. Sending is the OS's (PostMessage and UI Automation, in internal/win); nothing here moves the
// cursor or brings a window forward.
package bg

import (
	"strings"
	"unicode"

	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/rpc"
)

// Window messages and their flags (WinUser.h).
const (
	WM_NULL          = 0x0000
	WM_KEYDOWN       = 0x0100
	WM_KEYUP         = 0x0101
	WM_CHAR          = 0x0102
	WM_SYSKEYDOWN    = 0x0104
	WM_SYSKEYUP      = 0x0105
	WM_MOUSEMOVE     = 0x0200
	WM_LBUTTONDOWN   = 0x0201
	WM_LBUTTONUP     = 0x0202
	WM_LBUTTONDBLCLK = 0x0203
	WM_RBUTTONDOWN   = 0x0204
	WM_RBUTTONUP     = 0x0205
	WM_RBUTTONDBLCLK = 0x0206
	WM_MBUTTONDOWN   = 0x0207
	WM_MBUTTONUP     = 0x0208
	WM_MBUTTONDBLCLK = 0x0209
	WM_MOUSEWHEEL    = 0x020A
	WM_MOUSEHWHEEL   = 0x020E
	WM_CUT           = 0x0300
	WM_COPY          = 0x0301
	WM_PASTE         = 0x0302
	WM_UNDO          = 0x0304
	WM_NCHITTEST     = 0x0084
	EM_SETSEL        = 0x00B1
	EM_UNDO          = 0x00C7

	MK_LBUTTON = 0x0001
	MK_RBUTTON = 0x0002
	MK_SHIFT   = 0x0004
	MK_CONTROL = 0x0008
	MK_MBUTTON = 0x0010
)

// Message is one window message to post.
type Message struct {
	Msg    uint32
	WParam uintptr
	LParam uintptr
}

// MakeLParam is MAKELPARAM: two signed 16-bit coordinates, x in the low word (GET_X_LPARAM sign-extends them back).
func MakeLParam(x, y int) uintptr {
	return uintptr(uint32(uint16(int16(x))) | uint32(uint16(int16(y)))<<16)
}

// WheelWParam is a wheel message's wParam: the MK_* flags in the low word, the signed delta in the high word.
func WheelWParam(mk uint32, delta int32) uintptr {
	return uintptr(mk&0xFFFF | uint32(uint16(int16(delta)))<<16)
}

// KeyLParam is a key message's lParam: repeat count 1 (bits 0–15), the scan code (16–23), the extended bit (24), the
// context code (29: alt is down, for WM_SYSKEY*), the previous key state (30) and the transition state (31), both set
// for a key-up.
func KeyLParam(scan uint16, extended, alt, up bool) uintptr {
	l := uint32(1) | uint32(scan&0xFF)<<16
	if extended {
		l |= 1 << 24
	}
	if alt {
		l |= 1 << 29
	}
	if up {
		l |= 1<<30 | 1<<31
	}
	return uintptr(l)
}

// ---------------------------------------------------------------- mouse

// MouseKeys are the MK_* flags of a click's modifiers. Only ctrl and shift have one: an app sees alt or the Windows key
// only on the keyboard itself, which a background click doesn't touch.
func MouseKeys(mods []keys.Modifier) (uint32, error) {
	var mk uint32
	for _, m := range mods {
		switch m {
		case keys.Ctrl:
			mk |= MK_CONTROL
		case keys.Shift:
			mk |= MK_SHIFT
		default:
			return 0, rpc.Unsupported("%s-click can't be done in the background: apps read %s from the keyboard itself; only ctrl and shift go with a background click", m, m)
		}
	}
	return mk, nil
}

func buttonMessages(b input.Button) (down, up, dbl uint32, flag uint32) {
	switch b {
	case input.Right:
		return WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON
	case input.Middle:
		return WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON
	default:
		return WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON
	}
}

// ClickMessages are a click as the window would get it from the mouse, at x, y in its client coordinates: a move
// there, then a press and a release per click. The second press of a double click is WM_xBUTTONDBLCLK for a window
// whose class asks for double clicks (CS_DBLCLKS) and a plain press otherwise, as Windows does it; a third press is a
// plain press again (apps count triple clicks themselves). The button's MK_ flag is set while it is down. The logical
// buttons: a left click is WM_LBUTTON* even with swapped buttons.
func ClickMessages(b input.Button, count int, mk uint32, x, y int, doubleClicks bool) []Message {
	down, up, dbl, flag := buttonMessages(b)
	at := MakeLParam(x, y)
	out := []Message{{Msg: WM_MOUSEMOVE, WParam: uintptr(mk), LParam: at}}
	for n := 1; n <= count; n++ {
		press := down
		if n == 2 && doubleClicks {
			press = dbl
		}
		out = append(out, Message{Msg: press, WParam: uintptr(mk | flag), LParam: at}, Message{Msg: up, WParam: uintptr(mk), LParam: at})
	}
	return out
}

// WheelMessages are a scroll of dx, dy lines (the units of mouse.scroll: positive dy scrolls down, positive dx right,
// one line is 40 wheel units) as WM_MOUSEWHEEL and WM_MOUSEHWHEEL in notches of at most 120. Their lParam is the point
// in screen coordinates, as Windows sends it.
func WheelMessages(dx, dy float64, mk uint32, screenX, screenY int) []Message {
	vertical, horizontal := input.WheelSteps(dx, dy)
	at := MakeLParam(screenX, screenY)
	var out []Message
	for _, d := range vertical {
		out = append(out, Message{Msg: WM_MOUSEWHEEL, WParam: WheelWParam(mk, d), LParam: at})
	}
	for _, d := range horizontal {
		out = append(out, Message{Msg: WM_MOUSEHWHEEL, WParam: WheelWParam(mk, d), LParam: at})
	}
	return out
}

// ---------------------------------------------------------------- keys

// KeyAction is how bg.key delivers a key: posted key messages, or a shortcut done by its own message (or UI
// Automation), since an app in the background reads ctrl, alt and shift from the keyboard, not from the message.
type KeyAction int

const (
	KeyPost KeyAction = iota
	KeySelectAll
	KeyCopy
	KeyCut
	KeyPaste
	KeyUndo
)

func (a KeyAction) String() string {
	return [...]string{"keys", "select all", "copy", "cut", "paste", "undo"}[a]
}

// KeyPlan is what bg.key does.
type KeyPlan struct {
	Action KeyAction
	// Messages are posted in order for KeyPost (repeat included).
	Messages []Message
	// Times: how many times a shortcut is done (paste and undo repeat; select all, copy and cut are done once).
	Times int
	// Label is the keys as given, for messages: "ctrl+s".
	Label string
}

// KeyMessages are one press of a key without modifiers: WM_KEYDOWN and WM_KEYUP with its scan code and extended bit.
// The app's own message loop turns the press into WM_CHAR (TranslateMessage), as it does for the keyboard.
func KeyMessages(k keys.Key, scan uint16) []Message {
	return []Message{
		{Msg: WM_KEYDOWN, WParam: uintptr(k.VK), LParam: KeyLParam(scan, k.Extended, false, false)},
		{Msg: WM_KEYUP, WParam: uintptr(k.VK), LParam: KeyLParam(scan, k.Extended, false, true)},
	}
}

// SysKeyMessages are alt+key: WM_SYSKEYDOWN and WM_SYSKEYUP with the context bit (alt down) set, which is all the
// window's default handling looks at (alt+F4 closes, alt+letter opens a menu).
func SysKeyMessages(k keys.Key, scan uint16) []Message {
	return []Message{
		{Msg: WM_SYSKEYDOWN, WParam: uintptr(k.VK), LParam: KeyLParam(scan, k.Extended, true, false)},
		{Msg: WM_SYSKEYUP, WParam: uintptr(k.VK), LParam: KeyLParam(scan, k.Extended, true, true)},
	}
}

// CharMessages are WM_CHAR per UTF-16 unit of r (a surrogate pair is two).
func CharMessages(r rune) []Message {
	var out []Message
	for _, u := range utf16Units(r) {
		out = append(out, Message{Msg: WM_CHAR, WParam: uintptr(u), LParam: 1})
	}
	return out
}

func utf16Units(r rune) []uint16 {
	if r >= 0x10000 && r <= 0x10FFFF {
		r -= 0x10000
		return []uint16{uint16(0xD800 + (r>>10)&0x3FF), uint16(0xDC00 + r&0x3FF)}
	}
	return []uint16{uint16(r)}
}

func repeatMessages(one []Message, times int) []Message {
	out := make([]Message, 0, len(one)*times)
	for i := 0; i < times; i++ {
		out = append(out, one...)
	}
	return out
}

func singleRune(name string) (rune, bool) {
	r := []rune(name)
	if len(r) != 1 || !unicode.IsPrint(r[0]) || r[0] == ' ' {
		return 0, false
	}
	return r[0], true
}

func onlyModifier(mods []keys.Modifier, m keys.Modifier) bool { return len(mods) == 1 && mods[0] == m }

// PlanKeys decides how bg.key delivers keys (`['ctrl', 'a']`, `['return']`) to a window in the background. Unknown
// keys are InvalidParams, as for key.press. What works:
//   - keys without modifiers: posted WM_KEYDOWN/WM_KEYUP (a character that needs shift or AltGr on the layout, like
//     `!`, as WM_CHAR of that character);
//   - shift+letter: WM_CHAR of the capital;
//   - alt+key: WM_SYSKEYDOWN/WM_SYSKEYUP (but alt+tab and alt+esc, which are the system's);
//   - ctrl+a, ctrl+c, ctrl+x, ctrl+v, ctrl+z (cmd is ctrl): select all, copy, cut, paste and undo by their own
//     messages.
//
// Anything else is -32032: apps take other shortcuts (ctrl+s, shift+tab, shift+arrows) from the keyboard's state,
// which a background window doesn't get.
func PlanKeys(names []string, layout keys.Layout, scan func(vk uint16) uint16, repeat int) (KeyPlan, error) {
	stroke, err := keys.Resolve(names, layout)
	if err != nil {
		return KeyPlan{}, rpc.InvalidParams("%v", err)
	}
	if repeat < 1 {
		repeat = 1
	}
	label := strings.ToLower(strings.Join(names, "+"))
	plan := KeyPlan{Action: KeyPost, Times: 1, Label: label}
	var given []keys.Modifier
	keyName := ""
	for _, name := range names {
		if m, ignored, ok := keys.ModifierNamed(name); ok {
			if !ignored && !containsModifier(given, m) {
				given = append(given, m)
			}
			continue
		}
		keyName = name
	}
	if stroke.Key == nil {
		return KeyPlan{}, rpc.Unsupported("%s: modifier keys alone can't be pressed in a window in the background", label)
	}
	key := *stroke.Key
	// The modifiers the layout adds for the character (shift for `!`, ctrl+alt for AltGr).
	var needed []keys.Modifier
	for _, m := range stroke.Modifiers {
		if !containsModifier(given, m) {
			needed = append(needed, m)
		}
	}
	unsupported := func(why string) (KeyPlan, error) {
		return KeyPlan{}, rpc.Unsupported("%s can't be pressed in a window in the background: %s", label, why)
	}
	const readKeyboard = "apps read ctrl, alt and shift from the keyboard itself. In the background, keys without modifiers, shift+letters, alt+key, and in text fields select all, copy, cut, paste and undo (ctrl+a, c, x, v, z) work"

	switch {
	case containsModifier(given, keys.Win):
		return unsupported("the Windows key goes to the system, not to a window")
	case len(given) == 0:
		if len(needed) == 0 {
			plan.Messages = repeatMessages(KeyMessages(key, scan(key.VK)), repeat)
			return plan, nil
		}
		if r, ok := singleRune(keyName); ok {
			plan.Messages = repeatMessages(CharMessages(r), repeat)
			return plan, nil
		}
		return unsupported(readKeyboard)
	case onlyModifier(given, keys.Shift) && len(needed) == 0 && key.VK >= 'A' && key.VK <= 'Z':
		plan.Messages = repeatMessages(CharMessages(rune(key.VK)), repeat)
		return plan, nil
	case onlyModifier(given, keys.Alt) && len(needed) == 0:
		if key.VK == keys.VK_TAB || key.VK == keys.VK_ESCAPE {
			return unsupported("switching windows is the system's, not a window's")
		}
		plan.Messages = repeatMessages(SysKeyMessages(key, scan(key.VK)), repeat)
		return plan, nil
	case onlyModifier(given, keys.Ctrl) && len(needed) == 0:
		switch key.VK {
		case 'A':
			plan.Action = KeySelectAll
		case 'C':
			plan.Action = KeyCopy
		case 'X':
			plan.Action = KeyCut
		case 'V':
			plan.Action, plan.Times = KeyPaste, repeat
		case 'Z':
			plan.Action, plan.Times = KeyUndo, repeat
		default:
			return unsupported(readKeyboard)
		}
		return plan, nil
	}
	return unsupported(readKeyboard)
}

func containsModifier(list []keys.Modifier, m keys.Modifier) bool {
	for _, have := range list {
		if have == m {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- typing

// TypeMessages are bg.type's messages, in pieces: WM_CHAR per UTF-16 unit, a line break ("\n", "\r" or "\r\n") as
// Return and a tab as Tab, each a WM_KEYDOWN and WM_KEYUP the app's loop translates as the keyboard's.
func TypeMessages(text string, scan func(vk uint16) uint16) [][]Message {
	var out [][]Message
	for _, piece := range keys.Pieces(text) {
		switch piece.Kind {
		case keys.Newline:
			out = append(out, KeyMessages(keys.Key{VK: keys.VK_RETURN}, scan(keys.VK_RETURN)))
		case keys.TabKey:
			out = append(out, KeyMessages(keys.Key{VK: keys.VK_TAB}, scan(keys.VK_TAB)))
		default:
			messages := make([]Message, 0, len(piece.Units))
			for _, u := range piece.Units {
				messages = append(messages, Message{Msg: WM_CHAR, WParam: uintptr(u), LParam: 1})
			}
			out = append(out, messages)
		}
	}
	return out
}

// HasKeyPresses: the text has line breaks or tabs, which are key presses, not characters a field's value can take.
func HasKeyPresses(text string) bool { return strings.ContainsAny(text, "\r\n\t") }
