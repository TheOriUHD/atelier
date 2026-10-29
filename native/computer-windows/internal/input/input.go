// Package input is synthesized mouse and keyboard input (a port of the macOS helper's Input.swift): what is sent, in
// which order, and what the helper holds, so input.releaseAll, the Esc stop and exiting can let go of it. Sending is
// the OS's (SendInput, in internal/win); every event carries Tag in dwExtraInfo so the control watch can tell it from
// the person's own input.
package input

import (
	"math"
	"sync"
	"time"

	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// Tag is 'ATLR', in every event's dwExtraInfo.
const Tag = 0x41544C52

// SendInput flags (WinUser.h).
const (
	KeyExtended = 0x0001 // KEYEVENTF_EXTENDEDKEY
	KeyUp       = 0x0002 // KEYEVENTF_KEYUP
	KeyUnicode  = 0x0004 // KEYEVENTF_UNICODE

	MouseMove        = 0x0001 // MOUSEEVENTF_MOVE
	MouseLeftDown    = 0x0002
	MouseLeftUp      = 0x0004
	MouseRightDown   = 0x0008
	MouseRightUp     = 0x0010
	MouseMiddleDown  = 0x0020
	MouseMiddleUp    = 0x0040
	MouseWheel       = 0x0800
	MouseHWheel      = 0x1000
	MouseVirtualDesk = 0x4000
	MouseAbsolute    = 0x8000
)

// Event is one INPUT for SendInput: a key (VK, Scan, Flags) or, with Mouse, a mouse event (DX, DY, Data, Flags).
type Event struct {
	Mouse  bool
	VK     uint16
	Scan   uint16
	DX, DY int32
	Data   uint32
	Flags  uint32
}

// Screen is the virtual screen in physical pixels.
type Screen struct{ X, Y, Width, Height int }

// Sender is the OS side.
type Sender interface {
	// Send sends events in one SendInput call, each tagged.
	Send(events []Event) error
	SetCursorPos(x, y int)
	CursorPos() (proto.Point, bool)
	VirtualScreen() Screen
	// SwapButtons: the person swapped the primary and secondary buttons (SM_SWAPBUTTON).
	SwapButtons() bool
	// ScanCode is the scan code of a virtual key on the current layout.
	ScanCode(vk uint16) uint16
}

type Button string

const (
	Left   Button = "left"
	Right  Button = "right"
	Middle Button = "middle"
)

// Flags are the down and up flags of a button; with swapped buttons the physical buttons swap, so a left click stays
// a left click.
func (b Button) Flags(swapped bool) (down, up uint32) {
	switch {
	case b == Middle:
		return MouseMiddleDown, MouseMiddleUp
	case (b == Left) != swapped:
		return MouseLeftDown, MouseLeftUp
	default:
		return MouseRightDown, MouseRightUp
	}
}

// Controller sends input and tracks what it holds. Everything is guarded by mu; key.hold waits on `released`.
type Controller struct {
	sender Sender
	// sleep is time.Sleep (tests make it free).
	sleep func(time.Duration)
	now   func() time.Time

	mu          sync.Mutex
	stopped     bool
	terminated  bool
	released    chan struct{} // closed (and replaced) by every release, so a hold in progress knows it was let go
	heldKeys    []keys.Key
	heldMods    []keys.Modifier
	heldButtons []Button
	lastPointer *proto.Point
	lastEscAt   time.Time
}

func NewController(sender Sender) *Controller {
	return &Controller{sender: sender, sleep: time.Sleep, now: time.Now, released: make(chan struct{})}
}

// SetSleep replaces time.Sleep (tests).
func (c *Controller) SetSleep(sleep func(time.Duration)) { c.sleep = sleep }

// ---------------------------------------------------------------- state

func (c *Controller) IsStopped() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stopped
}

// LastPointer is where the helper last put the pointer.
func (c *Controller) LastPointer() *proto.Point {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastPointer == nil {
		return nil
	}
	p := *c.lastPointer
	return &p
}

func (c *Controller) SetPointerBaseline(p proto.Point) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastPointer == nil {
		c.lastPointer = &p
	}
}

// OwnsEscape: the helper holds Esc itself, or sent an Esc event in the last 300 ms, so the Esc key-state poll would see
// its own key, not the person's.
func (c *Controller) OwnsEscape() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range c.heldKeys {
		if k.VK == keys.VK_ESCAPE {
			return true
		}
	}
	return !c.lastEscAt.IsZero() && c.now().Sub(c.lastEscAt) < 300*time.Millisecond
}

func (c *Controller) CursorPosition() proto.Point {
	if p, ok := c.sender.CursorPos(); ok {
		return p
	}
	if p := c.LastPointer(); p != nil {
		return *p
	}
	return proto.Point{}
}

