//go:build windows

package win

import (
	"encoding/base64"
	"image"
	"runtime"
	"strings"
	"unsafe"

	"atelier.dev/computer-windows/internal/helper"
	"atelier.dev/computer-windows/internal/imaging"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/region"
	"atelier.dev/computer-windows/internal/rpc"
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]uint32
}

type cursorInfo struct {
	Size   uint32
	Flags  uint32
	Cursor uintptr
	Pos    point
}

type iconInfo struct {
	IsIcon   int32
	HotspotX uint32
	HotspotY uint32
	Mask     uintptr
	Color    uintptr
}

// Capture takes a screenshot of a display, or part of it: BitBlt from the screen (windows kept out of captures, like
// Atelier's overlay, aren't in it), with the windows it must not show blacked out and the pointer drawn in, then
// scaled down to fit and encoded.
func (s *System) Capture(req helper.CaptureRequest) (proto.CaptureResult, error) {
	display, ok := findDisplay(req.Display)
	if !ok {
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
	mask := s.maskFor(req, clip)

	img, err := grab(x, y, w, h, mask)
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

// grab copies the screen's pixels at x, y (w×h), blacks out the mask (in the image's own pixels) and draws the pointer.
func grab(x, y, w, h int, mask []imaging.IntRect) (*image.RGBA, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, rpc.Internal("screen capture failed: no screen device context")
	}
	defer procReleaseDC.Call(0, screen)
	mem, _, _ := procCreateCompatibleDC.Call(screen)
	if mem == 0 {
		return nil, rpc.Internal("screen capture failed: no memory device context")
	}
	defer procDeleteDC.Call(mem)

	info := bitmapInfo{Header: bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32, Compression: BI_RGB}}
	info.Header.Size = uint32(unsafe.Sizeof(info.Header))
	var bits *byte
	bitmap, _, _ := procCreateDIBSection.Call(screen, uintptr(unsafe.Pointer(&info)), DIB_RGB_COLORS, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bitmap == 0 || bits == nil {
		return nil, rpc.Internal("screen capture failed: could not make a %dx%d bitmap", w, h)
	}
	defer procDeleteObject.Call(bitmap)
	old, _, _ := procSelectObject.Call(mem, bitmap)
	defer procSelectObject.Call(mem, old)

	blit := func(rop uintptr) error {
		r, _, err := procBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(int32(x)), uintptr(int32(y)), rop)
		if r == 0 {
			return err
		}
		return nil
	}
	// CAPTUREBLT takes layered windows in too; a driver that refuses it still gets the plain copy.
	if err := blit(SRCCOPY | CAPTUREBLT); err != nil {
		if err2 := blit(SRCCOPY); err2 != nil {
			return nil, rpc.Internal("screen capture failed (the desktop can't be read: locked, or no one signed in at the screen): %v", err)
		}
	}
	procGdiFlush.Call()
	pixels := unsafe.Slice(bits, w*h*4)
	imaging.FillBlackBGRA(pixels, w, h, w*4, mask)
	drawCursor(mem, x, y)
	procGdiFlush.Call()
	return imaging.FromBGRA(pixels, w, h, w*4), nil
}

// drawCursor draws the pointer where it is, like the Mac's showsCursor.
func drawCursor(dc uintptr, originX, originY int) {
	ci := cursorInfo{}
	ci.Size = uint32(unsafe.Sizeof(ci))
	if !boolCall(procGetCursorInfo, uintptr(unsafe.Pointer(&ci))) || ci.Flags&CURSOR_SHOWING == 0 || ci.Cursor == 0 {
		return
	}
	var ii iconInfo
	hotX, hotY := int32(0), int32(0)
	if boolCall(procGetIconInfo, ci.Cursor, uintptr(unsafe.Pointer(&ii))) {
		hotX, hotY = int32(ii.HotspotX), int32(ii.HotspotY)
		if ii.Mask != 0 {
			procDeleteObject.Call(ii.Mask)
		}
		if ii.Color != 0 {
			procDeleteObject.Call(ii.Color)
		}
	}
	px := ci.Pos.X - hotX - int32(originX)
	py := ci.Pos.Y - hotY - int32(originY)
	procDrawIconEx.Call(dc, uintptr(px), uintptr(py), ci.Cursor, 0, 0, 0, 0, DI_NORMAL)
}

// maskFor is what to black out, in the image's pixels:
//   - apps: every window not of those apps (the desktop's wallpaper and icons stay);
//   - exclude: those apps' windows;
//   - neither: Atelier's own windows (the parent process's, and any atelier.exe's).
func (s *System) maskFor(req helper.CaptureRequest, clip region.Rect) []imaging.IntRect {
	allowed := map[string]bool{}
	for _, id := range req.Apps {
		allowed[strings.ToLower(id)] = true
	}
	excluded := map[string]bool{}
	for _, id := range req.Exclude {
		excluded[strings.ToLower(id)] = true
	}
	pc := newProcCache()
	idOf := func(w window) string {
		if info := pc.get(w.appPID); info.ok {
			return strings.ToLower(info.id)
		}
		return ""
	}
	var windows []region.Window
	for _, w := range topWindows() {
		// Not drawn, or not drawn opaque: kept out of captures (Atelier's overlay), click-through overlays, invisible
		// layered windows. They neither show nor hide anything.
		if !w.onScreen() || w.affinity != WDA_NONE || w.clickThrough() || w.fullyTransparent() {
			continue
		}
		var masked bool
		switch {
		case req.HasApps:
			masked = !isDesktopClass(w.class) && !allowed[idOf(w)]
		case req.HasExclude:
			masked = excluded[idOf(w)]
		default:
			masked = w.pid == s.parent || w.appPID == s.parent || idOf(w) == "atelier.exe"
		}
		windows = append(windows, region.Window{
			Rect:     region.Rect{X0: int(w.rect.Left), Y0: int(w.rect.Top), X1: int(w.rect.Right), Y1: int(w.rect.Bottom)},
			Masked:   masked,
			Occludes: true,
		})
	}
	var out []imaging.IntRect
	for _, r := range region.Mask(windows, clip) {
		out = append(out, imaging.IntRect{X0: r.X0 - clip.X0, Y0: r.Y0 - clip.Y0, X1: r.X1 - clip.X0, Y1: r.Y1 - clip.Y0})
	}
	return out
}
