package glob

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

func setup(t *testing.T) (*fsops.Scope, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	files := []string{".gitignore", "a.ts", "b.js", "src/c.ts", "src/deep/d.ts", "src/deep/e.tsx", "dist/f.ts", ".hidden/g.ts"}
	now := time.Now()
	for i, name := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		content := ""
		if name == ".gitignore" {
			content = "dist/\n"
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		// Later files are newer.
		mtime := now.Add(time.Duration(i-len(files)) * time.Minute)
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(base, "outside"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func rels(root string, files []string) string {
	out := make([]string, len(files))
	for i, f := range files {
		r, _ := filepath.Rel(root, f)
		out[i] = filepath.ToSlash(r)
	}
	return strings.Join(out, " ")
}

func TestGlob(t *testing.T) {
	s, root := setup(t)
	cases := map[string]string{
		"*.ts":             "a.ts",
		"**/*.ts":          ".hidden/g.ts src/deep/d.ts src/c.ts a.ts", // newest first; dist/ is ignored
		"src/**/*.ts":      "src/deep/d.ts src/c.ts",
		"src/*/*.{ts,tsx}": "src/deep/e.tsx src/deep/d.ts",
		"**/deep/*":        "src/deep/e.tsx src/deep/d.ts",
		"nothing/**":       "",
		"dist/*.ts":        "dist/f.ts", // naming an ignored directory searches it
		filepath.ToSlash(filepath.Join(root, "src", "*.ts")): "src/c.ts",
	}
	for pattern, want := range cases {
		res, err := Glob(context.Background(), s, rpc.FsGlobParams{Pattern: pattern})
		if err != nil {
			t.Errorf("%s: %v", pattern, err)
			continue
		}
		if got := rels(root, res.Files); got != want || res.Truncated {
			t.Errorf("%s: got %q (truncated %v), want %q", pattern, got, res.Truncated, want)
		}
	}
}

func TestGlobLimitCwdAndScope(t *testing.T) {
	s, root := setup(t)
	res, err := Glob(context.Background(), s, rpc.FsGlobParams{Pattern: "**/*", Limit: 2})
	if err != nil || len(res.Files) != 2 || !res.Truncated {
		t.Fatalf("limit: %+v, %v", res, err)
	}
	res, err = Glob(context.Background(), s, rpc.FsGlobParams{Pattern: "*.ts", Cwd: "src/deep"})
	if err != nil || rels(root, res.Files) != "src/deep/d.ts" {
		t.Fatalf("cwd: %+v, %v", res, err)
	}
	if _, err := Glob(context.Background(), s, rpc.FsGlobParams{Pattern: "../outside/**"}); err == nil {
		t.Error("pattern escaping the root accepted")
	}
	if _, err := Glob(context.Background(), s, rpc.FsGlobParams{Pattern: "*", Cwd: ".."}); err == nil {
		t.Error("cwd outside the root accepted")
	}
	if _, err := Glob(context.Background(), s, rpc.FsGlobParams{Pattern: "[unclosed"}); err == nil {
		t.Error("invalid pattern accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Glob(ctx, s, rpc.FsGlobParams{Pattern: "**/*"}); err == nil {
		t.Error("cancelled glob succeeded")
	}
}
