//go:build linux

package x11

import (
	"strings"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/shape"
	"github.com/jezek/xgb/xproto"

	"atelier.dev/computer-linux/internal/region"
)

// Props are what an application tells the window manager about one of its windows.
type Props struct {
	Title    string
	Class    string // WM_CLASS class ("Firefox")
	Instance string // WM_CLASS instance ("Navigator")
	// GtkAppID is _GTK_APPLICATION_ID (GTK apps name themselves by their desktop file), DesktopFile is KDE's
	// _KDE_NET_WM_DESKTOP_FILE.
	GtkAppID    string
	DesktopFile string
	PID         uint32
	Types       []string // _NET_WM_WINDOW_TYPE_*, without the prefix
	States      []string // _NET_WM_STATE_*, without the prefix
}

// Win is one top-level window as the person sees it.
type Win struct {
	// ID is the client window: the one with the application's properties. Frame is the child of the root that holds it (the
	// window manager's frame, or the client itself where nothing reparents).
	ID, Frame xproto.Window
	// Rect is the frame in the root's coordinates, borders included.
	Rect     region.Rect
	Viewable bool
	// Iconic: minimized (or hidden by the window manager some other way). It has no place on screen.
	Iconic bool
	// ClickThrough: the window takes no pointer input (an empty input shape: Atelier's overlay), so it neither hides what
	// is below it from a click nor from a screenshot's masks.
	ClickThrough bool
	Props
}

func (w Win) hasType(name string) bool {
	for _, t := range w.Types {
		if t == name {
			return true
		}
	}
	return false
}

// Desktop is the window that draws the desktop (wallpaper, icons): it is never masked from a screenshot.
func (w Win) Desktop() bool { return w.hasType("DESKTOP") }

// Snapshot is the windows at one moment.
type Snapshot struct {
	// Stack is every window drawn on screen, top first (menus and panels included).
	Stack []Win
	// Clients are the windows the person can switch to, top first, minimized ones too.
	Clients []Win
	// Active is the window with the keyboard focus (0: none known).
	Active xproto.Window
}

// frameAbove is the child of the root that holds the window: its parent, or further up where a window manager nests
// its frame in another window.
func (c *Conn) frameAbove(client, parent xproto.Window) xproto.Window {
	if parent == c.Root || parent == 0 {
		return client
	}
	for depth := 0; depth < 4; depth++ {
		r, err := xproto.QueryTree(c.X, parent).Reply()
		if err != nil || r.Parent == c.Root || r.Parent == 0 {
			return parent
		}
		parent = r.Parent
	}
	return parent
}

// hasWM: a window manager that speaks EWMH is running.
func (c *Conn) hasWM() bool {
	return len(c.propertyCardinals(c.Root, "_NET_SUPPORTING_WM_CHECK", xproto.AtomWindow, 1)) > 0
}

type treeCookie struct {
	w      xproto.Window
	cookie xproto.QueryTreeCookie
}

