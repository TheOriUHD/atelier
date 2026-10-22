package shell

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

type recorder struct {
	mu     sync.Mutex
	chunks map[string][]string
}

func (r *recorder) notify(method string, params any) {
	if n, ok := params.(rpc.ShellOutputNotification); ok && method == "shell.output" {
		r.mu.Lock()
		r.chunks[n.ExecID] = append(r.chunks[n.ExecID], n.Chunk)
		r.mu.Unlock()
	}
}

func (r *recorder) get(id string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.chunks[id]...)
}

type fixture struct {
	m     *Manager
	rec   *recorder
	root  string
	shell string
}

func setup(t *testing.T) fixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	if err := os.MkdirAll(filepath.Join(root, "sub", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	scope, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	rec := &recorder{chunks: map[string][]string{}}
	m := NewManager(scope, rec.notify, t.TempDir())
	t.Cleanup(m.CloseAll)
	res, err := m.Open(context.Background(), rpc.ShellOpenParams{Env: map[string]string{"ATELIER_TEST": "yes"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Cwd != root {
		t.Fatalf("shell cwd = %q, want %q", res.Cwd, root)
	}
	return fixture{m: m, rec: rec, root: root, shell: res.ShellID}
}

func (f fixture) exec(t *testing.T, command string, timeoutMs int64) rpc.ShellExecResult {
	t.Helper()
	res, err := f.m.Exec(context.Background(), rpc.ShellExecParams{ShellID: f.shell, Command: command, TimeoutMs: timeoutMs})
	if err != nil {
		t.Fatalf("%s: %v", command, err)
	}
	return res
}

func TestSessionSemantics(t *testing.T) {
	f := setup(t)
	res := f.exec(t, "cd sub && export FOO=bar && alias ll='ls -l' && echo $ATELIER_TEST", 0)
	if *res.ExitCode != 0 || res.Output != "yes\n" || res.Cwd != filepath.Join(f.root, "sub") {
		t.Fatalf("first command: %+v", res)
	}
	res = f.exec(t, `pwd; echo "FOO=${FOO:-unset}"; type ll >/dev/null 2>&1 || echo no-alias; exit 3`, 0)
	want := filepath.ToSlash(filepath.Join(f.root, "sub")) + "\nFOO=unset\nno-alias\n"
	if *res.ExitCode != 3 || !strings.HasSuffix(res.Output, want[strings.Index(want, "\n"):]) || res.Cwd != filepath.Join(f.root, "sub") {
		t.Fatalf("cwd must persist, exports and aliases must not, exit code must survive: %+v", res)
	}
	res = f.exec(t, "cd deeper; echo err >&2; false", 0)
	if *res.ExitCode != 1 || res.Output != "err\n" || res.Cwd != filepath.Join(f.root, "sub", "deeper") {
		t.Fatalf("stderr is captured, cwd follows a failing command: %+v", res)
	}
	res = f.exec(t, "cd /", 0)
	if res.Cwd != f.root {
		t.Fatalf("leaving the workspace resets cwd to the shell's start: %q", res.Cwd)
	}
	if got := strings.Join(f.rec.get(res.ExecID), ""); got != "" {
		t.Errorf("unexpected output %q", got)
	}
}

func TestStreamingKeepsUTF8Intact(t *testing.T) {
	f := setup(t)
	res := f.exec(t, `printf 'caf\303'; sleep 0.2; printf '\251\n'; printf 'done\n'`, 0)
	if res.Output != "café\ndone\n" {
		t.Fatalf("output %q", res.Output)
	}
	chunks := f.rec.get(res.ExecID)
	for _, c := range chunks {
		if !utf8.ValidString(c) {
			t.Errorf("chunk %q splits a character", c)
		}
	}
	if strings.Join(chunks, "") != res.Output || len(chunks) < 2 {
		t.Errorf("streamed %q", chunks)
	}
}

func TestTimeoutKillsProcessGroup(t *testing.T) {
	f := setup(t)
	pidFile := filepath.Join(f.root, "bg.pid")
	start := time.Now()
	res := f.exec(t, "sleep 30 & echo $! > bg.pid; sleep 30", 500)
	if !res.TimedOut || *res.ExitCode == 0 || time.Since(start) > 10*time.Second {
		t.Fatalf("timeout: %+v after %v", res, time.Since(start))
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	waitDead(t, pid)
}

func TestBackgroundReadAndKill(t *testing.T) {
	f := setup(t)
	res, err := f.m.Exec(context.Background(), rpc.ShellExecParams{ShellID: f.shell, Command: "for i in 1 2 3; do echo line$i; sleep 0.05; done; sleep 30", Background: true, ExecID: "bg-1"})
	if err != nil || res.ExecID != "bg-1" || res.ExitCode != nil {
		t.Fatalf("background start: %+v, %v", res, err)
	}
	var out strings.Builder
	var offset int64
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(out.String(), "line3") {
		if time.Now().After(deadline) {
			t.Fatalf("background output never arrived: %q", out.String())
		}
		r, err := f.m.Read(context.Background(), rpc.ShellReadParams{ExecID: "bg-1", SinceOffset: offset})
		if err != nil || !r.Running {
			t.Fatalf("read: %+v, %v", r, err)
		}
		out.WriteString(r.Output)
		offset = r.Offset
		time.Sleep(20 * time.Millisecond)
	}
	if out.String() != "line1\nline2\nline3\n" {
		t.Fatalf("background output %q", out.String())
	}
	if len(f.rec.get("bg-1")) != 0 {
		t.Error("background output was streamed as notifications")
	}
	if k, err := f.m.Kill(context.Background(), rpc.ShellKillParams{ExecID: "bg-1"}); err != nil || !k.Killed {
		t.Fatalf("kill: %+v, %v", k, err)
	}
	for {
		r, err := f.m.Read(context.Background(), rpc.ShellReadParams{ExecID: "bg-1", SinceOffset: 0})
		if err != nil {
			t.Fatal(err)
		}
		if !r.Running {
			if r.ExitCode == nil || *r.ExitCode == 0 || r.Output != "line1\nline2\nline3\n" {
				t.Fatalf("after kill: %+v", r)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("killed command still running")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if k, _ := f.m.Kill(context.Background(), rpc.ShellKillParams{ExecID: "bg-1"}); k.Killed {
		t.Error("killing a finished command reported success")
	}
	if _, err := f.m.Exec(context.Background(), rpc.ShellExecParams{ShellID: f.shell, Command: "true", ExecID: "bg-1"}); err == nil {
		t.Error("duplicate execId accepted")
	}
}

func TestCancelKillsForegroundCommand(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	start := time.Now()
	_, err := f.m.Exec(ctx, rpc.ShellExecParams{ShellID: f.shell, Command: "echo started; sleep 30"})
	if !errors.Is(err, context.Canceled) || time.Since(start) > 10*time.Second {
		t.Fatalf("cancel: %v after %v", err, time.Since(start))
	}
	// The shell stays usable.
	if res := f.exec(t, "echo ok", 0); res.Output != "ok\n" {
		t.Fatalf("after cancel: %+v", res)
	}
}

func TestCloseAndUnknownIDs(t *testing.T) {
	f := setup(t)
	if _, err := f.m.Exec(context.Background(), rpc.ShellExecParams{ShellID: f.shell, Command: "sleep 30", Background: true, ExecID: "bg"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.m.Close(context.Background(), rpc.ShellCloseParams{ShellID: f.shell}); err != nil {
		t.Fatal(err)
	}
	restarted := func(err error) bool {
		var e *rpc.Error
		return errors.As(err, &e) && e.Code == rpc.CodeShellRestarted
	}
	if _, err := f.m.Exec(context.Background(), rpc.ShellExecParams{ShellID: f.shell, Command: "true"}); !restarted(err) {
		t.Errorf("exec on closed shell: %v", err)
	}
	if _, err := f.m.Read(context.Background(), rpc.ShellReadParams{ExecID: "bg"}); !restarted(err) {
		t.Errorf("read of a closed shell's exec: %v", err)
	}
	if _, err := f.m.Kill(context.Background(), rpc.ShellKillParams{ExecID: "nope"}); !restarted(err) {
		t.Errorf("kill unknown: %v", err)
	}
	if _, err := f.m.Open(context.Background(), rpc.ShellOpenParams{Cwd: "/"}); err == nil {
		t.Error("shell.open outside the workspace accepted")
	}
}

func TestOutputIsCapped(t *testing.T) {
	f := setup(t)
	res := f.exec(t, `i=0; while [ $i -lt 1100 ]; do printf '%01023d\n' $i; i=$((i+1)); done`, 0)
	if !res.Truncated || !strings.Contains(res.Output, "bytes of output truncated") {
		t.Fatalf("not truncated: len=%d", len(res.Output))
	}
	if !strings.HasPrefix(res.Output, strings.Repeat("0", 1023)+"\n") || !strings.HasSuffix(res.Output, "1099\n") || len(res.Output) > headCap+tailCap+100 {
		t.Fatalf("head/tail wrong: len=%d", len(res.Output))
	}
	streamed := 0
	for _, c := range f.rec.get(res.ExecID) {
		streamed += len(c)
	}
	if streamed > headCap+tailCap+64<<10 {
		t.Errorf("streamed %d bytes past the cap", streamed)
	}
}
