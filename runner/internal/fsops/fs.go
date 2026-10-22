package fsops

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"

	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/walk"
)

const (
	maxReadBytes     = 16 << 20 // content returned by one fs.read
	maxListEntries   = 50_000
	maxAncestorBytes = 1 << 20
	binarySniffBytes = 8000 // git's heuristic: a NUL byte in the first 8000 bytes means binary
)

// FS implements the fs.* methods against a Scope.
type FS struct {
	Scope   *Scope
	writeMu sync.Mutex // serializes check-and-write so expectSha256 holds across concurrent writes
}

func (f *FS) Stat(_ context.Context, p rpc.FsStatParams) (rpc.FsStat, error) {
	path, err := f.Scope.Resolve(p.Path)
	if err != nil {
		return rpc.FsStat{}, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return rpc.FsStat{}, err
	}
	return rpc.FsStat{Path: path, Type: fileType(fi.Mode()), Size: fi.Size(), MtimeMs: fi.ModTime().UnixMilli(), Mode: uint32(fi.Mode().Perm())}, nil
}

func (f *FS) Read(ctx context.Context, p rpc.FsReadParams) (rpc.FsReadResult, error) {
	if p.Offset < 0 || p.Limit < 0 {
		return rpc.FsReadResult{}, rpc.InvalidParams("offset and limit must not be negative")
	}
	enc, err := encoding(p.Encoding)
	if err != nil {
		return rpc.FsReadResult{}, err
	}
	path, err := f.Scope.Resolve(p.Path)
	if err != nil {
		return rpc.FsReadResult{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return rpc.FsReadResult{}, err
	}
	defer file.Close()
	fi, err := file.Stat()
	if err != nil {
		return rpc.FsReadResult{}, err
	}
	if fi.IsDir() {
		return rpc.FsReadResult{}, rpc.IOError("EISDIR", "is a directory: "+path)
	}

	// One pass hashes the whole file, counts lines and copies out the requested window.
	h := sha256.New()
	var out bytes.Buffer
	var pos, line int64 // byte position and 0-based line index at the start of the current block
	var last byte
	binary, truncated := false, false
	buf := make([]byte, 64<<10)
	for {
		if ctx.Err() != nil {
			return rpc.FsReadResult{}, ctx.Err()
		}
		n, rerr := file.Read(buf)
		b := buf[:n]
		h.Write(b)
		if pos < binarySniffBytes && bytes.IndexByte(b[:min(int64(n), binarySniffBytes-pos)], 0) >= 0 {
			binary = true
		}
		if enc == "base64" {
			lo, hi := max(p.Offset-pos, 0), int64(n)
			if p.Limit > 0 {
				hi = min(hi, p.Offset+p.Limit-pos)
			}
			if lo < hi {
				take := b[lo:hi]
				if room := maxReadBytes - out.Len(); len(take) > room {
					take, truncated = take[:room], true
				}
				out.Write(take)
			}
			if p.Limit > 0 && pos+int64(n) > p.Offset+p.Limit {
				truncated = true
			}
			line += int64(bytes.Count(b, []byte{'\n'}))
		} else {
			for len(b) > 0 {
				seg := b
				if i := bytes.IndexByte(b, '\n'); i >= 0 {
					seg = b[:i+1]
				}
				inWindow := line >= p.Offset && (p.Limit == 0 || line < p.Offset+p.Limit)
				if inWindow && !truncated && !binary {
					if room := maxReadBytes - out.Len(); len(seg) > room {
						out.Write(seg[:rpc.CompleteUTF8(seg[:room])])
						truncated = true
					} else {
						out.Write(seg)
					}
				} else if p.Limit > 0 && line >= p.Offset+p.Limit {
					truncated = true
				}
				if seg[len(seg)-1] == '\n' {
					line++
				}
				b = b[len(seg):]
			}
		}
		if n > 0 {
			last = buf[n-1]
		}
		pos += int64(n)
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rpc.FsReadResult{}, rerr
		}
	}
	if pos > 0 && last != '\n' {
		line++
	}
	res := rpc.FsReadResult{Encoding: enc, Sha256: hex.EncodeToString(h.Sum(nil)), Size: pos, TotalLines: line, Truncated: truncated, Binary: binary}
	switch {
	case enc == "base64":
		res.Content = base64.StdEncoding.EncodeToString(out.Bytes())
	case !binary:
		res.Content = out.String()
	default:
		res.Truncated = false
	}
	return res, nil
}

