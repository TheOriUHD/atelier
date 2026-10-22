package walk

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-git/go-git/v5/plumbing/format/config"
	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
)

// parentPatterns collects the ignore rules that apply to start from outside it: the global excludes
// file, .git/info/exclude, and .gitignore/.ignore files in the directories between the repository
// top (the nearest ancestor holding .git, never above top) and start. Patterns are relative to base.
func parentPatterns(start, top string) (base string, patterns []gitignore.Pattern) {
	base = start
	if rel, err := filepath.Rel(top, start); err == nil && !strings.HasPrefix(rel, "..") {
		base = top
		for d := start; ; d = filepath.Dir(d) {
			if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
				base = d
				break
			}
			if d == top || filepath.Dir(d) == d {
				break
			}
		}
	}
	patterns = append(patterns, globalPatterns()...)
	if fi, err := os.Stat(filepath.Join(base, ".git")); err == nil && fi.IsDir() {
		patterns = append(patterns, readPatterns(filepath.Join(base, ".git", "info", "exclude"), nil)...)
	}
	comps := components(base, start)
	d := base
	for i, c := range comps {
		patterns = append(patterns, readPatterns(filepath.Join(d, ".gitignore"), comps[:i])...)
		patterns = append(patterns, readPatterns(filepath.Join(d, ".ignore"), comps[:i])...)
		d = filepath.Join(d, c)
	}
	return base, patterns
}

// globalPatterns reads git's core.excludesFile (default $XDG_CONFIG_HOME/git/ignore) once.
var globalPatterns = sync.OnceValue(func() []gitignore.Pattern {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	file := ""
	if data, err := os.ReadFile(filepath.Join(home, ".gitconfig")); err == nil {
		cfg := config.New()
		if config.NewDecoder(bytes.NewReader(data)).Decode(cfg) == nil {
			file = cfg.Section("core").Options.Get("excludesfile")
		}
	}
	if file == "" {
		xdg := os.Getenv("XDG_CONFIG_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".config")
		}
		file = filepath.Join(xdg, "git", "ignore")
	} else if rest, ok := strings.CutPrefix(file, "~/"); ok {
		file = filepath.Join(home, rest)
	}
	return readPatterns(file, nil)
})

func readPatterns(path string, domain []string) []gitignore.Pattern {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var patterns []gitignore.Pattern
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, gitignore.ParsePattern(line, domain))
	}
	return patterns
}
