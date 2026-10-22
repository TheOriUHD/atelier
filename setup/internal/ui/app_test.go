package ui

import (
	"context"
	"fmt"
	"github.com/charmbracelet/bubbles/spinner"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"

	"atelier.dev/setup/internal/apply"
	"atelier.dev/setup/internal/plan"
	"atelier.dev/setup/internal/system"
	"atelier.dev/setup/internal/verify"
)

func init() { lipgloss.SetColorProfile(termenv.Ascii) }

func press(m tea.Model, keys ...string) tea.Model {
	for _, k := range keys {
		var msg tea.KeyMsg
		switch k {
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case "up":
			msg = tea.KeyMsg{Type: tea.KeyUp}
		case "tab":
			msg = tea.KeyMsg{Type: tea.KeyTab}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "space":
			msg = tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		}
		m, _ = m.Update(msg)
	}
	return m
}

func typeText(m tea.Model, s string) tea.Model {
	for _, r := range s {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	return m
}

func goodInfo() system.Info {
	return system.Info{OS: "linux", Arch: "amd64", Distro: "Ubuntu 24.04", Root: true, Home: "/root", DiskFreeGB: 80, MemGB: 23, Addrs: []string{"192.168.77.10"},
		Docker: system.Docker{Installed: true, Access: true, Version: "29.1", Compose: "2.40"}}
}

func view(m tea.Model) string { return m.(Model).View() }

// settle runs the commands a step returned and feeds their results back, except the spinner's ticks, until none is left.
func settle(m tea.Model, cmd tea.Cmd) tea.Model {
	queue := []tea.Cmd{cmd}
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		if c == nil {
			continue
		}
		switch msg := c().(type) {
		case nil:
		case tea.BatchMsg:
			queue = append(queue, msg...)
		case spinner.TickMsg:
		default:
			var next tea.Cmd
			m, next = m.Update(msg)
			queue = append(queue, next)
		}
	}
	return m
}

func newTestModel(t *testing.T) (tea.Model, *[]string) {
	t.Helper()
	var cmds []string
	verifyOK := func(_ context.Context, _ string, _ bool) verify.Report {
		return verify.Report{Checks: []verify.Check{{Name: "Server answers", Status: verify.Pass, Detail: "answered 200"}}}
	}
	run := func(_ context.Context, _, name string, args []string, out func(string)) error {
		c := name + " " + strings.Join(args, " ")
		cmds = append(cmds, c)
		switch {
		case strings.HasPrefix(c, "docker compose ps -q"):
			out("abc")
		case strings.HasPrefix(c, "docker inspect"):
			out("healthy")
		default:
			out("ok")
		}
		return nil
	}
	dir := filepath.Join(t.TempDir(), "atelier")
	// Every port is free here, whatever listens on the machine running the tests.
	m := New(Config{Dir: dir, Images: &plan.Images{Local: true}, Run: run, Verify: verifyOK, PortBusy: func(int) bool { return false }, CreateAdmin: func(context.Context, string, string, apply.Admin, bool) error { return nil }})
	var tm tea.Model = m
	tm, _ = tm.Update(tea.WindowSizeMsg{Width: 110, Height: 40})
	return tm, &cmds
}

func contains(t *testing.T, s string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(s, w) {
			t.Errorf("screen lacks %q:\n%s", w, s)
		}
	}
}

func TestWelcomeShowsTheLogo(t *testing.T) {
	m, _ := newTestModel(t)
	contains(t, view(m), "/_/   \\_\\_| |_____|_____|___|_____|_| \\_\\", "begin")
}

func TestChecksBlockWithoutDocker(t *testing.T) {
	m, _ := newTestModel(t)
	m, _ = m.Update(probeMsg{system.Info{OS: "linux", Distro: "Ubuntu 24.04", Root: true, Home: "/root"}})
	v := view(m)
	contains(t, v, "Docker", "not installed", "install Docker")
	// Enter does nothing while a check fails.
	m = press(m, "enter")
	if m.(Model).screen != scChecks {
		t.Errorf("moved on past a failed check: screen %v", m.(Model).screen)
	}
}

