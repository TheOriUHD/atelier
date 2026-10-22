//go:build windows

package shell

import "testing"

// waitDead: $! in Git Bash is an MSYS pid, not a Windows one, so the check is Unix-only.
func waitDead(t *testing.T, _ int) { t.Log("process-group liveness is checked on Unix only") }
