package input

import (
	"encoding/binary"
	"slices"
	"sync"
	"testing"
	"time"

	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

type fakeSender struct {
	mu      sync.Mutex
	events  []Event
	sends   []int
	cursor  []proto.Point
	swapped bool
}

func (f *fakeSender) Send(e []Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, e...)
	f.sends = append(f.sends, len(e))
	return nil
}
func (f *fakeSender) SetCursorPos(x, y int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cursor = append(f.cursor, proto.Point{X: float64(x), Y: float64(y)})
}
func (f *fakeSender) CursorPos() (proto.Point, bool) { return proto.Point{}, false }
func (f *fakeSender) VirtualScreen() Screen {
	// Two monitors: one left of the primary.
	return Screen{X: -1920, Y: 0, Width: 1920 + 2560, Height: 1440}
}
func (f *fakeSender) SwapButtons() bool         { return f.swapped }
func (f *fakeSender) ScanCode(vk uint16) uint16 { return vk + 0x100 }

func (f *fakeSender) take() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.events
	f.events = nil
	return e
}

func newController() (*Controller, *fakeSender) {
	s := &fakeSender{}
	c := NewController(s)
	c.SetSleep(func(time.Duration) {})
	return c, s
}

func TestTheTagIsATLR(t *testing.T) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], Tag)
	if string(b[:]) != "ATLR" {
		t.Errorf("tag: %q", b)
	}
}

func TestNormalize(t *testing.T) {
	s := Screen{X: -1920, Y: -200, Width: 4480, Height: 1640}
	for _, p := range []proto.Point{{X: -1920, Y: -200}, {X: 0, Y: 0}, {X: 1234, Y: 567}, {X: 2559, Y: 1439}, {X: -1, Y: 1}} {
		nx, ny := Normalize(p.X, p.Y, s)
		if nx < 0 || nx > 65535 || ny < 0 || ny > 65535 {
			t.Errorf("%v: out of range %d,%d", p, nx, ny)
		}
		// Windows maps a normalized coordinate back to n × size / 65536 pixels from the origin.
		bx := s.X + int(nx)*s.Width/65536
		by := s.Y + int(ny)*s.Height/65536
		if bx != int(p.X) || by != int(p.Y) {
			t.Errorf("%v → %d,%d → %d,%d", p, nx, ny, bx, by)
		}
	}
	// Off the screen: clamped to its edge.
	if nx, _ := Normalize(99999, 0, s); nx > 65535 {
		t.Errorf("clamped: %d", nx)
	}
	if nx, ny := Normalize(1, 1, Screen{}); nx != 0 || ny != 0 {
		t.Error("an empty screen")
	}
}

func TestWheelSteps(t *testing.T) {
	// Three lines are one notch (120); positive dy scrolls down: a negative wheel delta.
	v, h := WheelSteps(0, 3)
	if !slices.Equal(v, []int32{-120}) || len(h) != 0 {
		t.Errorf("dy 3: %v %v", v, h)
	}
	v, _ = WheelSteps(0, -10)
	if !slices.Equal(v, []int32{120, 120, 120, 40}) {
		t.Errorf("dy -10: %v", v)
	}
	_, h = WheelSteps(2, 0)
	if !slices.Equal(h, []int32{80}) {
		t.Errorf("dx 2 scrolls right, a positive hwheel delta: %v", h)
	}
	_, h = WheelSteps(-4, 0)
	if !slices.Equal(h, []int32{-120, -40}) {
		t.Errorf("dx -4: %v", h)
	}
	if v, h := WheelSteps(0, 0); len(v)+len(h) != 0 {
		t.Error("nothing to scroll")
	}
}

func TestDragPath(t *testing.T) {
	path := DragPath(proto.Point{}, proto.Point{X: 100, Y: -50}, 10)
	if len(path) != 10 || path[0] != (proto.Point{X: 10, Y: -5}) || path[9] != (proto.Point{X: 100, Y: -50}) {
		t.Errorf("path: %v", path)
	}
}

