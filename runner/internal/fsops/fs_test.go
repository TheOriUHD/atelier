package fsops

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"atelier.dev/runner/internal/rpc"
)

var ctx = context.Background()

func newFS(t *testing.T) (*FS, string) {
	t.Helper()
	root := tempDir(t)
	return &FS{Scope: mustScope(t, root)}, root
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func errCode(err error) (int, string) {
	var e *rpc.Error
	if !errors.As(rpc.FromError(err), &e) {
		return 0, ""
	}
	name, _ := e.Data["code"].(string)
	return e.Code, name
}

func TestReadLines(t *testing.T) {
	f, root := newFS(t)
	content := "one\ntwo\nthree\nfour\nfive"
	write(t, filepath.Join(root, "f.txt"), content)
	cases := []struct {
		offset, limit int64
		want          string
		truncated     bool
	}{
		{0, 0, content, false},
		{0, 2, "one\ntwo\n", true},
		{1, 2, "two\nthree\n", true},
		{3, 5, "four\nfive", false},
		{4, 1, "five", false},
		{9, 1, "", false},
	}
	for _, c := range cases {
		res, err := f.Read(ctx, rpc.FsReadParams{Path: "f.txt", Offset: c.offset, Limit: c.limit})
		if err != nil {
			t.Fatal(err)
		}
		if res.Content != c.want || res.Truncated != c.truncated || res.TotalLines != 5 || res.Sha256 != sum(content) || res.Binary {
			t.Errorf("offset=%d limit=%d: got %+v", c.offset, c.limit, res)
		}
	}
	write(t, filepath.Join(root, "nl.txt"), "a\nb\n")
	if res, _ := f.Read(ctx, rpc.FsReadParams{Path: "nl.txt"}); res.TotalLines != 2 {
		t.Errorf("trailing newline: totalLines = %d, want 2", res.TotalLines)
	}
	write(t, filepath.Join(root, "empty.txt"), "")
	if res, _ := f.Read(ctx, rpc.FsReadParams{Path: "empty.txt"}); res.TotalLines != 0 || res.Content != "" {
		t.Errorf("empty file: %+v", res)
	}
}

func TestReadLongLinesAcrossBlocks(t *testing.T) {
	f, root := newFS(t)
	long := strings.Repeat("x", 200_000)
	write(t, filepath.Join(root, "long.txt"), "a\n"+long+"\nb\n")
	res, err := f.Read(ctx, rpc.FsReadParams{Path: "long.txt", Offset: 1, Limit: 1})
	if err != nil || res.Content != long+"\n" || res.TotalLines != 3 || !res.Truncated {
		t.Fatalf("got len=%d totalLines=%d truncated=%v err=%v", len(res.Content), res.TotalLines, res.Truncated, err)
	}
}

func TestReadBinaryAndBase64(t *testing.T) {
	f, root := newFS(t)
	data := []byte{0x89, 'P', 'N', 'G', 0, 1, 2, '\n', 3}
	if err := os.WriteFile(filepath.Join(root, "img.png"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := f.Read(ctx, rpc.FsReadParams{Path: "img.png"})
	if err != nil || !res.Binary || res.Content != "" || res.Size != int64(len(data)) {
		t.Fatalf("utf8 read of binary: %+v, %v", res, err)
	}
	res, err = f.Read(ctx, rpc.FsReadParams{Path: "img.png", Encoding: "base64"})
	if err != nil || res.Content != base64.StdEncoding.EncodeToString(data) || res.Truncated {
		t.Fatalf("base64 read: %+v, %v", res, err)
	}
	res, err = f.Read(ctx, rpc.FsReadParams{Path: "img.png", Encoding: "base64", Offset: 1, Limit: 3})
	if err != nil || res.Content != base64.StdEncoding.EncodeToString(data[1:4]) || !res.Truncated {
		t.Fatalf("base64 window: %+v, %v", res, err)
	}
	if _, err := f.Read(ctx, rpc.FsReadParams{Path: "img.png", Encoding: "latin1"}); err == nil {
		t.Error("unknown encoding accepted")
	}
}

func TestReadErrors(t *testing.T) {
	f, root := newFS(t)
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, rpc.FsReadParams{Path: "missing.txt"}); !matches(err, rpc.CodeIO, "ENOENT") {
		t.Errorf("missing file: %v", err)
	}
	if _, err := f.Read(ctx, rpc.FsReadParams{Path: "dir"}); !matches(err, rpc.CodeIO, "EISDIR") {
		t.Errorf("directory: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	write(t, filepath.Join(root, "f.txt"), "x")
	if _, err := f.Read(cancelled, rpc.FsReadParams{Path: "f.txt"}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled read: %v", err)
	}
}

func matches(err error, code int, name string) bool {
	c, n := errCode(err)
	return c == code && n == name
}

func TestWriteAndConflict(t *testing.T) {
	f, root := newFS(t)
	res, err := f.Write(ctx, rpc.FsWriteParams{Path: "a/b/new.txt", Content: "hello", Mkdirp: true})
	if err != nil || res.Sha256 != sum("hello") || !res.Created {
		t.Fatalf("create: %+v, %v", res, err)
	}
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "x/y.txt", Content: "no parent"}); !matches(err, rpc.CodeIO, "ENOENT") {
		t.Errorf("write without mkdirp into a missing dir: %v", err)
	}

	stale := sum("hello")
	res, err = f.Write(ctx, rpc.FsWriteParams{Path: "a/b/new.txt", Content: "v2", ExpectSha256: &stale})
	if err != nil || res.Created {
		t.Fatalf("write with matching hash: %+v, %v", res, err)
	}
	_, err = f.Write(ctx, rpc.FsWriteParams{Path: "a/b/new.txt", Content: "v3", ExpectSha256: &stale})
	var e *rpc.Error
	if !errors.As(err, &e) || e.Code != rpc.CodeConflict || e.Data["actualSha256"] != sum("v2") {
		t.Fatalf("stale hash: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a", "b", "new.txt")); string(got) != "v2" {
		t.Fatalf("conflicting write changed the file: %q", got)
	}
	absent := ""
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "a/b/new.txt", Content: "x", ExpectSha256: &absent}); !matches(err, rpc.CodeConflict, "Conflict") {
		t.Errorf(`expectSha256 "" on an existing file: %v`, err)
	}
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "fresh.txt", Content: "x", ExpectSha256: &absent}); err != nil {
		t.Errorf(`expectSha256 "" on a new file: %v`, err)
	}
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "missing.txt", Content: "x", ExpectSha256: &stale}); !matches(err, rpc.CodeConflict, "Conflict") {
		t.Errorf("expected hash on a missing file: %v", err)
	}

	bin := []byte{0, 1, 2, 255}
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "bin.dat", Content: base64.StdEncoding.EncodeToString(bin), Encoding: "base64"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "bin.dat")); string(got) != string(bin) {
		t.Errorf("base64 write: %v", got)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "a", "b"))
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestWritePreservesModeAndFollowsLinksInside(t *testing.T) {
	f, root := newFS(t)
	path := filepath.Join(root, "run.sh")
	write(t, path, "#!/bin/sh\n")
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "run.sh", Content: "#!/bin/sh\necho hi\n"}); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o755 && os.PathSeparator == '/' {
		t.Errorf("mode = %v, want 0755", fi.Mode().Perm())
	}
	symlinkOrSkip(t, path, filepath.Join(root, "link.sh"))
	if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "link.sh", Content: "via link"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "via link" {
		t.Errorf("write through an in-root link: %q", got)
	}
	if fi, _ := os.Lstat(filepath.Join(root, "link.sh")); fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the link was replaced by a file")
	}
}

