// Package input is synthesized mouse and keyboard input (a port of the macOS helper's Input.swift, like the Windows
// helper's): what is sent, in which order, and what the helper holds, so input.releaseAll, the Esc stop and exiting
// can let go of it. Sending is the X server's (the XTEST extension, in internal/x11).
//
// XTEST input is indistinguishable from a keyboard's and mouse's to everything that watches the server, so the helper
// remembers what it holds and what it sent in the last moments (KeyIsOurs, ButtonIsOurs), and the control watch leaves
// those out.
package input

import (
	"math"
	"sync"
	"time"

	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
	"atelier.dev/computer-linux/internal/rpc"
)

// EventKind is one XTEST fake event.
type EventKind int

const (
	KeyDown EventKind = iota
	KeyUp
	ButtonDown
	ButtonUp
	Motion
)

// Event is one fake input event: a key (Detail is the keycode), a pointer button (Detail is the button number as the
// server numbers them), or a move to X, Y of the screen.
type Event struct {
	Kind   EventKind
	Detail uint8
	X, Y   int16
}

// Screen is the X screen in pixels.
type Screen struct{ Width, Height int }

// Sender is the X server's side.
type Sender interface {
	// Send sends the events in order, then flushes.
	Send(events []Event) error
	// Keymap is the keyboard as it is now.
	Keymap() (*keys.Keymap, error)
	// Button is the button number to fake for a logical one: with the person's buttons swapped (xmodmap, or a left-handed
	// setting) the left button is another physical one.
	Button(b Button) uint8
	// Pointer is where the pointer is.
	Pointer() (proto.Point, bool)
	Screen() Screen
	// Bind makes the keysym typeable on a spare key until restore is called, for a character the layout lacks.
	Bind(sym uint32) (code uint8, restore func(), err error)
}

type Button string

const (
	Left   Button = "left"
	Right  Button = "right"
	Middle Button = "middle"
)

// Scroll buttons (X11 numbers the wheel as buttons 4–7).
const (
	wheelUp    = 4
	wheelDown  = 5
	wheelLeft  = 6
	wheelRight = 7
)

// ownGrace is how long a key or button the helper let go of still counts as its own: the watch polls, so it sees an
// event up to a poll late.
const ownGrace = 150 * time.Millisecond

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
	heldKeys    []uint8
	heldButtons []uint8
	lastPointer *proto.Point
	lastEscAt   time.Time
	// sentKeys and sentButtons are when each keycode and button was last sent.
	sentKeys    map[uint8]time.Time
	sentButtons map[uint8]time.Time
}

func NewController(sender Sender) *Controller {
	return &Controller{
		sender: sender, sleep: time.Sleep, now: time.Now, released: make(chan struct{}),
		sentKeys: map[uint8]time.Time{}, sentButtons: map[uint8]time.Time{},
	}
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

// KeyIsOurs: the helper holds this keycode or sent it a moment ago.
func (c *Controller) KeyIsOurs(code uint8) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ours(code, c.heldKeys, c.sentKeys)
}

// ButtonIsOurs: the same for a pointer button.
func (c *Controller) ButtonIsOurs(button uint8) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ours(button, c.heldButtons, c.sentButtons)
}

func (c *Controller) ours(code uint8, held []uint8, sent map[uint8]time.Time) bool {
	if contains(held, code) {
		return true
	}
	at, ok := sent[code]
	return ok && c.now().Sub(at) < ownGrace
}

// OwnsEscape: the helper holds Esc itself, or sent an Esc event in the last 300 ms, so the Esc key-state poll would see
// its own key, not the person's.
func (c *Controller) OwnsEscape() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.lastEscAt.IsZero() && c.now().Sub(c.lastEscAt) < 300*time.Millisecond || c.holdsEscapeLocked()
}

func (c *Controller) holdsEscapeLocked() bool {
	code := c.escapeCode()
	return code != 0 && contains(c.heldKeys, code)
}

func (c *Controller) escapeCode() uint8 {
	km, err := c.sender.Keymap()
	if err != nil {
		return 0
	}
	code, _ := km.CodeOf(keys.XKEscape)
	return code
}

