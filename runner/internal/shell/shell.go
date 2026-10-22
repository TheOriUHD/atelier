// Package shell implements the Bash tool's session semantics: each command runs as `bash -c` in a
// new process group, in the cwd left behind by the previous command and with the login-shell
// environment captured at shell.open. cwd persists between commands; exports, aliases and
// sourced files do not. The cwd is recorded by an EXIT trap into a temp file, never parsed
// from output.
package shell

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/proc"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/sys"
)

const defaultTimeout = 120 * time.Second

type Manager struct {
	scope  *fsops.Scope
	notify func(method string, params any)
	tmpDir string
	path   string // the shell commands run with
	kind   string // bash | sh | powershell

	mu     sync.Mutex
	shells map[string]*shell
	execs  map[string]*execution
	seq    int
}

type shell struct {
	id         string
	env        []string
	initialCwd string
	cwd        string     // guarded by Manager.mu
	run        sync.Mutex // one foreground command at a time, since it moves cwd
}

type execution struct {
	id      string
	shellID string
	out     output
	cancel  context.CancelFunc
	done    chan struct{}
	code    int // valid once done is closed
}

func (x *execution) state() (running bool, code *int) {
	select {
	case <-x.done:
		c := x.code
		return false, &c
	default:
		return true, nil
	}
}

// NewManager keeps per-command cwd files in tmpDir.
func NewManager(scope *fsops.Scope, notify func(string, any), tmpDir string) *Manager {
	path, kind := sys.ExecShell()
	return &Manager{scope: scope, notify: notify, tmpDir: tmpDir, path: path, kind: kind, shells: map[string]*shell{}, execs: map[string]*execution{}}
}

// Kind is what commands run with: bash, sh or powershell.
func (m *Manager) Kind() string { return m.kind }

func (m *Manager) Open(ctx context.Context, p rpc.ShellOpenParams) (rpc.ShellOpenResult, error) {
	cwd, err := m.scope.ResolveDir(p.Cwd)
	if err != nil {
		return rpc.ShellOpenResult{}, err
	}
	env := proc.MergeEnv(loginEnv(ctx), p.Env)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	sh := &shell{id: fmt.Sprintf("shell-%d", m.seq), env: env, initialCwd: cwd, cwd: cwd}
	m.shells[sh.id] = sh
	return rpc.ShellOpenResult{ShellID: sh.id, Cwd: cwd}, nil
}

func (m *Manager) Exec(ctx context.Context, p rpc.ShellExecParams) (rpc.ShellExecResult, error) {
	if strings.TrimSpace(p.Command) == "" {
		return rpc.ShellExecResult{}, rpc.InvalidParams("command must not be empty")
	}
	if p.TimeoutMs < 0 {
		return rpc.ShellExecResult{}, rpc.InvalidParams("timeoutMs must not be negative")
	}
	m.mu.Lock()
	sh := m.shells[p.ShellID]
	m.mu.Unlock()
	if sh == nil {
		return rpc.ShellExecResult{}, rpc.ShellRestarted("unknown shell " + p.ShellID)
	}
	if !p.Background {
		sh.run.Lock()
		defer sh.run.Unlock()
		if ctx.Err() != nil { // cancelled while queued behind another command
			return rpc.ShellExecResult{}, ctx.Err()
		}
	}
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout == 0 && !p.Background {
		timeout = defaultTimeout
	}
	runCtx, cancel := context.WithCancel(context.Background()) // not the request's: background commands outlive it
	if timeout > 0 {
		runCtx, cancel = context.WithTimeout(runCtx, timeout)
	}
	x, seq, cwd, err := m.start(sh, p.ExecID, cancel)
	if err != nil {
		cancel()
		return rpc.ShellExecResult{}, err
	}
	cwdFile := filepath.Join(m.tmpDir, fmt.Sprintf("cwd-%d", seq))
	cmd := exec.CommandContext(runCtx, m.path, commandArgs(m.kind, p.Command, cwdFile)...)
	cmd.Dir = cwd
	cmd.Env = proc.MergeEnv(sh.env, map[string]string{"PWD": cwd})
	proc.NewGroup(cmd)
	cmd.Cancel = func() error { return proc.KillGroup(cmd.Process) }
	cmd.WaitDelay = 200 * time.Millisecond // stop reading once the command exits, even if a child it left behind holds the pipe
	st := &stream{out: &x.out, execID: x.id}
	if !p.Background {
		st.notify = m.notify
	}
	cmd.Stdout, cmd.Stderr = st, st

	started := time.Now()
	if err := cmd.Start(); err != nil {
		cancel()
		m.forget(x.id)
		return rpc.ShellExecResult{}, err
	}
	wait := func() (timedOut bool) {
		_ = cmd.Wait()
		st.flush()
		timedOut = errors.Is(runCtx.Err(), context.DeadlineExceeded)
		cancel()
		x.code = proc.ExitCode(cmd.ProcessState)
		close(x.done)
		return timedOut
	}
	if p.Background {
		go func() {
			wait()
			_ = os.Remove(cwdFile)
		}()
		return rpc.ShellExecResult{ExecID: x.id, Cwd: cwd}, nil
	}

	stop := context.AfterFunc(ctx, cancel) // $/cancel kills the command
	timedOut := wait()
	stop()
	m.forget(x.id)
	newCwd := m.updateCwd(sh, cwdFile)
	if ctx.Err() != nil {
		return rpc.ShellExecResult{}, ctx.Err()
	}
	text, truncated := x.out.text()
	code := x.code
	return rpc.ShellExecResult{
		ExecID:     x.id,
		ExitCode:   &code,
		Cwd:        newCwd,
		DurationMs: time.Since(started).Milliseconds(),
		Output:     text,
		Truncated:  truncated,
		TimedOut:   timedOut,
	}, nil
}

