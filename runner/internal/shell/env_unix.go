//go:build unix

package shell

import (
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"atelier.dev/runner/internal/proc"
	"atelier.dev/runner/internal/sys"
)

func commandArgs(_, command, cwdFile string) []string { return bashArgs("pwd -P", command, cwdFile) }

const envMarker = "__ATELIER_ENV__"

// loginEnv snapshots the environment of an interactive login shell, so commands see the PATH and
// variables the user's profile and rc files set up. Falls back to the runner's own environment.
func loginEnv(ctx context.Context) []string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, sys.DefaultShell(), "-l", "-i", "-c", "printf '\\n%s\\n' "+envMarker+"; env -0")
	proc.NewGroup(cmd)
	cmd.Cancel = func() error { return proc.KillGroup(cmd.Process) }
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	i := bytes.Index(out, []byte(envMarker+"\n"))
	if err != nil || i < 0 {
		log.Printf("login shell environment unavailable (%v); using the runner's environment", err)
		return os.Environ()
	}
	var env []string
	for _, kv := range strings.Split(string(out[i+len(envMarker)+1:]), "\x00") {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		switch k {
		case "PWD", "OLDPWD", "SHLVL", "_":
			continue
		}
		env = append(env, kv)
	}
	return env
}
