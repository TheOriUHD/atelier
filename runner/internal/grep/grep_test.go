package grep

import (
	"context"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

func setup(t *testing.T) (*fsops.Scope, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		".gitignore":          "vendor/\n",
		"a.go":                "package a\n\nfunc Hello() {}\nfunc hello() {}\n",
		"b.ts":                "const x = 1;\n// TODO one\nconst y = 2;\nconst z = 3;\n// TODO two\n",
		"docs/readme.md":      "# Title\nhello world\n",
		"vendor/v.go":         "func Hello() {}\n",
		"multi.txt":           "start\nmiddle\nend\n",
		"crlf.txt":            "alpha\r\nbeta\r\n",
		".config/settings.ts": "hello hidden\n",
	}
	now := time.Now()
	for i, name := range slices.Sorted(maps.Keys(files)) {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(files[name]), 0o644); err != nil {
			t.Fatal(err)
		}
		mtime := now.Add(-time.Duration(i) * time.Minute) // alphabetically earlier is newer
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "bin.dat"), []byte("hello\x00world"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(root, "a.go"), old, old); err != nil {
		t.Fatal(err)
	}
	s, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func grep(t *testing.T, s *fsops.Scope, p rpc.FsGrepParams) rpc.FsGrepResult {
	t.Helper()
	res, err := Grep(context.Background(), s, p)
	if err != nil {
		t.Fatalf("%+v: %v", p, err)
	}
	return res
}

func strip(root string, lines []string) string {
	return strings.ReplaceAll(strings.Join(lines, "\n"), root+string(filepath.Separator), "")
}

func TestOutputModes(t *testing.T) {
	s, root := setup(t)
	res := grep(t, s, rpc.FsGrepParams{Pattern: "hello", CaseInsensitive: true})
	// files mode is the default; newest first, a.go is oldest; vendor/ and bin.dat are skipped.
	if got := strip(root, res.Files); got != ".config/settings.ts\ndocs/readme.md\na.go" || res.OutputMode != "files" || res.NumFiles != 3 {
		t.Errorf("files: %q %+v", got, res)
	}

	res = grep(t, s, rpc.FsGrepParams{Pattern: "hello", OutputMode: "count"})
	var counts []string
	for _, c := range res.Counts {
		counts = append(counts, strings.TrimPrefix(c.Path, root+string(filepath.Separator))+"="+string(rune('0'+c.Count)))
	}
	if strings.Join(counts, " ") != ".config/settings.ts=1 a.go=1 docs/readme.md=1" || res.NumMatches != 3 {
		t.Errorf("count: %v %+v", counts, res)
	}

	res = grep(t, s, rpc.FsGrepParams{Pattern: "TODO", Path: "b.ts", OutputMode: "content", LineNumbers: true})
	if got := strings.Join(res.Lines, "\n"); got != "2:// TODO one\n5:// TODO two" || res.NumMatches != 2 {
		t.Errorf("single file content (no file name, like rg): %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "TODO", OutputMode: "content"})
	if got := strip(root, res.Lines); got != "b.ts:// TODO one\nb.ts:// TODO two" {
		t.Errorf("content without line numbers: %q", got)
	}
}

func TestContext(t *testing.T) {
	s, root := setup(t)
	res := grep(t, s, rpc.FsGrepParams{Pattern: "TODO", OutputMode: "content", LineNumbers: true, Before: 1})
	want := "b.ts-1-const x = 1;\nb.ts:2:// TODO one\n--\nb.ts-4-const z = 3;\nb.ts:5:// TODO two"
	if got := strip(root, res.Lines); got != want {
		t.Errorf("before=1:\n%s\nwant\n%s", got, want)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "TODO", OutputMode: "content", LineNumbers: true, After: 2})
	want = "b.ts:2:// TODO one\nb.ts-3-const y = 2;\nb.ts-4-const z = 3;\nb.ts:5:// TODO two"
	if got := strip(root, res.Lines); got != want {
		t.Errorf("after=2 merges adjacent groups:\n%s\nwant\n%s", got, want)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "hello|TODO one", OutputMode: "content", After: 1, Glob: "*.{go,ts}"})
	want = ".config/settings.ts:hello hidden\n--\na.go:func hello() {}\n--\nb.ts:// TODO one\nb.ts-const y = 2;"
	if got := strip(root, res.Lines); got != want {
		t.Errorf("context across files:\n%s\nwant\n%s", got, want)
	}
}

