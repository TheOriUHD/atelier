// Package keys turns the key names of key.press / key.hold (`['cmd', 'shift', 't']`, `['return']`, `['f5']`) into
// Windows virtual-key codes, and text for key.type into what is sent.
package keys

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf16"
)

// Virtual-key codes used here (WinUser.h).
const (
	VK_BACK     = 0x08
	VK_TAB      = 0x09
	VK_RETURN   = 0x0D
	VK_SHIFT    = 0x10
	VK_CONTROL  = 0x11
	VK_MENU     = 0x12
	VK_PAUSE    = 0x13
	VK_CAPITAL  = 0x14
	VK_ESCAPE   = 0x1B
	VK_SPACE    = 0x20
	VK_PRIOR    = 0x21
	VK_NEXT     = 0x22
	VK_END      = 0x23
	VK_HOME     = 0x24
	VK_LEFT     = 0x25
	VK_UP       = 0x26
	VK_RIGHT    = 0x27
	VK_DOWN     = 0x28
	VK_SNAPSHOT = 0x2C
	VK_INSERT   = 0x2D
	VK_DELETE   = 0x2E
	VK_LWIN     = 0x5B
	VK_RWIN     = 0x5C
	VK_APPS     = 0x5D
	VK_DIVIDE   = 0x6F
	VK_F1       = 0x70
	VK_F24      = 0x87
	VK_NUMLOCK  = 0x90
	VK_SCROLL   = 0x91
	VK_LSHIFT   = 0xA0
	VK_RSHIFT   = 0xA1
	VK_LCONTROL = 0xA2
	VK_RCONTROL = 0xA3
	VK_LMENU    = 0xA4
	VK_RMENU    = 0xA5

	VK_OEM_1      = 0xBA // ;:
	VK_OEM_PLUS   = 0xBB // =+
	VK_OEM_COMMA  = 0xBC // ,<
	VK_OEM_MINUS  = 0xBD // -_
	VK_OEM_PERIOD = 0xBE // .>
	VK_OEM_2      = 0xBF // /?
	VK_OEM_3      = 0xC0 // `~
	VK_OEM_4      = 0xDB // [{
	VK_OEM_5      = 0xDC // \|
	VK_OEM_6      = 0xDD // ]}
	VK_OEM_7      = 0xDE // '"
)

// Modifier is a modifier key held around a key or a click.
type Modifier int

const (
	Ctrl Modifier = iota
	Shift
	Alt
	Win
)

func (m Modifier) String() string {
	return [...]string{"ctrl", "shift", "alt", "win"}[m]
}

// VK is the modifier's virtual key: the generic ctrl/shift/alt (Windows makes them the left ones) and the left Windows key.
func (m Modifier) VK() uint16 {
	return [...]uint16{VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN}[m]
}

// IsModifierVK reports the virtual keys of modifier keys, generic and sided (the control watch ignores them, like the
// Mac's flagsChanged).
func IsModifierVK(vk uint32) bool {
	switch vk {
	case VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU,
		VK_RMENU, VK_CAPITAL:
		return true
	}
	return false
}

// ModifierNamed resolves a modifier name, case-insensitively. `cmd`/`command` is ctrl: the primary modifier on
// Windows (cmd+c copies). `win`/`super`/`meta` is the Windows key. `fn` has no Windows equivalent the OS sees: it is
// accepted and ignored (`ignored` true).
func ModifierNamed(name string) (m Modifier, ignored bool, ok bool) {
	switch strings.ToLower(name) {
	case "ctrl", "control", "cmd", "command":
		return Ctrl, false, true
	case "shift":
		return Shift, false, true
	case "alt", "option", "opt":
		return Alt, false, true
	case "win", "super", "meta", "windows":
		return Win, false, true
	case "fn", "function":
		return 0, true, true
	}
	return 0, false, false
}

// Modifiers resolves mouse.click's modifier names; unknown names are an error.
func Modifiers(names []string) ([]Modifier, error) {
	var out []Modifier
	for _, name := range names {
		m, ignored, ok := ModifierNamed(name)
		if !ok {
			return nil, fmt.Errorf("unknown modifier %q", name)
		}
		if !ignored {
			out = addModifier(out, m)
		}
	}
	return out, nil
}

func addModifier(list []Modifier, m Modifier) []Modifier {
	for _, have := range list {
		if have == m {
			return list
		}
	}
	return append(list, m)
}

// Key is one non-modifier key.
type Key struct {
	VK uint16
	// Extended: sent with KEYEVENTF_EXTENDEDKEY (the E0-prefixed keys: arrows, the navigation block, right ctrl/alt…).
	Extended bool
}

