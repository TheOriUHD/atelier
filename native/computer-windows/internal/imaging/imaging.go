// Package imaging is the arithmetic and pixels of a screenshot: which part of the display, how many pixels, masking,
// downscaling and encoding. The capture itself is the OS's (BitBlt, in internal/win).
package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"math"

	"atelier.dev/computer-windows/internal/proto"
)

// CoveredRect is the part of the display a capture covers: the region clipped to the display, or the whole display.
// ok false when the region misses the display (touching edges only counts as missing).
func CoveredRect(region *proto.Rect, display proto.Rect) (proto.Rect, bool) {
	if region == nil {
		return display, true
	}
	r := standardize(*region)
	x0 := math.Max(r.X, display.X)
	y0 := math.Max(r.Y, display.Y)
	x1 := math.Min(r.X+r.Width, display.X+display.Width)
	y1 := math.Min(r.Y+r.Height, display.Y+display.Height)
	if x1 <= x0 || y1 <= y0 {
		return proto.Rect{}, false
	}
	return proto.Rect{X: x0, Y: y0, Width: x1 - x0, Height: y1 - y0}, true
}

func standardize(r proto.Rect) proto.Rect {
	if r.Width < 0 {
		r.X += r.Width
		r.Width = -r.Width
	}
	if r.Height < 0 {
		r.Y += r.Height
		r.Height = -r.Height
	}
	return r
}

// PixelRect is the whole pixels a covered rectangle spans (physical pixels on Windows): its edges rounded outwards.
func PixelRect(r proto.Rect) (x, y, w, h int) {
	x0 := int(math.Floor(r.X))
	y0 := int(math.Floor(r.Y))
	x1 := int(math.Ceil(r.X + r.Width))
	y1 := int(math.Ceil(r.Y + r.Height))
	return x0, y0, max(1, x1-x0), max(1, y1-y0)
}

// Fit is the image size for a source of width×height pixels: scaled down, keeping the aspect ratio, to fit
// maxWidth×maxHeight, and never scaled up.
func Fit(width, height float64, maxWidth, maxHeight int) (int, int) {
	if width <= 0 || height <= 0 || maxWidth <= 0 || maxHeight <= 0 {
		return 1, 1
	}
	factor := math.Min(1, math.Min(float64(maxWidth)/width, float64(maxHeight)/height))
	w := min(maxWidth, max(1, int(math.Round(width*factor))))
	h := min(maxHeight, max(1, int(math.Round(height*factor))))
	return w, h
}

// FromBGRA makes an opaque RGBA image from 32-bit BGRA rows (a top-down DIB section).
func FromBGRA(bits []byte, width, height, stride int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		src := bits[y*stride : y*stride+width*4]
		dst := img.Pix[y*img.Stride : y*img.Stride+width*4]
		for x := 0; x < width*4; x += 4 {
			dst[x] = src[x+2]
			dst[x+1] = src[x+1]
			dst[x+2] = src[x]
			dst[x+3] = 0xFF
		}
	}
	return img
}

// IntRect is a half-open rectangle of pixels: [X0, X1) × [Y0, Y1).
type IntRect struct{ X0, Y0, X1, Y1 int }

// FillBlackBGRA blacks out rectangles (in the buffer's own pixels) of 32-bit BGRA rows, clipped to the buffer.
func FillBlackBGRA(bits []byte, width, height, stride int, rects []IntRect) {
	for _, r := range rects {
		x0, y0 := max(r.X0, 0), max(r.Y0, 0)
		x1, y1 := min(r.X1, width), min(r.Y1, height)
		if x1 <= x0 || y1 <= y0 {
			continue
		}
		for y := y0; y < y1; y++ {
			row := bits[y*stride+x0*4 : y*stride+x1*4]
			for i := 0; i < len(row); i += 4 {
				row[i], row[i+1], row[i+2], row[i+3] = 0, 0, 0, 0xFF
			}
		}
	}
}

// axisWeights are, for each output pixel along one axis, the source pixels it averages and how much each counts (the
// share of the source pixel the output pixel covers): a box filter that handles any downscale factor.
type axisWeights struct {
	start   []int
	weights [][]float32
}

func boxWeights(src, dst int) axisWeights {
	scale := float64(src) / float64(dst)
	w := axisWeights{start: make([]int, dst), weights: make([][]float32, dst)}
	for o := 0; o < dst; o++ {
		lo := float64(o) * scale
		hi := float64(o+1) * scale
		first := int(math.Floor(lo))
		last := min(int(math.Ceil(hi)), src)
		weights := make([]float32, 0, last-first)
		var total float64
		for s := first; s < last; s++ {
			cover := math.Min(hi, float64(s+1)) - math.Max(lo, float64(s))
			if cover < 0 {
				cover = 0
			}
			weights = append(weights, float32(cover))
			total += cover
		}
		for i := range weights {
			weights[i] /= float32(total)
		}
		w.start[o] = first
		w.weights[o] = weights
	}
	return w
}

// Downscale resizes src to width×height with an area-averaging box filter (no upscaling: a size at least the source's
// returns src). Rows are filtered horizontally once each and averaged vertically as they stream by.
func Downscale(src *image.RGBA, width, height int) *image.RGBA {
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	if width >= sw && height >= sh {
		return src
	}
	width, height = min(width, sw), min(height, sh)
	cols := boxWeights(sw, width)
	rows := boxWeights(sh, height)
	dst := image.NewRGBA(image.Rect(0, 0, width, height))

	// The horizontally filtered rows: a cache of the last one, since neighbouring output rows share a source row.
	cachedRow := -1
	cached := make([]float32, width*3)
	filtered := func(sy int) []float32 {
		if sy == cachedRow {
			return cached
		}
		line := src.Pix[(sy)*src.Stride:]
		for ox := 0; ox < width; ox++ {
			var r, g, b float32
			base := cols.start[ox] * 4
			for i, w := range cols.weights[ox] {
				p := base + i*4
				r += w * float32(line[p])
				g += w * float32(line[p+1])
				b += w * float32(line[p+2])
			}
			cached[ox*3], cached[ox*3+1], cached[ox*3+2] = r, g, b
		}
		cachedRow = sy
		return cached
	}

	acc := make([]float32, width*3)
	for oy := 0; oy < height; oy++ {
		clear(acc)
		for i, w := range rows.weights[oy] {
			row := filtered(rows.start[oy] + i)
			for j := range acc {
				acc[j] += w * row[j]
			}
		}
		out := dst.Pix[oy*dst.Stride:]
		for ox := 0; ox < width; ox++ {
			out[ox*4] = clamp8(acc[ox*3])
			out[ox*4+1] = clamp8(acc[ox*3+1])
			out[ox*4+2] = clamp8(acc[ox*3+2])
			out[ox*4+3] = 0xFF
		}
	}
	return dst
}

func clamp8(v float32) uint8 {
	v += 0.5
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(v)
}

// Mime is the MIME type of a format.
func Mime(format string) string {
	if format == "png" {
		return "image/png"
	}
	return "image/jpeg"
}

// Encode writes the image as JPEG (quality 0–1) or PNG.
func Encode(img image.Image, format string, quality float64) ([]byte, error) {
	var buf bytes.Buffer
	if format == "png" {
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, img); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	q := min(100, max(1, int(math.Round(quality*100))))
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
