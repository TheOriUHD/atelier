package control

import (
	"reflect"
	"testing"

	"atelier.dev/computer-windows/internal/proto"
)

func events(e ...EscEvent) []EscEvent { return e }

var (
	down = EscEvent{Kind: EscDown}
)

func up(held int) EscEvent      { return EscEvent{Kind: EscUp, HeldMs: held} }
func stopped(held int) EscEvent { return EscEvent{Kind: EscStopped, HeldMs: held} }

func yes() *bool { v := true; return &v }
func no() *bool  { v := false; return &v }

func eq(t *testing.T, got, want []EscEvent, what string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func TestShortPressIsDownThenUp(t *testing.T) {
	var e EscTracker
	eq(t, e.KeyDown(1000, false), events(down), "down")
	eq(t, e.Tick(1300, yes()), nil, "tick")
	eq(t, e.KeyUp(1420), events(up(420)), "up")
	if e.IsDown() {
		t.Error("still down")
	}
}

func TestHoldingASecondStops(t *testing.T) {
	var e EscTracker
	eq(t, e.KeyDown(0, false), events(down), "down")
	eq(t, e.Tick(950, yes()), nil, "950")
	eq(t, e.Tick(1000, yes()), events(stopped(1000)), "1000")
	// Only once per hold, and no up after a stop.
	eq(t, e.Tick(1050, yes()), nil, "1050")
	eq(t, e.KeyDown(1100, true), nil, "autorepeat")
	eq(t, e.KeyUp(1500), nil, "up after the stop")
	// The next press starts over.
	eq(t, e.KeyDown(3000, false), events(down), "next press")
	eq(t, e.KeyUp(3100), events(up(100)), "next up")
}

func TestAutorepeatAdvancesTheHold(t *testing.T) {
	var e EscTracker
	e.KeyDown(0, false)
	eq(t, e.KeyDown(500, true), nil, "500")
	eq(t, e.KeyDown(1033, true), events(stopped(1033)), "1033")
}

func TestAutorepeatAloneDoesNotStartAHold(t *testing.T) {
	var e EscTracker
	eq(t, e.KeyDown(0, true), nil, "autorepeat")
	if e.IsDown() {
		t.Error("an autorepeat started a hold")
	}
}

func TestThePollAloneDetectsAHold(t *testing.T) {
	var e EscTracker
	eq(t, e.Tick(0, no()), nil, "0")
	eq(t, e.Tick(50, yes()), events(down), "50")
	eq(t, e.Tick(1000, yes()), nil, "1000")
	eq(t, e.Tick(1050, yes()), events(stopped(1000)), "1050")
}

func TestThePollSeesAnEarlyRelease(t *testing.T) {
	var e EscTracker
	e.Tick(0, yes())
	eq(t, e.Tick(300, no()), events(up(300)), "300")
	eq(t, e.KeyUp(310), nil, "the hook's late up")
}

func TestAPollThatNeverSeesTheKeyCannotCancelAHookHold(t *testing.T) {
	var e EscTracker
	e.KeyDown(0, false)
	eq(t, e.Tick(50, no()), nil, "50")
	eq(t, e.Tick(500, no()), nil, "500")
	eq(t, e.Tick(1000, no()), events(stopped(1000)), "1000")
}

func TestAPollThatSawTheKeyEndsAHookHold(t *testing.T) {
	var e EscTracker
	e.KeyDown(0, false)
	eq(t, e.Tick(50, yes()), nil, "50")
	eq(t, e.Tick(400, no()), events(up(400)), "400")
}

func TestUnknownKeyStateChangesNothing(t *testing.T) {
	// The helper is pressing Esc itself: nil.
	var e EscTracker
	eq(t, e.Tick(0, nil), nil, "nil")
	if e.IsDown() {
		t.Error("down")
	}
}

func TestHookAndPollTogetherReportOnce(t *testing.T) {
	var e EscTracker
	eq(t, e.Tick(0, yes()), events(down), "poll")
	eq(t, e.KeyDown(5, false), nil, "hook")
	eq(t, e.KeyUp(200), events(up(200)), "up")
	eq(t, e.Tick(250, no()), nil, "poll after")
}

func TestAtMostOnceEvery500msPerKind(t *testing.T) {
	var f UserInputFilter
	for _, c := range []struct {
		kind string
		at   float64
		want bool
	}{
		{"move", 0, true}, {"move", 100, false}, {"move", 499, false}, {"move", 500, true}, {"move", 900, false},
		{"move", 1001, true},
		// A move just before never hides a button or a key: each kind has its own 500 ms.
		{"mouse", 1002, true}, {"key", 1003, true}, {"mouse", 1200, false}, {"key", 1400, false}, {"move", 1450, false},
		{"mouse", 1502, true}, {"key", 1503, true}, {"move", 1501, true},
	} {
		if got := f.Admit(c.kind, c.at); got != c.want {
			t.Errorf("%s at %v: %v", c.kind, c.at, got)
		}
	}
}

func TestMovesWithin24PixelsAreTheHelpers(t *testing.T) {
	at := &proto.Point{X: 100, Y: 100}
	for _, c := range []struct {
		p    proto.Point
		want bool
	}{
		{proto.Point{X: 110, Y: 110}, false},
		{proto.Point{X: 124, Y: 100}, false},
		{proto.Point{X: 125, Y: 100}, true},
		{proto.Point{X: 80, Y: 80}, true},
	} {
		if got := IsPersonMove(c.p, at); got != c.want {
			t.Errorf("%v: %v", c.p, got)
		}
	}
	if IsPersonMove(proto.Point{X: 500, Y: 500}, nil) {
		t.Error("with no helper position nothing is the person's")
	}
}

// ---------------------------------------------------------------- the monitor, driven by hand

type fakeInput struct {
	stopped  int
	ownsEsc  bool
	pointer  *proto.Point
	baseline *proto.Point
}

func (f *fakeInput) Stop()                            { f.stopped++ }
func (f *fakeInput) OwnsEscape() bool                 { return f.ownsEsc }
func (f *fakeInput) LastPointer() *proto.Point        { return f.pointer }
func (f *fakeInput) SetPointerBaseline(p proto.Point) { f.baseline = &p }
func (f *fakeInput) CursorPosition() proto.Point      { return proto.Point{X: 7, Y: 8} }

type sent struct {
	method string
	params any
}

func TestMonitor(t *testing.T) {
	in := &fakeInput{pointer: &proto.Point{X: 100, Y: 100}}
	var out []sent
	m := NewMonitor(nil, in, func() bool { return false }, func(method string, params any) {
		out = append(out, sent{method, params})
	})
	// The person's keys, clicks and moves, each kind throttled on its own.
	m.Handle(Sample{Kind: SampleKeyDown, Time: 0})
	m.Handle(Sample{Kind: SampleKeyDown, Time: 50})
	m.Handle(Sample{Kind: SampleMouseDown, Time: 100})
	// A move near where the helper put the pointer is the helper's; a far one the person's.
	m.Handle(Sample{Kind: SampleMoved, At: proto.Point{X: 110, Y: 100}, Time: 600})
	m.Handle(Sample{Kind: SampleMoved, At: proto.Point{X: 300, Y: 100}, Time: 700})
	m.Handle(Sample{Kind: SampleMoved, At: proto.Point{X: 320, Y: 100}, Time: 720})
	// A button and a key right after a move still get through.
	m.Handle(Sample{Kind: SampleMouseDown, Time: 730})
	m.Handle(Sample{Kind: SampleKeyDown, Time: 740})
	want := []sent{
		{proto.NControlUserInput, proto.UserInputParams{Kind: "key"}},
		{proto.NControlUserInput, proto.UserInputParams{Kind: "mouse"}},
		{proto.NControlUserInput, proto.UserInputParams{Kind: "move"}},
		{proto.NControlUserInput, proto.UserInputParams{Kind: "mouse"}},
		{proto.NControlUserInput, proto.UserInputParams{Kind: "key"}},
	}
	if !reflect.DeepEqual(out, want) {
		t.Errorf("user input: %v", out)
	}
	out = nil
	// Esc: down, then held a second: the stop latches before main hears of it.
	m.Handle(Sample{Kind: SampleEscDown, Time: 1000})
	m.Tick(1500, no())
	m.Tick(2000, no())
	want = []sent{
		{proto.NControlEsc, proto.EscParams{Phase: "down", HeldMs: 0}},
		{proto.NControlEsc, proto.EscParams{Phase: "stopped", HeldMs: 1000}},
	}
	if !reflect.DeepEqual(out, want) || in.stopped != 1 {
		t.Errorf("esc: %v, stopped %d", out, in.stopped)
	}
	// The helper's own Esc: the poll reads nothing while it owns the key.
	in.ownsEsc = true
	if p := m.poll(); p != nil {
		t.Error("the poll reads the helper's own Esc")
	}
}
