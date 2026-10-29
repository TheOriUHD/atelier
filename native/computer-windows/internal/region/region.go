// Package region is the visible-region math for masking windows in a screenshot: what of each window is on screen
// (its rectangle minus everything above it), and so which pixels to black out.
package region

// Rect is a half-open rectangle of pixels: [X0, X1) × [Y0, Y1).
type Rect struct{ X0, Y0, X1, Y1 int }

func (r Rect) Empty() bool { return r.X1 <= r.X0 || r.Y1 <= r.Y0 }

func (r Rect) Intersect(o Rect) Rect {
	out := Rect{max(r.X0, o.X0), max(r.Y0, o.Y0), min(r.X1, o.X1), min(r.Y1, o.Y1)}
	if out.Empty() {
		return Rect{}
	}
	return out
}

func (r Rect) Area() int {
	if r.Empty() {
		return 0
	}
	return (r.X1 - r.X0) * (r.Y1 - r.Y0)
}

// Subtract is r minus c: at most four rectangles (the bands above and below c, and the parts left and right of it).
func Subtract(r, c Rect) []Rect {
	i := r.Intersect(c)
	if i.Empty() {
		if r.Empty() {
			return nil
		}
		return []Rect{r}
	}
	var out []Rect
	add := func(x Rect) {
		if !x.Empty() {
			out = append(out, x)
		}
	}
	add(Rect{r.X0, r.Y0, r.X1, i.Y0}) // above
	add(Rect{r.X0, i.Y1, r.X1, r.Y1}) // below
	add(Rect{r.X0, i.Y0, i.X0, i.Y1}) // left
	add(Rect{i.X1, i.Y0, r.X1, i.Y1}) // right
	return out
}

// SubtractAll is the region (disjoint rectangles) minus c.
func SubtractAll(region []Rect, c Rect) []Rect {
	var out []Rect
	for _, r := range region {
		out = append(out, Subtract(r, c)...)
	}
	return out
}

// Window is one top-level window, in z-order from the top.
type Window struct {
	Rect Rect
	// Masked: black out what is visible of it.
	Masked bool
	// Occludes: it hides what is below it. Click-through overlays and windows kept out of captures don't.
	Occludes bool
}

// Mask is the pixels to black out, within clip: for every masked window, its rectangle minus the occluding windows
// above it. The rectangles are disjoint within one window's region, and may overlap across windows.
func Mask(windows []Window, clip Rect) []Rect {
	var covered []Rect
	var mask []Rect
	for _, w := range windows {
		r := w.Rect.Intersect(clip)
		if r.Empty() {
			continue
		}
		if w.Masked {
			visible := []Rect{r}
			for _, c := range covered {
				visible = SubtractAll(visible, c)
				if len(visible) == 0 {
					break
				}
			}
			mask = append(mask, visible...)
		}
		if w.Occludes {
			covered = append(covered, r)
		}
	}
	return mask
}

// Union is how many pixels of clip a set of possibly overlapping rectangles covers (tests).
func Union(rects []Rect, clip Rect) int {
	var disjoint []Rect
	for _, r := range rects {
		piece := []Rect{r.Intersect(clip)}
		for _, d := range disjoint {
			piece = SubtractAll(piece, d)
		}
		for _, p := range piece {
			if !p.Empty() {
				disjoint = append(disjoint, p)
			}
		}
	}
	total := 0
	for _, d := range disjoint {
		total += d.Area()
	}
	return total
}
