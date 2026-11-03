//go:build linux

package x11

import (
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jezek/xgb/xproto"

	"atelier.dev/computer-linux/internal/helper"
	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
	"atelier.dev/computer-linux/internal/rpc"
)

func TestAnEmptyOrOnePixelInputShapeIsClickThrough(t *testing.T) {
	rect := func(w, h uint16) xproto.Rectangle { return xproto.Rectangle{Width: w, Height: h} }
	cases := []struct {
		rects []xproto.Rectangle
		want  bool
	}{{nil, true}, {[]xproto.Rectangle{rect(1, 1)}, true}, {[]xproto.Rectangle{rect(5, 300)}, false}, {[]xproto.Rectangle{rect(1, 1), rect(1, 1)}, false}}
	for _, c := range cases {
		if got := tinyInputArea(c.rects); got != c.want {
			t.Errorf("%v: %v", c.rects, got)
		}
	}
}

type lineSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *lineSink) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.Split(strings.TrimSpace(string(p)), "\n")...)
	return len(p), nil
}

func (l *lineSink) has(sub string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, sub) {
			return true
		}
	}
	return false
}

// The person holds Esc (a second, from another client): the helper tells main, then refuses all input until resumed.
func TestHoldingEscStopsInputUntilResumed(t *testing.T) {
	s := system(t)
	if _, err := exec.LookPath("xdotool"); err != nil {
		t.Skip("no xdotool")
	}
	sink := &lineSink{}
	h := helper.New(rpc.NewOutput(sink), s)
	h.Input().SetSleep(func(time.Duration) {})
	h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`))
	h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":2,"method":"control.begin","params":{}}`))
	defer h.Finish()
	time.Sleep(150 * time.Millisecond)

	start := time.Now()
	_ = exec.Command("xdotool", "keydown", "Escape").Run()
	waitFor(t, "the Esc stop", func() bool { return sink.has(`"phase":"stopped"`) })
	held := time.Since(start)
	_ = exec.Command("xdotool", "keyup", "Escape").Run()
	if held < 900*time.Millisecond || held > 2500*time.Millisecond {
		t.Errorf("stopped after %v, want about a second", held)
	}
	if !sink.has(`"phase":"down"`) {
		t.Error("no down notification before the stop")
	}
	if !h.Input().IsStopped() {
		t.Fatal("input is not refused after the stop")
	}
	if err := h.Input().Move(proto.Point{X: 10, Y: 10}); !rpc.IsStopped(err) {
		t.Errorf("a move after the stop: %v", err)
	}
	h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":3,"method":"control.resume","params":{}}`))
	waitFor(t, "input after resume", func() bool { return h.Input().Move(proto.Point{X: 10, Y: 10}) == nil })
}

// An Esc the helper sends itself (the agent pressing it) is not the person's: it never stops anything, even held.
func TestTheHelpersOwnEscNeverStopsIt(t *testing.T) {
	s := system(t)
	sink := &lineSink{}
	h := helper.New(rpc.NewOutput(sink), s)
	h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`))
	h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":2,"method":"control.begin","params":{}}`))
	defer h.Finish()
	time.Sleep(150 * time.Millisecond)
	escAtStart := s.EscapeDown()
	stroke, _ := keys.Resolve([]string{"escape"})
	if err := h.Input().Hold(stroke, 1400); err != nil {
		t.Fatalf("%v; esc down at start %v; notifications %q", err, escAtStart, sink.lines)
	}
	if sink.has(`"phase"`) || h.Input().IsStopped() {
		t.Errorf("the helper's own Esc was taken for the person's: %q", sink.lines)
	}
}