// Stop: the person held Esc. Input is refused from now on, and everything is let go.
func (c *Controller) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = true
	c.releaseLocked()
}

func (c *Controller) Resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = false
}

// Terminate: the helper is exiting. Let go of everything, and send nothing more.
func (c *Controller) Terminate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.terminated = true
	c.releaseLocked()
}

func (c *Controller) ReleaseAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.releaseLocked()
}

func (c *Controller) releaseLocked() {
	var events []Event
	for i := len(c.heldKeys) - 1; i >= 0; i-- {
		events = append(events, c.keyEvent(c.heldKeys[i], false))
	}
	swapped := c.sender.SwapButtons()
	for i := len(c.heldButtons) - 1; i >= 0; i-- {
		_, up := c.heldButtons[i].Flags(swapped)
		events = append(events, Event{Mouse: true, Flags: up})
	}
	for i := len(c.heldMods) - 1; i >= 0; i-- {
		events = append(events, c.keyEvent(modifierKey(c.heldMods[i]), false))
	}
	if len(events) > 0 {
		_ = c.sender.Send(events)
	}
	c.heldKeys = nil
	c.heldButtons = nil
	c.heldMods = nil
	close(c.released)
	c.released = make(chan struct{})
}

// ---------------------------------------------------------------- sending

type changeKind int

const (
	noChange changeKind = iota
	keyDown
	keyUp
	modDown
	modUp
	buttonDown
	buttonUp
)

type change struct {
	kind   changeKind
	key    keys.Key
	mod    keys.Modifier
	button Button
}

// ready: input may go out (not stopped).
func (c *Controller) ready() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	return nil
}

// post sends events unless input was stopped meanwhile; the check and the send are atomic with Stop.
func (c *Controller) post(events []Event, ch change) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	if err := c.sender.Send(events); err != nil {
		return rpc.Internal("could not send input: %v", err)
	}
	switch ch.kind {
	case keyDown:
		if !containsKey(c.heldKeys, ch.key) {
			c.heldKeys = append(c.heldKeys, ch.key)
		}
	case keyUp:
		c.heldKeys = removeKey(c.heldKeys, ch.key)
	case modDown:
		if !containsMod(c.heldMods, ch.mod) {
			c.heldMods = append(c.heldMods, ch.mod)
		}
	case modUp:
		c.heldMods = removeMod(c.heldMods, ch.mod)
	case buttonDown:
		if !containsButton(c.heldButtons, ch.button) {
			c.heldButtons = append(c.heldButtons, ch.button)
		}
	case buttonUp:
		c.heldButtons = removeButton(c.heldButtons, ch.button)
	}
	for _, e := range events {
		if !e.Mouse && e.VK == keys.VK_ESCAPE {
			c.lastEscAt = c.now()
		}
	}
	return nil
}

func (c *Controller) keyEvent(k keys.Key, down bool) Event {
	e := Event{VK: k.VK, Scan: c.sender.ScanCode(k.VK)}
	if k.Extended {
		e.Flags |= KeyExtended
	}
	if !down {
		e.Flags |= KeyUp
	}
	return e
}

func modifierKey(m keys.Modifier) keys.Key {
	vk := m.VK()
	return keys.Key{VK: vk, Extended: keys.IsExtended(vk)}
}

// sequence runs a sequence of events; if something other than a stop breaks it, lets go of what it held.
func (c *Controller) sequence(body func() error) error {
	err := body()
	if err != nil && !rpc.IsStopped(err) {
		c.ReleaseAll()
	}
	return err
}

func (c *Controller) pressModifiers(mods []keys.Modifier) error {
	for _, m := range mods {
		if err := c.post([]Event{c.keyEvent(modifierKey(m), true)}, change{kind: modDown, mod: m}); err != nil {
			return err
		}
		c.sleep(8 * time.Millisecond)
	}
	return nil
}

// releaseModifiers lets go of the modifiers, last first; only those still held (a release may have come in between).
func (c *Controller) releaseModifiers(mods []keys.Modifier) error {
	c.mu.Lock()
	held := append([]keys.Modifier(nil), c.heldMods...)
	c.mu.Unlock()
	for i := len(mods) - 1; i >= 0; i-- {
		if !containsMod(held, mods[i]) {
			continue
		}
		if err := c.post([]Event{c.keyEvent(modifierKey(mods[i]), false)}, change{kind: modUp, mod: mods[i]}); err != nil {
			return err
		}
		c.sleep(8 * time.Millisecond)
	}
	return nil
}

// ---------------------------------------------------------------- mouse