func (c *Controller) CursorPosition() proto.Point {
	if p, ok := c.sender.Pointer(); ok {
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
		events = append(events, Event{Kind: KeyUp, Detail: c.heldKeys[i]})
		c.sentKeys[c.heldKeys[i]] = c.now()
	}
	for i := len(c.heldButtons) - 1; i >= 0; i-- {
		events = append(events, Event{Kind: ButtonUp, Detail: c.heldButtons[i]})
		c.sentButtons[c.heldButtons[i]] = c.now()
	}
	if len(events) > 0 {
		_ = c.sender.Send(events)
	}
	c.heldKeys = nil
	c.heldButtons = nil
	close(c.released)
	c.released = make(chan struct{})
}

// ---------------------------------------------------------------- sending

// ready: input may go out (not stopped).
func (c *Controller) ready() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	return nil
}

// Ready is nil when input may go out, else the stop (-32031).
func (c *Controller) Ready() error { return c.ready() }

// post sends events unless input was stopped meanwhile; the check, the send and the bookkeeping are atomic with Stop.
func (c *Controller) post(events []Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped || c.terminated {
		return rpc.ErrStopped
	}
	if err := c.sender.Send(events); err != nil {
		return rpc.Internal("could not send input: %v", err)
	}
	now := c.now()
	for _, e := range events {
		switch e.Kind {
		case KeyDown:
			if !contains(c.heldKeys, e.Detail) {
				c.heldKeys = append(c.heldKeys, e.Detail)
			}
			c.sentKeys[e.Detail] = now
			c.noteEscape(e.Detail, now)
		case KeyUp:
			c.heldKeys = remove(c.heldKeys, e.Detail)
			c.sentKeys[e.Detail] = now
			c.noteEscape(e.Detail, now)
		case ButtonDown:
			if !contains(c.heldButtons, e.Detail) {
				c.heldButtons = append(c.heldButtons, e.Detail)
			}
			c.sentButtons[e.Detail] = now
		case ButtonUp:
			c.heldButtons = remove(c.heldButtons, e.Detail)
			c.sentButtons[e.Detail] = now
		}
	}
	return nil
}

func (c *Controller) noteEscape(code uint8, now time.Time) {
	if code != 0 && code == c.escapeCode() {
		c.lastEscAt = now
	}
}

// sequence runs a sequence of events; if something other than a stop breaks it, lets go of what it held.
func (c *Controller) sequence(body func() error) error {
	err := body()
	if err != nil && !rpc.IsStopped(err) {
		c.ReleaseAll()
	}
	return err
}

func (c *Controller) keyEvent(code uint8, down bool) []Event {
	if down {
		return []Event{{Kind: KeyDown, Detail: code}}
	}
	return []Event{{Kind: KeyUp, Detail: code}}
}

// modifierCodes are the keycodes of the modifiers on this keyboard, in the order given.
func (c *Controller) modifierCodes(mods []keys.Modifier) ([]uint8, error) {
	km, err := c.sender.Keymap()
	if err != nil {
		return nil, rpc.Internal("could not read the keyboard: %v", err)
	}
	var codes []uint8
	for _, m := range mods {
		code, ok := km.ModifierCode(m)
		if !ok {
			return nil, rpc.Unsupported("this keyboard has no %s key", m)
		}
		codes = append(codes, code)
	}
	return codes, nil
}

func (c *Controller) pressCodes(codes []uint8) error {
	for _, code := range codes {
		if err := c.post(c.keyEvent(code, true)); err != nil {
			return err
		}
		c.sleep(8 * time.Millisecond)
	}
	return nil
}

// releaseCodes lets go of the keys, last first; only those still held (a release may have come in between).
func (c *Controller) releaseCodes(codes []uint8) error {
	c.mu.Lock()
	held := append([]uint8(nil), c.heldKeys...)
	c.mu.Unlock()
	for i := len(codes) - 1; i >= 0; i-- {
		if !contains(held, codes[i]) {
			continue
		}
		if err := c.post(c.keyEvent(codes[i], false)); err != nil {
			return err
		}
		c.sleep(8 * time.Millisecond)
	}
	return nil
}

// ---------------------------------------------------------------- mouse