func TestWholeFlowForTheLANPath(t *testing.T) {
	m, cmds := newTestModel(t)
	m, _ = m.Update(probeMsg{goodInfo()})
	contains(t, view(m), "Docker", "Ubuntu 24.04")
	m = press(m, "enter") // to the mode screen
	contains(t, view(m), "How will people reach Atelier?", "This machine's address, no domain needed", "http://192.168.77.10:7340", "Caddy", "reverse proxy", "Tailscale")
	// Tailscale is not installed here: it cannot be chosen.
	contains(t, view(m), "Tailscale is not installed here")
	m = press(m, "enter") // the plain address is the default
	if m.(Model).ans.Mode != plan.LAN {
		t.Fatalf("mode = %q", m.(Model).ans.Mode)
	}
	contains(t, view(m), "A few options", "Port Atelier listens on", "Chat sandbox", "Update from Settings")
	m = press(m, "enter") // Enter continues from any row: every row already has an answer
	v := view(m)
	contains(t, v, "Review", "docker compose up -d", "compose.yaml", "http://192.168.77.10:7340")
	if strings.Contains(v, "tok") && strings.Contains(v, "ATELIER_SETUP_TOKEN=") && !strings.Contains(v, "••••") {
		t.Error("the setup token is shown on the review screen")
	}

	// Install.
	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = settle(m, cmd)
	got := strings.Join(*cmds, "|")
	if !strings.Contains(got, "docker compose up -d") || strings.Contains(got, "pull") {
		t.Errorf("commands = %v", *cmds)
	}
	// The files exist.
	if _, err := os.Stat(filepath.Join(m.(Model).ans.Dir, "compose.yaml")); err != nil {
		t.Errorf("compose.yaml not written: %v", err)
	}
	if m.(Model).screen != scVerify {
		t.Fatalf("after installing the screen is %v, want the live test", m.(Model).screen)
	}

	// The live test finds everything right; then the account.
	contains(t, view(m), "It works", "Server answers")
	m = press(m, "enter")
	contains(t, view(m), "Create your account", "Username", "Password")
	m = typeText(m, "ada")
	m = press(m, "tab")
	m = typeText(m, "Ada Lovelace")
	m = press(m, "tab")
	m = typeText(m, "short")
	m = press(m, "tab")
	m = typeText(m, "short")
	m = press(m, "enter")
	contains(t, view(m), "at least 8 characters")
	// A good password: select all of the field's text by retyping from a fresh form.
	m, _ = m.(Model).toAdmin()
	m = typeText(m, "ada")
	m = press(m, "tab")
	m = typeText(m, "Ada Lovelace")
	m = press(m, "tab")
	m = typeText(m, "correct horse")
	m = press(m, "tab")
	m = typeText(m, "correct horse")
	var create tea.Cmd
	m, create = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = settle(m, create)
	contains(t, view(m), "Atelier is running.", "http://192.168.77.10:7340", "atelier-setup doctor")
}

// The options screen is one menu: the arrows move between rows, typing edits a text row, Space flips a switch,
// and Enter continues from wherever the cursor is.
func TestOptionsIsOneMenu(t *testing.T) {
	m, _ := newTestModel(t)
	m, _ = m.Update(probeMsg{goodInfo()})
	m = press(m, "enter", "enter") // checks, then the plain address
	contains(t, view(m), "A few options", "↑/↓", "space", "enter")
	down := func(m tea.Model, key string) tea.Model {
		for i := 0; i < 10 && m.(Model).optForm.fields[m.(Model).optForm.focus].Key != key; i++ {
			m = press(m, "down")
		}
		if got := m.(Model).optForm.fields[m.(Model).optForm.focus].Key; got != key {
			t.Fatalf("the arrow keys did not reach %q (on %q)", key, got)
		}
		return m
	}
	m = down(m, "sandbox")
	contains(t, view(m), "› [✓] Chat sandbox")
	m = press(m, "space") // switches the sandbox off
	m = down(m, "ollama")
	m = typeText(m, "http://10.0.0.5:11434")
	m = press(m, "up", "up") // and back to the sandbox row: still off
	if m.(Model).optForm.on("sandbox") {
		t.Error("Space did not switch the sandbox off")
	}
	m = press(m, "enter") // from a switch row, not only the last row
	cur := m.(Model)
	if cur.screen != scReview {
		t.Fatalf("Enter on a switch row did not continue: screen %v", cur.screen)
	}
	if cur.ans.Sandbox || !cur.ans.Updater || cur.ans.OllamaURL != "http://10.0.0.5:11434" {
		t.Errorf("answers = sandbox %v updater %v ollama %q", cur.ans.Sandbox, cur.ans.Updater, cur.ans.OllamaURL)
	}
}