// Stroke is a resolved key.press / key.hold: the modifiers to hold, in order, and at most one key.
type Stroke struct {
	Modifiers []Modifier
	// Key is nil when only modifiers are pressed.
	Key *Key
}

// Layout tells which key types a character on the keyboard layout the foreground window uses (VkKeyScanExW).
type Layout interface {
	// VkKeyScan returns the virtual key and the shift state (1 shift, 2 ctrl, 4 alt) that type r; ok false when no key
	// of the layout types it.
	VkKeyScan(r rune) (vk uint8, shiftState uint8, ok bool)
}

// IsExtended reports keys that need KEYEVENTF_EXTENDEDKEY: the arrows, the navigation block, right ctrl and alt,
// numpad divide, the Windows and menu keys, num lock and print screen.
func IsExtended(vk uint16) bool {
	switch vk {
	case VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_INSERT, VK_DELETE, VK_RCONTROL,
		VK_RMENU, VK_DIVIDE, VK_LWIN, VK_RWIN, VK_APPS, VK_NUMLOCK, VK_SNAPSHOT:
		return true
	}
	return false
}

// named are the keys by name (lowercase, without `_`, `-` or spaces).
var named = func() map[string]uint16 {
	keys := map[string]uint16{
		"return": VK_RETURN, "enter": VK_RETURN,
		"tab":   VK_TAB,
		"space": VK_SPACE, "spacebar": VK_SPACE,
		"escape": VK_ESCAPE, "esc": VK_ESCAPE,
		// The Mac naming: delete is the key left of it, backspace.
		"delete": VK_BACK, "backspace": VK_BACK,
		"forwarddelete": VK_DELETE, "del": VK_DELETE,
		"up": VK_UP, "down": VK_DOWN, "left": VK_LEFT, "right": VK_RIGHT,
		"home": VK_HOME, "end": VK_END,
		"pageup": VK_PRIOR, "pgup": VK_PRIOR, "pagedown": VK_NEXT, "pgdn": VK_NEXT,
		"insert": VK_INSERT, "ins": VK_INSERT,
		"capslock": VK_CAPITAL, "printscreen": VK_SNAPSHOT, "prtsc": VK_SNAPSHOT, "pause": VK_PAUSE,
		"numlock": VK_NUMLOCK, "scrolllock": VK_SCROLL, "contextmenu": VK_APPS, "apps": VK_APPS,
	}
	for _, d := range []string{"up", "down", "left", "right"} {
		keys["arrow"+d] = keys[d]
		keys[d+"arrow"] = keys[d]
	}
	for i := 0; i < 24; i++ {
		keys[fmt.Sprintf("f%d", i+1)] = uint16(VK_F1 + i)
	}
	return keys
}()

// punctuationNames are punctuation by name, for callers that spell it out.
var punctuationNames = map[string]rune{
	"minus": '-', "hyphen": '-', "dash": '-', "equal": '=', "equals": '=', "plus": '+',
	"leftbracket": '[', "bracketleft": '[', "rightbracket": ']', "bracketright": ']', "backslash": '\\',
	"semicolon": ';', "quote": '\'', "apostrophe": '\'', "comma": ',', "period": '.', "dot": '.', "slash": '/',
	"grave": '`', "backtick": '`', "backquote": '`',
}

// usPlain and usShifted are the US layout's punctuation, for characters the current layout doesn't have.
var usPlain = map[rune]uint16{
	'-': VK_OEM_MINUS, '=': VK_OEM_PLUS, '[': VK_OEM_4, ']': VK_OEM_6, '\\': VK_OEM_5, ';': VK_OEM_1,
	'\'': VK_OEM_7, ',': VK_OEM_COMMA, '.': VK_OEM_PERIOD, '/': VK_OEM_2, '`': VK_OEM_3,
}

var usShifted = map[rune]uint16{
	'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
	'_': VK_OEM_MINUS, '+': VK_OEM_PLUS, '{': VK_OEM_4, '}': VK_OEM_6, '|': VK_OEM_5, ':': VK_OEM_1,
	'"': VK_OEM_7, '<': VK_OEM_COMMA, '>': VK_OEM_PERIOD, '?': VK_OEM_2, '~': VK_OEM_3,
}

