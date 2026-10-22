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
	f := &fakeDocker{fail: map[string]error{"docker compose --progress json pull": os.ErrPermission}}
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

// Lines as Compose prints them with --progress json (shortened from a real pull of atelier-updater).
const pullJSON = `{"id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Pulling"}
{"id":"aaa","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Pulling fs layer"}
{"id":"bbb","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Pulling fs layer"}
{"id":"ccc","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Already exists","percent":100}
{"id":"aaa","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Downloading","current":1048576,"total":4194304}
{"id":"bbb","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Downloading","current":2097152,"total":2097152}
{"id":"bbb","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Download complete"}
{"id":"bbb","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Working","text":"Extracting","current":1}
{"id":"bbb","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Pull complete"}
{"id":"aaa","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Download complete"}
{"id":"aaa","parent_id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Pull complete"}
{"id":"Image ghcr.io/theoriuhd/atelier-updater:v0.2.3","status":"Done","text":"Pulled"}`

func TestThePullBecomesOneProgressPerImage(t *testing.T) {
	p, a := testPlan(t)
	a.Images = plan.DefaultImages()
	p, _ = plan.Build(a)
	run := func(_ context.Context, _, name string, args []string, out func(string)) error {
		if strings.Join(args, " ") == "compose --progress json pull" {
			for _, l := range strings.Split(pullJSON, "\n") {
				out(l)
			}
		}
		if len(args) > 1 && args[1] == "ps" {
			out("abc")
		}
		if name == "docker" && args[0] == "inspect" {
			out("healthy")
		}
		return nil
	}
	var seen []ImageProgress
	var logs []string
	if err := Execute(context.Background(), p, a, Options{Run: run, PollEvery: time.Millisecond}, func(e Event) {
		if e.Kind == "image" {
			seen = append(seen, *e.Image)
		}
		if e.Kind == "log" && e.Step == "pull" {
			logs = append(logs, e.Text)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(logs) != 0 {
		t.Errorf("progress lines went to the log: %v", logs)
	}
	// Half way: 1 of 4 MB of one layer and the 2 MB layer fetched; the layer already here counts as in place.
	mid := seen[5]
	if mid.Image != "ghcr.io/theoriuhd/atelier-updater:v0.2.3" || mid.Downloaded != 3<<20 || mid.Size != 6<<20 || mid.Layers != 3 || mid.Unpacked != 1 || mid.Done {
		t.Errorf("half way: %+v", mid)
	}
	last := seen[len(seen)-1]
	if !last.Done || last.Fraction() != 1 || last.Unpacked != 3 || last.Downloaded != last.Size {
		t.Errorf("at the end: %+v", last)
	}
	for i := 1; i < len(seen); i++ {
		if seen[i].Fraction() < seen[i-1].Fraction() {
			t.Errorf("the bar went back from %.2f to %.2f at line %d", seen[i-1].Fraction(), seen[i].Fraction(), i)
		}
	}
}

func TestAnOldComposeGetsThePlainPull(t *testing.T) {
	p, a := testPlan(t)
	a.Images = plan.DefaultImages()
	p, _ = plan.Build(a)
	var cmds []string
	run := func(_ context.Context, _, name string, args []string, out func(string)) error {
		cmd := strings.Join(args, " ")
		cmds = append(cmds, cmd)
		switch {
		case cmd == "compose --progress json pull":
			out(`invalid argument "json" for "--progress" flag`)
			return os.ErrInvalid
		case len(args) > 1 && args[1] == "ps":
			out("abc")
		case args[0] == "inspect":
			out("healthy")
		}
		return nil
	}
	if err := Execute(context.Background(), p, a, Options{Run: run, PollEvery: time.Millisecond}, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	if len(cmds) < 2 || cmds[0] != "compose --progress json pull" || cmds[1] != "compose pull" {
		t.Errorf("commands = %v", cmds)
	}
}

func TestARegistryErrorIsWhatTheFailureSays(t *testing.T) {
	p, a := testPlan(t)
	a.Images = plan.DefaultImages()
	p, _ = plan.Build(a)
	run := func(_ context.Context, _, _ string, args []string, out func(string)) error {
		out(`{"id":"Image ghcr.io/theoriuhd/atelier:latest","status":"Error","text":"error from registry: denied"}`)
		return os.ErrPermission
	}
	err := Execute(context.Background(), p, a, Options{Run: run}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "ghcr.io/theoriuhd/atelier:latest: error from registry: denied") {
		t.Errorf("err = %v", err)
	}
}

func TestFixingDockerRunsItsStepsInOrderAndStopsAtAFailure(t *testing.T) {
	var cmds []string
	run := func(_ context.Context, _, name string, args []string, out func(string)) error {
		cmds = append(cmds, args[len(args)-1])
		if strings.HasPrefix(args[len(args)-1], "sh /tmp/") {
			out("+ sh -c 'apt-get -qq update >/dev/null'")
			return os.ErrPermission
		}
		return nil
	}
	var events []string
	err := FixDocker(context.Background(), Options{Run: run}, InstallDocker, func(e Event) { events = append(events, e.Kind+":"+e.Step) })
	if err == nil || !strings.Contains(err.Error(), "install Docker failed") {
		t.Errorf("err = %v", err)
	}
	if len(cmds) != 2 || !strings.Contains(cmds[0], "get.docker.com") {
		t.Errorf("commands = %v", cmds)
	}
	if strings.Join(events, " ") != "start:get done:get start:install log:install fail:install" {
		t.Errorf("events = %v", events)
	}
}

func TestDockersInstallerLinesBecomeWords(t *testing.T) {
	for line, want := range map[string]string{
		"+ sh -c 'apt-get -qq update >/dev/null'": "Updating the package lists",
		"+ sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null'": "Installing Docker Engine, the CLI and Compose",
		"+ sh -c 'install -m 0755 -d /etc/apt/keyrings'": "Adding Docker's package source",
		"+ sh -c 'docker version'":                       "Checking Docker",
	} {
		if got, ok := DockerActivity(line); !ok || got != want {
			t.Errorf("%q -> %q, want %q", line, got, want)
		}
	}
	if _, ok := DockerActivity("Client: Docker Engine - Community"); ok {
		t.Error("an output line counted as a step")
	}
}

func TestComposesErrorLineIsWhatTheFailureSays(t *testing.T) {
	p, a := testPlan(t)
	a.Images = plan.DefaultImages()
	p, _ = plan.Build(a)
	run := func(_ context.Context, _, _ string, args []string, out func(string)) error {
		out(`{"error":true,"message":"failed to extract layer: no space left on device"}`)
		return os.ErrInvalid
	}
	err := Execute(context.Background(), p, a, Options{Run: run}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "failed to extract layer: no space left on device") {
		t.Errorf("err = %v", err)
	}
}

func TestAFailedStartSaysDockersReason(t *testing.T) {
	p, a := testPlan(t)
	run := func(_ context.Context, _, _ string, args []string, out func(string)) error {
		if args[1] == "up" {
			out(" Container atelier-sandbox-1 Starting")
			out("Error response from daemon: failed to create task for container: cgroup in threaded mode")
			out(" Container atelier-updater-1 Starting")
			return os.ErrInvalid
		}
		return nil
	}
	err := Execute(context.Background(), p, a, Options{Run: run}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "up -d --remove-orphans failed: Error response from daemon: failed to create task") {
		t.Errorf("err = %v", err)
	}
}
