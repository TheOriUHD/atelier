package apply

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"atelier.dev/setup/internal/plan"
)

// ImageProgress is how far one image of a pull has come, for a progress bar.
type ImageProgress struct {
	// Image is the name in the compose file, such as ghcr.io/theoriuhd/atelier:latest.
	Image string
	// Downloaded and Size are bytes of the layers it has to fetch; Size grows as Docker learns the sizes.
	Downloaded, Size int64
	// Layers is how many layers it has, Unpacked how many are in place (fetched and unpacked, or already here).
	Layers, Unpacked int
	Done             bool
}

// Fraction is how far along it is, from 0 to 1: mostly the download, the rest unpacking.
func (p ImageProgress) Fraction() float64 {
	if p.Done {
		return 1
	}
	f := 0.0
	if p.Size > 0 {
		f += 0.85 * float64(p.Downloaded) / float64(p.Size)
	}
	if p.Layers > 0 {
		f += 0.15 * float64(p.Unpacked) / float64(p.Layers)
	}
	return min(f, 0.99)
}

type pullLayer struct {
	current, total    int64
	fetched, unpacked bool
}

type pullImage struct {
	layers map[string]*pullLayer
	done   bool
}

// pullTracker adds up the per-layer lines of `docker compose --progress json pull` into one ImageProgress per image.
type pullTracker struct {
	images map[string]*pullImage
	errors []string
}

// composeEvent is one line of Compose's JSON progress; a failure comes as {"error":true,"message":...}.
type composeEvent struct {
	Error    bool   `json:"error"`
	Message  string `json:"message"`
	ID       string `json:"id"`
	ParentID string `json:"parent_id"`
	Status   string `json:"status"`
	Text     string `json:"text"`
	Current  int64  `json:"current"`
	Total    int64  `json:"total"`
}

// line reads one line of output; it returns the image it changed, or ok false for a line that is not progress.
func (t *pullTracker) line(s string) (ImageProgress, bool) {
	var e composeEvent
	if !strings.HasPrefix(strings.TrimSpace(s), "{") || json.Unmarshal([]byte(s), &e) != nil {
		return ImageProgress{}, false
	}
	if e.Error && e.Message != "" {
		t.errors = append(t.errors, e.Message)
		return ImageProgress{}, true
	}
	if e.ID == "" {
		return ImageProgress{}, false
	}
	if t.images == nil {
		t.images = map[string]*pullImage{}
	}
	if e.Status == "Error" {
		t.errors = append(t.errors, strings.TrimSpace(strings.TrimPrefix(e.ID, "Image ")+": "+e.Text))
	}
	name, layerID := strings.TrimPrefix(e.ID, "Image "), ""
	if e.ParentID != "" {
		name, layerID = strings.TrimPrefix(e.ParentID, "Image "), e.ID
	}
	img := t.images[name]
	if img == nil {
		img = &pullImage{layers: map[string]*pullLayer{}}
		t.images[name] = img
	}
	if layerID == "" {
		if e.Status == "Done" {
			img.done = true
		}
		return t.snapshot(name), true
	}
	l := img.layers[layerID]
	if l == nil {
		l = &pullLayer{}
		img.layers[layerID] = l
	}
	switch e.Text {
	case "Already exists":
		l.fetched, l.unpacked = true, true
	case "Downloading":
		l.current = e.Current
		if e.Total > 0 {
			l.total = e.Total
		}
	case "Verifying Checksum", "Download complete":
		l.fetched = true
	case "Extracting":
		l.fetched = true
	case "Pull complete":
		l.fetched, l.unpacked = true, true
	}
	return t.snapshot(name), true
}

func (t *pullTracker) snapshot(name string) ImageProgress {
	img := t.images[name]
	p := ImageProgress{Image: name, Layers: len(img.layers), Done: img.done}
	for _, l := range img.layers {
		if l.total > 0 {
			p.Size += l.total
			if l.fetched {
				p.Downloaded += l.total
			} else {
				p.Downloaded += min(l.current, l.total)
			}
		}
		if l.unpacked {
			p.Unpacked++
		}
	}
	return p
}

// pull downloads the images with a progress line per layer turned into one bar per image. A Compose too old for JSON
// progress gets the plain pull, whose lines go to the log.
func pull(ctx context.Context, o Options, dir string, s plan.Step, emit func(Event)) error {
	emit(Event{Step: s.ID, Kind: "start", Text: s.Title})
	t := &pullTracker{}
	var plain []string
	err := o.Run(ctx, dir, "docker", []string{"compose", "--progress", "json", "pull"}, func(line string) {
		if p, ok := t.line(line); ok {
			if p.Image != "" {
				emit(Event{Step: s.ID, Kind: "image", Image: &p})
			}
			return
		}
		plain = append(plain, line)
		emit(Event{Step: s.ID, Kind: "log", Text: line})
	})
	if err != nil && oldCompose(plain) {
		err = o.Run(ctx, dir, "docker", []string{"compose", "pull"}, func(line string) { emit(Event{Step: s.ID, Kind: "log", Text: line}) })
	}
	if err != nil {
		if len(t.errors) > 0 {
			err = errors.New(strings.Join(t.errors, "; "))
		}
		err = fmt.Errorf("docker compose pull failed: %w", err)
		emit(Event{Step: s.ID, Kind: "fail", Err: err})
		return err
	}
	emit(Event{Step: s.ID, Kind: "done"})
	return nil
}

// oldCompose tells from its output that Compose doesn't know `--progress json` (before v2.26).
func oldCompose(lines []string) bool {
	for _, l := range lines {
		l = strings.ToLower(l)
		if strings.Contains(l, "progress") && (strings.Contains(l, "invalid") || strings.Contains(l, "unknown") || strings.Contains(l, "unsupported")) {
			return true
		}
	}
	return false
}
