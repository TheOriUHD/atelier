// Package walk is a parallel, gitignore-aware directory walker with ripgrep's defaults: .gitignore,
// .ignore, .git/info/exclude and the global excludes file apply (including those in parent
// directories of the start, up to the scope root), symlinks are reported but never followed, and
// VCS metadata directories are skipped. Hidden files are included.
package walk

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
)

type Options struct {
	Ignore   bool // honor ignore files
	MaxDepth int  // 0 = unlimited, 1 = direct children only
	Dirs     bool // visit directories too, not only files and symlinks
}

// Entry is one visited directory entry.
type Entry struct {
	fs.DirEntry
	Path  string // absolute
	Rel   string // slash-separated, relative to the walk start
	Depth int    // 1 for direct children of the start
}

var vcsDirs = map[string]bool{".git": true, ".hg": true, ".svn": true, ".jj": true, ".sl": true, ".bzr": true}

// Walk visits every entry below start. visit runs concurrently from several goroutines and returns
// false to stop the walk. top bounds how far up parent ignore files are read (the scope root).
func Walk(ctx context.Context, start, top string, opt Options, visit func(Entry) bool) error {
	first := job{dir: start}
	if opt.Ignore {
		base, patterns := parentPatterns(start, top)
		first.comps = components(base, start)
		if len(first.comps) > 0 && gitignore.NewMatcher(patterns).Match(first.comps, true) {
			// The start was asked for explicitly, so only rules found below it and the global excludes apply.
			patterns = globalPatterns()
		}
		first.patterns = patterns
	}
	w := &walker{ctx: ctx, opt: opt, visit: visit, queue: []job{first}}
	w.cond = sync.NewCond(&w.mu)
	n := runtime.GOMAXPROCS(0)
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.work()
		}()
	}
	wg.Wait()
	return ctx.Err()
}

type job struct {
	dir      string
	rel      string
	comps    []string // path components relative to the ignore base, for pattern matching
	depth    int
	patterns []gitignore.Pattern
}

type walker struct {
	ctx   context.Context
	opt   Options
	visit func(Entry) bool

	mu      sync.Mutex
	cond    *sync.Cond
	queue   []job
	active  int
	stopped bool
}

func (w *walker) work() {
	for {
		w.mu.Lock()
		for len(w.queue) == 0 && w.active > 0 && !w.stopped {
			w.cond.Wait()
		}
		if w.stopped || len(w.queue) == 0 {
			w.mu.Unlock()
			return
		}
		j := w.queue[len(w.queue)-1]
		w.queue = w.queue[:len(w.queue)-1]
		w.active++
		w.mu.Unlock()

		children, ok := w.process(j)

		w.mu.Lock()
		w.active--
		if ok {
			w.queue = append(w.queue, children...)
		} else {
			w.stopped = true
		}
		w.cond.Broadcast()
		w.mu.Unlock()
	}
}

// process visits one directory's entries and returns its subdirectories to walk.
func (w *walker) process(j job) ([]job, bool) {
	if w.ctx.Err() != nil {
		return nil, false
	}
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil, true
	}
	patterns := j.patterns
	if w.opt.Ignore {
		for _, e := range entries {
			if name := e.Name(); (name == ".gitignore" || name == ".ignore") && e.Type().IsRegular() {
				patterns = append(patterns[:len(patterns):len(patterns)], readPatterns(filepath.Join(j.dir, name), j.comps)...)
			}
		}
	}
	matcher := gitignore.NewMatcher(patterns)
	var subdirs []job
	for i, e := range entries {
		if i%64 == 63 && w.ctx.Err() != nil {
			return nil, false
		}
		name := e.Name()
		isDir := e.IsDir()
		if vcsDirs[name] {
			continue
		}
		comps := append(j.comps[:len(j.comps):len(j.comps)], name)
		if len(patterns) > 0 && matcher.Match(comps, isDir) {
			continue
		}
		rel := name
		if j.rel != "" {
			rel = j.rel + "/" + name
		}
		entry := Entry{DirEntry: e, Path: filepath.Join(j.dir, name), Rel: rel, Depth: j.depth + 1}
		if (!isDir || w.opt.Dirs) && !w.visit(entry) {
			return nil, false
		}
		if isDir && (w.opt.MaxDepth == 0 || entry.Depth < w.opt.MaxDepth) {
			subdirs = append(subdirs, job{dir: entry.Path, rel: rel, comps: comps, depth: entry.Depth, patterns: patterns})
		}
	}
	return subdirs, true
}

// components splits the part of p below base into path components.
func components(base, p string) []string {
	rel, err := filepath.Rel(base, p)
	if err != nil || rel == "." {
		return nil
	}
	return strings.Split(filepath.ToSlash(rel), "/")
}
