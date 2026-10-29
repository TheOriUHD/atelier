// Package appid is how the Windows helper names apps. main matches on the ids (grants, the denied list, the app under
// a click), so an app has one id everywhere: apps.list, apps.frontmost and inspect.*.
//
//   - A packaged (MSIX/UWP) process: its package family name, as GetPackageFamilyName gives it
//     (`MSTeams_8wekyb3d8bbwe`).
//   - Any other process: its exe file name, lowercase (`chrome.exe`).
//   - A Start menu entry (Get-StartApps): from its AppID, see FromStartApp.
package appid

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"atelier.dev/computer-windows/internal/proto"
)

// StartAppPrefix marks the id of a Start menu entry whose app couldn't be told (`startapp:<AppID>`).
const StartAppPrefix = "startapp:"

// BaseName is the last element of a Windows (or slash) path.
func BaseName(path string) string {
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		return path[i+1:]
	}
	return path
}

// FromProcess is a running process's id: its package family name when it has one, else its exe's file name, lowercase.
func FromProcess(exePath, family string) string {
	if family != "" {
		return family
	}
	return strings.ToLower(BaseName(exePath))
}

// ExeName is an exe's name without `.exe`, for an app with no better one.
func ExeName(exePath string) string {
	base := BaseName(exePath)
	if strings.HasSuffix(strings.ToLower(base), ".exe") {
		base = base[:len(base)-4]
	}
	return base
}

// StartApp is one entry of `Get-StartApps`.
type StartApp struct {
	Name  string `json:"Name"`
	AppID string `json:"AppID"`
}

// ParseStartApps reads `Get-StartApps | ConvertTo-Json -Compress`: an array, or a single object when there is one
// entry, or nothing at all; a UTF-8 byte order mark is skipped.
func ParseStartApps(data []byte) ([]StartApp, error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return nil, nil
	}
	var apps []StartApp
	if data[0] == '{' {
		var one StartApp
		if err := json.Unmarshal(data, &one); err != nil {
			return nil, err
		}
		apps = []StartApp{one}
	} else if err := json.Unmarshal(data, &apps); err != nil {
		return nil, err
	}
	out := apps[:0]
	for _, a := range apps {
		a.Name = strings.TrimSpace(a.Name)
		a.AppID = strings.TrimSpace(a.AppID)
		if a.AppID != "" {
			out = append(out, a)
		}
	}
	return out, nil
}

// Resolver is what FromStartApp needs of the system.
type Resolver interface {
	// KnownFolder is the path of a known folder by its GUID (`{6D809377-…}`), as SHGetKnownFolderPath gives it.
	KnownFolder(guid string) (string, bool)
	// Shortcut is the target of the Start menu shortcut `<name>.lnk` (in either Start Menu\Programs, any subfolder).
	Shortcut(name string) (string, bool)
}

// FromStartApp derives a Start menu entry's id, and the exe path when it is known:
//
//  1. `Family!App` (a packaged app's AppUserModelID): the family.
//  2. A path ending in `.exe`: its file name, lowercase. It may start with a known folder's GUID
//     (`{6D809377-…}\Google\Chrome\Application\chrome.exe`), which gives the full path.
//  3. Otherwise the Start menu shortcut with the entry's name: its target exe's file name, lowercase.
//  4. Else `startapp:<AppID>`.
func FromStartApp(app StartApp, r Resolver) (id string, exePath string) {
	appID := app.AppID
	if i := strings.Index(appID, "!"); i > 0 && !strings.ContainsAny(appID[:i], `\/`) {
		return appID[:i], ""
	}
	if strings.HasSuffix(strings.ToLower(appID), ".exe") {
		return strings.ToLower(BaseName(appID)), resolveKnownFolder(appID, r)
	}
	if r != nil && app.Name != "" {
		if target, ok := r.Shortcut(app.Name); ok && strings.HasSuffix(strings.ToLower(target), ".exe") {
			return strings.ToLower(BaseName(target)), target
		}
	}
	if id, ok := knownAppIDs[strings.ToLower(appID)]; ok {
		return id, ""
	}
	return StartAppPrefix + appID, ""
}

// knownAppIDs are AppUserModelIDs of Windows' own apps whose shortcut doesn't name their exe.
var knownAppIDs = map[string]string{
	"microsoft.windows.explorer": "explorer.exe",
}

