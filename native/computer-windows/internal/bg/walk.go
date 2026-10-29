package bg

// Tree is what a walk needs of a UI Automation tree: its elements' children in order, and their bounds.
type Tree[N comparable] interface {
	FirstChild(n N) (N, bool)
	NextSibling(n N) (N, bool)
	// Bounds is the element's bounding rectangle in screen pixels; ok false when it has none.
	Bounds(n N) (Rect, bool)
	// Release lets go of an element the walk got from FirstChild or NextSibling.
	Release(n N)
}

// Limits bound a walk: how deep, how many children per level, and until when.
type Limits struct {
	Depth    int
	Children int
	// Expired reports that the walk's time is up (nil: never).
	Expired func() bool
}

// WalkLimits are bg.inspect's: 25 levels, 300 children examined per level (the 1 s budget is the caller's).
var WalkLimits = Limits{Depth: 25, Children: 300}

func (l Limits) expired() bool { return l.Expired != nil && l.Expired() }

// Descend walks down from root to the deepest element whose bounds contain x, y, whatever covers it on screen: at each
// level, of the children that contain the point, the smallest (the most specific; the first of equals). It stops at
// an element none of whose first Children children contain the point, at Depth levels, or when time is up, and returns
// the deepest element found so far and how many levels down it is. The caller owns root and, when it isn't root, the
// element returned; the walk releases every other element it got.
func Descend[N comparable](t Tree[N], root N, x, y float64, lim Limits) (N, int) {
	current := root
	depth := 0
	for depth < lim.Depth && !lim.expired() {
		var best N
		found := false
		bestArea := 0.0
		examined := 0
		child, ok := t.FirstChild(current)
		for ok {
			examined++
			keep := false
			area := 0.0
			if r, has := t.Bounds(child); has && r.Contains(x, y) {
				area = r.Area()
				keep = area > 0 && (!found || area < bestArea)
			}
			var next N
			more := false
			if examined < lim.Children && !lim.expired() {
				next, more = t.NextSibling(child)
			}
			if keep {
				if found {
					t.Release(best)
				}
				best, bestArea, found = child, area, true
			} else {
				t.Release(child)
			}
			child, ok = next, more
		}
		if !found {
			break
		}
		if current != root {
			t.Release(current)
		}
		current = best
		depth++
	}
	return current, depth
}