func TestOwnProxyPathShowsTheProxySettings(t *testing.T) {
	m, _ := newTestModel(t)
	m, _ = m.Update(probeMsg{goodInfo()})
	m = press(m, "enter")                 // mode screen
	m = press(m, "down", "down", "enter") // own reverse proxy
	contains(t, view(m), "Where will it live?", "Address people will type")
	m = typeText(m, "atelier.example.com")
	m = press(m, "enter")
	contains(t, view(m), "Which reverse proxy?", "Caddy", "nginx", "Traefik", "Nginx Proxy Manager", "Cloudflare Tunnel")
	m = press(m, "down", "enter") // nginx
	contains(t, view(m), "Where does your proxy run?")
	m = press(m, "enter") // on this machine
	if m.(Model).ans.BindAddr != "127.0.0.1" {
		t.Errorf("bind = %q", m.(Model).ans.BindAddr)
	}
	contains(t, view(m), "Proxy address (optional)")
	m = press(m, "enter") // the options
	contains(t, view(m), "Review", "https://atelier.example.com")
	cur := m.(Model)
	if cur.ans.Mode != plan.OwnProxy || cur.ans.PublicURL != "https://atelier.example.com" {
		t.Errorf("answers = %+v", cur.ans)
	}
	// Simulate the install having finished: the proxy screen shows nginx's settings.
	next, _ := cur.afterApply()
	nm := next.(Model)
	contains(t, nm.View(), "Set up your proxy", "nginx server block", "copy the settings")
	if !strings.Contains(nm.snippet.Body, "proxy_pass") || !strings.Contains(nm.snippet.Body, "Upgrade") {
		t.Errorf("nginx settings lack proxy_pass or the Upgrade header:\n%s", nm.snippet.Body)
	}
	if b, err := os.ReadFile(nm.snipFile); err != nil || string(b) != nm.snippet.Body {
		t.Errorf("the settings were not saved unwrapped: %v", err)
	}
}

func TestABadDomainIsRefusedWithAReason(t *testing.T) {
	m, _ := newTestModel(t)
	m, _ = m.Update(probeMsg{goodInfo()})
	m = press(m, "enter", "down", "enter") // a domain with HTTPS (Caddy)
	m = typeText(m, "http://nope")
	m = press(m, "enter")
	contains(t, view(m), "Where will it live?", "✗")
	if m.(Model).screen != scDomain {
		t.Errorf("accepted a bad address: screen %v", m.(Model).screen)
	}
}

func TestFailedInstallOffersRetry(t *testing.T) {
	m, _ := newTestModel(t)
	cur := m.(Model)
	cur.screen = scApply
	cur.steps = []stepView{{ID: "up", Title: "Start Atelier", State: "fail"}}
	cur.applyDone, cur.applyErr = true, context.DeadlineExceeded
	v := cur.View()
	contains(t, v, "✗", "try again", "change answers")
}

func TestVerifyFailureShowsTheFix(t *testing.T) {
	m, _ := newTestModel(t)
	cur := m.(Model)
	cur.screen = scVerify
	cur.plan = plan.Plan{URL: "https://atelier.example.com"}
	cur.report = verify.Report{Checks: []verify.Check{{Name: "Live connection (WebSocket)", Status: verify.Fail, Detail: "refused (403)", Fix: "Set ATELIER_BASE_URL=https://atelier.example.com for the Atelier server and restart it."}}}
	v := cur.View()
	contains(t, v, "Not quite yet", "ATELIER_BASE_URL=", "test again", "continue anyway")
}

