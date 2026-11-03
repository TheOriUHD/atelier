package input

import (
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
	"atelier.dev/computer-linux/internal/rpc"
)

type fakeSender struct {
	mu      sync.Mutex
	events  []Event
	bound   []uint32
	restore int
	swapped bool
	fail    error
}

func (f *fakeSender) Send(e []Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.events = append(f.events, e...)
	return nil
}

// Keycodes: 37 Control_L, 50 Shift_L, 64 Alt_L, 9 Escape, 38 a/A, 61 slash/question.
func (f *fakeSender) Keymap() (*keys.Keymap, error) {
	km := &keys.Keymap{Min: 8, Max: 100, Per: 2}
	km.Syms = make([]uint32, (100-8+1)*2)
	set := func(code int, a, b uint32) { km.Syms[(code-8)*2], km.Syms[(code-8)*2+1] = a, b }
	set(9, keys.XKEscape, 0)
	set(37, keys.XKControlL, 0)
	set(38, 'a', 'A')
	set(50, keys.XKShiftL, 0)
	set(61, '/', '?')
	set(64, keys.XKAltL, 0)
	return km, nil
}
func (f *fakeSender) Button(b Button) uint8 {
	n := map[Button]uint8{Left: 1, Middle: 2, Right: 3}[b]
	if f.swapped && n != 2 {
		return 4 - n
	}
	return n
}
func (f *fakeSender) Pointer() (proto.Point, bool) { return proto.Point{X: 9, Y: 9}, true }
func (f *fakeSender) Screen() Screen               { return Screen{Width: 1000, Height: 800} }
func (f *fakeSender) Bind(sym uint32) (uint8, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bound = append(f.bound, sym)
	return 99, func() { f.restore++ }, nil
}

func newController() (*Controller, *fakeSender) {
	f := &fakeSender{}
	c := NewController(f)
	c.SetSleep(func(time.Duration) {})
	return c, f
}

func kinds(events []Event) []string {
	var out []string
	for _, e := range events {
		out = append(out, [...]string{"kd", "ku", "bd", "bu", "mv"}[e.Kind])
	}
	return out
}

func TestClickMovesThenPressesAndReleases(t *testing.T) {
	c, f := newController()
	if err := c.Click(proto.Point{X: 100.4, Y: 200.6}, Left, 2, nil); err != nil {
		t.Fatal(err)
	}
	want := []string{"mv", "bd", "bu", "bd", "bu"}
	if got := kinds(f.events); !slices.Equal(got, want) {
		t.Errorf("events %v, want %v", got, want)
	}
	if e := f.events[0]; e.X != 100 || e.Y != 201 {
		t.Errorf("the move went to %d,%d", e.X, e.Y)
	}
	if p := c.LastPointer(); p == nil || p.X != 100 || p.Y != 201 {
		t.Errorf("last pointer %v", p)
	}
}

func TestMovesAreKeptOnTheScreen(t *testing.T) {
	c, f := newController()
	_ = c.Move(proto.Point{X: -50, Y: 5000})
	if e := f.events[0]; e.X != 0 || e.Y != 799 {
		t.Errorf("clamped to %d,%d", e.X, e.Y)
	}
}

func TestSwappedButtonsStillMakeALeftClick(t *testing.T) {
	c, f := newController()
	f.swapped = true
	_ = c.Click(proto.Point{X: 1, Y: 1}, Left, 1, nil)
	if f.events[1].Detail != 3 {
		t.Errorf("a left click on a swapped mouse presses button %d", f.events[1].Detail)
	}
}

func TestClickWithModifiersHoldsThemAround(t *testing.T) {
	c, f := newController()
	mods, _ := keys.Modifiers([]string{"cmd", "shift"})
	if err := c.Click(proto.Point{X: 1, Y: 1}, Left, 1, mods); err != nil {
		t.Fatal(err)
	}
	var codes []uint8
	for _, e := range f.events {
		if e.Kind == KeyDown || e.Kind == KeyUp {
			codes = append(codes, e.Detail)
		}
	}
	if !slices.Equal(codes, []uint8{37, 50, 50, 37}) {
		t.Errorf("modifier keys %v", codes)
	}
}

