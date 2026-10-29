package helper

import (
	"math"
	"strings"
	"unicode/utf16"

	"atelier.dev/computer-windows/internal/bg"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// Background mode (window.capture and bg.*): one app's window, without the person's mouse and keyboard. The params
// checks are here; the window itself is the System's. Capture and inspection run concurrently like their foreground
// twins; the input methods are queued with mouse.* and key.* (one at a time, in order) and refused after an Esc stop
// like them, bad params still being bad params.

func (h *Helper) registerBackground() {
	s := h.Server
	in := h.input
	sys := h.sys

	s.Register(proto.MWindowCapture, rpc.Async, func(p rpc.Params) (any, error) {
		var req WindowCaptureRequest
		var err error
		if req.App, err = p.String("app"); err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.App) == "" {
			return nil, rpc.InvalidParams("app must not be empty")
		}
		if req.MaxWidth, req.MaxHeight, req.Format, req.Quality, err = imageParams(p); err != nil {
			return nil, err
		}
		return sys.WindowCapture(req)
	})

	s.Register(proto.MBgInspect, rpc.Async, func(p rpc.Params) (any, error) {
		window, err := windowParam(p)
		if err != nil {
			return nil, err
		}
		at, err := point(p)
		if err != nil {
			return nil, err
		}
		return sys.BgInspect(window, at.X, at.Y)
	})
	s.Register(proto.MBgFocused, rpc.Async, func(p rpc.Params) (any, error) {
		window, err := windowParam(p)
		if err != nil {
			return nil, err
		}
		return sys.BgFocused(window)
	})

	s.Register(proto.MBgClick, rpc.Queued, func(p rpc.Params) (any, error) {
		var req BgClickRequest
		var err error
		if req.Window, err = windowParam(p); err != nil {
			return nil, err
		}
		if req.At, err = point(p); err != nil {
			return nil, err
		}
		if req.Button, err = mouseButton(p); err != nil {
			return nil, err
		}
		if req.Count, err = p.Int("count"); err != nil {
			return nil, err
		}
		names, err := p.Strings("modifiers")
		if err != nil {
			return nil, err
		}
		if req.Count < 1 || req.Count > 3 {
			return nil, rpc.InvalidParams("count must be 1, 2 or 3")
		}
		mods, merr := keys.Modifiers(names)
		if merr != nil {
			return nil, rpc.InvalidParams("%v", merr)
		}
		req.Modifiers = mods
		if req.MK, err = bg.MouseKeys(mods); err != nil {
			return nil, err
		}
		if err := in.Ready(); err != nil {
			return nil, err
		}
		return proto.Empty{}, sys.BgClick(in.Ready, req)
	})

	s.Register(proto.MBgScroll, rpc.Queued, func(p rpc.Params) (any, error) {
		window, err := windowParam(p)
		if err != nil {
			return nil, err
		}
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
		if err := in.Ready(); err != nil {
			return nil, err
		}
		return proto.Empty{}, sys.BgScroll(in.Ready, window, at, dx, dy)
	})

	s.Register(proto.MBgKey, rpc.Queued, func(p rpc.Params) (any, error) {
		window, err := windowParam(p)
		if err != nil {
			return nil, err
		}
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
		// Checked here on the layout key.press uses (unknown keys, shortcuts no background window takes); the System plans
		// again on the window's own layout.
		if _, err := bg.PlanKeys(names, sys.Layout(), func(uint16) uint16 { return 0 }, count); err != nil {
			return nil, err
		}
		if err := in.Ready(); err != nil {
			return nil, err
		}
		return proto.Empty{}, sys.BgKey(in.Ready, window, names, count)
	})

	s.Register(proto.MBgType, rpc.Queued, func(p rpc.Params) (any, error) {
		window, err := windowParam(p)
		if err != nil {
			return nil, err
		}
		text, err := p.String("text")
		if err != nil {
			return nil, err
		}
		if len(utf16.Encode([]rune(text))) > 100_000 {
			return nil, rpc.InvalidParams("text is longer than 100000")
		}
		if err := in.Ready(); err != nil {
			return nil, err
		}
		if text == "" {
			return proto.Empty{}, nil
		}
		return proto.Empty{}, sys.BgType(in.Ready, window, text)
	})
}

// windowParam is a bg.* call's `window`: window.capture's id, a non-empty string. Whether it names a window is the
// System's to tell (NotFound).
func windowParam(p rpc.Params) (string, error) {
	window, err := p.String("window")
	if err != nil {
		return "", err
	}
	if window == "" {
		return "", rpc.InvalidParams("window must not be empty (it is window.capture's `window`)")
	}
	return window, nil
}
