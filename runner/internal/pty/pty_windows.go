//go:build windows

package pty

import (
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/x/xpty"
)

// Windows has no hangup signal, so Close kills the process tree right away.
const killDelay = 0

func prepare(*exec.Cmd) {}

func release(xpty.Pty) {}

func hangup(*exec.Cmd) {}

func loginArgs(shell string) []string {
	switch strings.ToLower(filepath.Base(shell)) {
	case "bash.exe":
		return []string{"--login", "-i"}
	case "pwsh.exe", "powershell.exe":
		return []string{"-NoLogo"}
	}
	return nil
}
