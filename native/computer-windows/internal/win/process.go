//go:build windows

package win

import (
	"fmt"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/appid"
)

// procInfo is what a process is, as an app.
type procInfo struct {
	pid uint32
	// id: the package family name, else the exe's file name, lowercase.
	id     string
	exe    string // full path, or only the file name when the process couldn't be opened
	family string
	ok     bool
}

// procCache reads each process once per call (pids are reused, so nothing is kept between calls).
type procCache struct {
	m        map[uint32]procInfo
	snapshot map[uint32]string // pid → exe file name, from a Toolhelp snapshot, for processes that can't be opened
}

func newProcCache() *procCache { return &procCache{m: map[uint32]procInfo{}} }

func (c *procCache) get(pid uint32) procInfo {
	if info, ok := c.m[pid]; ok {
		return info
	}
	info := readProcess(pid)
	if !info.ok && pid > 4 {
		if c.snapshot == nil {
			c.snapshot = processNames()
		}
		if name, ok := c.snapshot[pid]; ok && name != "" {
			info = procInfo{pid: pid, id: strings.ToLower(name), exe: name, ok: true}
		}
	}
	c.m[pid] = info
	return info
}

func readProcess(pid uint32) procInfo {
	if pid == 0 || pid == 4 {
		return procInfo{pid: pid}
	}
	h, err := windows.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return procInfo{pid: pid}
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return procInfo{pid: pid}
	}
	exe := windows.UTF16ToString(buf[:n])
	family := packageFamily(h)
	return procInfo{pid: pid, id: appid.FromProcess(exe, family), exe: exe, family: family, ok: true}
}

// packageFamily is a packaged process's package family name ("" for an unpackaged one).
func packageFamily(h windows.Handle) string {
	if procGetPackageFamilyName.Find() != nil {
		return ""
	}
	var buf [256]uint16
	n := uint32(len(buf))
	r, _, _ := procGetPackageFamilyName.Call(uintptr(h), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&buf[0])))
	if r != ERROR_SUCCESS || n == 0 {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

// processNames are every process's exe file name and parent, from a Toolhelp snapshot.
func processNames() map[uint32]string {
	names := map[uint32]string{}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return names
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		names[entry.ProcessID] = windows.UTF16ToString(entry.ExeFile[:])
	}
	return names
}

// pidsByExe are the processes whose exe file name is `name` (lowercase).
func pidsByExe(name string) []uint32 {
	var pids []uint32
	for pid, exe := range processNames() {
		if strings.EqualFold(exe, name) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// ---------------------------------------------------------------- version resources

var (
	descriptionsMu sync.Mutex
	descriptions   = map[string]string{}
)

// fileDescription is an exe's FileDescription from its version resource ("Google Chrome"), cached by path.
func fileDescription(path string) string {
	if path == "" || !strings.ContainsAny(path, `\/`) {
		return ""
	}
	key := strings.ToLower(path)
	descriptionsMu.Lock()
	if d, ok := descriptions[key]; ok {
		descriptionsMu.Unlock()
		return d
	}
	descriptionsMu.Unlock()
	d := readFileDescription(path)
	descriptionsMu.Lock()
	descriptions[key] = d
	descriptionsMu.Unlock()
	return d
}

func readFileDescription(path string) string {
	size, err := windows.GetFileVersionInfoSize(path, nil)
	if err != nil || size == 0 {
		return ""
	}
	block := make([]byte, size)
	if windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&block[0])) != nil {
		return ""
	}
	var keys []string
	var translations *uint16
	var n uint32
	if windows.VerQueryValue(unsafe.Pointer(&block[0]), `\VarFileInfo\Translation`, unsafe.Pointer(&translations), &n) == nil && translations != nil {
		pairs := unsafe.Slice(translations, n/2)
		for i := 0; i+1 < len(pairs); i += 2 {
			keys = append(keys, fmt.Sprintf("%04x%04x", pairs[i], pairs[i+1]))
		}
	}
	keys = append(keys, "040904b0", "040904e4", "04090000", "000004b0")
	for _, k := range keys {
		var value *uint16
		var length uint32
		if windows.VerQueryValue(unsafe.Pointer(&block[0]), `\StringFileInfo\`+k+`\FileDescription`, unsafe.Pointer(&value), &length) != nil || value == nil || length == 0 {
			continue
		}
		if d := strings.TrimSpace(windows.UTF16PtrToString(value)); d != "" {
			return d
		}
	}
	return ""
}
