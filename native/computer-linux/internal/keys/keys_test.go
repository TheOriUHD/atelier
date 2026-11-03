package keys

import (
	"slices"
	"testing"
)

// usKeymap is a small US keyboard: keycode 38 is a/A, 39 is s/S, 10 is 1/!, 61 is slash/question, 37 is Control_L, 50 is
// Shift_L, 9 is Escape. A second group (columns 2–3) puts б/Б on keycode 38.
func usKeymap() *Keymap {
	km := &Keymap{Min: 8, Max: 100, Per: 4}
	km.Syms = make([]uint32, (100-8+1)*4)
	set := func(code int, syms ...uint32) { copy(km.Syms[(code-8)*4:], syms) }
	set(9, XKEscape)
	set(10, '1', '!')
	set(37, XKControlL)
	set(38, 'a', 'A', 0x01000431, 0x01000411)
	set(39, 's', 'S')
	set(50, XKShiftL)
	set(61, '/', '?')
	set(64, XKAltL)
	return km
}

func TestResolveNamesAndModifiers(t *testing.T) {
	s, err := Resolve([]string{"cmd", "shift", "T"})
	if err != nil || !slices.Equal(s.Modifiers, []Modifier{Ctrl, Shift}) || s.Sym != 't' {
		t.Errorf("cmd+shift+T: %+v %v", s, err)
	}
	for name, want := range map[string]uint32{"return": XKReturn, "Enter": XKReturn, "esc": XKEscape, "delete": XKBackSpace, "forwarddelete": XKDelete, "page_down": XKPageDown, "F5": XKF1 + 4, "ArrowLeft": XKLeft, "slash": '/', " ": XKSpace} {
		got, err := Resolve([]string{name})
		if err != nil || got.Sym != want {
			t.Errorf("%q: %#x %v, want %#x", name, got.Sym, err, want)
		}
	}
	if s, _ := Resolve([]string{"super", "e"}); !slices.Equal(s.Modifiers, []Modifier{Super}) {
		t.Errorf("super: %+v", s)
	}
	if s, err := Resolve([]string{"fn", "a"}); err != nil || len(s.Modifiers) != 0 {
		t.Errorf("fn is ignored: %+v %v", s, err)
	}
	for _, bad := range [][]string{{}, {"a", "b"}, {"nosuchkey"}, {"ctrl", "ctrl", "ctrl", "ctrl", "ctrl", "ctrl", "ctrl", "ctrl", "a"}} {
		if _, err := Resolve(bad); err == nil {
			t.Errorf("%v resolved", bad)
		}
	}
}

func TestModifiersForClicks(t *testing.T) {
	m, err := Modifiers([]string{"cmd", "option", "fn"})
	if err != nil || !slices.Equal(m, []Modifier{Ctrl, Alt}) {
		t.Errorf("%v %v", m, err)
	}
	if _, err := Modifiers([]string{"hyper"}); err == nil {
		t.Error("hyper is no modifier")
	}
}

func TestPlanFindsTheKeyAndTheShiftItNeeds(t *testing.T) {
	km := usKeymap()
	cases := []struct {
		sym  uint32
		want Plan
	}{{'a', Plan{Code: 38}}, {'A', Plan{Code: 38, Shift: true}}, {'!', Plan{Code: 10, Shift: true}}, {'?', Plan{Code: 61, Shift: true}}, {'/', Plan{Code: 61}}}
	for _, c := range cases {
		if got, ok := km.Plan(c.sym); !ok || got != c.want {
			t.Errorf("%q: %+v %v, want %+v", rune(c.sym), got, ok, c.want)
		}
	}
	if _, ok := km.Plan('€'); ok {
		t.Error("a character the layout lacks has a plan")
	}
	if _, ok := km.Plan(0x01000431); ok {
		t.Error("the second group's character is not typeable while the first is in use")
	}
}

func TestCapsLockSwapsShiftForLettersOnly(t *testing.T) {
	km := usKeymap()
	km.CapsLock = true
	if p, _ := km.Plan('a'); !p.Shift {
		t.Error("with Caps Lock on, a lowercase letter needs shift")
	}
	if p, _ := km.Plan('A'); p.Shift {
		t.Error("with Caps Lock on, an uppercase letter needs no shift")
	}
	if p, _ := km.Plan('!'); !p.Shift {
		t.Error("Caps Lock doesn't change symbols")
	}
}

func TestTheSecondGroupIsUsedWhileItIsInUse(t *testing.T) {
	km := usKeymap()
	km.Group = 1
	if p, ok := km.Plan(0x01000431); !ok || p != (Plan{Code: 38}) {
		t.Errorf("б in group 2: %+v %v", p, ok)
	}
	if _, ok := km.Plan('a'); ok {
		t.Error("a is not in group 2")
	}
	// A shortcut finds a in any group.
	if p, ok := km.PlanAny('a'); !ok || p.Code != 38 {
		t.Errorf("ctrl+a in group 2: %+v %v", p, ok)
	}
}

func TestModifierKeycodesAndSpare(t *testing.T) {
	km := usKeymap()
	for m, want := range map[Modifier]uint8{Ctrl: 37, Shift: 50, Alt: 64} {
		if code, ok := km.ModifierCode(m); !ok || code != want {
			t.Errorf("%v: %d %v", m, code, ok)
		}
	}
	if _, ok := km.ModifierCode(Super); ok {
		t.Error("no super key in range")
	}
	if got := km.Spare(); got != 100 {
		t.Errorf("spare: %d", got)
	}
	if !km.IsModifierCode(37) || km.IsModifierCode(38) {
		t.Error("modifier codes")
	}
	if code, _ := km.CodeOf(XKEscape); code != 9 {
		t.Errorf("escape: %d", code)
	}
}

func TestSymsOfCharacters(t *testing.T) {
	if SymOf('T') != 't' || TypedSym('T') != 'T' || TypedSym('ü') != 0xfc || TypedSym('€') != 0x010020ac {
		t.Errorf("syms: %#x %#x %#x %#x", SymOf('T'), TypedSym('T'), TypedSym('ü'), TypedSym('€'))
	}
}

func TestPiecesSplitLineBreaksAndTabs(t *testing.T) {
	got := Pieces("a\r\nb\tc\nd\re")
	var kinds []PieceKind
	for _, p := range got {
		kinds = append(kinds, p.Kind)
	}
	want := []PieceKind{Char, Newline, Char, TabKey, Char, Newline, Char, Newline, Char}
	if !slices.Equal(kinds, want) {
		t.Errorf("%v, want %v", kinds, want)
	}
}