// postMove moves the pointer to the pixel (absolute). With a button held this is a drag.
func (c *Controller) postMove(p proto.Point) error {
	s := c.sender.Screen()
	x := clampInt(int(math.Round(p.X)), 0, max(s.Width-1, 0))
	y := clampInt(int(math.Round(p.Y)), 0, max(s.Height-1, 0))
	c.mu.Lock()
	// Where the pointer goes is the helper's before it gets there: the control watch must not take this move for the
	// person's.
	if !c.stopped && !c.terminated {
		moved := proto.Point{X: float64(x), Y: float64(y)}
		c.lastPointer = &moved
	}
	c.mu.Unlock()
	return c.post([]Event{{Kind: Motion, X: int16(x), Y: int16(y)}})
}

func clampInt(v, lo, hi int) int { return min(max(v, lo), hi) }

func (c *Controller) button(b Button, down bool) error {
	n := c.sender.Button(b)
	if down {
		return c.post([]Event{{Kind: ButtonDown, Detail: n}})
	}
	return c.post([]Event{{Kind: ButtonUp, Detail: n}})
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
		codes, err := c.modifierCodes(mods)
		if err != nil {
			return err
		}
		if err := c.postMove(p); err != nil {
			return err
		}
		c.sleep(30 * time.Millisecond)
		if err := c.pressCodes(codes); err != nil {
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
		return c.releaseCodes(codes)
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

// WheelClicks are the wheel buttons to click for a scroll in lines (one click a line): positive dy scrolls the content
// down (button 5), positive dx right (button 7).
func WheelClicks(dx, dy float64) (vertical, horizontal []uint8) {
	repeat := func(n int, positive, negative uint8) []uint8 {
		button := positive
		if n < 0 {
			button, n = negative, -n
		}
		out := make([]uint8, n)
		for i := range out {
			out[i] = button
		}
		return out
	}
	return repeat(int(math.Round(dy)), wheelDown, wheelUp), repeat(int(math.Round(dx)), wheelRight, wheelLeft)
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
		vertical, horizontal := WheelClicks(dx, dy)
		for i, b := range append(vertical, horizontal...) {
			if i > 0 {
				c.sleep(10 * time.Millisecond)
			}
			// A click of the wheel button, as a wheel makes it.
			if err := c.post([]Event{{Kind: ButtonDown, Detail: b}, {Kind: ButtonUp, Detail: b}}); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---------------------------------------------------------------- keyboard

// strokeCodes are the keycodes to hold for the modifiers and the key of a stroke, in the order to press them.
type strokeKeys struct {
	mods []uint8
	key  uint8
	// shift: shift must be held for the key (and isn't among the modifiers already).
	shift uint8
}

// plan turns a stroke into keycodes on the keyboard as it is now.
func (c *Controller) plan(s keys.Stroke) (strokeKeys, error) {
	km, err := c.sender.Keymap()
	if err != nil {
		return strokeKeys{}, rpc.Internal("could not read the keyboard: %v", err)
	}
	var out strokeKeys
	hasShift := false
	for _, m := range s.Modifiers {
		code, ok := km.ModifierCode(m)
		if !ok {
			return out, rpc.Unsupported("this keyboard has no %s key", m)
		}
		out.mods = append(out.mods, code)
		hasShift = hasShift || m == keys.Shift
	}
	if s.Sym == 0 {
		return out, nil
	}
	p, ok := km.PlanAny(s.Sym)
	if !ok {
		return out, rpc.InvalidParams("this keyboard has no key for that")
	}
	out.key = p.Code
	if p.Shift && !hasShift {
		if code, ok := km.ModifierCode(keys.Shift); ok {
			out.shift = code
		}
	}
	return out, nil
}

// tap presses and lets go of one keycode, with shift around it when needed.
func (c *Controller) tap(k strokeKeys) error {
	if k.shift != 0 {
		if err := c.post(c.keyEvent(k.shift, true)); err != nil {
			return err
		}
		c.sleep(6 * time.Millisecond)
	}
	if err := c.post(c.keyEvent(k.key, true)); err != nil {
		return err
	}
	c.sleep(10 * time.Millisecond)
	if err := c.post(c.keyEvent(k.key, false)); err != nil {
		return err
	}
	if k.shift != 0 {
		c.sleep(6 * time.Millisecond)
		return c.post(c.keyEvent(k.shift, false))
	}
	return nil
}

// Press holds the modifiers, presses the key `repeat` times, and lets go of the modifiers.
func (c *Controller) Press(s keys.Stroke, repeat int) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		k, err := c.plan(s)
		if err != nil {
			return err
		}
		if err := c.pressCodes(k.mods); err != nil {
			return err
		}
		if k.key != 0 {
			for n := 0; n < repeat; n++ {
				if err := c.tap(k); err != nil {
					return err
				}
				if n < repeat-1 {
					c.sleep(20 * time.Millisecond)
				}
			}
		}
		c.sleep(10 * time.Millisecond)
		return c.releaseCodes(k.mods)
	})
}

// typingPause is the time between typed characters: applications read the keyboard mapping when a key arrives, and a
// character bound to a spare key must have been seen by them before it is rebound.
const typingPause = 12 * time.Millisecond

// bindPause lets applications take in the new mapping (MappingNotify) before a key that depends on it is sent.
const bindPause = 25 * time.Millisecond

// Type types text: each character on the key that has it in the layout in use (with shift when that takes), else on a
// spare key bound to it for the moment; line breaks as Return and tabs as Tab.
func (c *Controller) Type(text string) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		for _, piece := range keys.Pieces(text) {
			var err error
			switch piece.Kind {
			case keys.Newline:
				err = c.pressSym(keys.XKReturn)
			case keys.TabKey:
				err = c.pressSym(keys.XKTab)
			default:
				err = c.typeRune(piece.Rune)
			}
			if err != nil {
				return err
			}
			c.sleep(typingPause)
		}
		return nil
	})
}

