//go:build windows

package win

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/appid"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// System is the helper's Windows side (helper.System).
type System struct {
	start  *startMenu
	parent uint32
	self   uint32
	send   *sender

	hiddenMu sync.Mutex
	hidden   map[string][]uintptr // lowercase id → the windows apps.hide minimized

	pathsMu sync.Mutex
	paths   map[string]string // lowercase id → the exe path of an app seen running
}

func NewSystem() *System {
	return &System{
		start:  newStartMenu(),
		parent: uint32(os.Getppid()),
		self:   uint32(os.Getpid()),
		send:   &sender{},
		hidden: map[string][]uintptr{},
		paths:  map[string]string{},
	}
}

func (s *System) Displays() ([]proto.Display, error) { return listDisplays(), nil }

// nameFor is a process's app name: its Start menu name, else (packaged) the family name, else the exe's
// FileDescription, else its file name.
func (s *System) nameFor(info procInfo) string {
	var start string
	if inst, ok := s.start.lookup(info.id); ok {
		start = inst.Name
	}
	desc := ""
	if info.family == "" {
		desc = fileDescription(info.exe)
	}
	return appid.Clip(appid.Name(start, info.family, desc, info.exe), info.id)
}

func fullPath(exe string) string {
	if strings.ContainsAny(exe, `\/`) {
		return exe
	}
	return ""
}

// runningApps are the apps with a window the person can switch to (one entry per id, its topmost window's process),
// and those windows by lowercase id.
func (s *System) runningApps(pc *procCache) ([]appid.Running, map[string][]window) {
	fgID := ""
	if pid := foregroundPID(); pid != 0 {
		if info := pc.get(pid); info.ok {
			fgID = strings.ToLower(info.id)
		}
	}
	var apps []appid.Running
	index := map[string]int{}
	byID := map[string][]window{}
	for _, w := range topWindows() {
		if !w.altTab() || w.pid == s.self {
			continue
		}
		info := pc.get(w.appPID)
		if !info.ok {
			continue
		}
		key := strings.ToLower(info.id)
		byID[key] = append(byID[key], w)
		if i, ok := index[key]; ok {
			if !w.iconic {
				apps[i].Hidden = false
			}
			continue
		}
		index[key] = len(apps)
		apps = append(apps, appid.Running{
			ID: info.id, Name: s.nameFor(info), Path: fullPath(info.exe), PID: int(w.appPID),
			Active: key == fgID, Hidden: w.iconic,
		})
		if p := fullPath(info.exe); p != "" {
			s.pathsMu.Lock()
			s.paths[key] = p
			s.pathsMu.Unlock()
		}
	}
	return apps, byID
}

func (s *System) Apps(installed bool) ([]proto.App, error) {
	var inst []appid.Installed
	if installed {
		inst = s.start.list() // First, so the running apps' names come from the same answer.
	}
	running, _ := s.runningApps(newProcCache())
	return appid.Merge(running, inst), nil
}

// appFor is the app of a process, as a running app: with its windows' state when it has windows to switch to.
func (s *System) appFor(pid uint32, pc *procCache) *proto.App {
	if pid == 0 {
		return nil
	}
	info := pc.get(pid)
	if !info.ok {
		return nil
	}
	running, _ := s.runningApps(pc)
	for _, r := range running {
		if strings.EqualFold(r.ID, info.id) {
			r.PID = int(pid)
			app := r.HelperApp()
			return &app
		}
	}
	fg := false
	if fgPID := foregroundPID(); fgPID != 0 {
		fg = strings.EqualFold(pc.get(fgPID).id, info.id)
	}
	r := appid.Running{ID: info.id, Name: s.nameFor(info), Path: fullPath(info.exe), PID: int(pid), Active: fg}
	app := r.HelperApp()
	return &app
}

func (s *System) Frontmost() (*proto.App, error) {
	pid := foregroundPID()
	if pid == 0 {
		return nil, nil
	}
	app := s.appFor(pid, newProcCache())
	if app != nil {
		app.Active = true
	}
	return app, nil
}

// appByID is an app by id as it is now: running, or a process of it without windows, or from the Start menu.
func (s *System) appByID(id string) (proto.App, bool) {
	running, _ := s.runningApps(newProcCache())
	for _, r := range running {
		if strings.EqualFold(r.ID, id) {
			return r.HelperApp(), true
		}
	}
	if strings.HasSuffix(strings.ToLower(id), ".exe") {
		if pids := pidsByExe(id); len(pids) > 0 {
			if app := s.appFor(pids[0], newProcCache()); app != nil {
				return *app, true
			}
		}
	}
	return proto.App{}, false
}

func (s *System) knownPath(id string) string {
	s.pathsMu.Lock()
	defer s.pathsMu.Unlock()
	return s.paths[strings.ToLower(id)]
}