// Normalize maps a physical pixel to SendInput's absolute coordinates over the virtual screen (0–65535), rounding up so
// that the system's mapping back (n × width / 65536) lands on that pixel.
func Normalize(x, y float64, s Screen) (int32, int32) {
	axis := func(v float64, origin, size int) int32 {
		if size <= 0 {
			return 0
		}
		px := int(math.Round(v)) - origin
		px = min(max(px, 0), size-1)
		n := (px*65536 + size - 1) / size
		return int32(min(max(n, 0), 65535))
	}
	return axis(x, s.X, s.Width), axis(y, s.Y, s.Height)
}

// postMove moves the pointer: an absolute SendInput move over the virtual screen, then SetCursorPos to the same
// physical pixel (exact whatever the monitors' DPIs). With a button held this is a drag.
func (c *Controller) postMove(p proto.Point) error {
	dx, dy := Normalize(p.X, p.Y, c.sender.VirtualScreen())
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	// Where the pointer goes is the helper's before it gets there: the control watch must not take this move for the
	// person's.
	c.lastPointer = &p
	if err := c.sender.Send([]Event{{Mouse: true, DX: dx, DY: dy, Flags: MouseMove | MouseAbsolute | MouseVirtualDesk}}); err != nil {
		return rpc.Internal("could not send input: %v", err)
	}
	c.sender.SetCursorPos(int(math.Round(p.X)), int(math.Round(p.Y)))
	return nil
}

func (c *Controller) button(b Button, down bool) error {
	d, u := b.Flags(c.sender.SwapButtons())
	if down {
		return c.post([]Event{{Mouse: true, Flags: d}}, change{kind: buttonDown, button: b})
	}
	return c.post([]Event{{Mouse: true, Flags: u}}, change{kind: buttonUp, button: b})
}

func (c *Controller) Move(p proto.Point) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error { return c.postMove(p) })
}

// Click clicks count times at p (within the double-click time), modifiers held around it.
func (c *Controller) Click(p proto.Point, b Button, count int, mods []keys.Modifier) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.postMove(p); err != nil {
			return err
		}
		c.sleep(30 * time.Millisecond)
		if err := c.pressModifiers(mods); err != nil {
			return err
		}
		for n := 1; n <= count; n++ {
			if err := c.button(b, true); err != nil {
				return err
			}
			c.sleep(20 * time.Millisecond)
			if err := c.button(b, false); err != nil {
				return err
			}
			if n < count {
				c.sleep(40 * time.Millisecond)
			}
		}
		c.sleep(10 * time.Millisecond)
		return c.releaseModifiers(mods)
	})
}

func (c *Controller) ButtonDown(p proto.Point, b Button) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.postMove(p); err != nil {
			return err
		}
		c.sleep(20 * time.Millisecond)
		return c.button(b, true)
	})
}

func (c *Controller) ButtonUp(p proto.Point, b Button) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.postMove(p); err != nil {
			return err
		}
		c.sleep(20 * time.Millisecond)
		return c.button(b, false)
	})
}

// DragPath is the moves between from and to, to included.
func DragPath(from, to proto.Point, steps int) []proto.Point {
	path := make([]proto.Point, 0, steps)
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		path = append(path, proto.Point{X: from.X + (to.X-from.X)*t, Y: from.Y + (to.Y-from.Y)*t})
	}
	return path
}

func (c *Controller) Drag(from, to proto.Point, b Button) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.postMove(from); err != nil {
			return err
		}
		c.sleep(30 * time.Millisecond)
		if err := c.button(b, true); err != nil {
			return err
		}
		c.sleep(50 * time.Millisecond)
		for _, p := range DragPath(from, to, 10) {
			if err := c.postMove(p); err != nil {
				return err
			}
			c.sleep(16 * time.Millisecond)
		}
		c.sleep(30 * time.Millisecond)
		return c.button(b, false)
	})
}

// LineDelta is one line of scrolling in wheel units: a notch (WHEEL_DELTA, 120) scrolls three lines by default.
const LineDelta = 120 / 3

// WheelSteps are the wheel deltas for a scroll in lines, in notches of at most 120: positive dy scrolls the content
// down (a negative MOUSEEVENTF_WHEEL delta), positive dx right (a positive MOUSEEVENTF_HWHEEL delta).
func WheelSteps(dx, dy float64) (vertical, horizontal []int32) {
	split := func(total int) []int32 {
		var steps []int32
		for total != 0 {
			step := min(max(total, -120), 120)
			steps = append(steps, int32(step))
			total -= step
		}
		return steps
	}
	return split(int(math.Round(-dy * LineDelta))), split(int(math.Round(dx * LineDelta)))
}

