package fsops

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"atelier.dev/runner/internal/rpc"
)

// tempDir returns a symlink-free temp directory (macOS puts t.TempDir behind /var -> /private/var).
func tempDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func mustScope(t *testing.T, roots ...string) *Scope {
	t.Helper()
	s, err := NewScope(roots...)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func isOutside(err error) bool {
	var e *rpc.Error
	return errors.As(err, &e) && e.Code == rpc.CodePathOutsideWorkspace
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlinks unavailable: %v", err)
		}
		t.Fatal(err)
	}
}

func TestScopeTraversal(t *testing.T) {
	base := tempDir(t)
	root := filepath.Join(base, "proj")
	outside := filepath.Join(base, "secret")
	sibling := filepath.Join(base, "proj-evil") // shares the root's name as a string prefix
	for _, d := range []string{filepath.Join(root, "src"), outside, sibling} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s := mustScope(t, root)

	ok := map[string]string{
		"src/a.ts":                       filepath.Join(root, "src", "a.ts"),
		"":                               root,
		".":                              root,
		filepath.Join(root, "x", "y.go"): filepath.Join(root, "x", "y.go"),
		"src/../src/./b.ts":              filepath.Join(root, "src", "b.ts"),
		"../proj/c.ts":                   filepath.Join(root, "c.ts"),
		"new/dir/file.txt":               filepath.Join(root, "new", "dir", "file.txt"),
	}
	for in, want := range ok {
		got, err := s.Resolve(in)
		if err != nil || got != want {
			t.Errorf("Resolve(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"..",
		"../secret/key",
		"src/../../secret/key",
		filepath.Join(outside, "key"),
		filepath.Join(sibling, "x"),
		"../proj-evil/x",
		string(filepath.Separator),
	} {
		if got, err := s.Resolve(in); !isOutside(err) {
			t.Errorf("Resolve(%q) = %q, %v; want PathOutsideWorkspace", in, got, err)
		}
	}
}

func TestScopeSymlinks(t *testing.T) {
	base := tempDir(t)
	root := filepath.Join(base, "proj")
	outside := filepath.Join(base, "secret")
	for _, d := range []string{filepath.Join(root, "real"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "key"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, outside, filepath.Join(root, "escape"))                             // dir link out
	symlinkOrSkip(t, filepath.Join(outside, "key"), filepath.Join(root, "key"))          // file link out
	symlinkOrSkip(t, filepath.Join(outside, "missing"), filepath.Join(root, "dangling")) // dangling link out
	symlinkOrSkip(t, filepath.Join("..", "secret"), filepath.Join(root, "relative"))     // relative link out
	symlinkOrSkip(t, filepath.Join(root, "real"), filepath.Join(root, "inside"))         // link within
	symlinkOrSkip(t, filepath.Join(root, "loop-b"), filepath.Join(root, "loop-a"))       // cycle
	symlinkOrSkip(t, filepath.Join(root, "loop-a"), filepath.Join(root, "loop-b"))
	s := mustScope(t, root)

	for _, in := range []string{"escape/key", "escape", "key", "dangling", "dangling/new.txt", "relative/key"} {
		if got, err := s.Resolve(in); !isOutside(err) {
			t.Errorf("Resolve(%q) = %q, %v; want PathOutsideWorkspace", in, got, err)
		}
	}
	if got, err := s.Resolve("inside/f.txt"); err != nil || got != filepath.Join(root, "real", "f.txt") {
		t.Errorf("Resolve(inside/f.txt) = %q, %v", got, err)
	}
	if _, err := s.Resolve("loop-a/x"); err == nil {
		t.Error("Resolve through a symlink cycle succeeded")
	}
	// Acting on the link itself (remove, rename) is fine: it lives inside the root.
	if got, err := s.ResolveEntry("escape"); err != nil || got != filepath.Join(root, "escape") {
		t.Errorf("ResolveEntry(escape) = %q, %v", got, err)
	}
	if _, err := s.ResolveEntry("escape/key"); !isOutside(err) {
		t.Errorf("ResolveEntry(escape/key) = %v; want PathOutsideWorkspace", err)
	}
}

func TestScopeCaseInsensitive(t *testing.T) {
	base := tempDir(t)
	root := filepath.Join(base, "Proj")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(base, "proj-other"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := mustScope(t, root)
	upper := filepath.Join(base, "PROJ", "file.txt")
	got, err := s.Resolve(upper)
	if !caseInsensitive(root) {
		if !isOutside(err) {
			t.Fatalf("case-sensitive filesystem: Resolve(%q) = %q, %v; want PathOutsideWorkspace", upper, got, err)
		}
		return
	}
	// Same directory on a case-insensitive filesystem: accepted, spelled like the root.
	if err != nil || got != filepath.Join(root, "file.txt") {
		t.Fatalf("Resolve(%q) = %q, %v; want %q", upper, got, err, filepath.Join(root, "file.txt"))
	}
	for _, in := range []string{filepath.Join(base, "PROJ-OTHER", "x"), filepath.Join(base, "PROJ", "..", "proj-other")} {
		if got, err := s.Resolve(in); !isOutside(err) {
			t.Errorf("Resolve(%q) = %q, %v; want PathOutsideWorkspace", in, got, err)
		}
	}
}

func TestScopeAddRootAndRootOf(t *testing.T) {
	base := tempDir(t)
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	for _, d := range []string{filepath.Join(a, "inner"), b} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s := mustScope(t, filepath.Join(a, "inner"))
	if _, err := s.Resolve(filepath.Join(b, "x")); !isOutside(err) {
		t.Fatalf("b reachable before addRoot: %v", err)
	}
	if _, err := s.Add(b); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(a); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Resolve(filepath.Join(b, "x")); err != nil || got != filepath.Join(b, "x") {
		t.Fatalf("Resolve after addRoot = %q, %v", got, err)
	}
	if got := s.RootOf(filepath.Join(a, "inner", "f")); got != a {
		t.Errorf("RootOf picks the outermost root: got %q, want %q", got, a)
	}
	if _, err := s.Add(filepath.Join(base, "missing")); err == nil {
		t.Error("adding a missing root succeeded")
	}
	if !s.IsRoot(b) || s.IsRoot(filepath.Join(b, "x")) {
		t.Error("IsRoot is wrong")
	}
	if strings.Join(s.Roots(), ",") != strings.Join([]string{filepath.Join(a, "inner"), b, a}, ",") {
		t.Errorf("Roots() = %v", s.Roots())
	}
}
