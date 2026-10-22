// Package proc implements proc.exec (argv without a shell) and the process-group helpers that
// shell and pty share.
package proc

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

const maxStreamBytes = 16 << 20 // per stdout/stderr

func Exec(ctx context.Context, scope *fsops.Scope, p rpc.ProcExecParams) (rpc.ProcExecResult, error) {
	if len(p.Argv) == 0 || p.Argv[0] == "" {
		return rpc.ProcExecResult{}, rpc.InvalidParams("argv must not be empty")
	}
	cwd, err := scope.ResolveDir(p.Cwd)
	if err != nil {
		return rpc.ProcExecResult{}, err
	}
	runCtx := ctx
	if p.TimeoutMs > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, time.Duration(p.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	cmd := exec.CommandContext(runCtx, p.Argv[0], p.Argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = MergeEnv(os.Environ(), p.Env)
	NewGroup(cmd)
	cmd.Cancel = func() error { return KillGroup(cmd.Process) }
	cmd.WaitDelay = time.Second
	stdout, stderr := &capped{max: maxStreamBytes}, &capped{max: maxStreamBytes}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if p.Stdin != nil {
		cmd.Stdin = strings.NewReader(*p.Stdin)
	}
	err = cmd.Run()
	if cmd.ProcessState == nil {
		return rpc.ProcExecResult{}, err
	}
	if ctx.Err() != nil {
		return rpc.ProcExecResult{}, ctx.Err()
	}
	return rpc.ProcExecResult{
		ExitCode:  ExitCode(cmd.ProcessState),
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		TimedOut:  errors.Is(runCtx.Err(), context.DeadlineExceeded),
		Truncated: stdout.truncated || stderr.truncated,
	}, nil
}

// MergeEnv overlays overrides on a KEY=value list (case-insensitively on Windows).
func MergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	key := func(k string) string { return k }
	if runtime.GOOS == "windows" {
		key = strings.ToUpper
	}
	replaced := make(map[string]bool, len(overrides))
	for k := range overrides {
		replaced[key(k)] = true
	}
	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		if k, _, _ := strings.Cut(kv, "="); !replaced[key(k)] {
			out = append(out, kv)
		}
	}
	for k, v := range overrides {
		out = append(out, k+"="+v)
	}
	return out
}

// capped keeps the first max bytes written to it.
type capped struct {
	bytes.Buffer
	max       int
	truncated bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); len(p) > room {
		c.Buffer.Write(p[:max(room, 0)])
		c.truncated = true
		return len(p), nil
	}
	return c.Buffer.Write(p)
}
