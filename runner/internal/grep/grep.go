// Package grep implements fs.grep: RE2 search with ripgrep's flags, defaults and output formats,
// searching files in parallel over a gitignore-aware walk.
package grep

import (
	"bytes"
	"context"
	"os"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/bmatcuk/doublestar/v4"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/walk"
)

const (
	maxFileBytes   = 64 << 20 // larger files are skipped
	maxLineBytes   = 2000     // longer output lines are cut
	maxOutputBytes = 16 << 20 // content mode stops collecting beyond this
)

type fileResult struct {
	path  string
	mtime int64
	count int      // matching lines
	lines []string // formatted output, content mode only
}

func Grep(ctx context.Context, scope *fsops.Scope, p rpc.FsGrepParams) (rpc.FsGrepResult, error) {
	mode := p.OutputMode
	if mode == "" {
		mode = "files"
	}
	if mode != "files" && mode != "content" && mode != "count" {
		return rpc.FsGrepResult{}, rpc.InvalidParams("unknown outputMode %q", p.OutputMode)
	}
	if p.Before < 0 || p.After < 0 || p.HeadLimit < 0 {
		return rpc.FsGrepResult{}, rpc.InvalidParams("before, after and headLimit must not be negative")
	}
	flags := "m"
	if p.CaseInsensitive {
		flags += "i"
	}
	if p.Multiline {
		flags += "s"
	}
	re, err := regexp.Compile("(?" + flags + ")" + p.Pattern)
	if err != nil {
		return rpc.FsGrepResult{}, rpc.InvalidParams("invalid regex: %v", err)
	}
	filter, err := newFilter(p.Glob, p.Type)
	if err != nil {
		return rpc.FsGrepResult{}, err
	}
	target, err := scope.Resolve(p.Path)
	if err != nil {
		return rpc.FsGrepResult{}, err
	}
	fi, err := os.Stat(target)
	if err != nil {
		return rpc.FsGrepResult{}, err
	}

	s := &searcher{re: re, p: p, mode: mode}
	if !fi.IsDir() {
		// An explicitly named file is always searched and, as in ripgrep, printed without its name.
		s.search(target, false)
	} else {
		err = walk.Walk(ctx, target, scope.RootOf(target), walk.Options{Ignore: true}, func(e walk.Entry) bool {
			if e.Type().IsRegular() && filter.match(e.Rel) {
				s.search(e.Path, true)
			}
			return s.outputBytes.Load() < maxOutputBytes
		})
		if err != nil {
			return rpc.FsGrepResult{}, err
		}
	}
	return s.result(), nil
}

type searcher struct {
	re          *regexp.Regexp
	p           rpc.FsGrepParams
	mode        string
	outputBytes atomic.Int64

	mu      sync.Mutex
	results []fileResult
}

func (s *searcher) search(file string, withName bool) {
	fi, err := os.Stat(file)
	if err != nil || fi.Size() > maxFileBytes {
		return
	}
	data, err := os.ReadFile(file)
	if err != nil || bytes.IndexByte(data, 0) >= 0 || !s.re.Match(data) {
		return
	}
	lines := splitLines(data)
	matched := make([]bool, len(lines))
	count := 0
	if s.p.Multiline {
		starts := make([]int, len(lines))
		off := 0
		for i, l := range lines {
			starts[i] = off
			off += len(l)
		}
		lineOf := func(o int) int { return sort.SearchInts(starts, o+1) - 1 }
		for _, m := range s.re.FindAllIndex(data, -1) {
			last := lineOf(max(m[0], m[1]-1))
			for i := lineOf(m[0]); i <= last && i < len(lines); i++ {
				if !matched[i] {
					matched[i] = true
					count++
				}
			}
		}
	} else {
		for i, l := range lines {
			if s.re.Match(bytes.TrimSuffix(l, []byte{'\n'})) {
				matched[i] = true
				count++
			}
		}
	}
	if count == 0 {
		return
	}
	r := fileResult{path: file, mtime: fi.ModTime().UnixNano(), count: count}
	if s.mode == "content" {
		r.lines = s.format(file, withName, lines, matched)
		n := 0
		for _, l := range r.lines {
			n += len(l) + 1
		}
		s.outputBytes.Add(int64(n))
	}
	s.mu.Lock()
	s.results = append(s.results, r)
	s.mu.Unlock()
}