// Snapshot reads the windows. The requests for many windows are sent together and read back after, so it costs a few
// round trips whatever the number of windows.
func (c *Conn) Snapshot() Snapshot {
	var snap Snapshot
	tree, err := xproto.QueryTree(c.X, c.Root).Reply()
	if err != nil {
		return snap
	}
	ewmh := c.hasWM()
	var clientIDs []xproto.Window
	if ewmh {
		for _, id := range c.propertyCardinals(c.Root, "_NET_CLIENT_LIST_STACKING", xproto.AtomWindow, 4096) {
			clientIDs = append(clientIDs, xproto.Window(id))
		}
		if a := c.propertyCardinals(c.Root, "_NET_ACTIVE_WINDOW", xproto.AtomWindow, 1); len(a) > 0 {
			snap.Active = xproto.Window(a[0])
		}
	}

	// The frames: root children, bottom to top.
	type attrs struct {
		attr xproto.GetWindowAttributesCookie
		geom xproto.GetGeometryCookie
	}
	pending := make([]attrs, len(tree.Children))
	for i, w := range tree.Children {
		pending[i] = attrs{xproto.GetWindowAttributes(c.X, w), xproto.GetGeometry(c.X, xproto.Drawable(w))}
	}
	type frame struct {
		id       xproto.Window
		rect     region.Rect
		viewable bool
		override bool
	}
	var frames []frame
	for i, w := range tree.Children {
		a, aerr := pending[i].attr.Reply()
		g, gerr := pending[i].geom.Reply()
		if aerr != nil || gerr != nil || a.Class == xproto.WindowClassInputOnly {
			continue
		}
		b := int(g.BorderWidth)
		frames = append(frames, frame{
			id:       w,
			rect:     region.Rect{X0: int(g.X), Y0: int(g.Y), X1: int(g.X) + int(g.Width) + 2*b, Y1: int(g.Y) + int(g.Height) + 2*b},
			viewable: a.MapState == xproto.MapStateViewable,
			override: a.OverrideRedirect,
		})
	}

	// Which frame holds which client: walk up from each client to the root's child.
	frameOf := map[xproto.Window]xproto.Window{}
	{
		parents := make([]treeCookie, len(clientIDs))
		for i, id := range clientIDs {
			parents[i] = treeCookie{id, xproto.QueryTree(c.X, id)}
		}
		for _, p := range parents {
			r, err := p.cookie.Reply()
			if err != nil {
				continue
			}
			frameOf[p.w] = c.frameAbove(p.w, r.Parent)
		}
	}
	clientOfFrame := map[xproto.Window]xproto.Window{}
	for client, f := range frameOf {
		clientOfFrame[f] = client
	}

	// Without a window manager's list, the windows that look like applications' own are the clients.
	if !ewmh {
		for _, f := range frames {
			if f.viewable && !f.override {
				clientIDs = append(clientIDs, f.id)
				frameOf[f.id] = f.id
				clientOfFrame[f.id] = f.id
			}
		}
	}

	// Properties of every window that is a client or an override-redirect window (menus and tooltips name their
	// application too).
	want := map[xproto.Window]bool{}
	for _, id := range clientIDs {
		want[id] = true
	}
	for _, f := range frames {
		if f.viewable && clientOfFrame[f.id] == 0 {
			want[f.id] = true
		}
	}
	props := c.fetchProps(want)
	shaped := c.clickThrough(want)

	frameInfo := map[xproto.Window]frame{}
	for _, f := range frames {
		frameInfo[f.id] = f
	}
	build := func(client, fid xproto.Window) (Win, bool) {
		f, ok := frameInfo[fid]
		if !ok {
			return Win{}, false
		}
		p := props[client]
		return Win{ID: client, Frame: fid, Rect: f.rect, Viewable: f.viewable, Props: p, ClickThrough: shaped[client]}, true
	}
	for i := len(frames) - 1; i >= 0; i-- {
		f := frames[i]
		if !f.viewable {
			continue
		}
		client := clientOfFrame[f.id]
		if client == 0 {
			client = f.id
		}
		if w, ok := build(client, f.id); ok {
			snap.Stack = append(snap.Stack, w)
		}
	}
	for i := len(clientIDs) - 1; i >= 0; i-- {
		id := clientIDs[i]
		fid := frameOf[id]
		w, ok := build(id, fid)
		if !ok {
			// A client with no frame we know (not reparented yet): its own geometry.
			g, err := xproto.GetGeometry(c.X, xproto.Drawable(id)).Reply()
			if err != nil {
				continue
			}
			w = Win{ID: id, Frame: id, Rect: region.Rect{X0: int(g.X), Y0: int(g.Y), X1: int(g.X) + int(g.Width), Y1: int(g.Y) + int(g.Height)}, Props: props[id]}
		}
		w.Iconic = hasState(w.States, "HIDDEN") || !w.Viewable
		snap.Clients = append(snap.Clients, w)
	}
	return snap
}

func hasState(states []string, name string) bool {
	for _, s := range states {
		if s == name {
			return true
		}
	}
	return false
}