func (c *Controller) pressSym(sym uint32) error {
	k, err := c.plan(keys.Stroke{Sym: sym})
	if err != nil {
		return err
	}
	return c.tap(k)
}

func (c *Controller) typeRune(r rune) error {
	sym := keys.TypedSym(r)
	km, err := c.sender.Keymap()
	if err != nil {
		return rpc.Internal("could not read the keyboard: %v", err)
	}
	if p, ok := km.Plan(sym); ok {
		k := strokeKeys{key: p.Code}
		if p.Shift {
			if code, ok := km.ModifierCode(keys.Shift); ok {
				k.shift = code
			}
		}
		return c.tap(k)
	}
	code, restore, err := c.sender.Bind(sym)
	if err != nil {
		return rpc.Unsupported("could not type %q: %v", string(r), err)
	}
	defer restore()
	c.sleep(bindPause)
	if err := c.tap(strokeKeys{key: code}); err != nil {
		return err
	}
	c.sleep(bindPause)
	return nil
}

// Hold holds the stroke for ms, cut short by a release or a stop.
func (c *Controller) Hold(s keys.Stroke, ms int) error {
	if err := c.ready(); err != nil {
		return err
	}
	return c.sequence(func() error {
		k, err := c.plan(s)
		if err != nil {
			return err
		}
		if err := c.pressCodes(k.mods); err != nil {
			return err
		}
		if k.key != 0 {
			if k.shift != 0 {
				if err := c.post(c.keyEvent(k.shift, true)); err != nil {
					return err
				}
			}
			if err := c.post(c.keyEvent(k.key, true)); err != nil {
				return err
			}
		}
		if err := c.wait(time.Duration(ms) * time.Millisecond); err != nil {
			return err
		}
		if k.key != 0 {
			c.mu.Lock()
			held := contains(c.heldKeys, k.key)
			c.mu.Unlock()
			if held {
				if err := c.post(c.keyEvent(k.key, false)); err != nil {
					return err
				}
			}
			if k.shift != 0 {
				if err := c.releaseCodes([]uint8{k.shift}); err != nil {
					return err
				}
			}
		}
		return c.releaseCodes(k.mods)
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

func contains(list []uint8, v uint8) bool {
	for _, have := range list {
		if have == v {
			return true
		}
	}
	return false
}

func remove(list []uint8, v uint8) []uint8 {
	out := list[:0]
	for _, have := range list {
		if have != v {
			out = append(out, have)
		}
	}
	return out
}
