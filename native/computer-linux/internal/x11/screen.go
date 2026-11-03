//go:build linux

package x11

import (
	"image"

	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"

	"atelier.dev/computer-linux/internal/imaging"
	"atelier.dev/computer-linux/internal/proto"
	"atelier.dev/computer-linux/internal/region"
	"atelier.dev/computer-linux/internal/rpc"
)

// Displays are the monitors (RandR 1.5), or the whole root window as one display when the server has no RandR. Every
// coordinate is a pixel of the root window: X has no per-monitor scale, so the scale is 1.
func (c *Conn) Displays() []proto.Display {
	if c.HasRandR {
		if reply, err := randr.GetMonitors(c.X, c.Root, true).Reply(); err == nil && len(reply.Monitors) > 0 {
			var out []proto.Display
			for i, m := range reply.Monitors {
				name := c.AtomName(m.Name)
				if name == "" {
					name = "Display " + itoa(i+1)
				}
				out = append(out, proto.Display{
					ID: name, Name: name, Scale: 1, Primary: m.Primary,
					X: float64(m.X), Y: float64(m.Y), Width: float64(m.Width), Height: float64(m.Height),
				})
			}
			markPrimary(out)
			return out
		}
	}
	return []proto.Display{{
		ID: "screen", Name: "Screen", Scale: 1, Primary: true,
		Width: float64(c.Screen.WidthInPixels), Height: float64(c.Screen.HeightInPixels),
	}}
}

// markPrimary makes the first display the primary one when the server names none (a plain Xvfb), so the controller finds
// "the" display.
func markPrimary(displays []proto.Display) {
	for _, d := range displays {
		if d.Primary {
			return
		}
	}
	displays[0].Primary = true
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for ; n > 0; n /= 10 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
	}
	return string(digits)
}

// ScreenSize is the root window's size.
func (c *Conn) ScreenSize() (int, int) {
	return int(c.Screen.WidthInPixels), int(c.Screen.HeightInPixels)
}

// Grab copies the pixels at x, y (w×h) of the root window, blacks out the mask (in the image's own pixels) and draws the
// pointer in.
func (c *Conn) Grab(x, y, w, h int, mask []imaging.IntRect) (*image.RGBA, error) {
	reply, err := xproto.GetImage(c.X, xproto.ImageFormatZPixmap, xproto.Drawable(c.Root), int16(x), int16(y), uint16(w), uint16(h), 0xffffffff).Reply()
	if err != nil || reply == nil {
		return nil, rpc.Internal("screen capture failed (the X server refused to hand over the screen): %v", err)
	}
	img := c.toRGBA(reply.Data, w, h)
	if img == nil {
		return nil, rpc.Internal("screen capture failed: the X server returned %d bytes for a %dx%d image", len(reply.Data), w, h)
	}
	imaging.FillBlackRGBA(img, mask)
	c.drawCursor(img, x, y)
	return img, nil
}

// toRGBA reads a ZPixmap by the root visual's masks. The usual case, 32 bits per pixel with the colors in the low
// three bytes, is a straight copy of the three bytes.
func (c *Conn) toRGBA(data []byte, w, h int) *image.RGBA {
	if c.bytesPP == 0 || len(data) < w*h*c.bytesPP {
		return nil
	}
	// The usual case: 32 bits per pixel, blue in the first byte (what imaging.FromBGRA reads).
	if c.bytesPP == 4 && !c.msbFirst && c.redMask == 0xff0000 && c.greenMask == 0x00ff00 && c.blueMask == 0x0000ff {
		return imaging.FromBGRA(data, w, h, w*4)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	shift := func(mask uint32) (uint, uint32) {
		s := uint(0)
		for mask != 0 && mask&1 == 0 {
			mask >>= 1
			s++
		}
		return s, mask
	}
	rs, rm := shift(c.redMask)
	gs, gm := shift(c.greenMask)
	bs, bm := shift(c.blueMask)
	scale := func(v, max uint32) uint8 {
		if max == 0 {
			return 0
		}
		return uint8(v * 255 / max)
	}
	bpp := c.bytesPP
	for y := 0; y < h; y++ {
		row := data[y*w*bpp:]
		out := img.Pix[y*img.Stride:]
		for x := 0; x < w; x++ {
			var px uint32
			if c.msbFirst {
				for i := 0; i < bpp; i++ {
					px = px<<8 | uint32(row[x*bpp+i])
				}
			} else {
				for i := bpp - 1; i >= 0; i-- {
					px = px<<8 | uint32(row[x*bpp+i])
				}
			}
			out[x*4+0] = scale(px>>rs&rm, rm)
			out[x*4+1] = scale(px>>gs&gm, gm)
			out[x*4+2] = scale(px>>bs&bm, bm)
			out[x*4+3] = 0xff
		}
	}
	return img
}

// drawCursor draws the pointer where it is (XFixes), like the Mac's showsCursor.
func (c *Conn) drawCursor(img *image.RGBA, originX, originY int) {
	if !c.HasFixes {
		return
	}
	cur, err := xfixes.GetCursorImage(c.X).Reply()
	if err != nil || cur == nil || cur.Width == 0 || cur.Height == 0 || len(cur.CursorImage) < int(cur.Width)*int(cur.Height) {
		return
	}
	left := int(cur.X) - int(cur.Xhot) - originX
	top := int(cur.Y) - int(cur.Yhot) - originY
	b := img.Bounds()
	for cy := 0; cy < int(cur.Height); cy++ {
		for cx := 0; cx < int(cur.Width); cx++ {
			px, py := left+cx, top+cy
			if px < b.Min.X || py < b.Min.Y || px >= b.Max.X || py >= b.Max.Y {
				continue
			}
			// ARGB, premultiplied.
			v := cur.CursorImage[cy*int(cur.Width)+cx]
			a := v >> 24
			if a == 0 {
				continue
			}
			o := img.PixOffset(px, py)
			blend := func(dst uint8, src uint32) uint8 {
				return uint8(src + uint32(dst)*(255-a)/255)
			}
			img.Pix[o+0] = blend(img.Pix[o+0], v>>16&0xff)
			img.Pix[o+1] = blend(img.Pix[o+1], v>>8&0xff)
			img.Pix[o+2] = blend(img.Pix[o+2], v&0xff)
		}
	}
}

// Rects converts region rectangles to image pixels around an origin.
func Rects(rs []region.Rect, origin region.Rect) []imaging.IntRect {
	out := make([]imaging.IntRect, 0, len(rs))
	for _, r := range rs {
		out = append(out, imaging.IntRect{X0: r.X0 - origin.X0, Y0: r.Y0 - origin.Y0, X1: r.X1 - origin.X0, Y1: r.Y1 - origin.Y0})
	}
	return out
}
