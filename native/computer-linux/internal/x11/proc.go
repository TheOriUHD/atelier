//go:build linux

package x11

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// procInfo is what /proc tells about a window's process.
type procInfo struct {
	// Exe is the executable's file name ("firefox"); Path its full path where it can be read.
	Exe, Path string
	// Other: it runs as another user (root): a window of it may be a password prompt, and its accessibility tree is on
	// another user's bus.
	Other bool
}

// procs caches what /proc says for the pids seen in one call.
type procs struct {
	me   int
	seen map[uint32]procInfo
}

func newProcs() *procs { return &procs{me: os.Getuid(), seen: map[uint32]procInfo{}} }

func (p *procs) get(pid uint32) procInfo {
	if pid == 0 {
		return procInfo{}
	}
	if info, ok := p.seen[pid]; ok {
		return info
	}
	info := readProc(pid, p.me)
	p.seen[pid] = info
	return info
}

func readProc(pid uint32, me int) procInfo {
	dir := "/proc/" + strconv.Itoa(int(pid))
	var info procInfo
	if path, err := os.Readlink(dir + "/exe"); err == nil {
		// A deleted binary (an app updated while it runs) reads "… (deleted)".
		info.Path = strings.TrimSuffix(path, " (deleted)")
		info.Exe = filepath.Base(info.Path)
	}
	if data, err := os.ReadFile(dir + "/status"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			switch {
			case strings.HasPrefix(line, "Name:") && info.Exe == "":
				info.Exe = strings.TrimSpace(strings.TrimPrefix(line, "Name:"))
			case strings.HasPrefix(line, "Uid:"):
				// real, effective, saved, filesystem
				fields := strings.Fields(strings.TrimPrefix(line, "Uid:"))
				if len(fields) > 0 {
					if uid, err := strconv.Atoi(fields[0]); err == nil && uid != me {
						info.Other = true
					}
				}
			}
		}
	}
	return info
}

// pidsByExe are the processes of this user running a program of that file name.
func pidsByExe(name string) []uint32 {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []uint32
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if path, err := os.Readlink("/proc/" + e.Name() + "/exe"); err == nil && filepath.Base(path) == name {
			out = append(out, uint32(pid))
		}
	}
	return out
}
