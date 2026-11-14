//go:build linux

package x11

// These run against a real X server (Xvfb, with or without a window manager) and skip without DISPLAY. They are the
// tests of the behaviour that only an X server can show: what a screenshot holds, where a click lands, what a key types.
// native/computer-linux/test/run-in-docker.sh runs them in a container with Xvfb, openbox, xterm and xdotool.

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"atelier.dev/computer-linux/internal/control"
	"atelier.dev/computer-linux/internal/helper"
	"atelier.dev/computer-linux/internal/input"
	"atelier.dev/computer-linux/internal/keys"
	"atelier.dev/computer-linux/internal/proto"
)

func system(t *testing.T) *System {
	t.Helper()
	if os.Getenv("DISPLAY") == "" {
		t.Skip("no X display")
	}
	// No desktop entries of the machine: the tests name their apps by window class.
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_DATA_DIRS", t.TempDir())
	s, err := NewSystem(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// xterm starts an xterm running a shell command with a class of its own, and waits for its window.
func xterm(t *testing.T, class, script string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("xterm", "-class", class, "-name", class, "-geometry", "60x10+100+100", "-e", "sh", "-c", script)
	// UTF-8, so that the characters typed beyond Latin-1 arrive as they were typed.
	cmd.Env = append(os.Environ(), "LC_ALL=C.UTF-8")
	if err := cmd.Start(); err != nil {
		t.Skipf("no xterm: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func appNamed(s *System, id string) (proto.App, bool) {
	apps, _ := s.Apps(false)
	for _, a := range apps {
		if strings.EqualFold(a.ID, id) {
			return a, true
		}
	}
	return proto.App{}, false
}

func decode(t *testing.T, r proto.CaptureResult) image.Image {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(r.Data)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func capture(t *testing.T, s *System, req helper.CaptureRequest) (image.Image, proto.CaptureResult) {
	t.Helper()
	displays, _ := s.Displays()
	req.Display = displays[0].ID
	req.MaxWidth, req.MaxHeight, req.Format, req.Quality = 4000, 4000, "png", 1
	r, err := s.Capture(req)
	if err != nil {
		t.Fatal(err)
	}
	return decode(t, r), r
}

func black(img image.Image, x, y int) bool {
	r, g, b, _ := img.At(x, y).RGBA()
	return r == 0 && g == 0 && b == 0
}

func TestDisplaysAndRunningAppsAreListed(t *testing.T) {
	s := system(t)
	displays, err := s.Displays()
	if err != nil || len(displays) == 0 || !displays[0].Primary || displays[0].Width < 100 {
		t.Fatalf("displays: %+v %v", displays, err)
	}
	xterm(t, "listed-app", "sleep 30")
	waitFor(t, "the xterm in the app list", func() bool { _, ok := appNamed(s, "listed-app"); return ok })
	app, _ := appNamed(s, "listed-app")
	if !app.Running || app.PID == nil {
		t.Errorf("a running app has a pid: %+v", app)
	}
}

func TestACaptureHidesWhatWasNotAllowedAndShowsTheRest(t *testing.T) {
	s := system(t)
	xterm(t, "shown-app", "sleep 30")
	xterm(t, "hidden-app", "sleep 30")
	waitFor(t, "both xterms", func() bool {
		_, a := appNamed(s, "shown-app")
		_, b := appNamed(s, "hidden-app")
		return a && b
	})
	time.Sleep(500 * time.Millisecond)
	snap := s.c.Snapshot()
	var shown, hidden Win
	for _, w := range snap.Stack {
		switch strings.ToLower(w.Class) {
		case "shown-app":
			shown = w
		case "hidden-app":
			hidden = w
		}
	}
	if shown.ID == 0 || hidden.ID == 0 {
		t.Fatalf("windows not found in the stack: %+v", snap.Stack)
	}
	// Both xterms open at the same place; whichever is on top is what shows. Move the lower one aside so each has pixels.
	cmd := exec.Command("xdotool", "windowmove", fmt.Sprint(uint32(hidden.ID)), "700", "300")
	_ = cmd.Run()
	time.Sleep(300 * time.Millisecond)

	img, _ := capture(t, s, helper.CaptureRequest{HasApps: true, Apps: []string{"shown-app"}})
	snap = s.c.Snapshot()
	for _, w := range snap.Stack {
		cx, cy := (w.Rect.X0+w.Rect.X1)/2, (w.Rect.Y0+w.Rect.Y1)/2
		switch strings.ToLower(w.Class) {
		case "hidden-app":
			if !black(img, cx, cy) {
				t.Errorf("the not-allowed app shows in the screenshot at %d,%d", cx, cy)
			}
		case "shown-app":
			if black(img, cx, cy) {
				t.Errorf("the allowed app is black at %d,%d", cx, cy)
			}
		}
	}

	// exclude: the reverse.
	img, _ = capture(t, s, helper.CaptureRequest{HasExclude: true, Exclude: []string{"hidden-app"}})
	for _, w := range s.c.Snapshot().Stack {
		cx, cy := (w.Rect.X0+w.Rect.X1)/2, (w.Rect.Y0+w.Rect.Y1)/2
		switch strings.ToLower(w.Class) {
		case "hidden-app":
			if !black(img, cx, cy) {
				t.Errorf("an excluded app shows at %d,%d", cx, cy)
			}
		case "shown-app":
			if black(img, cx, cy) {
				t.Errorf("a not-excluded app is black at %d,%d", cx, cy)
			}
		}
	}
}

func TestInspectPointNamesTheAppUnderIt(t *testing.T) {
	s := system(t)
	xterm(t, "point-app", "sleep 30")
	waitFor(t, "the xterm", func() bool { _, ok := appNamed(s, "point-app"); return ok })
	time.Sleep(500 * time.Millisecond)
	for _, w := range s.c.Snapshot().Stack {
		if strings.EqualFold(w.Class, "point-app") {
			r, err := s.InspectPoint(float64((w.Rect.X0+w.Rect.X1)/2), float64((w.Rect.Y0+w.Rect.Y1)/2))
			if err != nil || r.App == nil || !strings.EqualFold(r.App.ID, "point-app") {
				t.Fatalf("inspect: %+v %v", r, err)
			}
			return
		}
	}
	t.Fatal("no window")
}

// controller builds the input controller over the real server, like the helper does.
func controller(s *System) *input.Controller { return input.NewController(s.Sender()) }

func TestClicksAndKeysReachTheFocusedApp(t *testing.T) {
	s := system(t)
	out := filepath.Join(t.TempDir(), "typed.txt")
	// The shell reads one line and writes it to a file: what was typed, as the app received it.
	xterm(t, "typing-app", "read line; printf %s \"$line\" > "+out+"; sleep 30")
	waitFor(t, "the xterm", func() bool { _, ok := appNamed(s, "typing-app"); return ok })
	time.Sleep(700 * time.Millisecond)
	var w Win
	for _, c := range s.c.Snapshot().Stack {
		if strings.EqualFold(c.Class, "typing-app") {
			w = c
		}
	}
	in := controller(s)
	cx, cy := float64((w.Rect.X0+w.Rect.X1)/2), float64((w.Rect.Y0+w.Rect.Y1)/2)
	if err := in.Click(proto.Point{X: cx, Y: cy}, input.Left, 1, nil); err != nil {
		t.Fatal(err)
	}
	// Characters of the layout, a shifted one, a space, and two that the layout lacks (bound to a spare key).
	const text = "Hello, World! 42 ü€"
	if err := in.Type(text); err != nil {
		t.Fatal(err)
	}
	stroke, _ := keys.Resolve([]string{"return"})
	if err := in.Press(stroke, 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the typed line", func() bool { b, _ := os.ReadFile(out); return len(b) > 0 })
	b, _ := os.ReadFile(out)
	if string(b) != text {
		t.Errorf("typed %q, the app got %q", text, string(b))
	}
	// Nothing is left held.
	if in.KeyIsOurs(1) && in.IsStopped() {
		t.Error("state")
	}
}

func TestKeyChordsAndTheMouseMoveThePointer(t *testing.T) {
	s := system(t)
	in := controller(s)
	if err := in.Move(proto.Point{X: 321, Y: 123}); err != nil {
		t.Fatal(err)
	}
	p, ok := s.Sender().Pointer()
	if !ok || p.X != 321 || p.Y != 123 {
		t.Errorf("pointer at %+v", p)
	}
	// ctrl+shift+a: three keys down and up with nothing left pressed.
	stroke, err := keys.Resolve([]string{"cmd", "shift", "a"})
	if err != nil || in.Press(stroke, 2) != nil {
		t.Fatalf("press: %v", err)
	}
	if s.EscapeDown() {
		t.Error("Esc reads as down")
	}
}

func TestHideAndUnhideMinimizeAndRestore(t *testing.T) {
	s := system(t)
	if !s.c.hasWM() {
		t.Skip("needs a window manager")
	}
	xterm(t, "hide-app", "sleep 30")
	waitFor(t, "the xterm", func() bool { _, ok := appNamed(s, "hide-app"); return ok })
	done, err := s.HideApps([]string{"hide-app"}, "")
	if err != nil || len(done) != 1 {
		t.Fatalf("hide: %v %v", done, err)
	}
	waitFor(t, "it to be hidden", func() bool { a, _ := appNamed(s, "hide-app"); return a.Hidden })
	if err := s.UnhideApps([]string{"hide-app"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "it to be shown again", func() bool { a, _ := appNamed(s, "hide-app"); return !a.Hidden })
}

func TestOpeningAnAppFromItsDesktopEntry(t *testing.T) {
	s := system(t)
	dir := t.TempDir()
	apps := filepath.Join(dir, "applications")
	_ = os.MkdirAll(apps, 0o755)
	entry := "[Desktop Entry]\nType=Application\nName=Opened By Entry\nExec=xterm -class opened-app -name opened-app -e sleep 30\nStartupWMClass=opened-app\n"
	if err := os.WriteFile(filepath.Join(apps, "opened-app.desktop"), []byte(entry), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_DATA_HOME", dir)
	s.idx = nil
	app, err := s.OpenApp("opened-app", true)
	if err != nil {
		t.Fatal(err)
	}
	if app.Name != "Opened By Entry" || !app.Running {
		t.Errorf("opened %+v", app)
	}
	_ = exec.Command("pkill", "-f", "opened-app").Run()
	if _, err := s.OpenApp("no-such-app", false); err == nil {
		t.Error("an unknown app opened")
	}
}

// The person's own input is told from the helper's: a key sent by another client (the "person", through xdotool) shows,
// the helper's own does not.
func TestTheWatchSeesThePersonsInputButNotTheHelpers(t *testing.T) {
	s := system(t)
	if _, err := exec.LookPath("xdotool"); err != nil {
		t.Skip("no xdotool")
	}
	in := controller(s)
	samples := make(chan control.Sample, 64)
	if err := s.Hooks().Start(func(sm control.Sample) { samples <- sm }, in); err != nil {
		t.Fatal(err)
	}
	defer s.Hooks().Stop()
	time.Sleep(100 * time.Millisecond)

	count := func(kind control.SampleKind, wait time.Duration) int {
		n := 0
		deadline := time.After(wait)
		for {
			select {
			case sm := <-samples:
				if sm.Kind == kind {
					n++
				}
			case <-deadline:
				return n
			}
		}
	}
	// Ours: a key press and a click.
	stroke, _ := keys.Resolve([]string{"x"})
	_ = in.Press(stroke, 1)
	_ = in.Click(proto.Point{X: 50, Y: 50}, input.Left, 1, nil)
	if n := count(control.SampleKeyDown, 400*time.Millisecond); n != 0 {
		t.Errorf("the helper's own key was reported %d times", n)
	}
	// The person's: xdotool holds a key down long enough for the 25 ms poll, and presses a button.
	go func() {
		_ = exec.Command("xdotool", "keydown", "y").Run()
		time.Sleep(200 * time.Millisecond)
		_ = exec.Command("xdotool", "keyup", "y").Run()
	}()
	if n := count(control.SampleKeyDown, 600*time.Millisecond); n != 1 {
		t.Errorf("the person's key was reported %d times", n)
	}
	go func() {
		_ = exec.Command("xdotool", "mousedown", "1").Run()
		time.Sleep(200 * time.Millisecond)
		_ = exec.Command("xdotool", "mouseup", "1").Run()
	}()
	if n := count(control.SampleMouseDown, 600*time.Millisecond); n != 1 {
		t.Errorf("the person's click was reported %d times", n)
	}
}