func (f *FS) Write(_ context.Context, p rpc.FsWriteParams) (rpc.FsWriteResult, error) {
	enc, err := encoding(p.Encoding)
	if err != nil {
		return rpc.FsWriteResult{}, err
	}
	data := []byte(p.Content)
	if enc == "base64" {
		if data, err = base64.StdEncoding.DecodeString(p.Content); err != nil {
			return rpc.FsWriteResult{}, rpc.InvalidParams("content is not valid base64: %v", err)
		}
	}
	path, err := f.Scope.Resolve(p.Path)
	if err != nil {
		return rpc.FsWriteResult{}, err
	}

	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	mode := fs.FileMode(0o644)
	fi, err := os.Stat(path)
	exists := err == nil
	switch {
	case exists && fi.IsDir():
		return rpc.FsWriteResult{}, rpc.IOError("EISDIR", "is a directory: "+path)
	case exists:
		mode = fi.Mode().Perm()
	case !errors.Is(err, fs.ErrNotExist):
		return rpc.FsWriteResult{}, err
	}
	if p.ExpectSha256 != nil {
		actual := ""
		if exists {
			if actual, err = hashFile(path); err != nil {
				return rpc.FsWriteResult{}, err
			}
		}
		if actual != *p.ExpectSha256 {
			e := rpc.NewError(rpc.CodeConflict, "Conflict", "file changed since it was read: "+path)
			e.Data["actualSha256"] = nil
			if exists {
				e.Data["actualSha256"] = actual
			}
			return rpc.FsWriteResult{}, e
		}
	}
	dir := filepath.Dir(path)
	if p.Mkdirp {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return rpc.FsWriteResult{}, err
		}
	}
	if err := writeAtomic(path, data, mode); err != nil {
		return rpc.FsWriteResult{}, err
	}
	sum := sha256.Sum256(data)
	return rpc.FsWriteResult{Sha256: hex.EncodeToString(sum[:]), Created: !exists}, nil
}

// writeAtomic writes a sibling temp file and renames it over path.
func writeAtomic(path string, data []byte, mode fs.FileMode) error {
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".atelier-"+hex.EncodeToString(suffix[:])+".tmp")
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Chmod(mode) // the umask may have narrowed the mode passed to OpenFile
	}
	if err == nil {
		err = file.Sync()
	}
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (f *FS) List(ctx context.Context, p rpc.FsListParams) (rpc.FsListResult, error) {
	dir, err := f.Scope.ResolveDir(p.Path)
	if err != nil {
		return rpc.FsListResult{}, err
	}
	depth := p.Depth
	if depth <= 0 {
		depth = 1
	}
	var mu sync.Mutex
	res := rpc.FsListResult{Entries: []rpc.FsEntry{}}
	err = walk.Walk(ctx, dir, f.Scope.RootOf(dir), walk.Options{Ignore: p.RespectGitignore, MaxDepth: depth, Dirs: true}, func(e walk.Entry) bool {
		fi, err := e.Info()
		if err != nil {
			return true
		}
		entry := rpc.FsEntry{Path: e.Path, Name: e.Name(), Type: fileType(fi.Mode()), Size: fi.Size(), MtimeMs: fi.ModTime().UnixMilli()}
		mu.Lock()
		defer mu.Unlock()
		if len(res.Entries) >= maxListEntries {
			res.Truncated = true
			return false
		}
		res.Entries = append(res.Entries, entry)
		return true
	})
	if err != nil {
		return rpc.FsListResult{}, err
	}
	sort.Slice(res.Entries, func(i, j int) bool { return res.Entries[i].Path < res.Entries[j].Path })
	return res, nil
}

func (f *FS) Mkdir(_ context.Context, p rpc.FsMkdirParams) (any, error) {
	path, err := f.Scope.Resolve(p.Path)
	if err != nil {
		return nil, err
	}
	if p.Recursive {
		return nil, os.MkdirAll(path, 0o755)
	}
	return nil, os.Mkdir(path, 0o755)
}

