package sys

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"atelier.dev/runner/internal/rpc"
)

func cpuModel() string {
	s, _ := unix.Sysctl("machdep.cpu.brand_string")
	return s
}

func memInfo() rpc.MemInfo {
	total, _ := unix.SysctlUint64("hw.memsize")
	page, _ := unix.SysctlUint32("vm.pagesize")
	var pages uint64
	for _, name := range []string{"vm.page_free_count", "vm.page_speculative_count", "vm.page_purgeable_count", "vm.page_pageable_external_count"} {
		n, _ := unix.SysctlUint32(name)
		pages += uint64(n)
	}
	return rpc.MemInfo{Total: total, Available: pages * uint64(page)}
}

func loadAvg() *[3]float64 {
	// struct loadavg { fixpt_t ldavg[3]; long fscale; }
	b, err := unix.SysctlRaw("vm.loadavg")
	if err != nil || len(b) < 24 {
		return nil
	}
	scale := float64(binary.LittleEndian.Uint64(b[16:24]))
	var load [3]float64
	for i := range load {
		load[i] = float64(binary.LittleEndian.Uint32(b[i*4:])) / scale
	}
	return &load
}

// gitUsable rejects the /usr/bin/git stub, which pops up an installer when the Command Line Tools are missing.
func gitUsable(path string) bool {
	if path != "/usr/bin/git" {
		return true
	}
	out, err := exec.Command("/usr/bin/xcode-select", "-p").Output()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(strings.TrimSpace(string(out)), "usr", "bin", "git"))
	return err == nil
}
