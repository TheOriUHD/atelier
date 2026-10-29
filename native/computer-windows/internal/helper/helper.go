// Package helper is the Windows helper: every method of computer protocol v1 wired to the OS (System), plus its
// lifecycle (stdin's EOF, shutdown and console control events let go of held input and exit 0). Policy (which apps,
// tiers, password fields) lives in main; the one rule here is the Esc-hold stop. The params checks mirror the macOS
// helper's Helper.swift.
package helper

import (
	"bufio"
	"io"
	"math"
	"strings"
	"sync"
	"unicode/utf16"

	"atelier.dev/computer-windows/internal/control"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// CaptureRequest is capture.display's params, checked.
type CaptureRequest struct {
	Display string
	// Apps: only these apps' windows (and the desktop). HasApps tells an empty list from none.
	Apps    []string
	HasApps bool
	// Exclude: everything but these apps' windows (when Apps is absent).
	Exclude    []string
	HasExclude bool
	Region     *proto.Rect
	MaxWidth   int
	MaxHeight  int
	Format     string
	Quality    float64
}

// System is the OS: everything but the protocol, the input bookkeeping and the control decisions.
type System interface {
	Displays() ([]proto.Display, error)
	Apps(installed bool) ([]proto.App, error)
	Frontmost() (*proto.App, error)
	OpenApp(id string, activate bool) (proto.App, error)
	HideApps(ids []string) ([]string, error)
	UnhideApps(ids []string) error
	Activate(pid int) (bool, error)
	Capture(req CaptureRequest) (proto.CaptureResult, error)
	InspectPoint(x, y float64) (proto.InspectResult, error)
	InspectFocused() (proto.InspectResult, error)

	// Sender sends input (SendInput).
	Sender() input.Sender
	// Layout is the keyboard layout of the foreground window, for key names.
	Layout() keys.Layout
	// Hooks are the low-level keyboard and mouse hooks of the control watch.
	Hooks() control.Hooks
	// EscapeDown reads Esc's key state (GetAsyncKeyState).
	EscapeDown() bool
}

type Helper struct {
	Server  *rpc.Server
	out     *rpc.Output
	sys     System
	input   *input.Controller
	monitor *control.Monitor
	finish  sync.Once
}

func New(out *rpc.Output, sys System) *Helper {
	server := rpc.NewServer(out)
	in := input.NewController(sys.Sender())
	h := &Helper{Server: server, out: out, sys: sys, input: in}
	h.monitor = control.NewMonitor(sys.Hooks(), in, sys.EscapeDown, server.Notify)
	h.register()
	return h
}

// Input is the input controller (tests).
func (h *Helper) Input() *input.Controller { return h.input }

// Run reads requests until EOF or shutdown. It returns when the helper should exit (after Finish).
func (h *Helper) Run(r io.Reader) {
	reader := bufio.NewReaderSize(r, 1<<16)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 && h.Server.Receive(line) == rpc.Stop {
			break
		}
		if err != nil {
			break
		}
	}
	h.Finish()
}

// Finish lets go of held input, stops the control watch and waits for writes in progress. Safe to call more than once
// and from any goroutine.
func (h *Helper) Finish() {
	h.finish.Do(func() {
		h.monitor.End()
		h.input.Terminate()
		h.out.Flush()
	})
}

// ---------------------------------------------------------------- methods

