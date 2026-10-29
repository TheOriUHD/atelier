package keys

import (
	"slices"
	"testing"
	"unicode/utf16"
)

// usLayout is VkKeyScanExW on a US keyboard, for the characters these tests use.
type usLayout struct{}

func (usLayout) VkKeyScan(r rune) (uint8, uint8, bool) {
	if vk, ok := usPlain[r]; ok {
		return uint8(vk), 0, true
	}
	if vk, ok := usShifted[r]; ok {
		return uint8(vk), 1, true
	}
	return 0, 0, false
}

// germanLayout: a few keys of the German layout, where '@' is AltGr+Q (ctrl+alt) and '-' is on VK_OEM_MINUS, '#' on
// VK_OEM_2, '/' is shift+7.
type germanLayout struct{}

func (germanLayout) VkKeyScan(r rune) (uint8, uint8, bool) {
	switch r {
	case '@':
		return 'Q', 6, true
	case '-':
		return VK_OEM_MINUS, 0, true
	case '#':
		return VK_OEM_2, 0, true
	case '/':
		return '7', 1, true
	case 'ü':
		return VK_OEM_1, 0, true
	}
	return 0, 0, false
}

func stroke(t *testing.T, names []string, layout Layout) Stroke {
	t.Helper()
	s, err := Resolve(names, layout)
	if err != nil {
		t.Fatalf("%v: %v", names, err)
	}
	return s
}

func TestModifiersAndLetter(t *testing.T) {
	s := stroke(t, []string{"cmd", "shift", "t"}, usLayout{})
	if !slices.Equal(s.Modifiers, []Modifier{Ctrl, Shift}) || s.Key == nil || s.Key.VK != 'T' || s.Key.Extended {
		t.Errorf("cmd+shift+t: %+v %+v", s.Modifiers, s.Key)
	}
}

func TestModifierAliases(t *testing.T) {
	cases := map[string]Modifier{
		"ctrl": Ctrl, "control": Ctrl, "cmd": Ctrl, "command": Ctrl, "CMD": Ctrl,
		"shift": Shift, "Shift": Shift,
		"alt": Alt, "option": Alt, "opt": Alt,
		"win": Win, "super": Win, "meta": Win,
	}
	for name, want := range cases {
		m, ignored, ok := ModifierNamed(name)
		if !ok || ignored || m != want {
			t.Errorf("%s: %v %v %v", name, m, ignored, ok)
		}
	}
	if _, ignored, ok := ModifierNamed("fn"); !ok || !ignored {
		t.Error("fn is accepted and ignored")
	}
	// cmd and ctrl are the same key: held once.
	if s := stroke(t, []string{"cmd", "ctrl", "alt", "a"}, nil); !slices.Equal(s.Modifiers, []Modifier{Ctrl, Alt}) {
		t.Errorf("cmd+ctrl+alt: %v", s.Modifiers)
	}
	if s := stroke(t, []string{"fn", "f5"}, nil); len(s.Modifiers) != 0 || s.Key.VK != VK_F1+4 {
		t.Errorf("fn+f5: %+v", s)
	}
	if Ctrl.VK() != VK_CONTROL || Shift.VK() != VK_SHIFT || Alt.VK() != VK_MENU || Win.VK() != VK_LWIN {
		t.Error("modifier virtual keys")
	}
	if mods, err := Modifiers([]string{"cmd", "shift", "fn"}); err != nil || !slices.Equal(mods, []Modifier{Ctrl, Shift}) {
		t.Errorf("Modifiers: %v %v", mods, err)
	}
	if _, err := Modifiers([]string{"hyper"}); err == nil {
		t.Error("an unknown modifier")
	}
	// Only modifiers.
	if s := stroke(t, []string{"win"}, nil); s.Key != nil || !slices.Equal(s.Modifiers, []Modifier{Win}) {
		t.Errorf("win alone: %+v", s)
	}
}

func TestNamedKeys(t *testing.T) {
	cases := map[string]struct {
		vk       uint16
		extended bool
	}{
		"return": {VK_RETURN, false}, "enter": {VK_RETURN, false}, "Return": {VK_RETURN, false},
		"tab": {VK_TAB, false}, "space": {VK_SPACE, false}, " ": {VK_SPACE, false},
		"esc": {VK_ESCAPE, false}, "escape": {VK_ESCAPE, false},
		"delete": {VK_BACK, false}, "backspace": {VK_BACK, false},
		"forward_delete": {VK_DELETE, true}, "forwarddelete": {VK_DELETE, true}, "del": {VK_DELETE, true},
		"up": {VK_UP, true}, "down": {VK_DOWN, true}, "left": {VK_LEFT, true}, "right": {VK_RIGHT, true},
		"arrowup": {VK_UP, true}, "ArrowLeft": {VK_LEFT, true}, "downarrow": {VK_DOWN, true},
		"home": {VK_HOME, true}, "end": {VK_END, true},
		"pageup": {VK_PRIOR, true}, "page_up": {VK_PRIOR, true}, "pagedown": {VK_NEXT, true}, "page_down": {VK_NEXT, true},
		"insert": {VK_INSERT, true}, "f1": {VK_F1, false}, "F12": {VK_F1 + 11, false}, "f24": {VK_F24, false},
	}
	for name, want := range cases {
		k, mods, ok := Lookup(name, usLayout{})
		if !ok || k.VK != want.vk || k.Extended != want.extended || len(mods) != 0 {
			t.Errorf("%q: %+v %v %v, want %#x extended=%v", name, k, mods, ok, want.vk, want.extended)
		}
	}
	if _, err := Resolve([]string{"f25"}, nil); err == nil {
		t.Error("f25 isn't a key")
	}
}

