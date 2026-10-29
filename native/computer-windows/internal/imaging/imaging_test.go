package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"testing"

	"atelier.dev/computer-windows/internal/proto"
)

func TestFitScalesDownKeepingTheAspectRatio(t *testing.T) {
	if w, h := Fit(3600, 2338, 800, 600); w != 800 || h != 520 {
		t.Errorf("width-bound: %dx%d", w, h)
	}
	if w, h := Fit(1000, 4000, 800, 600); w != 150 || h != 600 {
		t.Errorf("height-bound: %dx%d", w, h)
	}
	// A 4K monitor into the model's 1280.
	if w, h := Fit(3840, 2160, 1280, 1280); w != 1280 || h != 720 {
		t.Errorf("4K: %dx%d", w, h)
	}
}

func TestFitNeverUpscales(t *testing.T) {
	if w, h := Fit(640, 480, 4000, 4000); w != 640 || h != 480 {
		t.Errorf("%dx%d", w, h)
	}
}

func TestFitStaysInsideTheBox(t *testing.T) {
	for _, src := range [][2]float64{{3456, 2234}, {5120, 2880}, {1, 10000}, {10000, 1}, {2559, 1599}} {
		for _, box := range [][2]int{{1366, 768}, {1024, 1024}, {1, 1}, {333, 777}} {
			w, h := Fit(src[0], src[1], box[0], box[1])
			if w > box[0] || h > box[1] || w < 1 || h < 1 {
				t.Errorf("%v into %v: %dx%d", src, box, w, h)
			}
			if w > 20 && h > 20 {
				ratio := src[0] / src[1]
				if math.Abs(float64(w)/float64(h)-ratio) > ratio*0.05 {
					t.Errorf("%v into %v: aspect %dx%d", src, box, w, h)
				}
			}
		}
	}
}

func TestCoveredRect(t *testing.T) {
	display := proto.Rect{X: -2560, Y: -200, Width: 2560, Height: 1440}
	if r, ok := CoveredRect(nil, display); !ok || r != display {
		t.Errorf("no region: %v", r)
	}
	inside := proto.Rect{X: -2000, Y: 0, Width: 300, Height: 200}
	if r, ok := CoveredRect(&inside, display); !ok || r != inside {
		t.Errorf("inside: %v", r)
	}
	clipped := proto.Rect{X: -2660, Y: -300, Width: 300, Height: 300}
	if r, ok := CoveredRect(&clipped, display); !ok || r != (proto.Rect{X: -2560, Y: -200, Width: 200, Height: 200}) {
		t.Errorf("clipped: %v", r)
	}
	missing := proto.Rect{X: 0, Y: 0, Width: 100, Height: 100}
	if _, ok := CoveredRect(&missing, display); ok {
		t.Error("touching the edge only is missing it")
	}
}

func TestPixelRect(t *testing.T) {
	if x, y, w, h := PixelRect(proto.Rect{X: 10.4, Y: -3.5, Width: 100.2, Height: 50}); x != 10 || y != -4 || w != 101 || h != 51 {
		t.Errorf("%d,%d %dx%d", x, y, w, h)
	}
}

func bgra(w, h int, fill func(x, y int) (b, g, r byte)) []byte {
	buf := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			b, g, r := fill(x, y)
			i := (y*w + x) * 4
			buf[i], buf[i+1], buf[i+2], buf[i+3] = b, g, r, 0
		}
	}
	return buf
}

func TestFromBGRA(t *testing.T) {
	img := FromBGRA(bgra(2, 1, func(x, y int) (byte, byte, byte) { return 10, 20, 30 }), 2, 1, 8)
	if c := img.RGBAAt(1, 0); c.R != 30 || c.G != 20 || c.B != 10 || c.A != 255 {
		t.Errorf("pixel: %v", c)
	}
}

func TestFillBlackBGRA(t *testing.T) {
	w, h := 10, 6
	buf := bgra(w, h, func(x, y int) (byte, byte, byte) { return 200, 200, 200 })
	FillBlackBGRA(buf, w, h, w*4, []IntRect{{X0: 2, Y0: 1, X1: 5, Y1: 3}, {X0: 8, Y0: 4, X1: 20, Y1: 20}, {X0: -5, Y0: -5, X1: -1, Y1: -1}})
	black := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := (y*w + x) * 4
			isBlack := buf[i] == 0 && buf[i+1] == 0 && buf[i+2] == 0
			want := (x >= 2 && x < 5 && y >= 1 && y < 3) || (x >= 8 && y >= 4)
			if isBlack != want {
				t.Errorf("%d,%d black=%v", x, y, isBlack)
			}
			if isBlack {
				black++
			}
		}
	}
	if black != 6+4 {
		t.Errorf("black pixels: %d", black)
	}
}

func TestDownscaleAverages(t *testing.T) {
	// A 4×2 checkerboard of black and white, halved: every output pixel averages two of each.
	src := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 4; x++ {
			v := byte(0)
			if (x+y)%2 == 0 {
				v = 255
			}
			i := src.PixOffset(x, y)
			src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = v, v, v, 255
		}
	}
	dst := Downscale(src, 2, 1)
	if dst.Rect.Dx() != 2 || dst.Rect.Dy() != 1 {
		t.Fatalf("size: %v", dst.Rect)
	}
	for x := 0; x < 2; x++ {
		if c := dst.RGBAAt(x, 0); c.R < 126 || c.R > 129 || c.A != 255 {
			t.Errorf("pixel %d: %v", x, c)
		}
	}
	// A non-integer factor keeps a flat colour flat.
	flat := image.NewRGBA(image.Rect(0, 0, 1000, 700))
	for i := 0; i < len(flat.Pix); i += 4 {
		flat.Pix[i], flat.Pix[i+1], flat.Pix[i+2], flat.Pix[i+3] = 40, 120, 220, 255
	}
	small := Downscale(flat, 333, 233)
	for _, p := range [][2]int{{0, 0}, {332, 232}, {100, 50}} {
		if c := small.RGBAAt(p[0], p[1]); c.R != 40 || c.G != 120 || c.B != 220 {
			t.Errorf("%v: %v", p, c)
		}
	}
	// No upscaling.
	if same := Downscale(flat, 2000, 2000); same != flat {
		t.Error("a bigger size returns the source")
	}
}

func TestEncode(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 32))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 51, 128, 204, 255
	}
	data, err := Encode(img, "jpeg", 0.8)
	if err != nil || !bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}) {
		t.Fatalf("jpeg: %v %x", err, data[:4])
	}
	if decoded, err := jpeg.Decode(bytes.NewReader(data)); err != nil || decoded.Bounds().Dx() != 64 {
		t.Errorf("jpeg decodes: %v", err)
	}
	if low, err := Encode(img, "jpeg", 0); err != nil || len(low) == 0 {
		t.Errorf("quality 0: %v", err)
	}
	data, err = Encode(img, "png", 0.8)
	if err != nil || !bytes.HasPrefix(data, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		t.Fatalf("png: %v", err)
	}
	if decoded, err := png.Decode(bytes.NewReader(data)); err != nil || decoded.Bounds().Dy() != 32 {
		t.Errorf("png decodes: %v", err)
	}
	if Mime("png") != "image/png" || Mime("jpeg") != "image/jpeg" {
		t.Error("mime types")
	}
}
