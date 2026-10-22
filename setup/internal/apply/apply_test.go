package apply

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"atelier.dev/setup/internal/plan"
)

func testPlan(t *testing.T) (plan.Plan, plan.Answers) {
	t.Helper()
	a := plan.Defaults(true, "/root")
	a.Dir = filepath.Join(t.TempDir(), "atelier")
	a.Mode = plan.LAN
	a.Images = plan.Images{Local: true}
	a.SetupToken = "tok"
	p, err := plan.Build(a)
	if err != nil {
		t.Fatal(err)
	}
	return p, a
}

type fakeDocker struct {
	commands []string
	health   []string // statuses returned by successive inspects
	fail     map[string]error
}

func (f *fakeDocker) run(_ context.Context, _, name string, args []string, out func(string)) error {
	cmd := name + " " + strings.Join(args, " ")
	f.commands = append(f.commands, cmd)
	if err := f.fail[cmd]; err != nil {
		return err
	}
	switch {
	case strings.HasPrefix(cmd, "docker compose ps -q"):
		out("abc123")
	case strings.HasPrefix(cmd, "docker inspect"):
		s := "healthy"
		if len(f.health) > 0 {
			s, f.health = f.health[0], f.health[1:]
		}
		out(s)
	default:
		out("ok " + cmd)
	}
	return nil
}

func TestExecuteRunsTheStepsInOrderAndWritesTheFiles(t *testing.T) {
	p, a := testPlan(t)
	f := &fakeDocker{health: []string{"starting", "healthy"}}
	var events []Event
	err := Execute(context.Background(), p, a, Options{Run: f.run, PollEvery: time.Millisecond}, func(e Event) { events = append(events, e) })
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, c := range f.commands {
		if !strings.Contains(c, "inspect") && !strings.Contains(c, "ps -q") {
			cmds = append(cmds, c)
		}
	}
	// Local images: no pull.
	if strings.Join(cmds, "|") != "docker compose up -d --remove-orphans" {
		t.Errorf("commands = %v", cmds)
	}
	for _, name := range []string{"compose.yaml", ".env"} {
		if _, err := os.Stat(filepath.Join(a.Dir, name)); err != nil {
			t.Errorf("%s missing: %v", name, err)
		}
	}
	if st, _ := os.Stat(filepath.Join(a.Dir, ".env")); st.Mode().Perm() != 0o600 {
		t.Errorf(".env mode %v", st.Mode().Perm())
	}
	if last := events[len(events)-1]; last.Step != "healthy" || last.Kind != "done" {
		t.Errorf("last event %+v", last)
	}
}

