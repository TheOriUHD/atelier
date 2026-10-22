// Package glob implements fs.glob: doublestar patterns over a gitignore-aware walk, newest first.
package glob

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/bmatcuk/doublestar/v4"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/walk"
)

const defaultLimit = 100

func Glob(ctx context.Context, scope *fsops.Scope, p rpc.FsGlobParams) (rpc.FsGlobResult, error) {
	pattern := filepath.ToSlash(p.Pattern)
	if pattern == "" || !doublestar.ValidatePattern(pattern) {
		return rpc.FsGlobResult{}, rpc.InvalidParams("invalid glob pattern %q", p.Pattern)
	}
	cwd, err := scope.ResolveDir(p.Cwd)
	if err != nil {
		return rpc.FsGlobResult{}, err
	}
	// Walk only below the pattern's literal prefix ("src/**/*.ts" walks src).
	base, rest := doublestar.SplitPattern(pattern)
	start := filepath.FromSlash(base)
	if !filepath.IsAbs(start) {
		start = filepath.Join(cwd, start)
	}
	res := rpc.FsGlobResult{Files: []string{}}
	start, err = scope.ResolveDir(start)
	if errors.Is(err, fs.ErrNotExist) {
		return res, nil
	}
	if err != nil {
		return rpc.FsGlobResult{}, err
	}
	depth := 0
	if !strings.Contains(rest, "**") {
		depth = strings.Count(rest, "/") + 1
	}

	type match struct {
		path  string
		mtime int64
	}
	var mu sync.Mutex
	var matches []match
	err = walk.Walk(ctx, start, scope.RootOf(start), walk.Options{Ignore: true, MaxDepth: depth}, func(e walk.Entry) bool {
		if !e.Type().IsRegular() {
			return true
		}
		if ok, _ := doublestar.Match(rest, e.Rel); !ok {
			return true
		}
		fi, err := e.Info()
		if err != nil {
			return true
		}
		mu.Lock()
		matches = append(matches, match{e.Path, fi.ModTime().UnixNano()})
		mu.Unlock()
		return true
	})
	if err != nil {
		return rpc.FsGlobResult{}, err
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].mtime != matches[j].mtime {
			return matches[i].mtime > matches[j].mtime
		}
		return matches[i].path < matches[j].path
	})
	limit := p.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if len(matches) > limit {
		matches, res.Truncated = matches[:limit], true
	}
	for _, m := range matches {
		res.Files = append(res.Files, m.path)
	}
	return res, nil
}