func TestPressHoldsModifiersAndRepeats(t *testing.T) {
	c, f := newController()
	s, _ := keys.Resolve([]string{"ctrl", "a"})
	if err := c.Press(s, 2); err != nil {
		t.Fatal(err)
	}
	var codes []string
	for _, e := range f.events {
		codes = append(codes, kinds([]Event{e})[0]+string(rune('0'+e.Detail/10))+string(rune('0'+e.Detail%10)))
	}
	want := []string{"kd37", "kd38", "ku38", "kd38", "ku38", "ku37"}
	if !slices.Equal(codes, want) {
		t.Errorf("ctrl+a x2: %v, want %v", codes, want)
	}
}

func TestShiftIsAddedForACharacterThatNeedsIt(t *testing.T) {
	c, f := newController()
	s, _ := keys.Resolve([]string{"?"})
	s.Sym = '?'
	_ = c.Press(s, 1)
	if got := kinds(f.events); !slices.Equal(got, []string{"kd", "kd", "ku", "ku"}) || f.events[0].Detail != 50 || f.events[1].Detail != 61 {
		t.Errorf("shift+slash: %+v", f.events)
	}
	// Not twice when the caller already asked for shift.
	f.events = nil
	s2, _ := keys.Resolve([]string{"shift", "a"})
	_ = c.Press(s2, 1)
	if n := len(f.events); n != 4 {
		t.Errorf("shift+a sent %d events", n)
	}
}

func TestTypeUsesTheKeysOfTheLayoutWithShiftWhereNeeded(t *testing.T) {
	c, f := newController()
	if err := c.Type("aA"); err != nil {
		t.Fatal(err)
	}
	var downs []uint8
	for _, e := range f.events {
		if e.Kind == KeyDown {
			downs = append(downs, e.Detail)
		}
	}
	// a; shift, A.
	if !slices.Equal(downs, []uint8{38, 50, 38}) {
		t.Errorf("keys %v", downs)
	}
	if len(f.bound) != 0 {
		t.Errorf("a spare key was bound for %v", f.bound)
	}
}

func TestTypeBindsACharacterTheLayoutLacks(t *testing.T) {
	c, f := newController()
	if err := c.Type("€"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.bound, []uint32{0x010020ac}) || f.restore != 1 {
		t.Errorf("bound %v, restored %d", f.bound, f.restore)
	}
	if len(f.events) != 2 || f.events[0].Detail != 99 {
		t.Errorf("events %+v", f.events)
	}
}

func TestScrollClicksTheWheelButtons(t *testing.T) {
	v, h := WheelClicks(0, 3)
	if !slices.Equal(v, []uint8{5, 5, 5}) || len(h) != 0 {
		t.Errorf("down 3: %v %v", v, h)
	}
	v, h = WheelClicks(-2, -1)
	if !slices.Equal(v, []uint8{4}) || !slices.Equal(h, []uint8{6, 6}) {
		t.Errorf("up 1, left 2: %v %v", v, h)
	}
	c, f := newController()
	_ = c.Scroll(proto.Point{X: 5, Y: 5}, 1, 2)
	if got := kinds(f.events); !slices.Equal(got, []string{"mv", "bd", "bu", "bd", "bu", "bd", "bu"}) {
		t.Errorf("scroll events %v", got)
	}
}

func TestDragPathEndsAtTheTarget(t *testing.T) {
	path := DragPath(proto.Point{X: 0, Y: 0}, proto.Point{X: 100, Y: 50}, 10)
	if len(path) != 10 || path[9] != (proto.Point{X: 100, Y: 50}) {
		t.Errorf("%v", path)
	}
	c, f := newController()
	_ = c.Drag(proto.Point{X: 0, Y: 0}, proto.Point{X: 100, Y: 50}, Left)
	got := kinds(f.events)
	if got[0] != "mv" || got[1] != "bd" || got[len(got)-1] != "bu" {
		t.Errorf("drag events %v", got)
	}
}