func (c *Controller) Scroll(p proto.Point, dx, dy float64) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.postMove(p); err != nil {
			return err
		}
		c.sleep(20 * time.Millisecond)
		vertical, horizontal := WheelSteps(dx, dy)
		for i, d := range vertical {
			if i > 0 {
				c.sleep(10 * time.Millisecond)
			}
			if err := c.post([]Event{{Mouse: true, Data: uint32(d), Flags: MouseWheel}}, change{}); err != nil {
				return err
			}
		}
		for i, d := range horizontal {
			if i > 0 || len(vertical) > 0 {
				c.sleep(10 * time.Millisecond)
			}
			if err := c.post([]Event{{Mouse: true, Data: uint32(d), Flags: MouseHWheel}}, change{}); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---------------------------------------------------------------- keyboard

func (c *Controller) pressKey(k keys.Key) error {
	if err := c.post([]Event{c.keyEvent(k, true)}, change{kind: keyDown, key: k}); err != nil {
		return err
	}
	c.sleep(10 * time.Millisecond)
	return c.post([]Event{c.keyEvent(k, false)}, change{kind: keyUp, key: k})
}

// Press holds the modifiers, presses the key `repeat` times, and lets go of the modifiers.
func (c *Controller) Press(s keys.Stroke, repeat int) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.pressModifiers(s.Modifiers); err != nil {
			return err
		}
		if s.Key != nil {
			for n := 0; n < repeat; n++ {
				if err := c.pressKey(*s.Key); err != nil {
					return err
				}
				if n < repeat-1 {
					c.sleep(20 * time.Millisecond)
				}
			}
		}
		c.sleep(10 * time.Millisecond)
		return c.releaseModifiers(s.Modifiers)
	})
}

// UnicodeEvents types UTF-16 units with KEYEVENTF_UNICODE: each unit down, then up (a surrogate pair is two units).
func UnicodeEvents(units []uint16) []Event {
	events := make([]Event, 0, len(units)*2)
	for _, u := range units {
		events = append(events, Event{Scan: u, Flags: KeyUnicode}, Event{Scan: u, Flags: KeyUnicode | KeyUp})
	}
	return events
}

// Type types text: runs of UTF-16 units, line breaks as Return and tabs as Tab.
func (c *Controller) Type(text string) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		for _, piece := range keys.Pieces(text) {
			var err error
			switch piece.Kind {
			case keys.Newline:
				err = c.pressKey(keys.Key{VK: keys.VK_RETURN})
			case keys.TabKey:
				err = c.pressKey(keys.Key{VK: keys.VK_TAB})
			default:
				err = c.post(UnicodeEvents(piece.Units), change{})
			}
			if err != nil {
				return err
			}
			c.sleep(12 * time.Millisecond)
		}
		return nil
	})
}

// Hold holds the stroke for ms, cut short by a release or a stop.
func (c *Controller) Hold(s keys.Stroke, ms int) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		if err := c.pressModifiers(s.Modifiers); err != nil {
			return err
		}
		if s.Key != nil {
			if err := c.post([]Event{c.keyEvent(*s.Key, true)}, change{kind: keyDown, key: *s.Key}); err != nil {
				return err
			}
		}
		if err := c.wait(time.Duration(ms) * time.Millisecond); err != nil {
			return err
		}
		if s.Key != nil {
			c.mu.Lock()
			held := containsKey(c.heldKeys, *s.Key)
			c.mu.Unlock()
			if held {
				if err := c.post([]Event{c.keyEvent(*s.Key, false)}, change{kind: keyUp, key: *s.Key}); err != nil {
					return err
				}
			}
		}
		return c.releaseModifiers(s.Modifiers)
	})
}

// wait waits, cut short by a release (then the keys are already up) or a stop.
func (c *Controller) wait(d time.Duration) error {
	c.mu.Lock()
	released := c.released
	c.mu.Unlock()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-released:
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	return nil
}

// ---------------------------------------------------------------- small helpers

func containsKey(list []keys.Key, k keys.Key) bool {
	for _, have := range list {
		if have.VK == k.VK {
			return true
		}
	}
	return false
}

func removeKey(list []keys.Key, k keys.Key) []keys.Key {
	out := list[:0]
	for _, have := range list {
		if have.VK != k.VK {
			out = append(out, have)
		}
	}
	return out
}

func containsMod(list []keys.Modifier, m keys.Modifier) bool {
	for _, have := range list {
		if have == m {
			return true
		}
	}
	return false
}

func removeMod(list []keys.Modifier, m keys.Modifier) []keys.Modifier {
	out := list[:0]
	for _, have := range list {
		if have != m {
			out = append(out, have)
		}
	}
	return out
}

func containsButton(list []Button, b Button) bool {
	for _, have := range list {
		if have == b {
			return true
		}
	}
	return false
}

func removeButton(list []Button, b Button) []Button {
	out := list[:0]
	for _, have := range list {
		if have != b {
			out = append(out, have)
		}
	}
	return out
}