func TestButtonsFollowTheSwap(t *testing.T) {
	if d, u := Left.Flags(false); d != MouseLeftDown || u != MouseLeftUp {
		t.Error("left")
	}
	if d, u := Left.Flags(true); d != MouseRightDown || u != MouseRightUp {
		t.Error("left with swapped buttons is the physical right one")
	}
	if d, _ := Right.Flags(true); d != MouseLeftDown {
		t.Error("right, swapped")
	}
	if d, _ := Middle.Flags(true); d != MouseMiddleDown {
		t.Error("middle doesn't swap")
	}
}

func TestClickWithModifiers(t *testing.T) {
	c, s := newController()
	if err := c.Click(proto.Point{X: 10, Y: 20}, Left, 2, []keys.Modifier{keys.Ctrl, keys.Shift}); err != nil {
		t.Fatal(err)
	}
	e := s.take()
	// move, ctrl down, shift down, (down, up) × 2, shift up, ctrl up.
	if len(e) != 9 {
		t.Fatalf("events: %+v", e)
	}
	if !e[0].Mouse || e[0].Flags != MouseMove|MouseAbsolute|MouseVirtualDesk {
		t.Errorf("move: %+v", e[0])
	}
	if e[1].VK != keys.VK_CONTROL || e[1].Flags != 0 || e[1].Scan != keys.VK_CONTROL+0x100 || e[2].VK != keys.VK_SHIFT {
		t.Errorf("modifiers down: %+v %+v", e[1], e[2])
	}
	if e[3].Flags != MouseLeftDown || e[4].Flags != MouseLeftUp || e[5].Flags != MouseLeftDown || e[6].Flags != MouseLeftUp {
		t.Errorf("clicks: %+v", e[3:7])
	}
	if e[3].DX != 0 || e[3].DY != 0 || e[3].Flags&MouseMove != 0 {
		t.Errorf("a button event doesn't move the pointer: %+v", e[3])
	}
	if e[7].VK != keys.VK_SHIFT || e[7].Flags != KeyUp || e[8].VK != keys.VK_CONTROL || e[8].Flags != KeyUp {
		t.Errorf("modifiers up, last first: %+v %+v", e[7], e[8])
	}
	if !slices.Equal(s.cursor, []proto.Point{{X: 10, Y: 20}}) {
		t.Errorf("SetCursorPos: %v", s.cursor)
	}
	if p := c.LastPointer(); p == nil || *p != (proto.Point{X: 10, Y: 20}) {
		t.Errorf("last pointer: %v", p)
	}
}