func (f *FS) Remove(_ context.Context, p rpc.FsRemoveParams) (any, error) {
	path, err := f.Scope.ResolveEntry(p.Path)
	if err != nil {
		return nil, err
	}
	if f.Scope.IsRoot(path) {
		return nil, rpc.IOError("EPERM", "refusing to remove a workspace root: "+path)
	}
	if _, err := os.Lstat(path); err != nil {
		return nil, err
	}
	if p.Recursive {
		return nil, os.RemoveAll(path)
	}
	return nil, os.Remove(path)
}

func (f *FS) Rename(_ context.Context, p rpc.FsRenameParams) (any, error) {
	from, err := f.Scope.ResolveEntry(p.From)
	if err != nil {
		return nil, err
	}
	to, err := f.Scope.ResolveEntry(p.To)
	if err != nil {
		return nil, err
	}
	if f.Scope.IsRoot(from) {
		return nil, rpc.IOError("EPERM", "refusing to rename a workspace root: "+from)
	}
	src, err := os.Lstat(from)
	if err != nil {
		return nil, err
	}
	// A case-only rename on a case-insensitive filesystem finds the source at the destination.
	if dst, err := os.Lstat(to); err == nil && !p.Overwrite && !os.SameFile(src, dst) {
		return nil, rpc.IOError("EEXIST", "destination exists: "+to)
	}
	return nil, os.Rename(from, to)
}

// instructionFiles are the only names fs.readAncestors reads, and the only files readable above a root.
var instructionFiles = []string{"CLAUDE.md", "AGENTS.md", "ATELIER.md", "CLAUDE.local.md", filepath.Join(".claude", "CLAUDE.md")}

func (f *FS) ReadAncestors(_ context.Context, p rpc.FsReadAncestorsParams) (rpc.FsReadAncestorsResult, error) {
	names := instructionFiles
	if len(p.Names) > 0 {
		names = nil
		for _, n := range p.Names {
			n = filepath.FromSlash(n)
			if !slices.Contains(instructionFiles, n) {
				return rpc.FsReadAncestorsResult{}, rpc.InvalidParams("not an instruction file name: %s", n)
			}
			names = append(names, n)
		}
	}
	dir, err := f.Scope.Resolve(p.From)
	if err != nil {
		return rpc.FsReadAncestorsResult{}, err
	}
	if fi, err := os.Stat(dir); err == nil && !fi.IsDir() {
		dir = filepath.Dir(dir)
	}
	found := []rpc.FsAncestorFile{} // never null in JSON
	for {
		for i := len(names) - 1; i >= 0; i-- { // reversed below, so files come out in the given order
			path := filepath.Join(dir, names[i])
			if content, ok := readInstructionFile(path); ok {
				found = append(found, rpc.FsAncestorFile{Path: path, Content: content})
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	slices.Reverse(found)
	return rpc.FsReadAncestorsResult{Files: found}, nil
}

// readInstructionFile reads a regular file, or a symlink to a regular file that itself carries an
// instruction file name (CLAUDE.md -> AGENTS.md), so a link cannot expose arbitrary files.
func readInstructionFile(path string) (string, bool) {
	fi, err := os.Lstat(path)
	if err != nil {
		return "", false
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(path)
		if err != nil || !slices.ContainsFunc(instructionFiles, func(n string) bool { return filepath.Base(n) == filepath.Base(target) }) {
			return "", false
		}
		if fi, err = os.Stat(target); err != nil {
			return "", false
		}
	}
	if !fi.Mode().IsRegular() {
		return "", false
	}
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxAncestorBytes))
	if err != nil {
		return "", false
	}
	return string(data[:rpc.CompleteUTF8(data)]), true
}

func encoding(e string) (string, error) {
	switch e {
	case "", "utf8":
		return "utf8", nil
	case "base64":
		return "base64", nil
	}
	return "", rpc.InvalidParams("unknown encoding %q", e)
}

func fileType(m fs.FileMode) string {
	switch {
	case m.IsRegular():
		return "file"
	case m.IsDir():
		return "dir"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	}
	return "other"
}
