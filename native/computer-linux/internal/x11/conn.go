//go:build linux

// Package x11 is the Linux helper's X11 side: the screen (RandR, GetImage), the windows (EWMH, with plain X11 where there
// is no window manager), input (the XTEST extension) and the watch for the person's own input (polling the pointer and
// the keymap). The protocol is spoken by a pure-Go client (jezek/xgb), so the helper is a static binary that needs no
// X libraries, builds with CGO off and cross-compiles for x64 and arm64.
package x11

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/shape"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

// Conn is one connection to the X server and what was learned of it when it opened.
type Conn struct {
	X      *xgb.Conn
	Screen xproto.ScreenInfo
	Root   xproto.Window

	// Extensions that are optional: the helper still works without them, less well.
	HasRandR  bool
	HasShape  bool
	HasFixes  bool
	depth     byte
	bytesPP   int
	redMask   uint32
	greenMask uint32
	blueMask  uint32
	msbFirst  bool

	mu    sync.Mutex
	atoms map[string]xproto.Atom
	names map[xproto.Atom]string
}

// ErrNoDisplay: there is no X server to talk to (no DISPLAY, or it can't be reached).
var ErrNoDisplay = errors.New("no X display")

// Open connects to $DISPLAY. XTEST is required (it is how input goes in); the others are optional.
func Open() (*Conn, error) {
	if os.Getenv("DISPLAY") == "" {
		return nil, fmt.Errorf("%w: DISPLAY is not set (a Wayland-only or text session has no X server)", ErrNoDisplay)
	}
	// A server without an Xauthority file is normal (Xvfb in a container); the library says so on every connection.
	xgb.Logger.SetOutput(io.Discard)
	x, err := xgb.NewConn()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNoDisplay, err)
	}
	c := &Conn{X: x, atoms: map[string]xproto.Atom{}, names: map[xproto.Atom]string{}}
	setup := xproto.Setup(x)
	c.Screen = *setup.DefaultScreen(x)
	c.Root = c.Screen.Root
	if err := xtest.Init(x); err != nil {
		x.Close()
		return nil, fmt.Errorf("the X server has no XTEST extension, which Atelier sends input through: %v", err)
	}
	c.HasRandR = randr.Init(x) == nil
	c.HasShape = shape.Init(x) == nil
	if xfixes.Init(x) == nil {
		_, err := xfixes.QueryVersion(x, 4, 0).Reply()
		c.HasFixes = err == nil
	}
	if err := c.readFormat(setup); err != nil {
		x.Close()
		return nil, err
	}
	return c, nil
}

// readFormat finds how the root window's pixels are laid out in a GetImage reply.
func (c *Conn) readFormat(setup *xproto.SetupInfo) error {
	c.depth = c.Screen.RootDepth
	c.msbFirst = setup.ImageByteOrder == xproto.ImageOrderMSBFirst
	for _, f := range setup.PixmapFormats {
		if f.Depth == c.depth {
			c.bytesPP = int(f.BitsPerPixel) / 8
		}
	}
	for _, d := range c.Screen.AllowedDepths {
		for _, v := range d.Visuals {
			if v.VisualId == c.Screen.RootVisual {
				c.redMask, c.greenMask, c.blueMask = v.RedMask, v.GreenMask, v.BlueMask
			}
		}
	}
	if c.bytesPP != 4 && c.bytesPP != 3 && c.bytesPP != 2 {
		return fmt.Errorf("the screen's pixel format (%d bits) isn't one Atelier can read", c.bytesPP*8)
	}
	return nil
}

// Close ends the connection.
func (c *Conn) Close() { c.X.Close() }

// Atom is the atom with this name (created if the server doesn't have it yet).
func (c *Conn) Atom(name string) xproto.Atom {
	c.mu.Lock()
	if a, ok := c.atoms[name]; ok {
		c.mu.Unlock()
		return a
	}
	c.mu.Unlock()
	reply, err := xproto.InternAtom(c.X, false, uint16(len(name)), name).Reply()
	if err != nil {
		return 0
	}
	c.mu.Lock()
	c.atoms[name] = reply.Atom
	c.names[reply.Atom] = name
	c.mu.Unlock()
	return reply.Atom
}

// AtomName is the name of an atom ("" when it has none).
func (c *Conn) AtomName(a xproto.Atom) string {
	c.mu.Lock()
	if n, ok := c.names[a]; ok {
		c.mu.Unlock()
		return n
	}
	c.mu.Unlock()
	reply, err := xproto.GetAtomName(c.X, a).Reply()
	if err != nil {
		return ""
	}
	c.mu.Lock()
	c.names[a] = reply.Name
	c.mu.Unlock()
	return reply.Name
}

// property reads a window property's value, nil when the window doesn't have it (or is gone).
func (c *Conn) property(w xproto.Window, name string, typ xproto.Atom, maxWords uint32) []byte {
	prop := c.Atom(name)
	if prop == 0 {
		return nil
	}
	reply, err := xproto.GetProperty(c.X, false, w, prop, typ, 0, maxWords).Reply()
	if err != nil || reply == nil || reply.ValueLen == 0 {
		return nil
	}
	return reply.Value
}

// propertyWindows is a property made of window ids (_NET_CLIENT_LIST, _NET_ACTIVE_WINDOW).
func (c *Conn) propertyCardinals(w xproto.Window, name string, typ xproto.Atom, maxWords uint32) []uint32 {
	data := c.property(w, name, typ, maxWords)
	out := make([]uint32, 0, len(data)/4)
	for i := 0; i+4 <= len(data); i += 4 {
		out = append(out, xgb.Get32(data[i:]))
	}
	return out
}

// propertyString reads a UTF8_STRING or STRING property.
func (c *Conn) propertyString(w xproto.Window, name string) string {
	for _, typ := range []string{"UTF8_STRING", "STRING"} {
		if data := c.property(w, name, c.Atom(typ), 1024); data != nil {
			return string(data)
		}
	}
	return ""
}