// start registers an execution and returns it with a unique sequence number and the cwd to run in.
func (m *Manager) start(sh *shell, execID string, cancel context.CancelFunc) (*execution, int, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	if execID == "" {
		execID = fmt.Sprintf("exec-%d", m.seq)
	}
	if _, dup := m.execs[execID]; dup {
		return nil, 0, "", rpc.InvalidParams("execId %s is already in use", execID)
	}
	if fi, err := os.Stat(sh.cwd); err != nil || !fi.IsDir() {
		sh.cwd = sh.initialCwd // the directory was removed since
	}
	x := &execution{id: execID, shellID: sh.id, cancel: cancel, done: make(chan struct{})}
	m.execs[execID] = x
	return x, m.seq, sh.cwd, nil
}

func (m *Manager) forget(execID string) {
	m.mu.Lock()
	delete(m.execs, execID)
	m.mu.Unlock()
}

// updateCwd adopts the directory the command ended in. Leaving the workspace resets to the
// directory the shell was opened in.
func (m *Manager) updateCwd(sh *shell, cwdFile string) string {
	data, err := os.ReadFile(cwdFile)
	_ = os.Remove(cwdFile)
	m.mu.Lock()
	defer m.mu.Unlock()
	if dir := strings.TrimSpace(string(data)); err == nil && dir != "" {
		if real, err := m.scope.ResolveDir(filepath.Clean(filepath.FromSlash(dir))); err == nil {
			sh.cwd = real
		} else {
			sh.cwd = sh.initialCwd
		}
	}
	return sh.cwd
}

func (m *Manager) Read(_ context.Context, p rpc.ShellReadParams) (rpc.ShellReadResult, error) {
	m.mu.Lock()
	x := m.execs[p.ExecID]
	m.mu.Unlock()
	if x == nil {
		return rpc.ShellReadResult{}, rpc.ShellRestarted("unknown exec " + p.ExecID)
	}
	running, code := x.state()
	data, next, skipped := x.out.since(p.SinceOffset, !running)
	return rpc.ShellReadResult{Output: string(data), Offset: next, Running: running, ExitCode: code, Truncated: skipped}, nil
}

func (m *Manager) Kill(_ context.Context, p rpc.ShellKillParams) (rpc.ShellKillResult, error) {
	m.mu.Lock()
	x := m.execs[p.ExecID]
	m.mu.Unlock()
	if x == nil {
		return rpc.ShellKillResult{}, rpc.ShellRestarted("unknown exec " + p.ExecID)
	}
	running, _ := x.state()
	if running {
		x.cancel()
	}
	return rpc.ShellKillResult{Killed: running}, nil
}

// Close kills the shell's running commands and forgets it. Closing an unknown shell is a no-op.
func (m *Manager) Close(_ context.Context, p rpc.ShellCloseParams) (any, error) {
	m.mu.Lock()
	delete(m.shells, p.ShellID)
	var victims []*execution
	for id, x := range m.execs {
		if x.shellID == p.ShellID {
			victims = append(victims, x)
			delete(m.execs, id)
		}
	}
	m.mu.Unlock()
	for _, x := range victims {
		x.cancel()
	}
	return nil, nil
}

// CloseAll kills every command; used on shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.shells))
	for id := range m.shells {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_, _ = m.Close(context.Background(), rpc.ShellCloseParams{ShellID: id})
	}
}

// bashArgs runs command with an EXIT trap that records the final cwd (printed by pwd) into cwdFile.
func bashArgs(pwd, command, cwdFile string) []string {
	return []string{"-c", "__atelier_cwd=" + shQuote(cwdFile) + "\ntrap '" + pwd + " >| \"$__atelier_cwd\"' EXIT\n" + command}
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
