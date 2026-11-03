//go:build linux

package x11

import (
	"sync"
	"time"

	"github.com/jezek/xgb/xproto"

	"atelier.dev/computer-linux/internal/control"
	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
)

// Watch is the control watch (control.Hooks): it polls the pointer and the keyboard state every 25 ms and reports what
// the person did themselves, which is what the pointer, the buttons and the keys show that the helper didn't send.
//
// The X server offers events of all input only through the RECORD or XInput2 extensions. RECORD answers one request
// with a stream of replies, which the pure-Go client can't read, and XInput2 can't tell the person's mouse from XTEST's
// either in a plain server. Polling the state needs neither and works on every server; a key tapped and released
// within 25 ms can be missed, but a person's key press is longer than that.
type Watch struct {
	c *Conn

	mu   sync.Mutex
	stop chan struct{}
	done chan struct{}
}

func NewWatch(c *Conn) *Watch { return &Watch{c: c} }

const pollEvery = 25 * time.Millisecond

func (w *Watch) Start(sink func(control.Sample), own control.Own) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		return nil
	}
	// A first reading, so the loop reports changes from now on (and a refusal shows here).
	if _, err := xproto.QueryKeymap(w.c.X).Reply(); err != nil {
		return err
	}
	w.stop, w.done = make(chan struct{}), make(chan struct{})
	go w.loop(sink, own, w.stop, w.done)
	return nil
}

func (w *Watch) Stop() {
	w.mu.Lock()
	stop, done := w.stop, w.done
	w.stop, w.done = nil, nil
	w.mu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
}

// Buttons 1–3 are the ones a person clicks; 4 and 5 (the wheel) are momentary.
var buttonMasks = [...]uint16{xproto.ButtonMask1, xproto.ButtonMask2, xproto.ButtonMask3}

func (w *Watch) loop(sink func(control.Sample), own control.Own, stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(pollEvery)
	defer ticker.Stop()

	sender := NewSender(w.c)
	var (
		prevKeys    [32]byte
		prevMask    uint16
		prevX       int16 = -1
		prevY       int16 = -1
		modifiers         = map[uint8]bool{}
		escape      uint8
		mappingRead time.Time
	)
	if r, err := xproto.QueryKeymap(w.c.X).Reply(); err == nil {
		copy(prevKeys[:], r.Keys)
	}
	if q, err := xproto.QueryPointer(w.c.X, w.c.Root).Reply(); err == nil {
		prevMask, prevX, prevY = q.Mask, q.RootX, q.RootY
	}
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		if time.Since(mappingRead) > 2*time.Second {
			if km, err := sender.Keymap(); err == nil {
				modifiers = map[uint8]bool{}
				for code := int(km.Min); code <= int(km.Max); code++ {
					if km.IsModifierCode(uint8(code)) {
						modifiers[uint8(code)] = true
					}
				}
				escape, _ = km.CodeOf(keys.XKEscape)
				mappingRead = time.Now()
			}
		}
		if q, err := xproto.QueryPointer(w.c.X, w.c.Root).Reply(); err == nil {
			if q.RootX != prevX || q.RootY != prevY {
				sink(control.Sample{Kind: control.SampleMoved, At: proto.Point{X: float64(q.RootX), Y: float64(q.RootY)}})
			}
			for i, mask := range buttonMasks {
				if q.Mask&mask != 0 && prevMask&mask == 0 && !own.ButtonIsOurs(uint8(i+1)) {
					sink(control.Sample{Kind: control.SampleMouseDown})
				}
			}
			prevMask, prevX, prevY = q.Mask, q.RootX, q.RootY
		}
		if r, err := xproto.QueryKeymap(w.c.X).Reply(); err == nil && len(r.Keys) >= 32 {
			for code := 8; code < 256; code++ {
				now, before := r.Keys[code/8]&(1<<(code%8)) != 0, prevKeys[code/8]&(1<<(code%8)) != 0
				c := uint8(code)
				// Esc is the Esc watch's (the 50 ms poll), a modifier alone isn't input, and the helper's own keys aren't the
				// person's.
				if now && !before && c != escape && !modifiers[c] && !own.KeyIsOurs(c) {
					sink(control.Sample{Kind: control.SampleKeyDown})
				}
			}
			copy(prevKeys[:], r.Keys)
		}
	}
}

// EscapeDown reads whether Esc is down now (the key map), for the Esc hold's poll.
func (c *Conn) EscapeDown() bool {
	km, err := NewSender(c).Keymap()
	if err != nil {
		return false
	}
	code, ok := km.CodeOf(keys.XKEscape)
	if !ok {
		return false
	}
	r, err := xproto.QueryKeymap(c.X).Reply()
	if err != nil || len(r.Keys) < 32 {
		return false
	}
	return r.Keys[code/8]&(1<<(code%8)) != 0
}
