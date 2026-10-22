package pty

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

type events struct {
	mu   sync.Mutex
	data strings.Builder
	exit chan int
}

func (e *events) notify(method string, params any) {
	switch n := params.(type) {
	case rpc.PtyDataNotification:
		b, _ := base64.StdEncoding.DecodeString(n.B64)
		e.mu.Lock()
		e.data.Write(b)
		e.mu.Unlock()
	case rpc.PtyExitNotification:
		e.exit <- n.Code
	}
}

func (e *events) output() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.data.String()
}

func setup(t *testing.T) (*Manager, *events, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	ev := &events{exit: make(chan int, 1)}
	m := NewManager(s, ev.notify)
	t.Cleanup(m.CloseAll)
	return m, ev, root
}

func waitFor(t *testing.T, ev *events, substr string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(ev.output(), substr) {
		if time.Now().After(deadline) {
			t.Fatalf("never saw %q in %q", substr, ev.output())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTerminalSession(t *testing.T) {
	m, ev, root := setup(t)
	res, err := m.Open(context.Background(), rpc.PtyOpenParams{Shell: "/bin/sh", Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Write(context.Background(), rpc.PtyWriteParams{PtyID: res.PtyID, Data: "pwd; [ -t 0 ] && echo is-a-tty; stty size\n"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ev, root)
	waitFor(t, ev, "is-a-tty")
	waitFor(t, ev, "30 100")
	if _, err := m.Resize(context.Background(), rpc.PtyResizeParams{PtyID: res.PtyID, Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Write(context.Background(), rpc.PtyWriteParams{PtyID: res.PtyID, Data: base64.StdEncoding.EncodeToString([]byte("stty size; exit 7\n")), Encoding: "base64"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ev, "40 120")
	select {
	case code := <-ev.exit:
		if code != 7 {
			t.Fatalf("exit code %d, want 7", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no pty.exit")
	}
	var e *rpc.Error
	if _, err := m.Write(context.Background(), rpc.PtyWriteParams{PtyID: res.PtyID, Data: "x"}); !errors.As(err, &e) || e.Code != rpc.CodeShellRestarted {
		t.Errorf("write after exit: %v", err)
	}
}

func TestCloseEndsSession(t *testing.T) {
	m, ev, _ := setup(t)
	res, err := m.Open(context.Background(), rpc.PtyOpenParams{Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Close(context.Background(), rpc.PtyCloseParams{PtyID: res.PtyID}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ev.exit:
	case <-time.After(10 * time.Second):
		t.Fatal("no pty.exit after close")
	}
	if _, err := m.Open(context.Background(), rpc.PtyOpenParams{Cwd: "/"}); err == nil {
		t.Error("pty.open outside the workspace accepted")
	}
}