func TestStopRefusesInputAndLetsGoOfWhatIsHeld(t *testing.T) {
	c, f := newController()
	s, _ := keys.Resolve([]string{"a"})
	done := make(chan error, 1)
	go func() { done <- c.Hold(s, 5000) }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		n := len(f.events)
		f.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	c.Stop()
	if err := <-done; !rpc.IsStopped(err) {
		t.Errorf("the hold ended with %v", err)
	}
	f.mu.Lock()
	last := f.events[len(f.events)-1]
	f.mu.Unlock()
	if last.Kind != KeyUp || last.Detail != 38 {
		t.Errorf("the held key wasn't let go: %+v", last)
	}
	if err := c.Move(proto.Point{X: 1, Y: 1}); !rpc.IsStopped(err) {
		t.Errorf("input after the stop: %v", err)
	}
	c.Resume()
	if err := c.Move(proto.Point{X: 1, Y: 1}); err != nil {
		t.Errorf("input after resume: %v", err)
	}
}

func TestAFailureLetsGoOfWhatWasPressed(t *testing.T) {
	s, _ := keys.Resolve([]string{"ctrl", "a"})
	// The send of the second key fails: the control key already down is let go.
	fail := &failingAfter{fakeSender: &fakeSender{}, after: 1, err: errors.New("boom")}
	c := NewController(fail)
	c.SetSleep(func(time.Duration) {})
	if err := c.Press(s, 1); err == nil {
		t.Fatal("the failure wasn't reported")
	}
	fail.mu.Lock()
	defer fail.mu.Unlock()
	if len(fail.events) < 2 || fail.events[len(fail.events)-1].Kind != KeyUp || fail.events[len(fail.events)-1].Detail != 37 {
		t.Errorf("events %+v", fail.events)
	}
}

type failingAfter struct {
	*fakeSender
	after, n int
	err      error
}

func (f *failingAfter) Send(e []Event) error {
	f.mu.Lock()
	f.n++
	fail := f.n > f.after && e[0].Kind != KeyUp
	f.mu.Unlock()
	if fail {
		return f.err
	}
	return f.fakeSender.Send(e)
}

func TestOwnKeysAndButtonsAreRememberedForAMoment(t *testing.T) {
	c, _ := newController()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	s, _ := keys.Resolve([]string{"a"})
	_ = c.Press(s, 1)
	_ = c.Click(proto.Point{X: 1, Y: 1}, Left, 1, nil)
	if !c.KeyIsOurs(38) || !c.ButtonIsOurs(1) {
		t.Error("what it just sent is its own")
	}
	if c.KeyIsOurs(39) || c.ButtonIsOurs(3) {
		t.Error("what it didn't send is the person's")
	}
	now = now.Add(200 * time.Millisecond)
	if c.KeyIsOurs(38) || c.ButtonIsOurs(1) {
		t.Error("after the grace period a press is the person's")
	}
}

func TestEscapeIsOwnedWhileTheHelperPressesIt(t *testing.T) {
	c, _ := newController()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	if c.OwnsEscape() {
		t.Fatal("owns Esc before sending it")
	}
	s, _ := keys.Resolve([]string{"escape"})
	_ = c.Press(s, 1)
	if !c.OwnsEscape() {
		t.Error("just sent Esc")
	}
	now = now.Add(400 * time.Millisecond)
	if c.OwnsEscape() {
		t.Error("Esc was sent a while ago")
	}
}

func TestSetPointerBaselineOnlyFillsAnEmptyOne(t *testing.T) {
	c, _ := newController()
	c.SetPointerBaseline(proto.Point{X: 5, Y: 5})
	c.SetPointerBaseline(proto.Point{X: 99, Y: 99})
	if p := c.LastPointer(); p.X != 5 {
		t.Errorf("%v", p)
	}
}
