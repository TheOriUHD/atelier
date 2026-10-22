package walk

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func collect(t *testing.T, start, top string, opt Options) []string {
	t.Helper()
	var mu sync.Mutex
	var out []string
	err := Walk(context.Background(), start, top, opt, func(e Entry) bool {
		mu.Lock()
		defer mu.Unlock()
		out = append(out, e.Rel)
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(out)
	return out
}

func TestGitignoreSemantics(t *testing.T) {
	root := tree(t, map[string]string{
		".git/HEAD":                "ref",
		".git/info/exclude":        "excluded.txt\n",
		".gitignore":               "node_modules/\n*.log\n!keep.log\n/build\n",
		"a.ts":                     "",
		"debug.log":                "",
		"keep.log":                 "",
		"excluded.txt":             "",
		"build/out.js":             "",
		"src/build/x.ts":           "", // /build is anchored to the root
		"node_modules/dep/i.js":    "",
		"pkg/node_modules/d/i.js":  "",
		"pkg/.gitignore":           "gen/\n",
		"pkg/gen/g.ts":             "",
		"pkg/src/.ignore":          "*.tmp\n",
		"pkg/src/x.tmp":            "",
		"pkg/src/y.ts":             "",
		".github/workflows/ci.yml": "", // hidden files are included
	})
	got := strings.Join(collect(t, root, root, Options{Ignore: true}), " ")
	want := ".github/workflows/ci.yml .gitignore a.ts keep.log pkg/.gitignore pkg/src/.ignore pkg/src/y.ts src/build/x.ts"
	if got != want {
		t.Errorf("walk from root:\n got  %s\n want %s", got, want)
	}

	// Starting below the repository top still applies the parent .gitignore files.
	got = strings.Join(collect(t, filepath.Join(root, "pkg"), root, Options{Ignore: true}), " ")
	if want := ".gitignore src/.ignore src/y.ts"; got != want {
		t.Errorf("walk from pkg:\n got  %s\n want %s", got, want)
	}

	// An ignored directory named explicitly is searched.
	got = strings.Join(collect(t, filepath.Join(root, "node_modules"), root, Options{Ignore: true}), " ")
	if want := "dep/i.js"; got != want {
		t.Errorf("walk inside an ignored dir: got %s, want %s", got, want)
	}

	all := collect(t, root, root, Options{})
	if !slices.Contains(all, "node_modules/dep/i.js") || slices.ContainsFunc(all, func(s string) bool { return strings.HasPrefix(s, ".git/") }) {
		t.Errorf("walk without ignore rules: %v", all)
	}
}

func TestDepthDirsAndSymlinks(t *testing.T) {
	root := tree(t, map[string]string{"a/b/c/d.txt": "", "top.txt": ""})
	outside := tree(t, map[string]string{"secret.txt": ""})
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks unavailable")
		}
		t.Fatal(err)
	}
	got := strings.Join(collect(t, root, root, Options{Dirs: true, MaxDepth: 2}), " ")
	if want := "a a/b link top.txt"; got != want {
		t.Errorf("depth 2 with dirs: got %s, want %s", got, want)
	}
	got = strings.Join(collect(t, root, root, Options{}), " ")
	if want := "a/b/c/d.txt link top.txt"; got != want {
		t.Errorf("files: got %s, want %s (symlinks are reported, never followed)", got, want)
	}
}

func TestStopAndCancel(t *testing.T) {
	files := map[string]string{}
	for i := range 200 {
		files[filepath.Join("d", strings.Repeat("x", i%7+1), strings.Repeat("f", i+1))] = ""
	}
	root := tree(t, files)
	var mu sync.Mutex
	n := 0
	err := Walk(context.Background(), root, root, Options{}, func(Entry) bool {
		mu.Lock()
		defer mu.Unlock()
		n++
		return n < 10
	})
	if err != nil || n < 10 || n > 10+runtime.GOMAXPROCS(0) {
		t.Errorf("stop: visited %d, err %v", n, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Walk(ctx, root, root, Options{}, func(Entry) bool { return true }); err != context.Canceled {
		t.Errorf("cancelled walk returned %v", err)
	}
}
