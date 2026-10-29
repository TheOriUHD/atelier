// Package control is the watch while the helper has control (control.begin … control.end): the person's Esc hold,
// which stops all input, and their other keys and mouse, which main hears about (a port of the macOS helper's
// Control.swift). The hooks themselves are the OS's (internal/win); the decisions are here.
package control

import (
	"math"
	"sync"
	"time"

	"atelier.dev/computer-windows/internal/proto"
)

// ---------------------------------------------------------------- the Esc hold

// EscEventKind is what the Esc hold did.
type EscEventKind int

const (
	EscDown EscEventKind = iota
	EscUp
	EscStopped
)

type EscEvent struct {
	Kind   EscEventKind
	HeldMs int
}

// HoldMs is how long Esc must be held to stop.
const HoldMs = 1000.0

// EscTracker is the Esc hold, from two detectors: the keyboard hook's key events and a 50 ms poll of the key state.
// Times are milliseconds on one monotonic clock.
type EscTracker struct {
	down    bool
	downAt  float64
	fired   bool
	pollSaw bool // The poll saw this hold's key down, so its "up" can be trusted.
}

func (e *EscTracker) IsDown() bool { return e.down }

// KeyDown is a key-down from the hook. Only a fresh press starts a hold; autorepeats only advance it.
func (e *EscTracker) KeyDown(now float64, autorepeat bool) []EscEvent {
	if e.down {
		return e.check(now)
	}
	if autorepeat {
		return nil
	}
	e.start(now)
	return []EscEvent{{Kind: EscDown}}
}

func (e *EscTracker) KeyUp(now float64) []EscEvent {
	if !e.down {
		return nil
	}
	held := ms(now - e.downAt)
	wasFired := e.fired
	e.Reset()
	if wasFired {
		return nil
	}
	return []EscEvent{{Kind: EscUp, HeldMs: held}}
}

// Tick is the 50 ms poll: physicallyDown is the key state of Esc, nil when it can't be told (the helper is pressing
// Esc itself).
func (e *EscTracker) Tick(now float64, physicallyDown *bool) []EscEvent {
	var events []EscEvent
	if physicallyDown != nil && *physicallyDown {
		if !e.down {
			e.start(now)
			events = append(events, EscEvent{Kind: EscDown})
		}
		e.pollSaw = true
	} else if physicallyDown != nil && !*physicallyDown && e.down && e.pollSaw {
		return e.KeyUp(now)
	}
	return append(events, e.check(now)...)
}

func (e *EscTracker) Reset() { *e = EscTracker{} }

func (e *EscTracker) start(now float64) {
	e.down = true
	e.downAt = now
	e.fired = false
	e.pollSaw = false
}

func (e *EscTracker) check(now float64) []EscEvent {
	if !e.down || e.fired || now-e.downAt < HoldMs {
		return nil
	}
	e.fired = true
	return []EscEvent{{Kind: EscStopped, HeldMs: ms(now - e.downAt)}}
}

func ms(v float64) int { return max(0, int(math.Round(v))) }

// ---------------------------------------------------------------- the person's own input

// IntervalMs: at most one control.userInput per 500 ms.
const IntervalMs = 500.0

// MoveTolerance: pointer moves within 24 px of where the helper last put it are the helper's.
const MoveTolerance = 24.0

// UserInputFilter throttles control.userInput.
type UserInputFilter struct {
	sent   bool
	lastAt float64
}

// Admit is true when a notification may go out now.
func (f *UserInputFilter) Admit(now float64) bool {
	if f.sent && now-f.lastAt < IntervalMs {
		return false
	}
	f.sent = true
	f.lastAt = now
	return true
}

// IsPersonMove: a move more than 24 px from where the helper itself last put the pointer.
func IsPersonMove(p proto.Point, helperAt *proto.Point) bool {
	if helperAt == nil {
		return false
	}
	return math.Hypot(p.X-helperAt.X, p.Y-helperAt.Y) > MoveTolerance
}

// ---------------------------------------------------------------- the monitor

// SampleKind is what a hook saw.
type SampleKind int

const (
	SampleEscDown SampleKind = iota
	SampleEscUp
	SampleKeyDown
	SampleMouseDown
	SampleMoved
)

// Sample is one event from the hooks (never one of the helper's own: those are filtered by their tag).
type Sample struct {
	Kind       SampleKind
	Autorepeat bool
	At         proto.Point
	// Time on the monitor's clock, in ms.
	Time float64
}

// Hooks are the OS's keyboard and mouse watch.
type Hooks interface {
	// Start installs the hooks; sink receives samples (it must be quick and never block).
	Start(sink func(Sample)) error
	Stop()
}