var _ = apply.NewToken

func TestPortsAreOnlyCheckedForTheSetupsThatUseThem(t *testing.T) {
	m, _ := newTestModel(t)
	busy := goodInfo()
	busy.PortsBusy = []int{80, 443}
	m, _ = m.Update(probeMsg{busy})
	v := view(m)
	contains(t, v, "Ports 80, 443", "in use by something else")
	if m.(Model).screen != scChecks || system.Blocking(m.(Model).checks) {
		t.Fatalf("busy ports stop the install: screen %v", m.(Model).screen)
	}
	m = press(m, "enter")
	// The domain option needs 80 and 443: it cannot be chosen, the others can.
	contains(t, view(m), "ports 80 and 443 are in use")
	m = press(m, "down")
	if got := m.(Model).modeChoice.selected().Value; got != string(plan.OwnProxy) {
		t.Errorf("the cursor stopped on %q: it must skip the disabled domain option", got)
	}
}

func TestAnEarlierSetupCanBeReusedOrRemoved(t *testing.T) {
	var cmds []string
	run := func(_ context.Context, dir, name string, args []string, _ func(string)) error {
		cmds = append(cmds, dir+": "+name+" "+strings.Join(args, " "))
		return nil
	}
	mk := func() tea.Model {
		m := New(Config{Dir: t.TempDir(), Images: &plan.Images{Local: true}, Run: run, PortBusy: func(int) bool { return false }})
		var tm tea.Model = m
		tm, _ = tm.Update(tea.WindowSizeMsg{Width: 110, Height: 40})
		info := goodInfo()
		info.Existing = &system.Install{Dir: "/opt/atelier", Image: "atelier:local", Running: true, Managed: true, Ports: []int{80, 443}}
		tm, _ = tm.Update(probeMsg{info})
		contains(t, view(tm), "Earlier setup", "reinstall over it")
		return press(tm, "enter")
	}

	// Reinstall over it: the same folder, its data kept, and its own port is not a conflict.
	m := mk()
	contains(t, view(m), "Atelier is already set up here", "Reinstall over it and keep its accounts and chats", "Remove it and start fresh")
	m = press(m, "enter")
	cur := m.(Model)
	if cur.screen != scMode || cur.ans.Dir != "/opt/atelier" || !cur.reuse {
		t.Errorf("reuse: screen %v dir %q reuse %v", cur.screen, cur.ans.Dir, cur.reuse)
	}

	// Remove it: only after typing the word, and then the containers and volumes go.
	m = mk()
	m = press(m, "down", "enter")
	contains(t, view(m), "Remove the earlier setup", "all the data", "cannot be undone")
	m = typeText(m, "yes")
	m = press(m, "enter")
	contains(t, view(m), "type the word delete")
	if len(cmds) != 0 {
		t.Fatalf("removed before the word was typed: %v", cmds)
	}
	m = typeText(m, "") // keeps the text "yes": clear it with backspaces
	for i := 0; i < 3; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m = typeText(m, "delete")
	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = settle(m, cmd)
	if len(cmds) != 1 || cmds[0] != "/opt/atelier: docker compose down -v --remove-orphans" {
		t.Errorf("commands = %v", cmds)
	}
	if m.(Model).screen != scMode || m.(Model).info.Existing != nil {
		t.Errorf("after removing: screen %v existing %v", m.(Model).screen, m.(Model).info.Existing)
	}

	// Quit leaves it alone.
	m = mk()
	m = press(m, "down", "down")
	if _, c := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); c == nil {
		t.Error("quit does not quit")
	}
}

func TestAServerThatAlreadyHasAnAdminIsNotAnError(t *testing.T) {
	m, _ := newTestModel(t)
	cur := m.(Model)
	cur.screen = scAdmin
	cur.adminBusy = true
	cur.ans.Dir = t.TempDir()
	next, _ := cur.Update(adminMsg{fmt.Errorf("This server already has an admin. Sign in instead.")})
	contains(t, next.(Model).View(), "Atelier is running.", "It already had an account")
}