func TestExtendedKeys(t *testing.T) {
	for _, vk := range []uint16{VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_INSERT, VK_DELETE, VK_RCONTROL, VK_RMENU, VK_DIVIDE, VK_LWIN} {
		if !IsExtended(vk) {
			t.Errorf("%#x is extended", vk)
		}
	}
	for _, vk := range []uint16{VK_RETURN, VK_BACK, VK_CONTROL, VK_MENU, VK_SHIFT, 'A', VK_F1} {
		if IsExtended(vk) {
			t.Errorf("%#x isn't extended", vk)
		}
	}
}

func TestLettersDigitsAndPunctuation(t *testing.T) {
	for _, layout := range []Layout{nil, usLayout{}, germanLayout{}} {
		if s := stroke(t, []string{"A"}, layout); s.Key.VK != 'A' || len(s.Modifiers) != 0 {
			t.Errorf("'A' is the a key without shift: %+v", s)
		}
		if s := stroke(t, []string{"z"}, layout); s.Key.VK != 'Z' {
			t.Errorf("z: %+v", s)
		}
		if s := stroke(t, []string{"7"}, layout); s.Key.VK != '7' || len(s.Modifiers) != 0 {
			t.Errorf("7 never adds shift: %+v", s)
		}
	}
	// US punctuation, plain and shifted.
	if s := stroke(t, []string{"-"}, usLayout{}); s.Key.VK != VK_OEM_MINUS || len(s.Modifiers) != 0 {
		t.Errorf("-: %+v", s)
	}
	if s := stroke(t, []string{"?"}, usLayout{}); s.Key.VK != VK_OEM_2 || !slices.Equal(s.Modifiers, []Modifier{Shift}) {
		t.Errorf("? adds shift: %+v", s)
	}
	if s := stroke(t, []string{"shift", "?"}, usLayout{}); !slices.Equal(s.Modifiers, []Modifier{Shift}) {
		t.Errorf("shift isn't added twice: %+v", s)
	}
	if s := stroke(t, []string{"cmd", "slash"}, usLayout{}); s.Key.VK != VK_OEM_2 || !slices.Equal(s.Modifiers, []Modifier{Ctrl}) {
		t.Errorf("cmd+slash by name: %+v", s)
	}
	// The layout decides: '@' is AltGr+Q on a German keyboard, '/' shift+7.
	if s := stroke(t, []string{"@"}, germanLayout{}); s.Key.VK != 'Q' || !slices.Equal(s.Modifiers, []Modifier{Ctrl, Alt}) {
		t.Errorf("@ on German: %+v", s)
	}
	if s := stroke(t, []string{"/"}, germanLayout{}); s.Key.VK != '7' || !slices.Equal(s.Modifiers, []Modifier{Shift}) {
		t.Errorf("/ on German: %+v", s)
	}
	if s := stroke(t, []string{"Ü"}, germanLayout{}); s.Key.VK != VK_OEM_1 || len(s.Modifiers) != 0 {
		t.Errorf("Ü is the ü key: %+v", s)
	}
	// A character the layout doesn't have: the US key.
	if s := stroke(t, []string{"["}, germanLayout{}); s.Key.VK != VK_OEM_4 {
		t.Errorf("[ falls back to US: %+v", s)
	}
	// Nothing types it.
	if _, err := Resolve([]string{"é"}, usLayout{}); err == nil {
		t.Error("é on a US keyboard")
	}
}

func TestResolveLimits(t *testing.T) {
	if _, err := Resolve(nil, nil); err == nil {
		t.Error("no keys")
	}
	if _, err := Resolve([]string{"a", "b"}, nil); err == nil {
		t.Error("two keys")
	}
	if _, err := Resolve([]string{"ctrl", "shift", "alt", "win", "cmd", "ctrl", "shift", "alt", "a"}, nil); err == nil {
		t.Error("nine names")
	}
}

func TestPieces(t *testing.T) {
	pieces := Pieces("ab\r\ncd\ref\tg\n")
	kinds := []PieceKind{}
	for _, p := range pieces {
		kinds = append(kinds, p.Kind)
	}
	want := []PieceKind{Text, Newline, Text, Newline, Text, TabKey, Text, Newline}
	if !slices.Equal(kinds, want) {
		t.Fatalf("pieces: %v, want %v", kinds, want)
	}
	if string(utf16.Decode(pieces[0].Units)) != "ab" {
		t.Errorf("first run: %v", pieces[0].Units)
	}
	// Runs of at most 20 units; a surrogate pair is never split.
	text := "0123456789012345678😀x"
	runs := Pieces(text)
	if len(runs) != 2 || len(runs[0].Units) != 19 || len(runs[1].Units) != 3 {
		t.Fatalf("runs: %d (%v)", len(runs), runs)
	}
	if !utf16.IsSurrogate(rune(runs[1].Units[0])) || string(utf16.Decode(runs[1].Units)) != "😀x" {
		t.Errorf("the pair stays together: %v", runs[1].Units)
	}
}

func TestModifierVKs(t *testing.T) {
	for _, vk := range []uint32{VK_SHIFT, VK_LSHIFT, VK_RCONTROL, VK_LMENU, VK_LWIN, VK_CAPITAL} {
		if !IsModifierVK(vk) {
			t.Errorf("%#x is a modifier", vk)
		}
	}
	if IsModifierVK('A') || IsModifierVK(VK_ESCAPE) {
		t.Error("a and esc aren't modifiers")
	}
}
