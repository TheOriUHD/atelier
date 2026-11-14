//go:build linux

package x11

import (
	"encoding/base64"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jezek/xgb/xproto"

	"atelier.dev/computer-linux/internal/appid"
	"atelier.dev/computer-linux/internal/control"
	"atelier.dev/computer-linux/internal/helper"
	"atelier.dev/computer-linux/internal/imaging"
	"atelier.dev/computer-linux/internal/input"
	"atelier.dev/computer-linux/internal/inspect"
	"atelier.dev/computer-linux/internal/proto"
	"atelier.dev/computer-linux/internal/region"
	"atelier.dev/computer-linux/internal/rpc"
)

// AtelierID is the id of Atelier's own windows (the helper's parent process): main never lets the assistant use them.
const AtelierID = "atelier"

// System is the helper's X11 side (helper.System).
type System struct {
	c      *Conn
	sender *Sender
	watch  *Watch
	parent uint32

	idxMu  sync.Mutex
	idx    *appid.Index
	idxAt  time.Time
	locale []string

	hiddenMu sync.Mutex
	hidden   map[string][]xproto.Window // lowercase id → the windows apps.hide minimized

	access Accessibility
}

// Accessibility is what the accessibility tree (AT-SPI) tells about the element at a point or with the focus. Nothing
// implements it yet: the helper is built without it (ARCHITECTURE §22), so on Linux no field is known to be a password
// field and no link is known to be a link; the seam is here for when it is.
type Accessibility interface {
	// At is the element of the process's application at the screen point.
	At(pid uint32, x, y int) (*inspect.Element, bool)
	// Focused is the focused element anywhere.
	Focused() (*inspect.Element, bool)
}

// NewSystem opens the X connection.
func NewSystem(access Accessibility) (*System, error) {
	c, err := Open()
	if err != nil {
		return nil, err
	}
	sender := NewSender(c)
	return &System{
		c: c, sender: sender, watch: NewWatch(c), parent: uint32(os.Getppid()), hidden: map[string][]xproto.Window{},
		locale: appid.Locales(os.Getenv("LC_ALL"), os.Getenv("LC_MESSAGES"), os.Getenv("LANG")), access: access,
	}, nil
}

func (s *System) Close() { s.c.Close() }

func (s *System) Sender() input.Sender               { return s.sender }
func (s *System) Hooks() control.Hooks               { return s.watch }
func (s *System) Displays() ([]proto.Display, error) { return s.c.Displays(), nil }

// EscapeDown reads Esc's key state.
func (s *System) EscapeDown() bool {
	km, err := s.sender.Keymap()
	if err != nil {
		return false
	}
	code, ok := km.CodeOf(0xff1b)
	if !ok {
		return false
	}
	r, err := xproto.QueryKeymap(s.c.X).Reply()
	return err == nil && len(r.Keys) >= 32 && r.Keys[code/8]&(1<<(code%8)) != 0
}

// ---------------------------------------------------------------- apps

// entryTTL is how long the desktop entries are trusted: installing an app is rare, and reading them all costs a few
// hundred files.
const entryTTL = 30 * time.Second

func (s *System) index() *appid.Index {
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	if s.idx == nil || time.Since(s.idxAt) > entryTTL {
		s.idx = appid.NewIndex(appid.LoadEntries(os.Getenv, s.locale))
		s.idxAt = time.Now()
	}
	return s.idx
}

// appInfo is an app as one of its windows shows it.
type appInfo struct {
	ID, Name, Path string
	PID            int
	Entry          *appid.Entry
}

