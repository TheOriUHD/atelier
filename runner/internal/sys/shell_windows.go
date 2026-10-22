//go:build windows

package sys

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// DefaultShell is the shell a Windows terminal opens: PowerShell 7 if installed, else Windows PowerShell.
func DefaultShell() string {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	if c := os.Getenv("ComSpec"); c != "" {
		return c
	}
	return "cmd.exe"
}

// ExecShell is what shell.exec runs commands with: Git Bash when present, else PowerShell.
func ExecShell() (path, kind string) {
	if gb := GitBash(); gb != "" {
		return gb, "bash"
	}
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		return p, "powershell"
	}
	return "powershell.exe", "powershell"
}

// GitBash finds Git for Windows' bash.exe next to git on PATH or in the default install locations.
var GitBash = sync.OnceValue(func() string {
	var candidates []string
	if git, err := exec.LookPath("git.exe"); err == nil {
		// git.exe lives in <Git>\cmd or <Git>\mingw64\bin.
		dir := filepath.Dir(git)
		candidates = append(candidates, filepath.Join(dir, "..", "bin", "bash.exe"), filepath.Join(dir, "..", "..", "bin", "bash.exe"))
	}
	for _, env := range []string{"ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"} {
		if dir := os.Getenv(env); dir != "" {
			candidates = append(candidates, filepath.Join(dir, "Git", "bin", "bash.exe"))
		}
	}
	if dir := os.Getenv("LocalAppData"); dir != "" {
		candidates = append(candidates, filepath.Join(dir, "Programs", "Git", "bin", "bash.exe"))
	}
	for _, c := range candidates {
		if isExecutable(c) {
			return filepath.Clean(c)
		}
	}
	return ""
})