// Resolve turns key names into the keys to press. Names are case-insensitive (`'T'` is the t key, not shift-t); a
// character that needs shift (or AltGr, ctrl+alt) on the layout adds it. Letters and digits are their own virtual keys
// on every layout, so `['cmd', 'z']` is ctrl+z on any keyboard; punctuation follows the layout, else the US one.
func Resolve(names []string, layout Layout) (Stroke, error) {
	if len(names) == 0 {
		return Stroke{}, fmt.Errorf("keys must not be empty")
	}
	if len(names) > 8 {
		return Stroke{}, fmt.Errorf("at most 8 keys at once")
	}
	var modifiers []Modifier
	var others []string
	for _, name := range names {
		if m, ignored, ok := ModifierNamed(name); ok {
			if !ignored {
				modifiers = addModifier(modifiers, m)
			}
			continue
		}
		others = append(others, name)
	}
	if len(others) > 1 {
		return Stroke{}, fmt.Errorf("one key besides the modifiers, not %d: %s", len(others), strings.Join(others, ", "))
	}
	if len(others) == 0 {
		return Stroke{Modifiers: modifiers}, nil
	}
	key, extra, ok := Lookup(others[0], layout)
	if !ok {
		return Stroke{}, fmt.Errorf("unknown key %q", others[0])
	}
	for _, m := range extra {
		modifiers = addModifier(modifiers, m)
	}
	return Stroke{Modifiers: modifiers, Key: &key}, nil
}

// Lookup finds one key by name or character, with the modifiers the character needs.
func Lookup(name string, layout Layout) (Key, []Modifier, bool) {
	if r := []rune(name); len(r) == 1 {
		if r[0] == ' ' {
			return Key{VK: VK_SPACE}, nil, true
		}
		return forChar(r[0], layout)
	}
	normalized := strings.Map(func(r rune) rune {
		if r == '_' || r == '-' || r == ' ' {
			return -1
		}
		return unicode.ToLower(r)
	}, name)
	if vk, ok := named[normalized]; ok {
		return Key{VK: vk, Extended: IsExtended(vk)}, nil, true
	}
	if r, ok := punctuationNames[normalized]; ok {
		return forChar(r, layout)
	}
	return Key{}, nil, false
}

func forChar(raw rune, layout Layout) (Key, []Modifier, bool) {
	r := unicode.ToLower(raw)
	// ASCII letters and digits are their own virtual keys (VK 'A'–'Z', '0'–'9') on every layout, and never add shift.
	if r >= 'a' && r <= 'z' {
		return Key{VK: uint16(r - 'a' + 'A')}, nil, true
	}
	if r >= '0' && r <= '9' {
		return Key{VK: uint16(r)}, nil, true
	}
	if layout != nil {
		if vk, state, ok := layout.VkKeyScan(r); ok && vk != 0 {
			var mods []Modifier
			if state&1 != 0 {
				mods = append(mods, Shift)
			}
			if state&2 != 0 {
				mods = append(mods, Ctrl)
			}
			if state&4 != 0 {
				mods = append(mods, Alt)
			}
			return Key{VK: uint16(vk), Extended: IsExtended(uint16(vk))}, mods, true
		}
	}
	if vk, ok := usPlain[r]; ok {
		return Key{VK: vk}, nil, true
	}
	if vk, ok := usShifted[r]; ok {
		return Key{VK: vk}, []Modifier{Shift}, true
	}
	return Key{}, nil, false
}

// ---------------------------------------------------------------- typing

// PieceKind is what a piece of typed text is.
type PieceKind int

const (
	Text PieceKind = iota
	Newline
	TabKey
)

// Piece is a run of UTF-16 units typed with KEYEVENTF_UNICODE, or a line break (Return) or a tab (Tab).
type Piece struct {
	Kind  PieceKind
	Units []uint16
}

// ChunkLength is the most UTF-16 units sent in one go; a surrogate pair is never split.
const ChunkLength = 20

// Pieces splits text for key.type: "\n", "\r" and "\r\n" are one Return each, "\t" is Tab, the rest goes in runs.
func Pieces(text string) []Piece {
	var pieces []Piece
	var run []uint16
	flush := func() {
		if len(run) > 0 {
			pieces = append(pieces, Piece{Kind: Text, Units: run})
		}
		run = nil
	}
	previousCR := false
	for _, r := range text {
		switch r {
		case '\n', '\r':
			if !(r == '\n' && previousCR) {
				flush()
				pieces = append(pieces, Piece{Kind: Newline})
			}
			previousCR = r == '\r'
			continue
		case '\t':
			flush()
			pieces = append(pieces, Piece{Kind: TabKey})
			previousCR = false
			continue
		}
		previousCR = false
		units := utf16.Encode([]rune{r})
		if len(run)+len(units) > ChunkLength {
			flush()
		}
		run = append(run, units...)
	}
	flush()
	return pieces
}
