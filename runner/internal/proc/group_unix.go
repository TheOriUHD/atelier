//go:build unix

package proc

import (
	"os"
	"os/exec"
	"syscall"
)

// NewGroup makes cmd the leader of a new session and process group. Without a controlling
// terminal, nothing it spawns can block on reading /dev/tty.
func NewGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// KillGroup kills the process group led by p.
func KillGroup(p *os.Process) error {
	if p == nil {
		return nil
	}
	if err := syscall.Kill(-p.Pid, syscall.SIGKILL); err != nil {
		return p.Kill()
	}
	return nil
}

// ExitCode reports a shell-style exit code: 128+n when killed by signal n.
func ExitCode(state *os.ProcessState) int {
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return state.ExitCode()
}
