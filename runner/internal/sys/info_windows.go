package sys

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/runner/internal/rpc"
)

func cpuModel() string { return os.Getenv("PROCESSOR_IDENTIFIER") }

var globalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

func memInfo() rpc.MemInfo {
	// MEMORYSTATUSEX
	var s struct {
		Length               uint32
		MemoryLoad           uint32
		TotalPhys            uint64
		AvailPhys            uint64
		TotalPageFile        uint64
		AvailPageFile        uint64
		TotalVirtual         uint64
		AvailVirtual         uint64
		AvailExtendedVirtual uint64
	}
	s.Length = uint32(unsafe.Sizeof(s))
	if r, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&s))); r == 0 {
		return rpc.MemInfo{}
	}
	return rpc.MemInfo{Total: s.TotalPhys, Available: s.AvailPhys}
}

func loadAvg() *[3]float64 { return nil }

func gitUsable(string) bool { return true }

func diskInfo(path string) rpc.DiskInfo {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return rpc.DiskInfo{Path: path}
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
		return rpc.DiskInfo{Path: path}
	}
	return rpc.DiskInfo{Path: path, Total: total, Free: free}
}
