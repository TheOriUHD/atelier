//go:build unix

package sys

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// DefaultShell is the user's login shell.
func DefaultShell() string {
	if s := os.Getenv("SHELL"); s != "" && isExecutable(s) {
		return s
	}
	if data, err := os.ReadFile("/etc/passwd"); err == nil {
		uid := strconv.Itoa(os.Getuid())
		for _, line := range strings.Split(string(data), "\n") {
			if f := strings.Split(line, ":"); len(f) == 7 && f[2] == uid && isExecutable(f[6]) {
				return f[6]
			}
		}
	}
	if runtime.GOOS == "darwin" {
		return "/bin/zsh"
	}
	return "/bin/sh"
}

// ExecShell is what shell.exec runs commands with, and its kind: "bash", or "sh" without bash.
func ExecShell() (path, kind string) {
	for _, p := range []string{"/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"} {
		if isExecutable(p) {
			return p, "bash"
		}
	}
	if p, err := exec.LookPath("bash"); err == nil {
		return p, "bash"
	}
	return "/bin/sh", "sh"
}

// GitBash is only meaningful on Windows.
func GitBash() string { return "" }