// format renders ripgrep's output: "path:12:text" for matches, "path-11-text" for context lines,
// and "--" between non-adjacent groups when context is requested.
func (s *searcher) format(file string, withName bool, lines [][]byte, matched []bool) []string {
	show := make([]bool, len(lines))
	for i, m := range matched {
		if m {
			for j := max(0, i-s.p.Before); j <= min(len(lines)-1, i+s.p.After); j++ {
				show[j] = true
			}
		}
	}
	var out []string
	prev := -2
	for i, l := range lines {
		if !show[i] {
			continue
		}
		if (s.p.Before > 0 || s.p.After > 0) && prev >= 0 && i != prev+1 {
			out = append(out, "--")
		}
		prev = i
		sep := "-"
		if matched[i] {
			sep = ":"
		}
		var b strings.Builder
		if withName {
			b.WriteString(file)
			b.WriteString(sep)
		}
		if s.p.LineNumbers {
			b.WriteString(strconv.Itoa(i + 1))
			b.WriteString(sep)
		}
		text := trimEOL(l)
		if len(text) > maxLineBytes {
			b.Write(text[:rpc.CompleteUTF8(text[:maxLineBytes])])
			b.WriteString(" [...]")
		} else {
			b.Write(text)
		}
		out = append(out, b.String())
	}
	return out
}

func (s *searcher) result() rpc.FsGrepResult {
	res := rpc.FsGrepResult{OutputMode: s.mode, Files: []string{}, Lines: []string{}, Counts: []rpc.FsGrepCount{}, NumFiles: len(s.results)}
	if s.mode == "files" {
		sort.Slice(s.results, func(i, j int) bool {
			a, b := s.results[i], s.results[j]
			if a.mtime != b.mtime {
				return a.mtime > b.mtime
			}
			return a.path < b.path
		})
	} else {
		sort.Slice(s.results, func(i, j int) bool { return s.results[i].path < s.results[j].path })
	}
	limit := s.p.HeadLimit
	for _, r := range s.results {
		res.NumMatches += r.count
		switch s.mode {
		case "files":
			res.Files = append(res.Files, r.path)
		case "count":
			res.Counts = append(res.Counts, rpc.FsGrepCount{Path: r.path, Count: r.count})
		case "content":
			if len(res.Lines) > 0 && (s.p.Before > 0 || s.p.After > 0) {
				res.Lines = append(res.Lines, "--")
			}
			res.Lines = append(res.Lines, r.lines...)
		}
	}
	res.Truncated = s.outputBytes.Load() >= maxOutputBytes
	if limit > 0 {
		if len(res.Files) > limit {
			res.Files, res.Truncated = res.Files[:limit], true
		}
		if len(res.Counts) > limit {
			res.Counts, res.Truncated = res.Counts[:limit], true
		}
		if len(res.Lines) > limit {
			res.Lines, res.Truncated = res.Lines[:limit], true
		}
	}
	return res
}

// splitLines splits after each '\n', keeping the terminators so byte offsets add up.
func splitLines(data []byte) [][]byte {
	lines := bytes.SplitAfter(data, []byte{'\n'})
	if len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func trimEOL(l []byte) []byte {
	l = bytes.TrimSuffix(l, []byte{'\n'})
	return bytes.TrimSuffix(l, []byte{'\r'})
}

// filter selects files by ripgrep --glob (space-separated, "!" negates; a glob without "/"
// matches the file name, one with "/" the path relative to the search root) and --type.
type filter struct {
	include, exclude []string
	types            []string
}

func newFilter(globs, typ string) (filter, error) {
	var f filter
	for _, g := range strings.Fields(globs) {
		neg := strings.HasPrefix(g, "!")
		g = strings.TrimPrefix(g, "!")
		if !doublestar.ValidatePattern(g) {
			return f, rpc.InvalidParams("invalid glob %q", g)
		}
		if neg {
			f.exclude = append(f.exclude, g)
		} else {
			f.include = append(f.include, g)
		}
	}
	if typ != "" {
		t, ok := types[typ]
		if !ok {
			return f, rpc.InvalidParams("unknown file type %q; known types: %s", typ, strings.Join(typeNames(), ", "))
		}
		f.types = t
	}
	return f, nil
}

func (f filter) match(rel string) bool {
	name := path.Base(rel)
	matches := func(g string) bool {
		subject := name
		if strings.Contains(g, "/") {
			subject = rel
		}
		ok, _ := doublestar.Match(g, subject)
		return ok
	}
	if len(f.types) > 0 && !slices.ContainsFunc(f.types, func(g string) bool { ok, _ := doublestar.Match(g, name); return ok }) {
		return false
	}
	if len(f.include) > 0 && !slices.ContainsFunc(f.include, matches) {
		return false
	}
	return !slices.ContainsFunc(f.exclude, matches)
}
