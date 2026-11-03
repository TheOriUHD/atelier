//go:build linux

package x11

import (
	"sync"
	"time"

	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"atelier.dev/computer-linux/internal/input"
	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
)

// Sender sends input through XTEST (input.Sender): fake key, button and motion events the server treats like a keyboard's
// and a mouse's.
type Sender struct {
	c *Conn

	mu       sync.Mutex
	mapping  *keys.Keymap
	mappedAt time.Time
	buttons  []byte
	buttonAt time.Time
}

func NewSender(c *Conn) *Sender { return &Sender{c: c} }

// Event types of XTEST's FakeInput (the core protocol's event numbers).
const (
	evKeyPress      = 2
	evKeyRelease    = 3
	evButtonPress   = 4
	evButtonRelease = 5
	evMotionNotify  = 6
)

func (s *Sender) Send(events []input.Event) error {
	var last xtest.FakeInputCookie
	for _, e := range events {
		var kind byte
		switch e.Kind {
		case input.KeyDown:
			kind = evKeyPress
		case input.KeyUp:
			kind = evKeyRelease
		case input.ButtonDown:
			kind = evButtonPress
		case input.ButtonUp:
			kind = evButtonRelease
		default:
			kind = evMotionNotify
		}
		// Motion is absolute (detail 0) in the root's coordinates; the others carry the keycode or button.
		last = xtest.FakeInputChecked(s.c.X, kind, e.Detail, 0, s.c.Root, e.X, e.Y, 0)
	}
	if len(events) == 0 {
		return nil
	}
	// The last one is checked: it makes the server answer, so everything before has been handled when this returns.
	return last.Check()
}

// mappingTTL is how long the keyboard mapping is trusted: it changes when the person switches layout settings, and when
// Bind rebinds a key (which drops it at once).
const mappingTTL = 2 * time.Second

func (s *Sender) Keymap() (*keys.Keymap, error) {
	s.mu.Lock()
	if s.mapping == nil || time.Since(s.mappedAt) > mappingTTL {
		m, err := s.readMapping()
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		s.mapping, s.mappedAt = m, time.Now()
	}
	km := *s.mapping
	s.mu.Unlock()
	// The layout in use and the lock state change as the person types: read them each time. Bits 13–14 of the state are the
	// keyboard group, bit 1 is Caps Lock.
	if q, err := xproto.QueryPointer(s.c.X, s.c.Root).Reply(); err == nil {
		km.Group = int(q.Mask>>13) & 3
		km.CapsLock = q.Mask&xproto.ModMaskLock != 0
	}
	return &km, nil
}

func (s *Sender) readMapping() (*keys.Keymap, error) {
	setup := xproto.Setup(s.c.X)
	first, last := setup.MinKeycode, setup.MaxKeycode
	reply, err := xproto.GetKeyboardMapping(s.c.X, first, byte(int(last)-int(first)+1)).Reply()
	if err != nil {
		return nil, err
	}
	syms := make([]uint32, len(reply.Keysyms))
	for i, k := range reply.Keysyms {
		syms[i] = uint32(k)
	}
	return &keys.Keymap{Min: uint8(first), Max: uint8(last), Per: int(reply.KeysymsPerKeycode), Syms: syms}, nil
}

func (s *Sender) forget() {
	s.mu.Lock()
	s.mapping = nil
	s.mu.Unlock()
}

// Button is the physical button number that the server maps to the logical one: with the buttons swapped (a left-handed
// setting) the left button is another one.
func (s *Sender) Button(b input.Button) uint8 {
	logical := map[input.Button]byte{input.Left: 1, input.Middle: 2, input.Right: 3}[b]
	s.mu.Lock()
	if s.buttons == nil || time.Since(s.buttonAt) > mappingTTL {
		if r, err := xproto.GetPointerMapping(s.c.X).Reply(); err == nil {
			s.buttons, s.buttonAt = r.Map, time.Now()
		}
	}
	mapping := s.buttons
	s.mu.Unlock()
	for i, l := range mapping {
		if l == logical {
			return uint8(i + 1)
		}
	}
	return logical
}

func (s *Sender) Pointer() (proto.Point, bool) {
	q, err := xproto.QueryPointer(s.c.X, s.c.Root).Reply()
	if err != nil {
		return proto.Point{}, false
	}
	return proto.Point{X: float64(q.RootX), Y: float64(q.RootY)}, true
}

func (s *Sender) Screen() input.Screen {
	w, h := s.c.ScreenSize()
	return input.Screen{Width: w, Height: h}
}

// Bind gives a spare key the keysym in every column, so it types it whatever the layout and shift state; restore puts
// back what the key held.
func (s *Sender) Bind(sym uint32) (uint8, func(), error) {
	s.mu.Lock()
	m, err := s.readMapping()
	s.mu.Unlock()
	if err != nil {
		return 0, nil, err
	}
	code := m.Spare()
	per := m.Per
	old := make([]xproto.Keysym, per)
	for col := 0; col < per; col++ {
		old[col] = xproto.Keysym(m.Syms[int(code-m.Min)*per+col])
	}
	bound := make([]xproto.Keysym, per)
	for col := range bound {
		bound[col] = xproto.Keysym(sym)
	}
	if err := xproto.ChangeKeyboardMappingChecked(s.c.X, 1, xproto.Keycode(code), byte(per), bound).Check(); err != nil {
		return 0, nil, err
	}
	s.forget()
	var once sync.Once
	restore := func() {
		once.Do(func() {
			_ = xproto.ChangeKeyboardMappingChecked(s.c.X, 1, xproto.Keycode(code), byte(per), old).Check()
			s.forget()
		})
	}
	return code, restore, nil
}
