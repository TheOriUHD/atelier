// Package keys turns the key names of key.press / key.hold (`['cmd', 'shift', 't']`, `['return']`, `['f5']`) into X11
// keysyms, and keysyms into the keycodes of the keyboard that is attached now (the core keyboard mapping), and splits
// text for key.type. Pure: the X connection that reads the mapping and sends the keys is internal/x11's.
package keys

import (
	"fmt"
	"strings"
	"unicode"
)

// Keysyms used here (X11/keysymdef.h).
const (
	XKSpace      = 0x0020
	XKBackSpace  = 0xff08
	XKTab        = 0xff09
	XKReturn     = 0xff0d
	XKPause      = 0xff13
	XKScrollLock = 0xff14
	XKEscape     = 0xff1b
	XKHome       = 0xff50
	XKLeft       = 0xff51
	XKUp         = 0xff52
	XKRight      = 0xff53
	XKDown       = 0xff54
	XKPageUp     = 0xff55
	XKPageDown   = 0xff56
	XKEnd        = 0xff57
	XKPrint      = 0xff61
	XKInsert     = 0xff63
	XKMenu       = 0xff67
	XKNumLock    = 0xff7f
	XKF1         = 0xffbe
	XKShiftL     = 0xffe1
	XKShiftR     = 0xffe2
	XKControlL   = 0xffe3
	XKControlR   = 0xffe4
	XKCapsLock   = 0xffe5
	XKMetaL      = 0xffe7
	XKMetaR      = 0xffe8
	XKAltL       = 0xffe9
	XKAltR       = 0xffea
	XKSuperL     = 0xffeb
	XKSuperR     = 0xffec
	XKDelete     = 0xffff
)

// Modifier is a modifier key held around a key or a click.
type Modifier int

const (
	Ctrl Modifier = iota
	Shift
	Alt
	Super
)

func (m Modifier) String() string {
	return [...]string{"ctrl", "shift", "alt", "super"}[m]
}

// Keysyms are the keysyms of the keys that act as this modifier, the left one first.
func (m Modifier) Keysyms() []uint32 {
	switch m {
	case Ctrl:
		return []uint32{XKControlL, XKControlR}
	case Shift:
		return []uint32{XKShiftL, XKShiftR}
	case Alt:
		return []uint32{XKAltL, XKAltR, XKMetaL, XKMetaR}
	default:
		return []uint32{XKSuperL, XKSuperR}
	}
}

// IsModifierSym reports the keysyms of modifier and lock keys (the control watch ignores them, like the Mac's
// flagsChanged).
func IsModifierSym(sym uint32) bool {
	return sym >= XKShiftL && sym <= XKSuperR+2 || sym == 0xfe03 /* ISO_Level3_Shift */ || sym == 0xff7e /* Mode_switch */
}

