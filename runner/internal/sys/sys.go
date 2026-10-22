// Package sys reports host facts: sys.info, the user's shells and Git Bash on Windows.
package sys

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"atelier.dev/runner/internal/proc"
	"atelier.dev/runner/internal/rpc"
)

func Info(ctx context.Context, primaryRoot, runnerVersion string) rpc.SysInfoResult {
	host, _ := os.Hostname()
	res := rpc.SysInfoResult{
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		Hostname:      host,
		RunnerVersion: runnerVersion,
		CPU:           rpc.CPUInfo{Count: runtime.NumCPU(), Model: cpuModel()},
		Mem:           memInfo(),
		Disk:          diskInfo(primaryRoot),
		Load:          loadAvg(),
		GitVersion:    gitVersion(ctx),
		DefaultShell:  DefaultShell(),
	}
	if gb := GitBash(); gb != "" {
		res.GitBash = &gb
	}
	return res
}

func gitVersion(ctx context.Context) *string {
	path, err := exec.LookPath("git")
	if err != nil || !gitUsable(path) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	proc.NewGroup(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	v := strings.TrimSpace(strings.TrimPrefix(string(out), "git version "))
	return &v
}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir() && (runtime.GOOS == "windows" || fi.Mode()&0o111 != 0)
}