// Input is what the monitor needs of the input controller.
type Input interface {
	// Stop latches the stop and lets go of everything held.
	Stop()
	// OwnsEscape: the helper holds Esc itself or sent one in the last 300 ms.
	OwnsEscape() bool
	LastPointer() *proto.Point
	SetPointerBaseline(p proto.Point)
	CursorPosition() proto.Point
}

// Monitor runs the watch: hook samples and a 50 ms poll of Esc's key state, serialized on one goroutine.
type Monitor struct {
	hooks     Hooks
	input     Input
	escapeKey func() bool
	notify    func(method string, params any)
	clock     func() float64

	mu      sync.Mutex // begin/end
	active  bool
	samples chan Sample
	quit    chan struct{}
	done    chan struct{}

	// Only touched by the loop (or by tests calling Handle and Tick directly).
	esc       EscTracker
	userInput UserInputFilter
}

var epoch = time.Now()

// Now is the monitor's clock: monotonic milliseconds.
func Now() float64 { return float64(time.Since(epoch).Nanoseconds()) / 1e6 }

// NewMonitor: escapeKey reads whether Esc is physically down (GetAsyncKeyState); notify sends a notification.
func NewMonitor(hooks Hooks, input Input, escapeKey func() bool, notify func(method string, params any)) *Monitor {
	return &Monitor{hooks: hooks, input: input, escapeKey: escapeKey, notify: notify, clock: Now}
}

func (m *Monitor) IsActive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// Begin installs the hooks and starts the poll; a second Begin does nothing.
func (m *Monitor) Begin() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active {
		return nil
	}
	samples := make(chan Sample, 1024)
	clock := m.clock
	err := m.hooks.Start(func(s Sample) {
		s.Time = clock()
		select {
		case samples <- s:
		default: // Never hold up the hook: a burst too big to queue is dropped.
		}
	})
	if err != nil {
		return err
	}
	m.input.SetPointerBaseline(m.input.CursorPosition())
	m.esc.Reset()
	m.userInput = UserInputFilter{}
	m.samples = samples
	m.quit = make(chan struct{})
	m.done = make(chan struct{})
	m.active = true
	go m.loop(samples, m.quit, m.done)
	return nil
}

// End removes the hooks and stops the poll.
func (m *Monitor) End() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.active {
		return
	}
	m.active = false
	m.hooks.Stop()
	close(m.quit)
	<-m.done
	m.esc.Reset()
}

func (m *Monitor) loop(samples <-chan Sample, quit <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	m.Tick(m.clock(), m.poll())
	for {
		select {
		case <-quit:
			return
		case s := <-samples:
			m.Handle(s)
		case <-ticker.C:
			m.Tick(m.clock(), m.poll())
		}
	}
}

// poll is Esc's key state, or nil while the helper owns Esc.
func (m *Monitor) poll() *bool {
	if m.input.OwnsEscape() {
		return nil
	}
	down := m.escapeKey()
	return &down
}

// Handle takes one hook sample.
func (m *Monitor) Handle(s Sample) {
	switch s.Kind {
	case SampleEscDown:
		m.emit(m.esc.KeyDown(s.Time, s.Autorepeat))
	case SampleEscUp:
		m.emit(m.esc.KeyUp(s.Time))
	case SampleKeyDown:
		if m.userInput.Admit(s.Time) {
			m.notify(proto.NControlUserInput, proto.UserInputParams{Kind: "key"})
		}
	case SampleMouseDown:
		if m.userInput.Admit(s.Time) {
			m.notify(proto.NControlUserInput, proto.UserInputParams{Kind: "mouse"})
		}
	case SampleMoved:
		if IsPersonMove(s.At, m.input.LastPointer()) && m.userInput.Admit(s.Time) {
			m.notify(proto.NControlUserInput, proto.UserInputParams{Kind: "mouse"})
		}
	}
}

// Tick is one poll of Esc's key state.
func (m *Monitor) Tick(now float64, physicallyDown *bool) {
	m.emit(m.esc.Tick(now, physicallyDown))
}

func (m *Monitor) emit(events []EscEvent) {
	for _, e := range events {
		switch e.Kind {
		case EscDown:
			m.notify(proto.NControlEsc, proto.EscParams{Phase: "down", HeldMs: 0})
		case EscUp:
			m.notify(proto.NControlEsc, proto.EscParams{Phase: "up", HeldMs: e.HeldMs})
		case EscStopped:
			// Latch first, so no input slips out after the release; then tell main.
			m.input.Stop()
			m.notify(proto.NControlEsc, proto.EscParams{Phase: "stopped", HeldMs: e.HeldMs})
		}
	}
}
