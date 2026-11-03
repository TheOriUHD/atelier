// Package appid is how the Linux helper names apps. main matches on the ids (grants, the denied list, the app under a
// click), so an app has one id everywhere: apps.list, apps.frontmost and inspect.*.
//
//   - An app with a desktop entry (the .desktop files of the application folders): the entry's id, its file name without
//     `.desktop` (`org.mozilla.firefox`, `firefox`, `org.keepassxc.KeePassXC`), as the desktop itself names it.
//   - An app without one: its window class, lowercase (`xterm`), else its process's file name.
//   - An app running as another user: `elevated:` and its id above. Atelier never uses those.
//
// Ids compare without case.
package appid

import (
	"bufio"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"atelier.dev/computer-linux/internal/proto"
)

// ElevatedPrefix marks an app that runs as another user (root): a window of it can't be told apart from a password
// prompt, and its accessibility tree is on another bus, so Atelier doesn't use it.
const ElevatedPrefix = "elevated:"

// Entry is one desktop entry that starts an application.
type Entry struct {
	// ID is the file's name without `.desktop` (a file in a subfolder joins its path with `-`).
	ID   string
	Name string
	// Exec is the command, split and with its field codes (%u, %F…) left out.
	Exec    []string
	TryExec string
	// Path is the folder it starts in.
	Path       string
	WMClass    string
	Categories []string
	// Hidden entries are for other entries to point at; NoDisplay ones are not in menus (Atelier lists neither as
	// installed, but a running one is still the app); Terminal ones need a terminal to run in.
	Hidden, NoDisplay, Terminal bool
	File                        string
}

// BaseName is the last element of a slash path.
func BaseName(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

// ParseEntry reads a desktop entry. locales are the preferred locales for Name, most specific first (`de_DE`, `de`).
// ok is false for anything that isn't an application.
func ParseEntry(id string, data []byte, locales []string) (Entry, bool) {
	e := Entry{ID: id}
	in := false
	names := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	kind := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			in = line == "[Desktop Entry]"
			continue
		}
		if !in {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch {
		case key == "Type":
			kind = value
		case key == "Name":
			names[""] = unescape(value)
		case strings.HasPrefix(key, "Name[") && strings.HasSuffix(key, "]"):
			names[key[5:len(key)-1]] = unescape(value)
		case key == "Exec":
			e.Exec = SplitExec(value)
		case key == "TryExec":
			e.TryExec = value
		case key == "Path":
			e.Path = value
		case key == "StartupWMClass":
			e.WMClass = value
		case key == "Categories":
			for _, c := range strings.Split(value, ";") {
				if c != "" {
					e.Categories = append(e.Categories, c)
				}
			}
		case key == "Hidden":
			e.Hidden = value == "true"
		case key == "NoDisplay":
			e.NoDisplay = value == "true"
		case key == "Terminal":
			e.Terminal = value == "true"
		}
	}
	if kind != "Application" || len(e.Exec) == 0 {
		return Entry{}, false
	}
	for _, l := range locales {
		if n, ok := names[l]; ok && n != "" {
			e.Name = n
			break
		}
	}
	if e.Name == "" {
		e.Name = names[""]
	}
	if e.Name == "" {
		e.Name = id
	}
	return e, true
}

func unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	r := strings.NewReplacer(`\s`, " ", `\n`, "\n", `\t`, "\t", `\r`, "\r", `\\`, `\`)
	return r.Replace(s)
}

// SplitExec splits an Exec value into arguments by the desktop entry rules (double quotes, backslash escapes inside
// them) and drops the field codes: %f %F %u %U %d %D %n %N %i %c %k %v %m, and %% becomes %.
func SplitExec(exec string) []string {
	var args []string
	var cur strings.Builder
	has, quoted := false, false
	flush := func() {
		if has {
			args = append(args, cur.String())
		}
		cur.Reset()
		has = false
	}
	rs := []rune(exec)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case quoted && r == '\\' && i+1 < len(rs):
			i++
			cur.WriteRune(rs[i])
			has = true
		case r == '"':
			quoted = !quoted
			has = true
		case !quoted && (r == ' ' || r == '\t'):
			flush()
		case r == '%' && i+1 < len(rs):
			i++
			if rs[i] == '%' {
				cur.WriteRune('%')
				has = true
			}
			// Any other field code is dropped; an argument that was only a field code goes with it.
		default:
			cur.WriteRune(r)
			has = true
		}
	}
	flush()
	return args
}

// Locales are the locale names to try for a translated Name, from LANG-like values (`de_DE.UTF-8@euro` → `de_DE`, `de`).
func Locales(values ...string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, v := range values {
		v = strings.SplitN(v, ".", 2)[0]
		v = strings.SplitN(v, "@", 2)[0]
		if v == "" || v == "C" || v == "POSIX" {
			continue
		}
		add(v)
		add(strings.SplitN(v, "_", 2)[0])
	}
	return out
}

// DataDirs are the application folders, user first: $XDG_DATA_HOME, $XDG_DATA_DIRS, and where Flatpak and Snap export
// their entries (their folders are in XDG_DATA_DIRS on most systems, but not every session passes it on).
func DataDirs(env func(string) string) []string {
	home := env("HOME")
	dataHome := env("XDG_DATA_HOME")
	if dataHome == "" && home != "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	dirs := []string{}
	add := func(d string) {
		if d == "" {
			return
		}
		for _, have := range dirs {
			if have == d {
				return
			}
		}
		dirs = append(dirs, d)
	}
	add(dataHome)
	data := env("XDG_DATA_DIRS")
	if data == "" {
		data = "/usr/local/share:/usr/share"
	}
	for _, d := range strings.Split(data, ":") {
		add(d)
	}
	if home != "" {
		add(filepath.Join(home, ".local", "share", "flatpak", "exports", "share"))
	}
	add("/var/lib/flatpak/exports/share")
	add("/var/lib/snapd/desktop")
	return dirs
}

// Index finds the entry of a window.
type Index struct {
	entries []Entry
	byID    map[string]int
	byClass map[string]int // StartupWMClass, lowercase
	byLast  map[string]int // last dotted part of the id, lowercase
	byExec  map[string]int // the command's file name, lowercase
}

// NewIndex indexes entries given in priority order (the user's own first): of two entries for one key the first wins.
func NewIndex(entries []Entry) *Index {
	ix := &Index{entries: entries, byID: map[string]int{}, byClass: map[string]int{}, byLast: map[string]int{}, byExec: map[string]int{}}
	put := func(m map[string]int, key string, i int) {
		key = strings.ToLower(key)
		if key == "" {
			return
		}
		if _, ok := m[key]; !ok {
			m[key] = i
		}
	}
	for i, e := range entries {
		put(ix.byID, e.ID, i)
		put(ix.byClass, e.WMClass, i)
		put(ix.byLast, e.ID[strings.LastIndex(e.ID, ".")+1:], i)
		if len(e.Exec) > 0 {
			put(ix.byExec, BaseName(e.Exec[0]), i)
		}
	}
	return ix
}

// Entries are every entry, in priority order.
func (ix *Index) Entries() []Entry { return ix.entries }

// Window is what is known of a window and its process, to find its app.
type Window struct {
	// GtkAppID and DesktopFile are what GTK and KDE applications name themselves by.
	GtkAppID, DesktopFile string
	Class, Instance       string
	// Exe is the process's executable file name.
	Exe string
}

// Match finds the desktop entry of the app a window belongs to, strongest evidence first.
func (ix *Index) Match(w Window) (Entry, bool) {
	get := func(m map[string]int, keys ...string) (Entry, bool) {
		for _, k := range keys {
			if k == "" {
				continue
			}
			if i, ok := m[strings.ToLower(k)]; ok {
				return ix.entries[i], true
			}
		}
		return Entry{}, false
	}
	for _, name := range []string{w.GtkAppID, w.DesktopFile} {
		name = strings.TrimSuffix(name, ".desktop")
		if e, ok := get(ix.byID, name); ok {
			return e, true
		}
	}
	if e, ok := get(ix.byClass, w.Class, w.Instance); ok {
		return e, true
	}
	if e, ok := get(ix.byID, w.Class, w.Instance); ok {
		return e, true
	}
	if e, ok := get(ix.byLast, w.Class, w.Instance); ok {
		return e, true
	}
	// The program is the last evidence, and not for a runtime that runs anything: python3 is no app.
	if generic[strings.ToLower(w.Exe)] {
		return get(ix.byExec, w.Class, w.Instance)
	}
	return get(ix.byExec, w.Exe, w.Class, w.Instance)
}

// generic are programs that run other programs: many apps share them, so they say nothing about which app a window is.
var generic = map[string]bool{
	"python": true, "python3": true, "java": true, "node": true, "electron": true, "sh": true, "bash": true, "env": true,
	"perl": true, "ruby": true, "wine": true, "wine64": true, "mono": true, "flatpak": true, "bwrap": true, "snap": true,
	"appimagelauncher": true,
}

// ByID finds an entry by id, without case.
func (ix *Index) ByID(id string) (Entry, bool) {
	i, ok := ix.byID[strings.ToLower(strings.TrimSuffix(id, ".desktop"))]
	if !ok {
		return Entry{}, false
	}
	return ix.entries[i], true
}

// Identity is an app as a window shows it: its id and name.
func Identity(entry *Entry, w Window) (id, name string) {
	if entry != nil {
		return entry.ID, entry.Name
	}
	for _, v := range []string{w.Class, w.Instance} {
		if v != "" {
			return strings.ToLower(v), v
		}
	}
	return strings.ToLower(w.Exe), w.Exe
}

// Running is an app with windows on screen.
type Running struct {
	ID     string
	Name   string
	Path   string
	PID    int
	Active bool
	Hidden bool
}

// Clip trims a name and keeps it at most 200 characters; an empty one is the fallback.
func Clip(name, fallback string) string {
	value := strings.TrimSpace(name)
	if value == "" {
		value = fallback
	}
	if r := []rune(value); len(r) > 200 {
		value = string(r[:200])
	}
	return value
}

// HelperApp is a running app on the wire.
func (r Running) HelperApp() proto.App {
	app := proto.App{ID: r.ID, Name: Clip(r.Name, r.ID), Running: true, Active: r.Active, Hidden: r.Hidden}
	if r.PID > 0 {
		app.PID = proto.Ptr(r.PID)
	}
	if r.Path != "" {
		app.Path = proto.Ptr(r.Path)
	}
	return app
}

// Installed is an app of the application folders.
type Installed struct {
	ID   string
	Name string
	Path string
}

// HelperApp is an installed app that isn't running, on the wire.
func (i Installed) HelperApp() proto.App {
	app := proto.App{ID: i.ID, Name: Clip(i.Name, i.ID)}
	if i.Path != "" {
		app.Path = proto.Ptr(i.Path)
	}
	return app
}

// InstalledApps are the entries that belong in an app list: shown in menus and runnable without a terminal.
func InstalledApps(entries []Entry) []Installed {
	seen := map[string]bool{}
	var out []Installed
	for _, e := range entries {
		key := strings.ToLower(e.ID)
		if seen[key] || e.Hidden || e.NoDisplay || e.Terminal {
			continue
		}
		seen[key] = true
		out = append(out, Installed{ID: e.ID, Name: e.Name, Path: e.File})
	}
	return out
}

// Merge is the running apps, and with installed the entries too: one entry per id (ids compare without case), a
// running app's details winning, sorted by name and then id.
func Merge(running []Running, installed []Installed) []proto.App {
	byID := map[string]proto.App{}
	var order []string
	for _, r := range running {
		key := strings.ToLower(r.ID)
		if _, ok := byID[key]; ok {
			continue
		}
		byID[key] = r.HelperApp()
		order = append(order, key)
	}
	for _, i := range installed {
		key := strings.ToLower(i.ID)
		if have, ok := byID[key]; ok {
			if have.Path == nil && i.Path != "" {
				have.Path = proto.Ptr(i.Path)
				byID[key] = have
			}
			continue
		}
		byID[key] = i.HelperApp()
		order = append(order, key)
	}
	apps := make([]proto.App, 0, len(order))
	for _, key := range order {
		apps = append(apps, byID[key])
	}
	sort.SliceStable(apps, func(a, b int) bool {
		na, nb := strings.ToLower(apps[a].Name), strings.ToLower(apps[b].Name)
		if na != nb {
			return na < nb
		}
		return apps[a].ID < apps[b].ID
	})
	return apps
}

// LoadEntries reads the desktop entries of every application folder, user first. An entry that appears in several
// folders is the first one. Unreadable files and entries that are not applications are skipped.
func LoadEntries(env func(string) string, locales []string) []Entry {
	var entries []Entry
	seen := map[string]bool{}
	for _, dir := range DataDirs(env) {
		root := filepath.Join(dir, "applications")
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".desktop") {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			id := strings.ReplaceAll(strings.TrimSuffix(rel, ".desktop"), string(filepath.Separator), "-")
			if seen[strings.ToLower(id)] {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			seen[strings.ToLower(id)] = true
			if e, ok := ParseEntry(id, data, locales); ok {
				e.File = path
				entries = append(entries, e)
			}
			return nil
		})
	}
	return entries
}
