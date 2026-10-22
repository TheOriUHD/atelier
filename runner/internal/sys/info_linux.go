package sys

import (
	"os"
	"strconv"
	"strings"

	"atelier.dev/runner/internal/rpc"
)

func cpuModel() string {
	data, _ := os.ReadFile("/proc/cpuinfo")
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "model name" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func memInfo() rpc.MemInfo {
	data, _ := os.ReadFile("/proc/meminfo")
	var m rpc.MemInfo
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			m.Total = kb * 1024
		case "MemAvailable:":
			m.Available = kb * 1024
		}
	}
	return m
}

func loadAvg() *[3]float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	f := strings.Fields(string(data))
	if len(f) < 3 {
		return nil
	}
	var load [3]float64
	for i := range load {
		load[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return &load
}

func gitUsable(string) bool { return true }
