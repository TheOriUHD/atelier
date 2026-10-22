package proc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
)

func setup(t *testing.T) (*fsops.Scope, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := fsops.NewScope(root)
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestExec(t *testing.T) {
	s, root := setup(t)
	stdin := "from stdin\n"
	res, err := Exec(context.Background(), s, rpc.ProcExecParams{
		Argv:  []string{"sh", "-c", `pwd; cat; echo "$ATELIER_X"; echo oops >&2; exit 4`, "ignored-$0"},
		Cwd:   "sub",
		Env:   map[string]string{"ATELIER_X": "x-value"},
		Stdin: &stdin,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "sub") + "\nfrom stdin\nx-value\n"
	if res.ExitCode != 4 || res.Stdout != want || res.Stderr != "oops\n" || res.TimedOut || res.Truncated {
		t.Fatalf("got %+v", res)
	}
	// Arguments are passed verbatim, never through a shell.
	res, err = Exec(context.Background(), s, rpc.ProcExecParams{Argv: []string{"echo", "$HOME", "a;b", "`x`"}})
	if err != nil || res.Stdout != "$HOME a;b `x`\n" {
		t.Fatalf("argv: %+v, %v", res, err)
	}
}

func TestExecTimeoutCancelAndErrors(t *testing.T) {
	s, _ := setup(t)
	start := time.Now()
	res, err := Exec(context.Background(), s, rpc.ProcExecParams{Argv: []string{"sh", "-c", "sleep 30 & sleep 30"}, TimeoutMs: 300})
	if err != nil || !res.TimedOut || res.ExitCode == 0 || time.Since(start) > 10*time.Second {
		t.Fatalf("timeout: %+v, %v after %v", res, err, time.Since(start))
	}

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(200*time.Millisecond, cancel)
	if _, err := Exec(ctx, s, rpc.ProcExecParams{Argv: []string{"sleep", "30"}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}

	if _, err := Exec(context.Background(), s, rpc.ProcExecParams{Argv: []string{"definitely-not-a-command-xyz"}}); err == nil || !strings.Contains(rpc.FromError(err).Data["code"].(string), "ENOENT") {
		t.Errorf("missing executable: %v", err)
	}
	if _, err := Exec(context.Background(), s, rpc.ProcExecParams{Argv: []string{"true"}, Cwd: "/"}); err == nil {
		t.Error("cwd outside the workspace accepted")
	}
	if _, err := Exec(context.Background(), s, rpc.ProcExecParams{}); err == nil {
		t.Error("empty argv accepted")
	}
}

func TestMergeEnv(t *testing.T) {
	got := MergeEnv([]string{"A=1", "B=2", "PATH=/bin"}, map[string]string{"B": "3", "C": "4"})
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "A=1") || !strings.Contains(joined, "B=3") || strings.Contains(joined, "B=2") || !strings.Contains(joined, "C=4") {
		t.Errorf("MergeEnv = %v", got)
	}
}