// resolveKnownFolder expands a leading `{GUID}\` into the known folder's path; an absolute path stays as it is.
func resolveKnownFolder(appID string, r Resolver) string {
	if strings.HasPrefix(appID, "{") {
		end := strings.Index(appID, "}")
		if end < 0 || r == nil {
			return ""
		}
		folder, ok := r.KnownFolder(appID[:end+1])
		if !ok {
			return ""
		}
		rest := strings.TrimLeft(appID[end+1:], `\/`)
		return strings.TrimRight(folder, `\`) + `\` + rest
	}
	if len(appID) > 2 && appID[1] == ':' || strings.HasPrefix(appID, `\\`) {
		return appID
	}
	return ""
}

// Installed is an app of the Start menu, by id: the first entry for an id wins.
type Installed struct {
	ID    string
	Name  string
	AppID string
	Path  string
}

// Index derives the ids of Start menu entries: one per id, the first entry winning, in the order given.
func Index(apps []StartApp, r Resolver) []Installed {
	seen := map[string]bool{}
	var out []Installed
	for _, a := range apps {
		id, path := FromStartApp(a, r)
		key := strings.ToLower(id)
		if id == "" || seen[key] {
			continue
		}
		seen[key] = true
		name := a.Name
		if name == "" {
			name = id
		}
		out = append(out, Installed{ID: id, Name: name, AppID: a.AppID, Path: path})
	}
	return out
}

// FromShortcut is a Start menu shortcut as an installed app: one whose target is an exe, by that exe's id. Uninstallers
// are left out.
func FromShortcut(name, target string) (Installed, bool) {
	base := strings.ToLower(BaseName(target))
	name = strings.TrimSpace(name)
	if !strings.HasSuffix(base, ".exe") || strings.HasPrefix(base, "unins") || strings.HasPrefix(strings.ToLower(name), "uninstall") {
		return Installed{}, false
	}
	if name == "" {
		name = ExeName(target)
	}
	return Installed{ID: base, Name: name, Path: target}, true
}

// PreferShortcuts orders shortcuts so that, of several leading to one exe, the plainest names it: not a 32-bit
// variant ("Windows PowerShell (x86)"), then the shortest name.
func PreferShortcuts(apps []Installed) {
	key := func(a Installed) (bool, int, string) {
		lower := strings.ToLower(a.Name)
		return strings.Contains(lower, "(x86)") || strings.Contains(lower, "(32-bit)"), len([]rune(a.Name)), lower
	}
	sort.SliceStable(apps, func(i, j int) bool {
		xi, li, ni := key(apps[i])
		xj, lj, nj := key(apps[j])
		if xi != xj {
			return !xi
		}
		if li != lj {
			return li < lj
		}
		return ni < nj
	})
}

// AppendNew adds the apps whose id (without case) isn't in the list yet.
func AppendNew(list []Installed, more []Installed) []Installed {
	seen := map[string]bool{}
	for _, a := range list {
		seen[strings.ToLower(a.ID)] = true
	}
	for _, a := range more {
		if key := strings.ToLower(a.ID); !seen[key] {
			seen[key] = true
			list = append(list, a)
		}
	}
	return list
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
	app := proto.App{ID: r.ID, Name: Clip(r.Name, r.ID), PID: proto.Ptr(r.PID), Running: true, Active: r.Active, Hidden: r.Hidden}
	if r.Path != "" {
		app.Path = proto.Ptr(r.Path)
	}
	return app
}

// HelperApp is an installed app that isn't running, on the wire.
func (i Installed) HelperApp() proto.App {
	app := proto.App{ID: i.ID, Name: Clip(i.Name, i.ID)}
	if i.Path != "" {
		app.Path = proto.Ptr(i.Path)
	}
	return app
}

// Merge is the running apps, and with installed the Start menu's apps too: one entry per id (ids compare without
// case), a running app's details winning, sorted by name and then id.
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

// Name is an app's name: its Start menu name when it has one (the name the person knows), else for a packaged app its
// family name, else the exe's FileDescription, else the exe's name without `.exe`.
func Name(startName, family, fileDescription, exePath string) string {
	if s := strings.TrimSpace(startName); s != "" {
		return s
	}
	if family != "" {
		return family
	}
	if s := strings.TrimSpace(fileDescription); s != "" {
		return s
	}
	return ExeName(exePath)
}
