//go:build linux

package x11

import (
	"github.com/jezek/xgb/xproto"
)

// clientMessage sends a client message about a window to the root, where the window manager reads it (EWMH: the
// request to activate a window, to change its state…).
func (c *Conn) clientMessage(w xproto.Window, atom string, data []uint32) {
	c.clientMessageTo(c.Root, w, atom, data, xproto.EventMaskSubstructureRedirect|xproto.EventMaskSubstructureNotify)
}

// clientMessageTo sends a 32-bit client message with the window and type atom to a window.
func (c *Conn) clientMessageTo(to, w xproto.Window, atom string, data []uint32, mask int) {
	typ := c.Atom(atom)
	if typ == 0 {
		return
	}
	var words [5]uint32
	copy(words[:], data)
	ev := xproto.ClientMessageEvent{
		Format: 32,
		Window: w,
		Type:   typ,
		Data:   xproto.ClientMessageDataUnionData32New(words[:]),
	}
	_ = xproto.SendEventChecked(c.X, false, to, uint32(mask), string(ev.Bytes())).Check()
}
