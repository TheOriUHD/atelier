package sys

import (
	"context"
	"runtime"
	"testing"
)

func TestInfo(t *testing.T) {
	dir := t.TempDir()
	info := Info(context.Background(), dir, "test")
	if info.OS != runtime.GOOS || info.Arch != runtime.GOARCH || info.RunnerVersion != "test" {
		t.Errorf("identity: %+v", info)
	}
	if info.CPU.Count < 1 || info.Mem.Total == 0 || info.Disk.Total == 0 || info.Disk.Path != dir {
		t.Errorf("resources: %+v", info)
	}
	if (info.Load == nil) != (runtime.GOOS == "windows") {
		t.Errorf("load: %v", info.Load)
	}
	if info.DefaultShell == "" {
		t.Error("no default shell")
	}
	if (info.GitBash != nil) && runtime.GOOS != "windows" {
		t.Error("Git Bash reported off Windows")
	}
	if path, kind := ExecShell(); path == "" || kind == "" {
		t.Errorf("ExecShell() = %q, %q", path, kind)
	}
}