func TestExistingFilesAreKeptAsBackups(t *testing.T) {
	p, a := testPlan(t)
	if err := os.MkdirAll(a.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.Dir, "compose.yaml")
	if err := os.WriteFile(path, []byte("old: file\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 21, 15, 4, 5, 0, time.UTC)
	f := &fakeDocker{}
	if err := Execute(context.Background(), p, a, Options{Run: f.run, Now: func() time.Time { return now }, PollEvery: time.Millisecond}, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path + ".bak-20261021-150405")
	if err != nil || string(b) != "old: file\n" {
		t.Errorf("backup = %q, %v", b, err)
	}
	// Running again with the same files changes nothing and makes no second backup.
	entries, _ := os.ReadDir(a.Dir)
	before := len(entries)
	if err := Execute(context.Background(), p, a, Options{Run: f.run, Now: func() time.Time { return now.Add(time.Hour) }, PollEvery: time.Millisecond}, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(a.Dir)
	if len(entries) != before {
		t.Errorf("a second run added files: %d -> %d", before, len(entries))
	}
}

func TestAFailedCommandStopsAndSaysWhich(t *testing.T) {
	p, a := testPlan(t)
	a.Images = plan.DefaultImages()
	p, _ = plan.Build(a)
	f := &fakeDocker{fail: map[string]error{"docker compose pull": os.ErrPermission}}
	var failed Event
	err := Execute(context.Background(), p, a, Options{Run: f.run, PollEvery: time.Millisecond}, func(e Event) {
		if e.Kind == "fail" {
			failed = e
		}
	})
	if err == nil || !strings.Contains(err.Error(), "docker compose pull failed") || failed.Step != "pull" {
		t.Errorf("err %v, event %+v", err, failed)
	}
	for _, c := range f.commands {
		if strings.Contains(c, "up -d") {
			t.Error("kept going after the pull failed")
		}
	}
}

func TestHealthWaitGivesUpAndNamesTheFix(t *testing.T) {
	p, a := testPlan(t)
	f := &fakeDocker{health: []string{"unhealthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy"}}
	err := Execute(context.Background(), p, a, Options{Run: f.run, HealthTimeout: 30 * time.Millisecond, PollEvery: 5 * time.Millisecond}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "docker compose logs atelier") {
		t.Errorf("err = %v", err)
	}
	f2 := &fakeDocker{health: []string{"exited"}}
	err = Execute(context.Background(), p, a, Options{Run: f2.run, PollEvery: time.Millisecond}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "stopped right after starting") {
		t.Errorf("exited: %v", err)
	}
}

func TestCreateAdmin(t *testing.T) {
	var got struct {
		Username, Name, Password, SetupToken string
	}
	var origin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin = r.Header.Get("Origin")
		_ = json.NewDecoder(r.Body).Decode(&got)
		switch got.SetupToken {
		case "good":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"user":{"id":"u1"}}`))
		case "cross":
			w.WriteHeader(403)
			_, _ = w.Write([]byte(`{"code":"bad_origin","message":"Cross-site request refused."}`))
		default:
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"code":"invalid_credentials","message":"That setup token is wrong. It is printed in the server log."}`))
		}
	}))
	defer srv.Close()
	admin := Admin{Username: " Ada ", Name: "Ada Lovelace", Password: "correct horse"}
	if err := CreateAdmin(context.Background(), nil, srv.URL, "good", admin); err != nil {
		t.Fatal(err)
	}
	if got.Username != "Ada" || got.Name != "Ada Lovelace" || origin != srv.URL {
		t.Errorf("sent %+v with origin %q", got, origin)
	}
	if err := CreateAdmin(context.Background(), nil, srv.URL, "cross", admin); err == nil || !strings.Contains(err.Error(), "ATELIER_BASE_URL") {
		t.Errorf("cross-site: %v", err)
	}
	if err := CreateAdmin(context.Background(), nil, srv.URL, "wrong", admin); err == nil || !strings.Contains(err.Error(), "setup token is wrong") {
		t.Errorf("wrong token: %v", err)
	}
	if err := CreateAdmin(context.Background(), nil, srv.URL, "good", Admin{Username: "a", Name: "x", Password: "short"}); err == nil {
		t.Error("invalid input was sent")
	}
}

func TestValidateAdmin(t *testing.T) {
	ok := Admin{Username: "ada", Name: "Ada", Password: "12345678"}
	if err := ValidateAdmin(ok); err != nil {
		t.Fatal(err)
	}
	for name, a := range map[string]Admin{
		"short name":     {Username: "a", Name: "Ada", Password: "12345678"},
		"bad characters": {Username: "ada lovelace", Name: "Ada", Password: "12345678"},
		"no name":        {Username: "ada", Name: " ", Password: "12345678"},
		"short password": {Username: "ada", Name: "Ada", Password: "1234567"},
	} {
		if ValidateAdmin(a) == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestClearTokenAndBaseURLAndTokens(t *testing.T) {
	dir := t.TempDir()
	env := filepath.Join(dir, ".env")
	if err := os.WriteFile(env, []byte("COMPOSE_PROJECT_NAME=atelier\nATELIER_SETUP_TOKEN=abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ClearToken(dir); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(env)
	if string(b) != "COMPOSE_PROJECT_NAME=atelier\nATELIER_SETUP_TOKEN=\n" {
		t.Errorf(".env = %q", b)
	}
	compose := filepath.Join(dir, "compose.yaml")
	_ = os.WriteFile(compose, []byte("    environment:\n      ATELIER_BASE_URL: https://atelier.example.com\n"), 0o644)
	if got := BaseURL(compose); got != "https://atelier.example.com" {
		t.Errorf("BaseURL = %q", got)
	}
	if BaseURL(filepath.Join(dir, "missing")) != "" {
		t.Error("a missing file has an address")
	}
	if a, b := NewToken(), NewToken(); a == b || len(a) < 20 {
		t.Errorf("tokens %q %q", a, b)
	}
}
