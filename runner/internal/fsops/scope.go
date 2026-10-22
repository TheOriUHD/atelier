// Package fsops implements path scoping and the fs.* methods.
package fsops

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode"

	"atelier.dev/runner/internal/rpc"
)

// Scope is the set of directories the runner may touch. Every client path goes through Resolve.
type Scope struct {
	mu    sync.RWMutex
	roots []root
}

type root struct {
	path string
	fold bool // the root's filesystem is case-insensitive
}

func NewScope(paths ...string) (*Scope, error) {
	s := &Scope{}
	for _, p := range paths {
		if _, err := s.Add(p); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Add makes an existing directory a root and returns its resolved path.
func (s *Scope) Add(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", rpc.IOError("ENOTDIR", "root is not a directory: "+real)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.roots {
		if r.path == real {
			return real, nil
		}
	}
	s.roots = append(s.roots, root{path: real, fold: caseInsensitive(real)})
	return real, nil
}

func (s *Scope) Roots() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, len(s.roots))
	for i, r := range s.roots {
		out[i] = r.path
	}
	return out
}

// Primary is the first root; relative paths resolve against it.
func (s *Scope) Primary() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.roots[0].path
}

// Resolve makes p absolute, cleans it, resolves symlinks in its existing prefix (including a final
// symlink) and checks that the result lies under a root.
func (s *Scope) Resolve(p string) (string, error) {
	real, err := realpath(s.abs(p), 0)
	if err != nil {
		return "", err
	}
	return s.check(real)
}

// ResolveEntry is Resolve for operations on a directory entry itself (remove, rename): the parent
// is resolved, the final component is kept as is, so a symlink is acted on rather than followed.
func (s *Scope) ResolveEntry(p string) (string, error) {
	abs := s.abs(p)
	dir, base := filepath.Dir(abs), filepath.Base(abs)
	if dir == abs {
		return s.Resolve(abs)
	}
	realDir, err := realpath(dir, 0)
	if err != nil {
		return "", err
	}
	return s.check(filepath.Join(realDir, base))
}

// ResolveDir is Resolve plus a check that the path is an existing directory.
func (s *Scope) ResolveDir(p string) (string, error) {
	real, err := s.Resolve(p)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", rpc.IOError("ENOTDIR", "not a directory: "+real)
	}
	return real, nil
}

// IsRoot reports whether the resolved path p is itself a root.
func (s *Scope) IsRoot(p string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.roots {
		if len(p) == len(r.path) && within(r, p) {
			return true
		}
	}
	return false
}

// RootOf returns the outermost root containing the resolved path p.
func (s *Scope) RootOf(p string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	best := ""
	for _, r := range s.roots {
		if within(r, p) && (best == "" || len(r.path) < len(best)) {
			best = r.path
		}
	}
	return best
}

func (s *Scope) abs(p string) string {
	if p == "" {
		return s.Primary()
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(s.Primary(), p)
	}
	return filepath.Clean(p)
}

// check returns p with the root prefix in the root's own spelling, or PathOutsideWorkspace.
func (s *Scope) check(p string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.roots {
		if within(r, p) {
			return r.path + p[len(r.path):], nil
		}
	}
	err := rpc.NewError(rpc.CodePathOutsideWorkspace, "PathOutsideWorkspace", "path is outside the workspace: "+p)
	err.Data["path"] = p
	return "", err
}

func within(r root, p string) bool {
	if len(p) < len(r.path) {
		return false
	}
	prefix := p[:len(r.path)]
	if prefix != r.path && !(r.fold && strings.EqualFold(prefix, r.path)) {
		return false
	}
	return len(p) == len(r.path) || os.IsPathSeparator(p[len(r.path)]) || os.IsPathSeparator(r.path[len(r.path)-1])
}

// caseInsensitive probes whether dir's filesystem ignores case by stat-ing a case-flipped spelling.
func caseInsensitive(dir string) bool {
	flipped := strings.Map(func(r rune) rune {
		if unicode.IsUpper(r) {
			return unicode.ToLower(r)
		}
		return unicode.ToUpper(r)
	}, dir)
	if flipped == dir {
		return false
	}
	a, err := os.Stat(dir)
	if err != nil {
		return false
	}
	b, err := os.Stat(flipped)
	return err == nil && os.SameFile(a, b)
}

// realpath resolves symlinks in the longest existing prefix of the clean absolute path p and
// appends the rest. A dangling symlink is followed to where it points, so writing through it
// cannot escape a root unnoticed.
func realpath(p string, depth int) (string, error) {
	if depth > 40 {
		return "", &fs.PathError{Op: "resolve", Path: p, Err: syscall.ELOOP}
	}
	cur, rest := p, []string(nil)
	for {
		fi, err := os.Lstat(cur)
		if err == nil {
			real, err := filepath.EvalSymlinks(cur)
			if err == nil {
				return filepath.Join(append([]string{real}, rest...)...), nil
			}
			if fi.Mode()&fs.ModeSymlink == 0 || !errors.Is(err, fs.ErrNotExist) {
				return "", err
			}
			target, err := os.Readlink(cur)
			if err != nil {
				return "", err
			}
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(cur), target)
			}
			return realpath(filepath.Join(append([]string{target}, rest...)...), depth+1)
		}
		if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) {
			return "", err
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p, nil
		}
		rest = append([]string{filepath.Base(cur)}, rest...)
		cur = parent
	}
}