func TestExtendedKeysCarryTheFlag(t *testing.T) {
	c, s := newController()
	stroke, err := keys.Resolve([]string{"shift", "left"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Press(stroke, 2); err != nil {
		t.Fatal(err)
	}
	e := s.take()
	if len(e) != 6 || e[1].VK != keys.VK_LEFT || e[1].Flags != KeyExtended || e[2].Flags != KeyExtended|KeyUp {
		t.Errorf("shift+left ×2: %+v", e)
	}
}

func TestTypeUnicodeAndBreaks(t *testing.T) {
	c, s := newController()
	if err := c.Type("a😀\tb\n"); err != nil {
		t.Fatal(err)
	}
	e := s.take()
	// a (down, up), the pair (2 × down, up), Tab (down, up), b (down, up), Return (down, up).
	var got []uint16
	for _, ev := range e {
		if ev.Flags&KeyUnicode != 0 {
			got = append(got, ev.Scan)
		} else {
			got = append(got, ev.VK|0x8000)
		}
	}
	want := []uint16{'a', 'a', 0xD83D, 0xD83D, 0xDE00, 0xDE00, keys.VK_TAB | 0x8000, keys.VK_TAB | 0x8000, 'b', 'b', keys.VK_RETURN | 0x8000, keys.VK_RETURN | 0x8000}
	if !slices.Equal(got, want) {
		t.Errorf("typed: %#x\nwant  %#x", got, want)
	}
	if e[0].VK != 0 || e[1].Flags != KeyUnicode|KeyUp {
		t.Errorf("unicode events: %+v %+v", e[0], e[1])
	}
}

func TestTypeSendsOneUnitAtATimeWithAPause(t *testing.T) {
	c, s := newController()
	var pauses []time.Duration
	c.SetSleep(func(d time.Duration) { pauses = append(pauses, d) })
	if err := c.Type("ab😀"); err != nil {
		t.Fatal(err)
	}
	// Down and up of each unit go together, the surrogate pair's two units apart.
	if want := []int{2, 2, 2, 2}; !slices.Equal(s.sends, want) {
		t.Errorf("sent in batches of %v, want %v", s.sends, want)
	}
	if n := slices.Index(pauses, typingPause); n != 0 || len(pauses) < 4 || pauses[3] != typingPause {
		t.Errorf("pauses: %v", pauses)
	}
}

func TestReleaseAllLetsGoOfWhatIsHeld(t *testing.T) {
	c, s := newController()
	if err := c.ButtonDown(proto.Point{X: 1, Y: 1}, Right); err != nil {
		t.Fatal(err)
	}
	stroke, _ := keys.Resolve([]string{"ctrl", "a"}, nil)
	done := make(chan error)
	go func() { done <- c.Hold(stroke, 10_000) }()
	// Wait until the hold has its keys down.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		n := len(c.heldKeys)
		c.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	s.take()
	c.ReleaseAll()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a released hold ends without an error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ReleaseAll didn't cut the hold short")
	}
	e := s.take()
	// a up, the right button up, ctrl up.
	if len(e) != 3 || e[0].VK != 'A' || e[0].Flags != KeyUp || !e[1].Mouse || e[1].Flags != MouseRightUp || e[2].VK != keys.VK_CONTROL || e[2].Flags != KeyUp {
		t.Errorf("released: %+v", e)
	}
}

func TestStopLatchesUntilResume(t *testing.T) {
	c, s := newController()
	stroke, _ := keys.Resolve([]string{"shift"}, nil)
	done := make(chan error)
	go func() { done <- c.Hold(stroke, 10_000) }()
	time.Sleep(20 * time.Millisecond)
	c.Stop()
	if err := <-done; !rpc.IsStopped(err) {
		t.Errorf("a hold stopped by Esc: %v", err)
	}
	if e := s.take(); len(e) < 2 || e[len(e)-1].VK != keys.VK_SHIFT || e[len(e)-1].Flags != KeyUp {
		t.Errorf("shift was let go: %+v", e)
	}
	for _, err := range []error{
		c.Move(proto.Point{X: 1, Y: 1}),
		c.Click(proto.Point{X: 1, Y: 1}, Left, 1, nil),
		c.Type("x"),
		c.Scroll(proto.Point{}, 0, 3),
	} {
		if !rpc.IsStopped(err) {
			t.Errorf("after a stop: %v", err)
		}
	}
	if len(s.take()) != 0 {
		t.Error("input went out after the stop")
	}
	c.Resume()
	if err := c.Move(proto.Point{X: 1, Y: 1}); err != nil {
		t.Errorf("after resume: %v", err)
	}
	c.Terminate()
	if err := c.Move(proto.Point{X: 1, Y: 1}); !rpc.IsStopped(err) {
		t.Error("nothing goes out after Terminate")
	}
}

func TestOwnEscape(t *testing.T) {
	c, _ := newController()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	if c.OwnsEscape() {
		t.Error("owns Esc before sending one")
	}
	esc, _ := keys.Resolve([]string{"esc"}, nil)
	if err := c.Press(esc, 1); err != nil {
		t.Fatal(err)
	}
	if !c.OwnsEscape() {
		t.Error("its own Esc, just sent")
	}
	now = now.Add(299 * time.Millisecond)
	if !c.OwnsEscape() {
		t.Error("299 ms later")
	}
	now = now.Add(2 * time.Millisecond)
	if c.OwnsEscape() {
		t.Error("301 ms later it's the person's again")
	}
}

func TestScrollEvents(t *testing.T) {
	c, s := newController()
	if err := c.Scroll(proto.Point{X: 5, Y: 5}, 1, 4); err != nil {
		t.Fatal(err)
	}
	e := s.take()
	if len(e) != 4 || e[1].Flags != MouseWheel || int32(e[1].Data) != -120 || int32(e[2].Data) != -40 || e[3].Flags != MouseHWheel || int32(e[3].Data) != 40 {
		t.Errorf("scroll: %+v", e)
	}
}