// OpenApp shows a running app's windows (and brings it to the front with activate), or launches it: by its AppID
// through the shell (`shell:AppsFolder\<AppID>`), else its exe. Then it waits up to 10 s for a window.
func (s *System) OpenApp(id string, activate bool) (proto.App, error) {
	key := strings.ToLower(id)
	_, wins := s.runningApps(newProcCache())
	if ws := wins[key]; len(ws) > 0 {
		for _, w := range ws {
			if w.iconic {
				if activate {
					procShowWindowAsync.Call(w.hwnd, SW_RESTORE)
				} else {
					procShowWindowAsync.Call(w.hwnd, SW_SHOWNOACTIVATE)
				}
			}
		}
		if activate {
			s.activateWindow(ws[0].hwnd, ws[0].appPID)
		}
		if app, ok := s.appByID(id); ok {
			return app, nil
		}
	}

	inst, known := s.start.find(id)
	appID := ""
	if strings.HasPrefix(id, appid.StartAppPrefix) {
		appID = strings.TrimPrefix(id, appid.StartAppPrefix)
	} else if known {
		appID = inst.AppID
	}
	path := ""
	if known {
		path = inst.Path
	}
	if path == "" {
		path = s.knownPath(id)
	}
	before := map[uintptr]bool{}
	for _, w := range topWindows() {
		before[w.hwnd] = true
	}
	var err error
	switch {
	case appID != "":
		err = launchAppID(appID)
	case path != "":
		err = launchExe(path)
	default:
		return proto.App{}, rpc.NotFound("no app %s", id)
	}
	if err != nil {
		return proto.App{}, rpc.Internal("could not open %s: %v", id, err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		pc := newProcCache()
		_, wins := s.runningApps(pc)
		if ws := wins[key]; len(ws) > 0 {
			if activate {
				s.activateWindow(ws[0].hwnd, ws[0].appPID)
			}
			if app, ok := s.appByID(id); ok {
				return app, nil
			}
		}
		if strings.HasPrefix(id, appid.StartAppPrefix) {
			// What a Start menu entry opens can't be told beforehand: the first new window is it.
			for _, w := range topWindows() {
				if w.altTab() && !before[w.hwnd] && w.pid != s.self {
					if app := s.appFor(w.appPID, pc); app != nil {
						return *app, nil
					}
				}
			}
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if app, ok := s.appByID(id); ok {
		return app, nil // Running, though without a window yet.
	}
	if strings.HasPrefix(id, appid.StartAppPrefix) {
		name := inst.Name
		if name == "" {
			name = appID
		}
		return appid.Installed{ID: id, Name: name}.HelperApp(), nil
	}
	return proto.App{}, rpc.NotFound("%s didn't start within 10 s", id)
}

// launchAppID opens a Start menu entry by its AppUserModelID through the shell, on a COM thread.
func launchAppID(appID string) error {
	err := onCOMThread(true, func() error {
		file, err := windows.UTF16PtrFromString(`shell:AppsFolder\` + appID)
		if err != nil {
			return err
		}
		verb, _ := windows.UTF16PtrFromString("open")
		return windows.ShellExecute(0, verb, file, nil, nil, SW_SHOWNORMAL)
	})
	if err == nil {
		return nil
	}
	// The shell's own launcher, as Explorer does it.
	explorer := filepath.Join(os.Getenv("SystemRoot"), "explorer.exe")
	cmd := exec.Command(explorer, `shell:AppsFolder\`+appID)
	if startErr := cmd.Start(); startErr != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func launchExe(path string) error {
	cmd := exec.Command(path)
	cmd.Dir = filepath.Dir(path)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// onCOMThread runs f on a goroutine locked to its OS thread with COM initialized (STA for the shell, else MTA).
func onCOMThread(sta bool, f func() error) error {
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		flags := uint32(windows.COINIT_MULTITHREADED)
		if sta {
			flags = windows.COINIT_APARTMENTTHREADED | windows.COINIT_DISABLE_OLE1DDE
		}
		if err := windows.CoInitializeEx(0, flags); err == nil {
			defer windows.CoUninitialize()
		}
		done <- f()
	}()
	return <-done
}

// HideApps minimizes every visible window of those apps, and remembers exactly which, for UnhideApps.
func (s *System) HideApps(ids []string) ([]string, error) {
	_, wins := s.runningApps(newProcCache())
	var hidden []string
	s.hiddenMu.Lock()
	defer s.hiddenMu.Unlock()
	for _, id := range ids {
		key := strings.ToLower(id)
		did := false
		for _, w := range wins[key] {
			if w.iconic {
				continue
			}
			// Async: a hung app must not hold this up.
			procShowWindowAsync.Call(w.hwnd, SW_MINIMIZE)
			if !containsHwnd(s.hidden[key], w.hwnd) {
				s.hidden[key] = append(s.hidden[key], w.hwnd)
			}
			did = true
		}
		if did && !containsString(hidden, id) {
			hidden = append(hidden, id)
		}
	}
	return hidden, nil
}

// UnhideApps restores exactly the windows HideApps minimized, without taking the focus.
func (s *System) UnhideApps(ids []string) error {
	s.hiddenMu.Lock()
	defer s.hiddenMu.Unlock()
	for _, id := range ids {
		key := strings.ToLower(id)
		for _, hwnd := range s.hidden[key] {
			if boolCall(procIsWindow, hwnd) && boolCall(procIsIconic, hwnd) {
				procShowWindowAsync.Call(hwnd, SW_SHOWNOACTIVATE)
			}
		}
		delete(s.hidden, key)
	}
	return nil
}

// Activate makes a process's main window the foreground window, and says whether it is.
func (s *System) Activate(pid int) (bool, error) {
	target := uint32(pid)
	hwnd := mainWindow(target)
	if hwnd == 0 {
		return foregroundIs(target, 0), nil
	}
	return s.activateWindow(hwnd, target), nil
}

// mainWindow is a process's topmost window to switch to, else its topmost visible unowned one.
func mainWindow(pid uint32) uintptr {
	var fallback uintptr
	for _, w := range topWindows() {
		if w.pid != pid && w.appPID != pid {
			continue
		}
		if w.altTab() {
			return w.hwnd
		}
		if fallback == 0 && w.owner == 0 && !w.cloaked && !w.clickThrough() {
			fallback = w.hwnd
		}
	}
	return fallback
}

// foregroundIs: the foreground window is hwnd, or belongs to pid.
func foregroundIs(pid uint32, hwnd uintptr) bool {
	fg := foregroundWindow()
	if fg == 0 {
		return false
	}
	if hwnd != 0 && fg == hwnd {
		return true
	}
	if owner, _ := windowPID(fg); owner == pid {
		return true
	}
	return effectivePID(fg) == pid
}

// activateWindow brings a window to the front from this background process, past the foreground lock: with its
// thread input attached to the foreground's, then after an input event of its own (a mouse event that moves nothing),
// then with Alt held (and a key no app uses pressed meanwhile, so letting go of Alt opens no menu). Every event is
// tagged, so the control watch ignores it. At most 3 s.
func (s *System) activateWindow(hwnd uintptr, pid uint32) bool {
	result := make(chan bool, 1)
	go func() {
		// Locked, and never unlocked: the thread ends with the goroutine, and with it the message queue and any input
		// state it shared.
		runtime.LockOSThread()
		var m msg
		procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, PM_NOREMOVE) // AttachThreadInput needs a queue.
		result <- s.forceForeground(hwnd, pid)
	}()
	select {
	case ok := <-result:
		return ok
	case <-time.After(3 * time.Second):
		return foregroundIs(pid, hwnd)
	}
}

const vkMenuMask = 0xE8 // Unassigned: pressed while Alt is down so its release isn't an Alt tap.

func (s *System) forceForeground(hwnd uintptr, pid uint32) bool {
	if foregroundIs(pid, hwnd) {
		return true
	}
	if boolCall(procIsIconic, hwnd) {
		procShowWindowAsync.Call(hwnd, SW_RESTORE)
	}
	procAllowSetForegroundWindow.Call(ASFW_ANY)
	settle := func() bool {
		for i := 0; i < 6; i++ {
			if foregroundIs(pid, hwnd) {
				return true
			}
			time.Sleep(25 * time.Millisecond)
		}
		return false
	}
	attempts := []func(){
		func() {
			me := windows.GetCurrentThreadId()
			_, fgThread := windowPID(foregroundWindow())
			_, target := windowPID(hwnd)
			var attached []uint32
			for _, t := range []uint32{fgThread, target} {
				if t != 0 && t != me && !containsThread(attached, t) && boolCall(procAttachThreadInput, uintptr(me), uintptr(t), 1) {
					attached = append(attached, t)
				}
			}
			procSetForegroundWindow.Call(hwnd)
			procBringWindowToTop.Call(hwnd)
			procSetFocus.Call(hwnd)
			for _, t := range attached {
				procAttachThreadInput.Call(uintptr(me), uintptr(t), 0)
			}
		},
		func() {
			_ = s.send.Send([]input.Event{{Mouse: true, Flags: input.MouseMove}})
			procSetForegroundWindow.Call(hwnd)
			procBringWindowToTop.Call(hwnd)
		},
		func() {
			alt := s.send.ScanCode(keys.VK_MENU)
			_ = s.send.Send([]input.Event{{VK: keys.VK_MENU, Scan: alt}, {VK: vkMenuMask}, {VK: vkMenuMask, Flags: input.KeyUp}})
			procSetForegroundWindow.Call(hwnd)
			_ = s.send.Send([]input.Event{{VK: keys.VK_MENU, Scan: alt, Flags: input.KeyUp}})
			procBringWindowToTop.Call(hwnd)
		},
	}
	for _, attempt := range attempts {
		attempt()
		if settle() {
			return true
		}
	}
	return foregroundIs(pid, hwnd)
}

func containsHwnd(list []uintptr, h uintptr) bool {
	for _, x := range list {
		if x == h {
			return true
		}
	}
	return false
}

func containsThread(list []uint32, t uint32) bool {
	for _, x := range list {
		if x == t {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