// ModifierNamed resolves a modifier name, case-insensitively. `cmd`/`command` is ctrl: the primary modifier of a
// desktop's shortcuts (cmd+c copies), as on Windows. `win`/`super`/`meta` is the Super key. `fn` has no equivalent the
// OS sees: it is accepted and ignored (`ignored` true).
func ModifierNamed(name string) (m Modifier, ignored bool, ok bool) {
	switch strings.ToLower(name) {
	case "ctrl", "control", "cmd", "command":
		return Ctrl, false, true
	case "shift":
		return Shift, false, true
	case "alt", "option", "opt":
		return Alt, false, true
	case "win", "super", "meta", "windows":
		return Super, false, true
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

// Stroke is a resolved key.press / key.hold: the modifiers to hold, in order, and at most one key (a keysym).
type Stroke struct {
	Modifiers []Modifier
	// Sym is 0 when only modifiers are pressed.
	Sym uint32
}

// named are the keys by name (lowercase, without `_`, `-` or spaces).
var named = func() map[string]uint32 {
	keys := map[string]uint32{
		"return": XKReturn, "enter": XKReturn,
		"tab":   XKTab,
		"space": XKSpace, "spacebar": XKSpace,
		"escape": XKEscape, "esc": XKEscape,
		// The Mac naming: delete is the key left of it, backspace.
		"delete": XKBackSpace, "backspace": XKBackSpace,
		"forwarddelete": XKDelete, "del": XKDelete,
		"up": XKUp, "down": XKDown, "left": XKLeft, "right": XKRight,
		"home": XKHome, "end": XKEnd,
		"pageup": XKPageUp, "pgup": XKPageUp, "pagedown": XKPageDown, "pgdn": XKPageDown,
		"insert": XKInsert, "ins": XKInsert,
		"capslock": XKCapsLock, "printscreen": XKPrint, "prtsc": XKPrint, "pause": XKPause,
		"numlock": XKNumLock, "scrolllock": XKScrollLock, "contextmenu": XKMenu, "apps": XKMenu, "menu": XKMenu,
	}
	for _, d := range []string{"up", "down", "left", "right"} {
		keys["arrow"+d] = keys[d]
		keys[d+"arrow"] = keys[d]
	}
	for i := 0; i < 24; i++ {
		keys[fmt.Sprintf("f%d", i+1)] = uint32(XKF1 + i)
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

// SymOf is the keysym of a character: Latin-1 characters are their own, the rest are Unicode keysyms
// (0x01000000 + the code point). Letters are lowercase: a key name `T` is the t key, not shift-t.
func SymOf(r rune) uint32 {
	r = unicode.ToLower(r)
	if r >= 0x20 && r <= 0x7e || r >= 0xa0 && r <= 0xff {
		return uint32(r)
	}
	return 0x01000000 + uint32(r)
}

// Resolve turns key names into the keys to press. Names are case-insensitive; a character that needs shift (or AltGr)
// on the keyboard gets it from Keymap.Plan, not from here.
func Resolve(names []string) (Stroke, error) {
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
	sym, ok := Lookup(others[0])
	if !ok {
		return Stroke{}, fmt.Errorf("unknown key %q", others[0])
	}
	return Stroke{Modifiers: modifiers, Sym: sym}, nil
}

// Lookup finds one key by name or character.
func Lookup(name string) (uint32, bool) {
	if r := []rune(name); len(r) == 1 {
		return SymOf(r[0]), true
	}
	normalized := strings.Map(func(r rune) rune {
		if r == '_' || r == '-' || r == ' ' {
			return -1
		}
		return unicode.ToLower(r)
	}, name)
	if sym, ok := named[normalized]; ok {
		return sym, true
	}
	if r, ok := punctuationNames[normalized]; ok {
		return SymOf(r), true
	}
	return 0, false
}

// ---------------------------------------------------------------- the keyboard

// Keymap is the keyboard as the X server has it now: the core mapping (keysyms per keycode: columns 0 and 1 are the
// first group's two levels, 2 and 3 the second group's) and the state that changes what a key types.
type Keymap struct {
	Min, Max uint8
	// Per is the number of keysyms for each keycode.
	Per  int
	Syms []uint32
	// Group is the layout in use (0 is the first), from the state bits 13–14 of the pointer query.
	Group int
	// CapsLock is on: letters come out upper-case unless shift is held.
	CapsLock bool
}

func (k *Keymap) sym(code uint8, column int) uint32 {
	if code < k.Min || code > k.Max || column >= k.Per {
		return 0
	}
	return k.Syms[int(code-k.Min)*k.Per+column]
}

// Plan is how one key types a keysym.
type Plan struct {
	Code  uint8
	Shift bool
}

func isLetter(sym uint32) bool {
	return sym < 0x01000000 && unicode.IsLetter(rune(sym)) || sym >= 0x01000000 && unicode.IsLetter(rune(sym-0x01000000))
}

// Plan finds the key that types sym in the layout in use: its keycode and whether shift must be held. ok is false
// when no key of that layout types it (the caller binds a spare key to it for the moment).
func (k *Keymap) Plan(sym uint32) (Plan, bool) {
	if sym == 0 {
		return Plan{}, false
	}
	base := 0
	if k.Group > 0 && k.Per >= 2*k.Group+2 {
		base = 2 * k.Group
	}
	var shifted *Plan
	for code := int(k.Min); code <= int(k.Max); code++ {
		c := uint8(code)
		if k.sym(c, base) == sym {
			return k.caps(Plan{Code: c}, sym), true
		}
		if shifted == nil && k.sym(c, base+1) == sym && k.sym(c, base+1) != k.sym(c, base) {
			p := Plan{Code: c, Shift: true}
			shifted = &p
		}
	}
	if shifted != nil {
		return k.caps(*shifted, sym), true
	}
	return Plan{}, false
}

// caps flips shift for a letter while Caps Lock is on: the lock already capitalizes, shift undoes it.
func (k *Keymap) caps(p Plan, sym uint32) Plan {
	if k.CapsLock && isLetter(sym) {
		p.Shift = !p.Shift
	}
	return p
}

// PlanAny is Plan, then any key of any layout that has the keysym (shortcuts: `ctrl+a` is the key that is 'a' on the
// first layout even while another one is in use, as applications read shortcuts by key).
func (k *Keymap) PlanAny(sym uint32) (Plan, bool) {
	if p, ok := k.Plan(sym); ok {
		return p, true
	}
	for code := int(k.Min); code <= int(k.Max); code++ {
		for col := 0; col < k.Per && col < 4; col++ {
			if k.sym(uint8(code), col) == sym {
				return Plan{Code: uint8(code), Shift: col%2 == 1}, true
			}
		}
	}
	return Plan{}, false
}

// ModifierCode is a key that acts as the modifier (the left one when there are two).
func (k *Keymap) ModifierCode(m Modifier) (uint8, bool) {
	for _, sym := range m.Keysyms() {
		for code := int(k.Min); code <= int(k.Max); code++ {
			if k.sym(uint8(code), 0) == sym {
				return uint8(code), true
			}
		}
	}
	return 0, false
}

// CodeOf is the keycode that has the keysym in its first column.
func (k *Keymap) CodeOf(sym uint32) (uint8, bool) {
	for code := int(k.Min); code <= int(k.Max); code++ {
		if k.sym(uint8(code), 0) == sym {
			return uint8(code), true
		}
	}
	return 0, false
}

// Spare is a keycode with no symbols at all, which a character the layout lacks can be bound to for a moment. The
// last keycode when none is free (what it held is restored after).
func (k *Keymap) Spare() uint8 {
	for code := int(k.Max); code >= int(k.Min); code-- {
		empty := true
		for col := 0; col < k.Per; col++ {
			if k.sym(uint8(code), col) != 0 {
				empty = false
				break
			}
		}
		if empty {
			return uint8(code)
		}
	}
	return k.Max
}

// IsModifierCode reports a keycode whose first symbol is a modifier or lock key.
func (k *Keymap) IsModifierCode(code uint8) bool {
	return IsModifierSym(k.sym(code, 0))
}

// ---------------------------------------------------------------- typing

// PieceKind is what a piece of typed text is.
type PieceKind int

const (
	Char PieceKind = iota
	Newline
	TabKey
)

// Piece is one character to type, or a line break (Return) or a tab (Tab).
type Piece struct {
	Kind PieceKind
	Rune rune
}

// Pieces splits text for key.type: "\n", "\r" and "\r\n" are one Return each, "\t" is Tab, the rest goes character by
// character.
func Pieces(text string) []Piece {
	var pieces []Piece
	previousCR := false
	for _, r := range text {
		switch r {
		case '\n', '\r':
			if !(r == '\n' && previousCR) {
				pieces = append(pieces, Piece{Kind: Newline})
			}
			previousCR = r == '\r'
			continue
		case '\t':
			pieces = append(pieces, Piece{Kind: TabKey})
		default:
			pieces = append(pieces, Piece{Kind: Char, Rune: r})
		}
		previousCR = false
	}
	return pieces
}

// TypedSym is the keysym a typed character is: unlike a key name, its case counts (the Plan adds shift for 'A').
func TypedSym(r rune) uint32 {
	if r >= 0x20 && r <= 0x7e || r >= 0xa0 && r <= 0xff {
		return uint32(r)
	}
	return 0x01000000 + uint32(r)
}