// fetchProps reads the properties of many windows with the requests pipelined.
func (c *Conn) fetchProps(ids map[xproto.Window]bool) map[xproto.Window]Props {
	netName, name, class := c.Atom("_NET_WM_NAME"), xproto.Atom(xproto.AtomWmName), xproto.Atom(xproto.AtomWmClass)
	utf8, pid := c.Atom("UTF8_STRING"), c.Atom("_NET_WM_PID")
	gtk, kde := c.Atom("_GTK_APPLICATION_ID"), c.Atom("_KDE_NET_WM_DESKTOP_FILE")
	types, states := c.Atom("_NET_WM_WINDOW_TYPE"), c.Atom("_NET_WM_STATE")
	type set struct{ netName, name, class, pid, gtk, kde, types, states xproto.GetPropertyCookie }
	get := func(w xproto.Window, prop, typ xproto.Atom, words uint32) xproto.GetPropertyCookie {
		return xproto.GetProperty(c.X, false, w, prop, typ, 0, words)
	}
	cookies := make(map[xproto.Window]set, len(ids))
	for w := range ids {
		cookies[w] = set{
			netName: get(w, netName, utf8, 256), name: get(w, name, xproto.Atom(xproto.AtomAny), 256), class: get(w, class, xproto.Atom(xproto.AtomString), 256),
			pid: get(w, pid, xproto.Atom(xproto.AtomCardinal), 1), gtk: get(w, gtk, utf8, 128), kde: get(w, kde, utf8, 128),
			types: get(w, types, xproto.Atom(xproto.AtomAtom), 16), states: get(w, states, xproto.Atom(xproto.AtomAtom), 32),
		}
	}
	val := func(ck xproto.GetPropertyCookie) []byte {
		r, err := ck.Reply()
		if err != nil || r == nil || r.ValueLen == 0 {
			return nil
		}
		return r.Value
	}
	atoms := func(data []byte, prefix string) []string {
		var out []string
		for i := 0; i+4 <= len(data); i += 4 {
			out = append(out, strings.TrimPrefix(c.AtomName(xproto.Atom(xgb.Get32(data[i:]))), prefix))
		}
		return out
	}
	out := make(map[xproto.Window]Props, len(ids))
	for w, ck := range cookies {
		p := Props{
			Title:       string(val(ck.netName)),
			GtkAppID:    string(val(ck.gtk)),
			DesktopFile: string(val(ck.kde)),
			Types:       atoms(val(ck.types), "_NET_WM_WINDOW_TYPE_"),
			States:      atoms(val(ck.states), "_NET_WM_STATE_"),
		}
		if t := val(ck.name); p.Title == "" && t != nil {
			p.Title = string(t)
		}
		if b := val(ck.pid); len(b) >= 4 {
			p.PID = xgb.Get32(b)
		}
		// WM_CLASS is two NUL-terminated strings: the instance, then the class.
		if b := val(ck.class); b != nil {
			parts := strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
			p.Instance = parts[0]
			if len(parts) > 1 {
				p.Class = parts[1]
			}
		}
		out[w] = p
	}
	return out
}

// clickThrough finds which of the windows take no pointer input: their input shape is empty.
func (c *Conn) clickThrough(ids map[xproto.Window]bool) map[xproto.Window]bool {
	out := map[xproto.Window]bool{}
	if !c.HasShape {
		return out
	}
	cookies := make(map[xproto.Window]shape.GetRectanglesCookie, len(ids))
	for w := range ids {
		cookies[w] = shape.GetRectangles(c.X, w, shape.SkInput)
	}
	for w, ck := range cookies {
		r, err := ck.Reply()
		out[w] = err == nil && r != nil && len(r.Rectangles) == 0
	}
	return out
}

// WindowAt is the topmost window that takes a click at the point (the root's coordinates).
func (s Snapshot) WindowAt(x, y int) (Win, bool) {
	for _, w := range s.Stack {
		if w.ClickThrough || x < w.Rect.X0 || x >= w.Rect.X1 || y < w.Rect.Y0 || y >= w.Rect.Y1 {
			continue
		}
		return w, true
	}
	return Win{}, false
}
