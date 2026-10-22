//go:build unix

package shell

import (
	"syscall"
	"testing"
	"time"
)

// waitDead fails unless pid disappears within a few seconds.
func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("process %d from the timed-out command's group is still alive", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