func TestMultilineAndFlags(t *testing.T) {
	s, root := setup(t)
	if res := grep(t, s, rpc.FsGrepParams{Pattern: "start.*end", OutputMode: "count"}); len(res.Counts) != 0 {
		t.Errorf("without multiline, '.' must not cross lines: %+v", res)
	}
	res := grep(t, s, rpc.FsGrepParams{Pattern: "start.*end", Multiline: true, OutputMode: "content", LineNumbers: true})
	if got := strip(root, res.Lines); got != "multi.txt:1:start\nmulti.txt:2:middle\nmulti.txt:3:end" {
		t.Errorf("multiline: %q", got)
	}
	// As in ripgrep without --crlf, "$" does not match before "\r"; output lines drop the "\r".
	res = grep(t, s, rpc.FsGrepParams{Pattern: "^beta", OutputMode: "content"})
	if got := strip(root, res.Lines); got != "crlf.txt:beta" {
		t.Errorf("CRLF line: %q", got)
	}
	if res := grep(t, s, rpc.FsGrepParams{Pattern: "beta$"}); len(res.Files) != 0 {
		t.Errorf(`"$" matched before "\r": %v`, res.Files)
	}
	if res := grep(t, s, rpc.FsGrepParams{Pattern: "HELLO"}); len(res.Files) != 0 {
		t.Errorf("case-sensitive by default: %v", res.Files)
	}
}

func TestFilters(t *testing.T) {
	s, root := setup(t)
	res := grep(t, s, rpc.FsGrepParams{Pattern: "hello", CaseInsensitive: true, Type: "go"})
	if got := strip(root, res.Files); got != "a.go" {
		t.Errorf("type go: %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "hello", CaseInsensitive: true, Type: "md"})
	if got := strip(root, res.Files); got != "docs/readme.md" {
		t.Errorf("type md: %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "hello", CaseInsensitive: true, Glob: "!*.go"})
	if got := strip(root, res.Files); got != ".config/settings.ts\ndocs/readme.md" {
		t.Errorf("negated glob: %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "hello", CaseInsensitive: true, Glob: "docs/*.md"})
	if got := strip(root, res.Files); got != "docs/readme.md" {
		t.Errorf("glob with a path: %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "Hello", Path: "vendor"})
	if got := strip(root, res.Files); got != "vendor/v.go" {
		t.Errorf("explicit ignored dir: %q", got)
	}
	res = grep(t, s, rpc.FsGrepParams{Pattern: "e", OutputMode: "content", HeadLimit: 2})
	if len(res.Lines) != 2 || !res.Truncated {
		t.Errorf("headLimit: %+v", res)
	}
}

func TestErrors(t *testing.T) {
	s, _ := setup(t)
	for _, p := range []rpc.FsGrepParams{
		{Pattern: "("},
		{Pattern: "x", Type: "cobol"},
		{Pattern: "x", OutputMode: "json"},
		{Pattern: "x", Path: ".."},
		{Pattern: "x", Path: "missing"},
	} {
		if _, err := Grep(context.Background(), s, p); err == nil {
			t.Errorf("%+v: no error", p)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Grep(ctx, s, rpc.FsGrepParams{Pattern: "x"}); err == nil {
		t.Error("cancelled grep succeeded")
	}
}

func TestLongLinesAreCut(t *testing.T) {
	s, root := setup(t)
	long := strings.Repeat("é", 3000) + "needle"
	if err := os.WriteFile(filepath.Join(root, "min.js"), []byte(long+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := grep(t, s, rpc.FsGrepParams{Pattern: "needle", Path: "min.js", OutputMode: "content"})
	if len(res.Lines) != 1 || len(res.Lines[0]) > maxLineBytes+10 || !strings.HasSuffix(res.Lines[0], "é [...]") {
		t.Errorf("long line: len=%d suffix=%q", len(res.Lines[0]), res.Lines[0][len(res.Lines[0])-12:])
	}
}