func TestConcurrentWritesWithExpectedHash(t *testing.T) {
	f, root := newFS(t)
	write(t, filepath.Join(root, "f.txt"), "base")
	expect := sum("base")
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.Write(ctx, rpc.FsWriteParams{Path: "f.txt", Content: strings.Repeat("x", i+1), ExpectSha256: &expect}); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("%d writers won with the same expected hash, want 1", wins)
	}
}

func TestStatListMkdirRemoveRename(t *testing.T) {
	f, root := newFS(t)
	write(t, filepath.Join(root, ".gitignore"), "ignored/\n*.log\n")
	write(t, filepath.Join(root, "src", "a.ts"), "a")
	write(t, filepath.Join(root, "src", "deep", "b.ts"), "b")
	write(t, filepath.Join(root, "ignored", "c.ts"), "c")
	write(t, filepath.Join(root, "debug.log"), "d")
	write(t, filepath.Join(root, ".git", "HEAD"), "ref")

	st, err := f.Stat(ctx, rpc.FsStatParams{Path: "src/a.ts"})
	if err != nil || st.Type != "file" || st.Size != 1 || st.Path != filepath.Join(root, "src", "a.ts") {
		t.Fatalf("stat: %+v, %v", st, err)
	}
	if st, _ := f.Stat(ctx, rpc.FsStatParams{Path: "src"}); st.Type != "dir" {
		t.Errorf("stat dir: %+v", st)
	}

	names := func(res rpc.FsListResult) string {
		var out []string
		for _, e := range res.Entries {
			rel, _ := filepath.Rel(root, e.Path)
			out = append(out, filepath.ToSlash(rel)+":"+e.Type)
		}
		return strings.Join(out, " ")
	}
	res, err := f.List(ctx, rpc.FsListParams{Path: "", Depth: 1, RespectGitignore: true})
	if err != nil || names(res) != ".gitignore:file src:dir" {
		t.Errorf("list depth 1 = %q, %v", names(res), err)
	}
	res, _ = f.List(ctx, rpc.FsListParams{Depth: 3, RespectGitignore: true})
	if names(res) != ".gitignore:file src:dir src/a.ts:file src/deep:dir src/deep/b.ts:file" {
		t.Errorf("list depth 3 = %q", names(res))
	}
	res, _ = f.List(ctx, rpc.FsListParams{Depth: 1})
	if names(res) != ".gitignore:file debug.log:file ignored:dir src:dir" {
		t.Errorf("list without gitignore = %q", names(res))
	}

	if _, err := f.Mkdir(ctx, rpc.FsMkdirParams{Path: "m/n"}); !matches(err, rpc.CodeIO, "ENOENT") {
		t.Errorf("non-recursive mkdir of nested dir: %v", err)
	}
	if _, err := f.Mkdir(ctx, rpc.FsMkdirParams{Path: "m/n", Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Mkdir(ctx, rpc.FsMkdirParams{Path: "m"}); !matches(err, rpc.CodeIO, "EEXIST") {
		t.Errorf("mkdir existing: %v", err)
	}

	if _, err := f.Rename(ctx, rpc.FsRenameParams{From: "src/a.ts", To: "src/deep/b.ts"}); !matches(err, rpc.CodeIO, "EEXIST") {
		t.Errorf("rename onto existing without overwrite: %v", err)
	}
	if _, err := f.Rename(ctx, rpc.FsRenameParams{From: "src/a.ts", To: "src/deep/b.ts", Overwrite: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "src", "deep", "b.ts")); string(got) != "a" {
		t.Errorf("rename overwrite: %q", got)
	}
	if _, err := f.Rename(ctx, rpc.FsRenameParams{From: "src/deep/b.ts", To: "src/deep/B.ts"}); err != nil {
		t.Errorf("case-only rename: %v", err)
	}

	if _, err := f.Remove(ctx, rpc.FsRemoveParams{Path: "src"}); !matches(err, rpc.CodeIO, "ENOTEMPTY") {
		t.Errorf("non-recursive remove of non-empty dir: %v", err)
	}
	if _, err := f.Remove(ctx, rpc.FsRemoveParams{Path: "src", Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Remove(ctx, rpc.FsRemoveParams{Path: "src"}); !matches(err, rpc.CodeIO, "ENOENT") {
		t.Errorf("remove missing: %v", err)
	}
	if _, err := f.Remove(ctx, rpc.FsRemoveParams{Path: root, Recursive: true}); !matches(err, rpc.CodeIO, "EPERM") {
		t.Errorf("remove root: %v", err)
	}
	if _, err := f.Rename(ctx, rpc.FsRenameParams{From: "debug.log", To: "../escaped.log"}); !isOutside(err) {
		t.Errorf("rename out of the root: %v", err)
	}
}

func TestRemoveSymlinkRemovesLinkOnly(t *testing.T) {
	base := tempDir(t)
	root, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	write(t, filepath.Join(outside, "keep.txt"), "keep")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, outside, filepath.Join(root, "link"))
	f := &FS{Scope: mustScope(t, root)}
	if _, err := f.Remove(ctx, rpc.FsRemoveParams{Path: "link", Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep.txt")); err != nil {
		t.Fatalf("removing a link deleted its target: %v", err)
	}
}

func TestReadAncestors(t *testing.T) {
	base := tempDir(t)
	root := filepath.Join(base, "work", "repo")
	write(t, filepath.Join(base, "CLAUDE.md"), "top")
	write(t, filepath.Join(base, "secret.txt"), "nope")
	write(t, filepath.Join(base, "work", "AGENTS.md"), "agents")
	write(t, filepath.Join(base, "work", ".claude", "CLAUDE.md"), "dot-claude")
	write(t, filepath.Join(root, "CLAUDE.md"), "repo")
	write(t, filepath.Join(root, "ATELIER.md"), "atelier")
	write(t, filepath.Join(root, "CLAUDE.local.md"), "local")
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, filepath.Join(base, "secret.txt"), filepath.Join(base, "work", "CLAUDE.md")) // must not be read
	symlinkOrSkip(t, filepath.Join(root, "CLAUDE.md"), filepath.Join(root, "sub", "AGENTS.md"))   // allowed alias
	f := &FS{Scope: mustScope(t, root)}

	res, err := f.ReadAncestors(ctx, rpc.FsReadAncestorsParams{From: "sub"})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, file := range res.Files {
		if !strings.HasPrefix(file.Path, base) {
			continue // instruction files above the temp dir belong to the machine, not the test
		}
		rel, _ := filepath.Rel(base, file.Path)
		got = append(got, filepath.ToSlash(rel)+"="+file.Content)
	}
	want := "CLAUDE.md=top work/AGENTS.md=agents work/.claude/CLAUDE.md=dot-claude work/repo/CLAUDE.md=repo work/repo/ATELIER.md=atelier work/repo/CLAUDE.local.md=local work/repo/sub/AGENTS.md=repo"
	if strings.Join(got, " ") != want {
		t.Errorf("got  %s\nwant %s", strings.Join(got, " "), want)
	}
	if _, err := f.ReadAncestors(ctx, rpc.FsReadAncestorsParams{From: "sub", Names: []string{"secret.txt"}}); err == nil {
		t.Error("arbitrary names accepted")
	}
	if _, err := f.ReadAncestors(ctx, rpc.FsReadAncestorsParams{From: base}); !isOutside(err) {
		t.Errorf("from outside the root: %v", err)
	}
	if _, err := f.Read(ctx, rpc.FsReadParams{Path: filepath.Join(base, "CLAUDE.md")}); !isOutside(err) {
		t.Errorf("fs.read above the root: %v", err)
	}
}