func (h *Helper) register() {
	s := h.Server
	in := h.input
	sys := h.sys

	s.OnInitialize(func(p rpc.Params) (any, error) {
		version, err := p.Int("protocolVersion")
		if err != nil {
			return nil, err
		}
		if client, ok, err := p.OptObject("client"); err != nil {
			return nil, err
		} else if ok {
			if _, err := client.String("name"); err != nil {
				return nil, err
			}
			if _, err := client.String("version"); err != nil {
				return nil, err
			}
		}
		if version != proto.ProtocolVersion {
			e := rpc.Unsupported("computer protocol %d isn't supported (this helper speaks %d)", version, proto.ProtocolVersion)
			e.Data = map[string]any{"protocolVersion": proto.ProtocolVersion, "helperVersion": proto.HelperVersion}
			return nil, e
		}
		return proto.InitializeResult{
			ProtocolVersion: proto.ProtocolVersion, HelperVersion: proto.HelperVersion, Platform: proto.Platform,
			Supports: proto.Supports{Background: false, FullControl: true, Filter: true},
		}, nil
	})

	granted := proto.PermissionsStatus{Accessibility: true, ScreenRecording: true}
	s.Register(proto.MPermissionsStatus, rpc.Inline, func(rpc.Params) (any, error) { return granted, nil })
	s.Register(proto.MPermissionsRequest, rpc.Async, func(p rpc.Params) (any, error) {
		if _, err := p.Enum("kind", "accessibility", "screenRecording"); err != nil {
			return nil, err
		}
		return granted, nil
	})

	s.Register(proto.MDisplaysList, rpc.Async, func(rpc.Params) (any, error) {
		displays, err := sys.Displays()
		if err != nil {
			return nil, err
		}
		if displays == nil {
			displays = []proto.Display{}
		}
		return proto.DisplaysListResult{Displays: displays}, nil
	})
	s.Register(proto.MAppsList, rpc.Async, func(p rpc.Params) (any, error) {
		installed, err := p.Bool("installed")
		if err != nil {
			return nil, err
		}
		apps, err := sys.Apps(installed)
		if err != nil {
			return nil, err
		}
		if apps == nil {
			apps = []proto.App{}
		}
		return proto.AppsListResult{Apps: apps}, nil
	})
	s.Register(proto.MAppsFrontmost, rpc.Async, func(rpc.Params) (any, error) {
		app, err := sys.Frontmost()
		if err != nil {
			return nil, err
		}
		return proto.AppResult{App: app}, nil
	})
	s.Register(proto.MAppsOpen, rpc.Async, func(p rpc.Params) (any, error) {
		id, err := p.String("id")
		if err != nil {
			return nil, err
		}
		activate, err := p.Bool("activate")
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(id) == "" {
			return nil, rpc.InvalidParams("id must not be empty")
		}
		app, err := sys.OpenApp(id, activate)
		if err != nil {
			return nil, err
		}
		return proto.AppResult{App: &app}, nil
	})
	s.Register(proto.MAppsHide, rpc.Async, func(p rpc.Params) (any, error) {
		ids, err := appIDs(p)
		if err != nil {
			return nil, err
		}
		hidden, err := sys.HideApps(ids)
		if err != nil {
			return nil, err
		}
		if hidden == nil {
			hidden = []string{}
		}
		return proto.AppsHideResult{IDs: hidden}, nil
	})
	s.Register(proto.MAppsUnhide, rpc.Async, func(p rpc.Params) (any, error) {
		ids, err := appIDs(p)
		if err != nil {
			return nil, err
		}
		if err := sys.UnhideApps(ids); err != nil {
			return nil, err
		}
		return proto.Empty{}, nil
	})
	s.Register(proto.MAppsActivate, rpc.Async, func(p rpc.Params) (any, error) {
		pid, err := p.Int("pid")
		if err != nil {
			return nil, err
		}
		if pid <= 0 || pid > math.MaxInt32 {
			return nil, rpc.InvalidParams("pid must be a process id")
		}
		activated, err := sys.Activate(pid)
		if err != nil {
			return nil, err
		}
		return proto.AppsActivateResult{Activated: activated}, nil
	})

	s.Register(proto.MCaptureDisplay, rpc.Async, func(p rpc.Params) (any, error) {
		req, err := captureRequest(p)
		if err != nil {
			return nil, err
		}
		return sys.Capture(req)
	})
	s.Register(proto.MInspectPoint, rpc.Async, func(p rpc.Params) (any, error) {
		x, err := p.Float("x")
		if err != nil {
			return nil, err
		}
		y, err := p.Float("y")
		if err != nil {
			return nil, err
		}
		if !finite(x) || !finite(y) {
			return nil, rpc.InvalidParams("x and y must be numbers")
		}
		return sys.InspectPoint(x, y)
	})
	s.Register(proto.MInspectFocused, rpc.Async, func(rpc.Params) (any, error) { return sys.InspectFocused() })

	s.Register(proto.MMouseMove, rpc.Queued, func(p rpc.Params) (any, error) {
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		return proto.Empty{}, in.Move(at)
	})
	s.Register(proto.MMouseClick, rpc.Queued, func(p rpc.Params) (any, error) {
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		button, err := mouseButton(p)
		if err != nil {
			return nil, err
		}
		count, err := p.Int("count")
		if err != nil {
			return nil, err
		}
		names, err := p.Strings("modifiers")
		if err != nil {
			return nil, err
		}
		if count < 1 || count > 3 {
			return nil, rpc.InvalidParams("count must be 1, 2 or 3")
		}
		mods, merr := keys.Modifiers(names)
		if merr != nil {
			return nil, rpc.InvalidParams("%v", merr)
		}
		return proto.Empty{}, in.Click(at, button, count, mods)
	})
	s.Register(proto.MMouseDown, rpc.Queued, func(p rpc.Params) (any, error) {
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		button, err := mouseButton(p)
		if err != nil {
			return nil, err
		}
		return proto.Empty{}, in.ButtonDown(at, button)
	})
	s.Register(proto.MMouseUp, rpc.Queued, func(p rpc.Params) (any, error) {
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		button, err := mouseButton(p)
		if err != nil {
			return nil, err
		}
		return proto.Empty{}, in.ButtonUp(at, button)
	})
	s.Register(proto.MMouseDrag, rpc.Queued, func(p rpc.Params) (any, error) {
		fromObj, err := p.Object("from")
		if err != nil {
			return nil, err
		}
		toObj, err := p.Object("to")
		if err != nil {
			return nil, err
		}
		from, err := point(fromObj)
		if err != nil {
			return nil, err
		}
		to, err := point(toObj)
		if err != nil {
			return nil, err
		}
		button, err := mouseButton(p)
		if err != nil {
			return nil, err
		}
		return proto.Empty{}, in.Drag(from, to, button)
	})
	s.Register(proto.MMouseScroll, rpc.Queued, func(p rpc.Params) (any, error) {
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		dx, err := p.Float("dx")
		if err != nil {
			return nil, err
		}
		dy, err := p.Float("dy")
		if err != nil {
			return nil, err
		}
		if !finite(dx) || !finite(dy) || math.Abs(dx) > 10_000 || math.Abs(dy) > 10_000 {
			return nil, rpc.InvalidParams("dx and dy must be numbers of lines, at most 10000")
		}
		return proto.Empty{}, in.Scroll(at, dx, dy)
	})
	s.Register(proto.MCursorPosition, rpc.Inline, func(rpc.Params) (any, error) { return in.CursorPosition(), nil })

	s.Register(proto.MKeyPress, rpc.Queued, func(p rpc.Params) (any, error) {
		names, err := p.Strings("keys")
		if err != nil {
			return nil, err
		}
		count, ok, err := p.OptInt("repeat")
		if err != nil {
			return nil, err
		}
		if !ok {
			count = 1
		}
		if count < 1 || count > 100 {
			return nil, rpc.InvalidParams("repeat must be 1–100")
		}
		stroke, kerr := keys.Resolve(names, sys.Layout())
		if kerr != nil {
			return nil, rpc.InvalidParams("%v", kerr)
		}
		return proto.Empty{}, in.Press(stroke, count)
	})
	s.Register(proto.MKeyType, rpc.Queued, func(p rpc.Params) (any, error) {
		text, err := p.String("text")
		if err != nil {
			return nil, err
		}
		if len(utf16.Encode([]rune(text))) > 100_000 {
			return nil, rpc.InvalidParams("text is longer than 100000")
		}
		return proto.Empty{}, in.Type(text)
	})
	s.Register(proto.MKeyHold, rpc.Queued, func(p rpc.Params) (any, error) {
		names, err := p.Strings("keys")
		if err != nil {
			return nil, err
		}
		ms, err := p.Float("ms")
		if err != nil {
			return nil, err
		}
		if !finite(ms) || ms < 0 || ms > 10_000 {
			return nil, rpc.InvalidParams("ms must be 0–10000")
		}
		stroke, kerr := keys.Resolve(names, sys.Layout())
		if kerr != nil {
			return nil, rpc.InvalidParams("%v", kerr)
		}
		return proto.Empty{}, in.Hold(stroke, int(math.Round(ms)))
	})
	s.Register(proto.MInputReleaseAll, rpc.Inline, func(rpc.Params) (any, error) {
		in.ReleaseAll()
		return proto.Empty{}, nil
	})

	s.Register(proto.MControlBegin, rpc.Inline, func(rpc.Params) (any, error) {
		if err := h.monitor.Begin(); err != nil {
			return nil, rpc.Internal("could not watch the keyboard and mouse: %v", err)
		}
		return proto.Empty{}, nil
	})
	s.Register(proto.MControlEnd, rpc.Inline, func(rpc.Params) (any, error) {
		h.monitor.End()
		return proto.Empty{}, nil
	})
	s.Register(proto.MControlResume, rpc.Inline, func(rpc.Params) (any, error) {
		in.Resume()
		return proto.Empty{}, nil
	})
}

