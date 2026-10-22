// Package pty runs the user's interactive terminals: a login shell on a PTY (ConPTY on Windows),
// streamed as pty.data notifications until pty.exit.
package pty

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/charmbracelet/x/xpty"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/proc"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/sys"
)

type Manager struct {
	scope  *fsops.Scope
	notify func(method string, params any)

	mu    sync.Mutex
	terms map[string]*term
	seq   int
}

type term struct {
	pty    xpty.Pty
	cmd    *exec.Cmd
	exited chan struct{}
}

func NewManager(scope *fsops.Scope, notify func(string, any)) *Manager {
	return &Manager{scope: scope, notify: notify, terms: map[string]*term{}}
}

func (m *Manager) Open(_ context.Context, p rpc.PtyOpenParams) (rpc.PtyOpenResult, error) {
	cwd, err := m.scope.ResolveDir(p.Cwd)
	if err != nil {
		return rpc.PtyOpenResult{}, err
	}
	cols, rows := p.Cols, p.Rows
	if cols == 0 && rows == 0 {
		cols, rows = 80, 24
	}
	if cols <= 0 || rows <= 0 {
		return rpc.PtyOpenResult{}, rpc.InvalidParams("cols and rows must be positive")
	}
	shell := p.Shell
	if shell == "" {
		shell = sys.DefaultShell()
	}
	path, err := exec.LookPath(shell)
	if err != nil {
		return rpc.PtyOpenResult{}, err
	}
	pt, err := xpty.NewPty(cols, rows)
	if err != nil {
		return rpc.PtyOpenResult{}, err
	}
	cmd := exec.Command(path, loginArgs(path)...)
	cmd.Dir = cwd
	cmd.Env = proc.MergeEnv(os.Environ(), map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor"})
	prepare(cmd)
	if err := pt.Start(cmd); err != nil {
		_ = pt.Close()
		return rpc.PtyOpenResult{}, err
	}
	release(pt)
	t := &term{pty: pt, cmd: cmd, exited: make(chan struct{})}
	m.mu.Lock()
	m.seq++
	id := fmt.Sprintf("pty-%d", m.seq)
	m.terms[id] = t
	m.mu.Unlock()
	go m.pump(id, t)
	return rpc.PtyOpenResult{PtyID: id, Shell: path, Pid: cmd.Process.Pid}, nil
}

// pump forwards output until the shell exits, then reports the exit.
func (m *Manager) pump(id string, t *term) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32<<10)
		for {
			n, err := t.pty.Read(buf)
			if n > 0 {
				m.notify("pty.data", rpc.PtyDataNotification{PtyID: id, B64: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}()
	_ = xpty.WaitProcess(context.Background(), t.cmd)
	close(t.exited)
	code := -1
	if t.cmd.ProcessState != nil {
		code = proc.ExitCode(t.cmd.ProcessState)
	}
	hangup(t.cmd) // background jobs lose the terminal, as when a terminal window closes
	select {
	case <-readDone:
	case <-time.After(250 * time.Millisecond):
	}
	_ = t.pty.Close()
	m.mu.Lock()
	delete(m.terms, id)
	m.mu.Unlock()
	m.notify("pty.exit", rpc.PtyExitNotification{PtyID: id, Code: code})
}

func (m *Manager) get(id string) (*term, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t := m.terms[id]; t != nil {
		return t, nil
	}
	return nil, rpc.ShellRestarted("unknown pty " + id)
}

func (m *Manager) Write(_ context.Context, p rpc.PtyWriteParams) (any, error) {
	t, err := m.get(p.PtyID)
	if err != nil {
		return nil, err
	}
	data := []byte(p.Data)
	switch p.Encoding {
	case "", "utf8":
	case "base64":
		if data, err = base64.StdEncoding.DecodeString(p.Data); err != nil {
			return nil, rpc.InvalidParams("data is not valid base64: %v", err)
		}
	default:
		return nil, rpc.InvalidParams("unknown encoding %q", p.Encoding)
	}
	_, err = t.pty.Write(data)
	return nil, err
}

func (m *Manager) Resize(_ context.Context, p rpc.PtyResizeParams) (any, error) {
	if p.Cols <= 0 || p.Rows <= 0 {
		return nil, rpc.InvalidParams("cols and rows must be positive")
	}
	t, err := m.get(p.PtyID)
	if err != nil {
		return nil, err
	}
	return nil, t.pty.Resize(p.Cols, p.Rows)
}

// Close hangs up the terminal and kills what is left of its session after a grace period.
// pty.exit follows once the shell is gone.
func (m *Manager) Close(_ context.Context, p rpc.PtyCloseParams) (any, error) {
	t, err := m.get(p.PtyID)
	if err != nil {
		return nil, err
	}
	hangup(t.cmd)
	go func() {
		select {
		case <-t.exited:
		case <-time.After(killDelay):
			select {
			case <-t.exited: // never signal a pid that may have been reused
			default:
				_ = proc.KillGroup(t.cmd.Process)
			}
		}
	}()
	return nil, nil
}

// CloseAll closes every terminal; used on shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	terms := make([]*term, 0, len(m.terms))
	for _, t := range m.terms {
		terms = append(terms, t)
	}
	m.mu.Unlock()
	for _, t := range terms {
		_ = proc.KillGroup(t.cmd.Process)
	}
}
