//go:build unix

package pty

import (
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"github.com/charmbracelet/x/xpty"
)

const killDelay = 2 * time.Second

// prepare makes the shell a session leader with the PTY as its controlling terminal.
func prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
}

// release closes the runner's copy of the PTY's slave side, so reads end once the session does.
func release(pt xpty.Pty) {
	if u, ok := pt.(*xpty.UnixPty); ok {
		_ = u.Slave().Close()
	}
}

func hangup(cmd *exec.Cmd) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
}

func loginArgs(shell string) []string {
	if slices.Contains([]string{"bash", "zsh", "sh", "ksh", "dash", "fish", "tcsh", "csh"}, filepath.Base(shell)) {
		return []string{"-l"}
	}
	return nil
}
