//go:build windows

package win

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/appid"
	"atelier.dev/computer-windows/internal/rpc"
)

// startMenuTTL is how long a Get-StartApps answer is used before it is asked again.
const startMenuTTL = 60 * time.Second

const createNoWindow = 0x08000000

// startMenu is the Start menu's apps (Get-StartApps), cached for 60 s. An older answer still names apps while a newer
// one loads.
type startMenu struct {
	mu       sync.Mutex
	apps     []appid.Installed
	byID     map[string]appid.Installed // lowercase id
	loadedAt time.Time
	loading  chan struct{} // closed when the load in progress ends
	logged   bool
}

func newStartMenu() *startMenu { return &startMenu{byID: map[string]appid.Installed{}} }

// list is the Start menu's apps, loading them first when the cache is stale.
func (m *startMenu) list() []appid.Installed {
	m.mu.Lock()
	if !m.loadedAt.IsZero() && time.Since(m.loadedAt) < startMenuTTL {
		apps := m.apps
		m.mu.Unlock()
		return apps
	}
	done := m.startLoadLocked()
	m.mu.Unlock()
	<-done
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apps
}

// lookup is an app of the Start menu by id from what is cached, for naming apps: it never waits. A load starts in the
// background only when nothing was loaded yet, or the id isn't there and the answer is older than the TTL (a new app),
// so naming the app under every click doesn't run PowerShell once a minute.
func (m *startMenu) lookup(id string) (appid.Installed, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	app, ok := m.byID[strings.ToLower(id)]
	if m.loadedAt.IsZero() || (!ok && time.Since(m.loadedAt) >= startMenuTTL) {
		m.startLoadLocked()
	}
	return app, ok
}

// find is an app of the Start menu by id, loading the Start menu first when the id isn't in a fresh answer.
func (m *startMenu) find(id string) (appid.Installed, bool) {
	m.mu.Lock()
	app, ok := m.byID[strings.ToLower(id)]
	m.mu.Unlock()
	if ok {
		return app, true
	}
	m.list()
	m.mu.Lock()
	defer m.mu.Unlock()
	app, ok = m.byID[strings.ToLower(id)]
	return app, ok
}

func (m *startMenu) startLoadLocked() chan struct{} {
	if m.loading != nil {
		return m.loading
	}
	done := make(chan struct{})
	m.loading = done
	go func() {
		apps, err := loadStartMenu()
		m.mu.Lock()
		defer m.mu.Unlock()
		if err != nil {
			if !m.logged {
				rpc.Logf("Get-StartApps failed: %v", err)
				m.logged = true
			}
			if m.loadedAt.IsZero() {
				m.loadedAt = time.Now() // Don't ask again on every call; try again after the TTL.
			}
		} else {
			m.apps = apps
			m.byID = map[string]appid.Installed{}
			for _, a := range apps {
				m.byID[strings.ToLower(a.ID)] = a
			}
			m.loadedAt = time.Now()
		}
		m.loading = nil
		close(done)
	}()
	return done
}

// loadStartMenu runs Get-StartApps (hidden, UTF-8 out) and derives an id for each entry; then it adds the Start menu
// shortcuts to programs that Get-StartApps didn't list (it lists them all on a normal desktop, but can come back nearly
// empty, as for an account that never signed in at the screen, or fail where the StartLayout module is missing).
func loadStartMenu() ([]appid.Installed, error) {
	r := newResolver()
	var installed []appid.Installed
	entries, err := getStartApps()
	if err == nil {
		installed = appid.Index(entries, r)
	}
	installed = appid.AppendNew(installed, r.shortcutApps())
	if err != nil && len(installed) == 0 {
		return nil, err
	}
	if err != nil {
		rpc.Logf("Get-StartApps failed (Start menu shortcuts only): %v", err)
	}
	return installed, nil
}

func getStartApps() ([]appid.StartApp, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if os.Getenv("SystemRoot") == "" {
		shell = "powershell.exe"
	}
	script := "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-StartApps | ConvertTo-Json -Compress"
	cmd := exec.CommandContext(ctx, shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return appid.ParseStartApps(out)
}

// resolver finds known folders and Start menu shortcuts for appid.FromStartApp.
type resolver struct {
	once      sync.Once
	shortcuts map[string]string // lowercase name without .lnk → path
	order     []string          // the shortcuts' paths, per-user folder first
}

func newResolver() *resolver { return &resolver{} }

func (r *resolver) KnownFolder(guid string) (string, bool) {
	id, err := windows.GUIDFromString(guid)
	if err != nil {
		return "", false
	}
	path, err := windows.KnownFolderPath((*windows.KNOWNFOLDERID)(&id), 0)
	if err != nil || path == "" {
		return "", false
	}
	return path, true
}

// startMenuFolders are the per-user and all-users Start Menu\Programs folders.
func startMenuFolders() []string {
	var folders []string
	for _, base := range []string{os.Getenv("APPDATA"), os.Getenv("ProgramData")} {
		if base != "" {
			folders = append(folders, filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs"))
		}
	}
	return folders
}

func (r *resolver) walk() {
	r.once.Do(func() {
		r.shortcuts = map[string]string{}
		for _, folder := range startMenuFolders() {
			_ = filepath.WalkDir(folder, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".lnk") {
					return nil
				}
				key := strings.ToLower(strings.TrimSuffix(d.Name(), filepath.Ext(d.Name())))
				if _, ok := r.shortcuts[key]; !ok {
					r.shortcuts[key] = path
					r.order = append(r.order, path)
				}
				return nil
			})
		}
	})
}

// target is a shortcut file's target, environment variables expanded.
func target(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 1<<20 {
		return "", false
	}
	t, err := appid.LnkTarget(data)
	if err != nil || t == "" {
		return "", false
	}
	return expandEnv(t), true
}

func (r *resolver) Shortcut(name string) (string, bool) {
	r.walk()
	path, ok := r.shortcuts[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return "", false
	}
	return target(path)
}

// shortcutApps are the Start menu's shortcuts to programs, as installed apps.
func (r *resolver) shortcutApps() []appid.Installed {
	r.walk()
	var apps []appid.Installed
	for _, path := range r.order {
		t, ok := target(path)
		if !ok {
			continue
		}
		name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		if app, ok := appid.FromShortcut(name, t); ok {
			apps = append(apps, app)
		}
	}
	appid.PreferShortcuts(apps)
	return apps
}

// expandEnv expands %VARIABLES% the way Windows does.
func expandEnv(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	src, err := windows.UTF16PtrFromString(s)
	if err != nil {
		return s
	}
	buf := make([]uint16, 1024)
	n, err := windows.ExpandEnvironmentStrings(src, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return s
	}
	return windows.UTF16ToString(buf[:n])
}