// appOf names the app a window belongs to.
func (s *System) appOf(w Win, pc *procs, ix *appid.Index) appInfo {
	if w.PID != 0 && w.PID == s.parent {
		return appInfo{ID: AtelierID, Name: "Atelier", PID: int(w.PID)}
	}
	proc := pc.get(w.PID)
	win := appid.Window{GtkAppID: w.GtkAppID, DesktopFile: w.DesktopFile, Class: w.Class, Instance: w.Instance, Exe: proc.Exe}
	var entry *appid.Entry
	if e, ok := ix.Match(win); ok {
		entry = &e
	}
	id, name := appid.Identity(entry, win)
	info := appInfo{ID: id, Name: name, Path: proc.Path, PID: int(w.PID), Entry: entry}
	if id == "" {
		info.ID, info.Name = "unknown", firstNonEmpty(w.Title, "An app")
	}
	if proc.Other {
		info.ID, info.Name = appid.ElevatedPrefix+info.ID, info.Name+" (running as another user)"
	}
	return info
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// switchable: a window the person would find in a task switcher (not a panel, a menu or the desktop).
func (w Win) switchable() bool {
	for _, t := range w.Types {
		switch t {
		case "DOCK", "DESKTOP", "TOOLBAR", "MENU", "DROPDOWN_MENU", "POPUP_MENU", "TOOLTIP", "NOTIFICATION", "COMBO", "DND", "SPLASH":
			return false
		}
	}
	return !hasState(w.States, "SKIP_TASKBAR") || hasState(w.States, "HIDDEN")
}

type running struct {
	info    appInfo
	windows []Win
}

// runningApps groups the switchable windows by app, topmost first.
func (s *System) runningApps(snap Snapshot) (map[string]*running, []string) {
	pc, ix := newProcs(), s.index()
	byID := map[string]*running{}
	var order []string
	for _, w := range snap.Clients {
		if !w.switchable() || w.ClickThrough {
			continue
		}
		info := s.appOf(w, pc, ix)
		key := strings.ToLower(info.ID)
		r, ok := byID[key]
		if !ok {
			r = &running{info: info}
			byID[key] = r
			order = append(order, key)
		}
		r.windows = append(r.windows, w)
	}
	return byID, order
}

func (s *System) wire(r *running, active xproto.Window) proto.App {
	hidden, isActive := true, false
	for _, w := range r.windows {
		hidden = hidden && w.Iconic
		isActive = isActive || w.ID == active
	}
	path := r.info.Path
	if path == "" && r.info.Entry != nil {
		path = r.info.Entry.File
	}
	return appid.Running{ID: r.info.ID, Name: r.info.Name, Path: path, PID: r.info.PID, Active: isActive, Hidden: hidden}.HelperApp()
}

func (s *System) Apps(installed bool) ([]proto.App, error) {
	snap := s.c.Snapshot()
	active := s.activeClient(snap)
	byID, order := s.runningApps(snap)
	var run []appid.Running
	for _, key := range order {
		a := s.wire(byID[key], active)
		r := appid.Running{ID: a.ID, Name: a.Name, Active: a.Active, Hidden: a.Hidden}
		if a.Path != nil {
			r.Path = *a.Path
		}
		if a.PID != nil {
			r.PID = *a.PID
		}
		run = append(run, r)
	}
	var inst []appid.Installed
	if installed {
		inst = appid.InstalledApps(s.index().Entries())
	}
	return appid.Merge(run, inst), nil
}

// activeClient is the client window with the keyboard: the window manager's active window, else the focus window's
// top-level.
func (s *System) activeClient(snap Snapshot) xproto.Window {
	if snap.Active != 0 {
		return snap.Active
	}
	focus, err := xproto.GetInputFocus(s.c.X).Reply()
	if err != nil || focus.Focus <= 1 {
		return 0
	}
	w := focus.Focus
	for depth := 0; depth < 8 && w != 0 && w != s.c.Root; depth++ {
		for _, c := range snap.Clients {
			if c.ID == w || c.Frame == w {
				return c.ID
			}
		}
		for _, c := range snap.Stack {
			if c.ID == w || c.Frame == w {
				return c.ID
			}
		}
		tree, err := xproto.QueryTree(s.c.X, w).Reply()
		if err != nil {
			return 0
		}
		w = tree.Parent
	}
	return 0
}

func (s *System) Frontmost() (*proto.App, error) {
	snap := s.c.Snapshot()
	active := s.activeClient(snap)
	if active == 0 {
		return nil, nil
	}
	pc, ix := newProcs(), s.index()
	for _, w := range snap.Clients {
		if w.ID != active {
			continue
		}
		info := s.appOf(w, pc, ix)
		byID, _ := s.runningApps(snap)
		if r, ok := byID[strings.ToLower(info.ID)]; ok {
			app := s.wire(r, active)
			return &app, nil
		}
		app := appid.Running{ID: info.ID, Name: info.Name, Path: info.Path, PID: info.PID, Active: true}.HelperApp()
		return &app, nil
	}
	return nil, nil
}

// appByID is an app by id as it is now.
func (s *System) appByID(id string) (proto.App, *running, bool) {
	snap := s.c.Snapshot()
	byID, _ := s.runningApps(snap)
	if r, ok := byID[strings.ToLower(id)]; ok {
		return s.wire(r, s.activeClient(snap)), r, true
	}
	return proto.App{}, nil, false
}

// OpenApp raises a running app's windows (activate), or starts it from its desktop entry and waits up to 10 s for a
// window.
func (s *System) OpenApp(id string, activate bool) (proto.App, error) {
	if app, r, ok := s.appByID(id); ok {
		if activate || app.Hidden {
			s.activate(r.windows[0])
		}
		if app, _, ok := s.appByID(id); ok {
			return app, nil
		}
	}
	entry, ok := s.index().ByID(id)
	if !ok {
		return proto.App{}, rpc.NotFound("no app %s", id)
	}
	if err := launch(entry); err != nil {
		return proto.App{}, rpc.Internal("could not open %s: %v", id, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if app, r, ok := s.appByID(id); ok && len(r.windows) > 0 {
			if activate {
				s.activate(r.windows[0])
			}
			return app, nil
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return proto.App{}, rpc.NotFound("%s didn't show a window within 10 s", id)
}

// launch starts a desktop entry's command in its own session, as a desktop does, without Electron's switches (they
// would make another Electron app run as Node).
func launch(e appid.Entry) error {
	if len(e.Exec) == 0 {
		return os.ErrInvalid
	}
	cmd := exec.Command(e.Exec[0], e.Exec[1:]...)
	cmd.Dir = e.Path
	cmd.Env = environment()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func environment() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "ELECTRON_RUN_AS_NODE=") || strings.HasPrefix(kv, "ELECTRON_NO_ATTACH_CONSOLE=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// ---------------------------------------------------------------- hiding, activating

// activate asks the window manager to make the window the active one (which also shows a minimized one), as a taskbar
// click does; without a window manager it raises the window and gives it the focus itself.
func (s *System) activate(w Win) {
	c := s.c
	if c.hasWM() {
		c.clientMessage(w.ID, "_NET_ACTIVE_WINDOW", []uint32{2 /* a pager/taskbar's request */, 0, 0, 0, 0})
		return
	}
	_ = xproto.MapWindowChecked(c.X, w.ID).Check()
	_ = xproto.ConfigureWindowChecked(c.X, w.Frame, xproto.ConfigWindowStackMode, []uint32{xproto.StackModeAbove}).Check()
	_ = xproto.SetInputFocusChecked(c.X, xproto.InputFocusPointerRoot, w.ID, xproto.TimeCurrentTime).Check()
}

// Activate makes the process's window the active one (Atelier itself: it comes to the front when control ends).
func (s *System) Activate(pid int) (bool, error) {
	snap := s.c.Snapshot()
	for _, w := range snap.Clients {
		if int(w.PID) == pid && w.switchable() {
			s.activate(w)
			return true, nil
		}
	}
	return false, nil
}

// HideApps minimizes the apps' windows: the window manager is asked as a minimize button would. Without a window manager
// the windows are unmapped (and mapped again by UnhideApps).
func (s *System) HideApps(ids []string, display string) ([]string, error) {
	var on *proto.Display
	if display != "" {
		for _, d := range s.c.Displays() {
			if strings.EqualFold(d.ID, display) {
				d := d
				on = &d
				break
			}
		}
		if on == nil {
			return nil, rpc.NotFound("no display %s", display)
		}
	}
	snap := s.c.Snapshot()
	byID, _ := s.runningApps(snap)
	wm := s.c.hasWM()
	var done []string
	s.hiddenMu.Lock()
	defer s.hiddenMu.Unlock()
	for _, id := range ids {
		r, ok := byID[strings.ToLower(id)]
		if !ok {
			continue
		}
		var moved []xproto.Window
		for _, w := range r.windows {
			// With a display: only the windows whose middle is on it.
			if w.Iconic || (on != nil && !onDisplay(w.Rect, *on)) {
				continue
			}
			if wm {
				// ICCCM: a WM_CHANGE_STATE message to the root asks the window manager to iconify the window.
				s.c.clientMessageTo(s.c.Root, w.ID, "WM_CHANGE_STATE", []uint32{3 /* IconicState */, 0, 0, 0, 0},
					xproto.EventMaskSubstructureRedirect|xproto.EventMaskSubstructureNotify)
			} else {
				_ = xproto.UnmapWindowChecked(s.c.X, w.ID).Check()
			}
			moved = append(moved, w.ID)
		}
		if len(moved) > 0 {
			s.hidden[strings.ToLower(id)] = moved
			done = append(done, id)
		}
	}
	return done, nil
}

// UnhideApps shows the windows HideApps hid, without taking the focus from where it is when the window manager lets it.
func (s *System) UnhideApps(ids []string) error {
	wm := s.c.hasWM()
	s.hiddenMu.Lock()
	defer s.hiddenMu.Unlock()
	for _, id := range ids {
		windows := s.hidden[strings.ToLower(id)]
		delete(s.hidden, strings.ToLower(id))
		for _, w := range windows {
			if wm {
				// source 1: an application's request, which window managers weigh against focus stealing.
				s.c.clientMessage(w, "_NET_ACTIVE_WINDOW", []uint32{1, 0, 0, 0, 0})
			} else {
				_ = xproto.MapWindowChecked(s.c.X, w).Check()
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------- capture

func (s *System) Capture(req helper.CaptureRequest) (proto.CaptureResult, error) {
	var display *proto.Display
	for _, d := range s.c.Displays() {
		d := d
		if d.ID == req.Display || strings.EqualFold(d.Name, req.Display) {
			display = &d
			break
		}
	}
	if display == nil {
		return proto.CaptureResult{}, rpc.NotFound("no display %s", req.Display)
	}
	bounds := proto.Rect{X: display.X, Y: display.Y, Width: display.Width, Height: display.Height}
	covered, ok := imaging.CoveredRect(req.Region, bounds)
	if !ok {
		return proto.CaptureResult{}, rpc.InvalidParams("region is outside display %s", req.Display)
	}
	x, y, w, h := imaging.PixelRect(covered)
	// Whole pixels, within the display.
	x0, y0 := max(x, int(display.X)), max(y, int(display.Y))
	x1, y1 := min(x+w, int(display.X+display.Width)), min(y+h, int(display.Y+display.Height))
	x, y, w, h = x0, y0, max(1, x1-x0), max(1, y1-y0)

	clip := region.Rect{X0: x, Y0: y, X1: x + w, Y1: y + h}
	img, err := s.c.Grab(x, y, w, h, s.maskFor(req, clip))
	if err != nil {
		return proto.CaptureResult{}, err
	}
	fw, fh := imaging.Fit(float64(w), float64(h), req.MaxWidth, req.MaxHeight)
	scaled := imaging.Downscale(img, fw, fh)
	data, err := imaging.Encode(scaled, req.Format, req.Quality)
	if err != nil {
		return proto.CaptureResult{}, rpc.Internal("could not encode the screenshot as %s: %v", req.Format, err)
	}
	return proto.CaptureResult{
		Data: base64.StdEncoding.EncodeToString(data), Mime: imaging.Mime(req.Format),
		Width: scaled.Rect.Dx(), Height: scaled.Rect.Dy(),
		Rect: proto.Rect{X: float64(x), Y: float64(y), Width: float64(w), Height: float64(h)},
	}, nil
}

// maskFor is what to black out, in the image's pixels:
//   - apps: every window not of those apps (the desktop's wallpaper and icons stay);
//   - exclude: those apps' windows;
//   - neither: Atelier's own windows.
//
// A window with no known app, or a menu or tooltip of an app that isn't allowed, is hidden with the rest in `apps` mode:
// the screenshot shows only what was allowed.
func (s *System) maskFor(req helper.CaptureRequest, clip region.Rect) []imaging.IntRect {
	lower := func(ids []string) map[string]bool {
		m := map[string]bool{}
		for _, id := range ids {
			m[strings.ToLower(id)] = true
		}
		return m
	}
	allowed, excluded := lower(req.Apps), lower(req.Exclude)
	snap := s.c.Snapshot()
	pc, ix := newProcs(), s.index()
	var windows []region.Window
	for _, w := range snap.Stack {
		// A window that takes no input and draws nothing of its own (Atelier's overlay) neither shows nor hides anything.
		if w.ClickThrough {
			continue
		}
		id := strings.ToLower(s.appOf(w, pc, ix).ID)
		var masked bool
		switch {
		case req.HasApps:
			masked = !w.Desktop() && !allowed[id]
		case req.HasExclude:
			masked = excluded[id]
		default:
			masked = id == AtelierID
		}
		windows = append(windows, region.Window{Rect: w.Rect, Masked: masked, Occludes: true})
	}
	return Rects(region.Mask(windows, clip), clip)
}

// ---------------------------------------------------------------- what is under a point

func (s *System) InspectPoint(x, y float64) (proto.InspectResult, error) {
	snap := s.c.Snapshot()
	px, py := int(x), int(y)
	w, ok := snap.WindowAt(px, py)
	if !ok || w.Desktop() {
		return proto.InspectResult{}, nil
	}
	app := s.wireWindow(snap, w)
	var el *inspect.Element
	if s.access != nil && w.PID != 0 {
		el, _ = s.access.At(w.PID, px, py)
	}
	return inspect.Describe(el, &app), nil
}

// wireWindow is the app of one window, as running (with its state when it is in the task list).
func (s *System) wireWindow(snap Snapshot, w Win) proto.App {
	pc, ix := newProcs(), s.index()
	info := s.appOf(w, pc, ix)
	byID, _ := s.runningApps(snap)
	if r, ok := byID[strings.ToLower(info.ID)]; ok {
		return s.wire(r, s.activeClient(snap))
	}
	return appid.Running{ID: info.ID, Name: info.Name, Path: info.Path, PID: info.PID}.HelperApp()
}

func (s *System) InspectFocused() (proto.InspectResult, error) {
	app, err := s.Frontmost()
	if err != nil || app == nil {
		return proto.InspectResult{}, err
	}
	var el *inspect.Element
	if s.access != nil {
		el, _ = s.access.Focused()
	}
	return inspect.Describe(el, app), nil
}

// onDisplay says whether a window's middle is on the display (both in the root's coordinates).
func onDisplay(r region.Rect, d proto.Display) bool {
	x, y := float64(r.X0+r.X1)/2, float64(r.Y0+r.Y1)/2
	return x >= d.X && x < d.X+d.Width && y >= d.Y && y < d.Y+d.Height
}
