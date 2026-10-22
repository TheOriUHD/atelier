package watch

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

func setup(t *testing.T) (*Manager, chan rpc.FsChangedNotification, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"src", "node_modules/dep"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan rpc.FsChangedNotification, 16)
	m := NewManager(s, func(_ string, p any) { ch <- p.(rpc.FsChangedNotification) })
	t.Cleanup(m.CloseAll)
	return m, ch, root
}

// collect gathers events until none arrive for a while.
func collect(ch chan rpc.FsChangedNotification, quiet time.Duration) (map[string]string, int) {
	got, batches := map[string]string{}, 0
	for {
		select {
		case n := <-ch:
			batches++
			for _, e := range n.Events {
				got[e.Path] = e.Op
			}
		case <-time.After(quiet):
			return got, batches
		}
	}
}

func TestRecursiveWatch(t *testing.T) {
	m, ch, root := setup(t)
	res, err := m.Watch(context.Background(), rpc.FsWatchParams{Path: root, Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(root, "src", "a.ts")
	for i := range 5 {
		if err := os.WriteFile(a, []byte{byte('0' + i)}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, batches := collect(ch, 500*time.Millisecond)
	if got[a] != "create" || batches != 1 {
		t.Fatalf("debounced create+writes: %v in %d batches", got, batches)
	}

	// Directories created after the watch started are watched too.
	newDir := filepath.Join(root, "src", "new")
	if err := os.Mkdir(newDir, 0o755); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	b := filepath.Join(newDir, "b.ts")
	if err := os.WriteFile(b, []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "dep", "x.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(a); err != nil {
		t.Fatal(err)
	}
	got, _ = collect(ch, 500*time.Millisecond)
	if got[b] != "create" || got[a] != "remove" {
		t.Fatalf("events: %v", got)
	}
	if _, ok := got[filepath.Join(root, "node_modules", "dep", "x.js")]; ok {
		t.Errorf("ignored directory was watched: %v", got)
	}

	if _, err := m.Unwatch(context.Background(), rpc.FsUnwatchParams{WatchID: res.WatchID}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "c.ts"), []byte("c"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := collect(ch, 300*time.Millisecond); len(got) != 0 {
		t.Errorf("events after unwatch: %v", got)
	}
}

func TestWatchFileAndScope(t *testing.T) {
	m, ch, root := setup(t)
	f := filepath.Join(root, "f.txt")
	if err := os.WriteFile(f, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Watch(context.Background(), rpc.FsWatchParams{Path: f}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f, []byte("2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := collect(ch, 500*time.Millisecond); got[f] != "write" {
		t.Errorf("file watch: %v", got)
	}
	if _, err := m.Watch(context.Background(), rpc.FsWatchParams{Path: filepath.Dir(root)}); err == nil {
		t.Error("watch outside the workspace accepted")
	}
	if _, err := m.Unwatch(context.Background(), rpc.FsUnwatchParams{WatchID: "nope"}); err != nil {
		t.Errorf("unwatch unknown id: %v", err)
	}
}
