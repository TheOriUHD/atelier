//go:build windows

package proc

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000 // CREATE_NO_WINDOW: no console window flashes up for console programs

// NewGroup starts cmd in a new process group without a console window.
func NewGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow}
}

// KillGroup kills p and every process it started.
func KillGroup(p *os.Process) error {
	if p == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.Pid))
	kill.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	if err := kill.Run(); err != nil {
		return p.Kill()
	}
	return nil
}

func ExitCode(state *os.ProcessState) int { return state.ExitCode() }
