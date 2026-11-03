package region

import "testing"

func TestSubtract(t *testing.T) {
	r := Rect{0, 0, 100, 100}
	// A hole in the middle: four pieces with the hole's area missing.
	pieces := Subtract(r, Rect{40, 40, 60, 60})
	if len(pieces) != 4 || Union(pieces, r) != 100*100-20*20 {
		t.Errorf("hole: %v", pieces)
	}
	// Not touching: unchanged.
	if pieces := Subtract(r, Rect{200, 200, 300, 300}); len(pieces) != 1 || pieces[0] != r {
		t.Errorf("apart: %v", pieces)
	}
	// Covering it: nothing left.
	if pieces := Subtract(r, Rect{-10, -10, 200, 200}); len(pieces) != 0 {
		t.Errorf("covered: %v", pieces)
	}
	// Over one edge.
	if pieces := Subtract(r, Rect{50, -10, 200, 200}); len(pieces) != 1 || pieces[0] != (Rect{0, 0, 50, 100}) {
		t.Errorf("edge: %v", pieces)
	}
}

func TestMaskOnlyWhatIsVisible(t *testing.T) {
	screen := Rect{0, 0, 1000, 800}
	// From the top: an allowed window over a masked one, which is over the desktop.
	windows := []Window{
		{Rect: Rect{100, 100, 500, 500}, Masked: false, Occludes: true},
		{Rect: Rect{300, 300, 900, 700}, Masked: true, Occludes: true},
		{Rect: Rect{0, 0, 1000, 800}, Masked: false, Occludes: true}, // the desktop
	}
	mask := Mask(windows, screen)
	// The masked window minus the allowed one's overlap (200×200).
	if got, want := Union(mask, screen), 600*400-200*200; got != want {
		t.Errorf("masked pixels: %d, want %d (%v)", got, want, mask)
	}
	for _, m := range mask {
		if !m.Intersect(Rect{100, 100, 500, 500}).Empty() {
			t.Errorf("the allowed window is masked: %v", m)
		}
	}
}

func TestMaskClipsToTheCapture(t *testing.T) {
	// A capture of the left monitor (negative coordinates) only.
	clip := Rect{-1920, 0, 0, 1080}
	windows := []Window{{Rect: Rect{-500, 100, 500, 300}, Masked: true, Occludes: true}}
	mask := Mask(windows, clip)
	if len(mask) != 1 || mask[0] != (Rect{-500, 100, 0, 300}) {
		t.Errorf("clipped: %v", mask)
	}
	// A window entirely on another monitor masks nothing here.
	if mask := Mask([]Window{{Rect: Rect{100, 100, 200, 200}, Masked: true, Occludes: true}}, clip); len(mask) != 0 {
		t.Errorf("other monitor: %v", mask)
	}
}

func TestMaskedWindowsUnderOthers(t *testing.T) {
	screen := Rect{0, 0, 100, 100}
	// A masked window fully under an allowed one: nothing of it shows, nothing is masked.
	windows := []Window{
		{Rect: Rect{0, 0, 100, 100}, Occludes: true},
		{Rect: Rect{10, 10, 50, 50}, Masked: true, Occludes: true},
	}
	if mask := Mask(windows, screen); Union(mask, screen) != 0 {
		t.Errorf("hidden window: %v", mask)
	}
	// Two masked windows overlapping: the union of what shows of both.
	windows = []Window{
		{Rect: Rect{0, 0, 60, 60}, Masked: true, Occludes: true},
		{Rect: Rect{40, 40, 100, 100}, Masked: true, Occludes: true},
	}
	if got := Union(Mask(windows, screen), screen); got != 60*60+60*60-20*20 {
		t.Errorf("two masked: %d", got)
	}
	// A window that doesn't occlude (a click-through overlay) leaves what is under it visible.
	windows = []Window{
		{Rect: Rect{0, 0, 100, 100}, Occludes: false},
		{Rect: Rect{0, 0, 50, 50}, Masked: true, Occludes: true},
	}
	if got := Union(Mask(windows, screen), screen); got != 50*50 {
		t.Errorf("under an overlay: %d", got)
	}
}