// ---------------------------------------------------------------- params

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func point(p rpc.Params) (proto.Point, error) {
	x, err := p.Float("x")
	if err != nil {
		return proto.Point{}, err
	}
	y, err := p.Float("y")
	if err != nil {
		return proto.Point{}, err
	}
	if !finite(x) || !finite(y) || math.Abs(x) >= 1_000_000 || math.Abs(y) >= 1_000_000 {
		return proto.Point{}, rpc.InvalidParams("x and y must be screen coordinates")
	}
	return proto.Point{X: x, Y: y}, nil
}

func mouseButton(p rpc.Params) (input.Button, error) {
	b, err := p.Enum("button", "left", "right", "middle")
	if err != nil {
		return "", err
	}
	return input.Button(b), nil
}

func appIDs(p rpc.Params) ([]string, error) {
	ids, err := p.Strings("ids")
	if err != nil {
		return nil, err
	}
	if len(ids) > 500 {
		return nil, rpc.InvalidParams("ids must be at most 500 app ids")
	}
	for _, id := range ids {
		if id == "" {
			return nil, rpc.InvalidParams("ids must be at most 500 app ids")
		}
	}
	return ids, nil
}

func captureRequest(p rpc.Params) (CaptureRequest, error) {
	var req CaptureRequest
	var err error
	if req.Display, err = p.String("display"); err != nil {
		return req, err
	}
	if req.Apps, req.HasApps, err = p.OptStrings("apps"); err != nil {
		return req, err
	}
	if req.Exclude, req.HasExclude, err = p.OptStrings("exclude"); err != nil {
		return req, err
	}
	region, hasRegion, err := p.OptObject("region")
	if err != nil {
		return req, err
	}
	var r proto.Rect
	if hasRegion {
		for _, f := range []struct {
			name string
			v    *float64
		}{{"x", &r.X}, {"y", &r.Y}, {"width", &r.Width}, {"height", &r.Height}} {
			if *f.v, err = region.Float(f.name); err != nil {
				return req, err
			}
		}
	}
	maxWidth, err := p.Float("maxWidth")
	if err != nil {
		return req, err
	}
	maxHeight, err := p.Float("maxHeight")
	if err != nil {
		return req, err
	}
	if req.Format, err = p.Enum("format", "jpeg", "png"); err != nil {
		return req, err
	}
	quality, hasQuality, err := p.OptFloat("quality")
	if err != nil {
		return req, err
	}
	if !finite(maxWidth) || !finite(maxHeight) || maxWidth < 1 || maxHeight < 1 || maxWidth > 16384 || maxHeight > 16384 {
		return req, rpc.InvalidParams("maxWidth and maxHeight must be between 1 and 16384")
	}
	req.MaxWidth, req.MaxHeight = int(maxWidth), int(maxHeight)
	req.Quality = 0.8
	if hasQuality {
		if !finite(quality) || quality < 0 || quality > 1 {
			return req, rpc.InvalidParams("quality must be 0–1")
		}
		req.Quality = quality
	}
	if hasRegion {
		if !finite(r.X) || !finite(r.Y) || !finite(r.Width) || !finite(r.Height) || r.Width <= 0 || r.Height <= 0 {
			return req, rpc.InvalidParams("region must have a positive width and height")
		}
		req.Region = &r
	}
	return req, nil
}
