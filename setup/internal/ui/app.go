package ui

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	qrcode "github.com/skip2/go-qrcode"

	"atelier.dev/setup/internal/apply"
	"atelier.dev/setup/internal/plan"
	"atelier.dev/setup/internal/proxy"
	"atelier.dev/setup/internal/system"
	"atelier.dev/setup/internal/verify"
)

type screen int

const (
	scWelcome screen = iota
	scProbe
	scChecks
	scExisting
	scRemove
	scMode
	scDomain
	scProxyKind
	scProxyWhere
	scOptions
	scReview
	scApply
	scDocker
	scProxySetup
	scVerify
	scAdmin
	scDone
)

// Config is what the command line decided before the wizard starts.
type Config struct {
	// Dir and Images override the defaults (Dir "" keeps them).
	Dir    string
	Images *plan.Images
	// InsecureTLS accepts self-signed certificates in the live test (the wizard's own tests).
	InsecureTLS bool
	Version     string
	// Run, Verify and CreateAdmin can be replaced in tests.
	Run    apply.RunFunc
	Verify func(ctx context.Context, url string, insecure bool) verify.Report
	// PortBusy tells whether something listens on a port (default: look for real).
	PortBusy func(port int) bool
	// Probe looks at the machine (default: for real).
	Probe       func(ctx context.Context, dir string) system.Info
	CreateAdmin func(ctx context.Context, baseURL, token string, a apply.Admin, insecure bool) error
}

type probeMsg struct{ info system.Info }
type eventMsg struct{ ev apply.Event }
type applyDoneMsg struct{ err error }
type verifyMsg struct{ report verify.Report }
type adminMsg struct{ err error }
type execDoneMsg struct{ err error }
type fixEventMsg struct{ ev apply.Event }
type fixDoneMsg struct{ err error }
type removedMsg struct{ err error }

// Model is the wizard.
type Model struct {
	cfg           Config
	width, height int
	screen        screen

	info   system.Info
	checks []system.Check
	ans    plan.Answers
	plan   plan.Plan

	spin spinner.Model

	modeChoice  choice
	domainForm  *form
	kindChoice  choice
	whereChoice choice
	optForm     *form
	review      viewport.Model
	reviewErr   string

	steps     []stepView
	logLines  []string
	events    chan apply.Event
	applyErr  error
	applyDone bool
	// The pull's progress per image, in the order they started; shown never goes back, so a bar doesn't jump back when
	// Docker learns the size of another layer.
	pullOrder []string
	pull      map[string]apply.ImageProgress
	shown     map[string]float64

	// Installing, starting or completing Docker from the checks screen.
	fix         apply.DockerFix
	fixSteps    []stepView
	fixLog      []string
	fixActivity string
	fixErr      error
	fixEvents   chan apply.Event
	fixStarted  time.Time

	snippet proxy.Snippet
	snipVP  viewport.Model

	report     verify.Report
	verifying  bool
	adminForm  *form
	adminErr   string
	adminBusy  bool
	fatal      string
	snipFile   string
	exChoice   choice
	removeForm *form
	removeBusy bool
	reuse      bool
	hadAdmin   bool
	note       string
}

type stepView struct {
	ID, Title string
	State     string // "", "running", "done", "fail"
}

// New makes the wizard.
func New(cfg Config) Model {
	sp := spinner.New(spinner.WithSpinner(spinner.Dot))
	sp.Style = styAccent
	return Model{cfg: cfg, spin: sp, screen: scWelcome, width: 100, height: 34}
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) probe() tea.Cmd {
	dir := m.cfg.Dir
	if dir == "" {
		dir = "/opt"
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if m.cfg.Probe != nil {
			return probeMsg{m.cfg.Probe(ctx, dir)}
		}
		return probeMsg{system.Probe(ctx, system.ExecRunner{}, dir, []int{80, 443, 7340})}
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.resizeViewports()
		return m, nil
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd
	case probeMsg:
		return m.onProbe(msg.info)
	case eventMsg:
		m.onEvent(msg.ev)
		return m, waitEvent(m.events)
	case applyDoneMsg:
		m.applyDone, m.applyErr = true, msg.err
		if msg.err == nil {
			return m.afterApply()
		}
		return m, nil
	case verifyMsg:
		m.report, m.verifying = msg.report, false
		return m, nil
	case adminMsg:
		m.adminBusy = false
		if msg.err != nil && strings.Contains(msg.err.Error(), "already has an admin") {
			// A server that was reinstalled over keeps its accounts.
			m.hadAdmin = true
			_ = apply.ClearToken(m.ans.Dir)
			m.screen = scDone
			return m, nil
		}
		if msg.err != nil {
			m.adminErr = msg.err.Error()
			return m, nil
		}
		_ = apply.ClearToken(m.ans.Dir)
		m.screen = scDone
		return m, nil
	case removedMsg:
		m.removeBusy = false
		if msg.err != nil {
			m.removeForm.fields[0].err = msg.err.Error()
			return m, nil
		}
		ex := m.info.Existing
		m.info.Existing, m.reuse = nil, false
		m.ans.Dir = ex.Dir
		return m.toMode()
	case fixEventMsg:
		m.onFixEvent(msg.ev)
		return m, waitFix(m.fixEvents)
	case fixDoneMsg:
		m.fixErr = msg.err
		if msg.err == nil {
			m.screen = scProbe
			return m, tea.Batch(m.spin.Tick, m.probe())
		}
		return m, nil
	case execDoneMsg:
		if msg.err != nil {
			m.note = "That did not finish: " + msg.err.Error()
		} else {
			m.note = ""
		}
		if m.screen == scChecks {
			m.screen = scProbe
			return m, tea.Batch(m.spin.Tick, m.probe())
		}
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		return m.key(msg)
	}
	return m, nil
}

func (m *Model) resizeViewports() {
	w, h := m.bodyWidth(), m.bodyHeight()
	m.review.Width, m.review.Height = w, h
	m.snipVP.Width, m.snipVP.Height = w, h
}

func (m Model) bodyWidth() int {
	w := m.width - 14
	if w > 92 {
		w = 92
	}
	if w < 40 {
		w = 40
	}
	return w
}

func (m Model) bodyHeight() int {
	h := m.height - 17
	if h < 8 {
		h = 8
	}
	if h > 28 {
		h = 28
	}
	return h
}

// ---------------------------------------------------------------- key handling

func (m Model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := k.String()
	if s == "q" && m.screen != scDomain && m.screen != scOptions && m.screen != scAdmin && m.screen != scDocker {
		return m, tea.Quit
	}
	switch m.screen {
	case scWelcome:
		if s == "enter" {
			m.screen = scProbe
			return m, tea.Batch(m.spin.Tick, m.probe())
		}
	case scChecks:
		switch s {
		case "enter":
			if !system.Blocking(m.checks) {
				return m.afterChecks()
			}
			if fix := system.DockerFix(m.info); fix != "" {
				return m.startFix(apply.DockerFix(fix))
			}
		case "r":
			m.screen = scProbe
			return m, tea.Batch(m.spin.Tick, m.probe())
		}
	case scDocker:
		if m.fixErr != nil {
			switch s {
			case "r":
				return m.startFix(m.fix)
			case "esc":
				m.screen = scChecks
			case "q":
				return m, tea.Quit
			}
		}
	case scExisting:
		switch s {
		case "enter":
			switch m.exChoice.selected().Value {
			case "reuse":
				m.ans.Dir, m.reuse = m.info.Existing.Dir, true
				return m.toMode()
			case "fresh":
				m.removeForm = newForm(textField("confirm", "Type delete to remove it and all its data", "", "", false, func(v string) error {
					if strings.TrimSpace(v) != "delete" {
						return fmt.Errorf("type the word delete to go ahead")
					}
					return nil
				}))
				m.screen = scRemove
				return m, m.removeForm.fields[0].Input.Focus()
			default:
				return m, tea.Quit
			}
		default:
			m.exChoice.update(k)
		}
	case scRemove:
		if m.removeBusy {
			return m, nil
		}
		submit, cmd := m.removeForm.update(k)
		if s == "esc" {
			m.screen = scExisting
			return m, nil
		}
		if submit {
			if !m.removeForm.check() {
				return m, nil
			}
			m.removeBusy = true
			ex, run := *m.info.Existing, m.cfg.Run
			if run == nil {
				run = apply.ExecRun
			}
			return m, tea.Batch(m.spin.Tick, func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
				defer cancel()
				return removedMsg{run(ctx, ex.Dir, "docker", []string{"compose", "down", "-v", "--remove-orphans"}, func(string) {})}
			})
		}
		return m, cmd
	case scMode:
		switch s {
		case "enter":
			return m.chooseMode()
		default:
			m.modeChoice.update(k)
		}
	case scDomain:
		submit, cmd := m.domainForm.update(k)
		if s == "esc" {
			return m.toMode()
		}
		if submit {
			return m.submitDomain()
		}
		return m, cmd
	case scProxyKind:
		switch s {
		case "enter":
			m.screen = scProxyWhere
			m.whereChoice = newChoice(whereOptions(m.info), "host")
		case "esc":
			m.screen = scDomain
		default:
			m.kindChoice.update(k)
		}
	case scProxyWhere:
		switch s {
		case "enter":
			switch m.whereChoice.selected().Value {
			case "host":
				m.ans.BindAddr = "127.0.0.1"
			default:
				m.ans.BindAddr = "0.0.0.0"
			}
			return m.toOptions()
		case "esc":
			m.screen = scProxyKind
		default:
			m.whereChoice.update(k)
		}
	case scOptions:
		submit, cmd := m.optForm.update(k)
		if s == "esc" {
			return m.backFromOptions()
		}
		if submit {
			return m.submitOptions()
		}
		return m, cmd
	case scReview:
		switch s {
		case "enter":
			return m.startApply()
		case "esc", "b":
			return m.toOptions()
		}
		var cmd tea.Cmd
		m.review, cmd = m.review.Update(k)
		return m, cmd
	case scApply:
		if m.applyDone && m.applyErr != nil {
			switch s {
			case "r":
				return m.startApply()
			case "b", "esc":
				return m.toOptions()
			}
		}
	case scProxySetup:
		switch s {
		case "enter":
			return m.toVerify()
		case "c":
			if m.snippet.Body != "" {
				copyToClipboard(m.snippet.Body)
				m.note = "Copied."
			}
		case "t":
			if m.ans.Mode == plan.Tailscale {
				run := m.cfg.Run
				if run == nil {
					run = apply.ExecRun
				}
				port := m.ans.Port
				m.note = "Running tailscale serve…"
				return m, func() tea.Msg {
					err := run(context.Background(), "/", "tailscale", []string{"serve", "--bg", "--https=443", fmt.Sprintf("http://127.0.0.1:%d", port)}, func(string) {})
					return execDoneMsg{err}
				}
			}
		}
		var cmd tea.Cmd
		m.snipVP, cmd = m.snipVP.Update(k)
		return m, cmd
	case scVerify:
		switch s {
		case "r":
			return m.toVerify()
		case "enter", "c":
			if !m.verifying && (m.report.OK() || s == "c" || s == "enter") {
				return m.toAdmin()
			}
		}
	case scAdmin:
		if m.adminBusy {
			return m, nil
		}
		submit, cmd := m.adminForm.update(k)
		if s == "esc" {
			m.screen = scVerify
			return m, nil
		}
		if submit {
			return m.submitAdmin()
		}
		return m, cmd
	case scDone:
		if s == "enter" {
			return m, tea.Quit
		}
	}
	return m, nil
}

// ---------------------------------------------------------------- transitions

func (m Model) onProbe(info system.Info) (tea.Model, tea.Cmd) {
	m.info = info
	if m.ans.Dir == "" {
		m.ans = plan.Defaults(info.Root, info.Home)
		if m.cfg.Dir != "" {
			m.ans.Dir = m.cfg.Dir
		}
		if m.cfg.Images != nil {
			m.ans.Images = *m.cfg.Images
		}
		m.ans.OllamaURL = info.Ollama
	}
	m.checks = system.Checks(info)
	m.screen = scChecks
	return m, nil
}

func containsInt(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// afterChecks goes on from the machine screen: a server this program set up earlier is dealt with first.
func (m Model) afterChecks() (tea.Model, tea.Cmd) {
	if in := m.info.Existing; in != nil && in.Managed {
		m.exChoice = newChoice([]option{
			{Value: "reuse", Label: "Reinstall over it and keep its accounts and chats", Desc: "Replaces its compose file (a copy is kept) and restarts it in " + in.Dir + ". Use this to change how it is reached, for example to add a domain and HTTPS."},
			{Value: "fresh", Label: "Remove it and start fresh", Desc: "Deletes its containers and ALL its data: accounts, chats and settings. You are asked to confirm."},
			{Value: "quit", Label: "Leave it alone and quit"},
		}, "reuse")
		m.screen = scExisting
		return m, nil
	}
	return m.toMode()
}

func (m Model) toMode() (tea.Model, tea.Cmd) {
	addr := "this machine's address"
	if len(m.info.Addrs) > 0 {
		addr = "http://" + m.info.Addrs[0] + ":7340"
	}
	opts := []option{
		{Value: string(plan.LAN), Label: plan.LAN.Label(), Desc: "The simplest start. Open " + addr + " from any device on your network: no domain, no certificates, nothing else to set up. It is plain http, so passkeys are not offered. Run this again later to add a domain and HTTPS."},
		{Value: string(plan.BundledCaddy), Label: plan.BundledCaddy.Label(), Desc: "For when people reach it from the internet. You need a domain name that points at this machine and ports 80 and 443 free: Caddy gets the certificate and keeps it renewed."},
		{Value: string(plan.OwnProxy), Label: plan.OwnProxy.Label(), Desc: "You already run Caddy, nginx, Traefik, Nginx Proxy Manager or a Cloudflare Tunnel. Setup writes the Atelier side and gives you the exact settings for your proxy."},
		{Value: string(plan.Tailscale), Label: plan.Tailscale.Label(), Desc: "Reachable only from your own devices, with a real HTTPS address from Tailscale. No domain or open ports needed."},
	}
	if contains80or443(m.info.PortsBusy) {
		opts[1].Disabled, opts[1].Note = true, "ports 80 and 443 are in use"
	}
	if !m.info.Tailscale.Installed {
		opts[3].Disabled, opts[3].Note = true, "Tailscale is not installed here"
	}
	sel := string(m.ans.Mode)
	if sel == "" {
		sel = string(plan.LAN)
	}
	m.modeChoice = newChoice(opts, sel)
	m.screen = scMode
	return m, nil
}

func contains80or443(busy []int) bool {
	for _, p := range busy {
		if p == 80 || p == 443 {
			return true
		}
	}
	return false
}

func (m Model) chooseMode() (tea.Model, tea.Cmd) {
	m.ans.Mode = plan.Mode(m.modeChoice.selected().Value)
	switch m.ans.Mode {
	case plan.LAN:
		m.ans.BindAddr = "0.0.0.0"
		m.ans.PublicURL = ""
		return m.toOptions()
	case plan.Tailscale:
		m.ans.BindAddr = "127.0.0.1"
	}
	value := m.ans.PublicURL
	label, help := "Address people will type", "For example https://atelier.example.com"
	if m.ans.Mode == plan.BundledCaddy {
		label, help = "Domain name", "A name that points at this machine, for example atelier.example.com. Caddy gets its certificate from Let's Encrypt."
	}
	if m.ans.Mode == plan.Tailscale {
		label, help = "Your Tailscale address", "Tailscale gives each machine a name like box.tail1234.ts.net. HTTPS certificates must be enabled for your tailnet."
		if m.info.Tailscale.DNSName != "" && value == "" {
			value = "https://" + m.info.Tailscale.DNSName
		}
	}
	m.domainForm = newForm(textField("url", label, help, strings.TrimPrefix(value, "https://"), false, nil))
	m.screen = scDomain
	return m, m.domainForm.fields[0].Input.Focus()
}

func normalizeAddress(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return raw
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	return strings.TrimRight(raw, "/")
}

func (m Model) submitDomain() (tea.Model, tea.Cmd) {
	addr := normalizeAddress(m.domainForm.raw("url"))
	u, err := plan.ParsePublicURL(addr)
	if err != nil {
		m.domainForm.fields[0].err = err.Error()
		return m, nil
	}
	if m.ans.Mode == plan.Tailscale && !strings.HasSuffix(u.Hostname(), ".ts.net") {
		m.domainForm.fields[0].err = "a Tailscale address ends in .ts.net"
		return m, nil
	}
	m.ans.PublicURL = "https://" + u.Host
	if m.ans.Mode == plan.OwnProxy {
		var opts []option
		for _, k := range proxy.Kinds() {
			if k == proxy.Tailscale {
				continue
			}
			opts = append(opts, option{Value: string(k), Label: proxy.Label(k)})
		}
		m.kindChoice = newChoice(opts, string(proxy.Caddy))
		m.screen = scProxyKind
		return m, nil
	}
	return m.toOptions()
}

func whereOptions(info system.Info) []option {
	host := "this machine"
	if len(info.Addrs) > 0 {
		host = info.Addrs[0]
	}
	return []option{
		{Value: "host", Label: "On this machine, installed directly (not in Docker)", Desc: "Atelier listens on 127.0.0.1 only, so nothing else on the network can reach it."},
		{Value: "docker", Label: "On this machine, in a Docker container", Desc: "Atelier listens on all addresses so the container can reach it at " + host + ". Keep the port closed to the internet in your firewall."},
		{Value: "other", Label: "On another machine on my network", Desc: "Atelier listens on all addresses; your proxy reaches it at " + host + ". Keep the port closed to the internet in your firewall."},
	}
}

func (m Model) toOptions() (tea.Model, tea.Cmd) {
	a := m.ans
	fields := []field{
		textField("dir", "Install folder", "Where compose.yaml and .env go.", a.Dir, false, func(s string) error {
			if !filepath.IsAbs(strings.TrimSpace(s)) {
				return fmt.Errorf("use an absolute path, for example /opt/atelier")
			}
			return nil
		}),
	}
	if a.Mode == plan.OwnProxy || a.Mode == plan.Tailscale || a.Mode == plan.LAN {
		port := a.Port
		if port == 0 {
			port = 7340
		}
		fields = append(fields, textField("port", "Port Atelier listens on", "The port on this machine. Your proxy forwards to it.", strconv.Itoa(port), false, func(s string) error {
			n, err := strconv.Atoi(strings.TrimSpace(s))
			if err != nil || n < 1 || n > 65535 {
				return fmt.Errorf("a port between 1 and 65535")
			}
			return nil
		}))
	}
	if a.Mode == plan.OwnProxy {
		fields = append(fields, textField("proxies", "Proxy address (optional)", "The address your proxy connects from, for example 192.168.1.10, or a range such as 172.16.0.0/12. It makes client addresses right in sign-in limits. Leave empty if unsure.", a.ProxyAddrs, false, nil))
	}
	fields = append(fields,
		toggleField("sandbox", "Chat sandbox", "A separate container where chats can clone repositories and run commands. Recommended.", a.Sandbox),
		toggleField("updater", "Update from Settings", "Adds a small service so an admin can press Update server. It can restart Atelier's containers, so it holds the Docker socket.", a.Updater),
		textField("tag", "Version", "latest follows new releases when you update. Pin one, for example v0.2.2, to stay on it.", a.Images.Tag, false, nil),
	)
	if a.Images.Local {
		fields = fields[:len(fields)-1]
	}
	fields = append(fields, textField("ollama", "Ollama address (optional)", "Atelier can use models from an Ollama server. Leave empty to add providers later in Settings.", a.OllamaURL, false, nil))
	m.optForm = newForm(fields...)
	m.optForm.submitOnEnter = true
	m.screen = scOptions
	return m, m.optForm.fields[0].Input.Focus()
}

func (m Model) backFromOptions() (tea.Model, tea.Cmd) {
	switch m.ans.Mode {
	case plan.LAN:
		return m.toMode()
	case plan.OwnProxy:
		m.screen = scProxyWhere
		m.whereChoice = newChoice(whereOptions(m.info), "host")
		return m, nil
	default:
		return m.chooseMode()
	}
}

func (m Model) submitOptions() (tea.Model, tea.Cmd) {
	if !m.optForm.check() {
		return m, nil
	}
	f := m.optForm
	m.ans.Dir = f.value("dir")
	if v := f.value("port"); v != "" {
		m.ans.Port, _ = strconv.Atoi(v)
		// A port is free when nothing listens on it, or when only the server being reinstalled does.
		busy := m.cfg.PortBusy
		if busy == nil {
			busy = system.PortBusy
		}
		own := m.reuse && m.info.Existing != nil && containsInt(m.info.Existing.Ports, m.ans.Port)
		if busy(m.ans.Port) && !own {
			for i := range f.fields {
				if f.fields[i].Key == "port" {
					f.fields[i].err = fmt.Sprintf("port %d is in use on this machine: choose another", m.ans.Port)
					f.focus = i
					f.refocus()
				}
			}
			return m, nil
		}
	} else if m.ans.Mode == plan.BundledCaddy {
		m.ans.Port = 7340
	}
	m.ans.ProxyAddrs = f.value("proxies")
	m.ans.Sandbox, m.ans.Updater = f.on("sandbox"), f.on("updater")
	if t := f.value("tag"); t != "" {
		m.ans.Images.Tag = t
	}
	m.ans.OllamaURL = f.value("ollama")
	if m.ans.SetupToken == "" {
		m.ans.SetupToken = apply.NewToken()
	}
	if m.ans.Mode == plan.LAN {
		host := "localhost"
		if len(m.info.Addrs) > 0 {
			host = m.info.Addrs[0]
		}
		m.ans.PublicURL = fmt.Sprintf("http://%s:%d", host, m.ans.Port)
	}
	p, err := plan.Build(m.ans)
	if err != nil {
		m.optForm.fields[0].err = err.Error()
		return m, nil
	}
	if m.ans.Mode == plan.LAN {
		p.URL = m.ans.PublicURL
	}
	m.plan = p
	m.review = viewport.New(m.bodyWidth(), m.bodyHeight())
	m.review.SetContent(m.reviewText())
	m.screen = scReview
	return m, nil
}

func (m Model) reviewText() string {
	var b strings.Builder
	b.WriteString(styTitle.Render("What will happen") + "\n")
	for i, s := range m.plan.Steps {
		b.WriteString(fmt.Sprintf("  %s %s\n     %s\n", styAccent.Render(strconv.Itoa(i+1)+"."), s.Title, styFaint.Render(s.Command)))
	}
	b.WriteString("\n" + styTitle.Render("Where people will open it") + "\n  " + styCode.Render(m.plan.URL) + "\n")
	for _, f := range m.plan.Files {
		b.WriteString("\n" + styTitle.Render(f.Path) + "\n")
		if f.Secret {
			var lines []string
			for _, l := range strings.Split(strings.TrimRight(f.Body, "\n"), "\n") {
				if k, _, ok := strings.Cut(l, "="); ok && !strings.HasPrefix(l, "#") {
					lines = append(lines, k+"=••••••••")
				} else {
					lines = append(lines, l)
				}
			}
			b.WriteString(styCode.Render(strings.Join(lines, "\n")) + "\n")
			continue
		}
		b.WriteString(styCode.Render(wrap(strings.TrimRight(f.Body, "\n"), m.bodyWidth()-2)) + "\n")
	}
	return b.String()
}

func (m Model) startApply() (tea.Model, tea.Cmd) {
	m.screen = scApply
	m.steps, m.logLines, m.applyErr, m.applyDone = nil, nil, nil, false
	m.pullOrder, m.pull, m.shown = nil, map[string]apply.ImageProgress{}, map[string]float64{}
	for _, s := range m.plan.Steps {
		if s.ID == "files" || s.ID == "pull" || s.ID == "up" || s.ID == "healthy" {
			m.steps = append(m.steps, stepView{ID: s.ID, Title: s.Title})
		}
	}
	ch := make(chan apply.Event, 64)
	m.events = ch
	p, a, run := m.plan, m.ans, m.cfg.Run
	go func() {
		err := apply.Execute(context.Background(), p, a, apply.Options{Run: run}, func(e apply.Event) { ch <- e })
		ch <- apply.Event{Kind: "end", Err: err}
		close(ch)
	}()
	return m, tea.Batch(m.spin.Tick, waitEvent(ch))
}

func waitEvent(ch chan apply.Event) tea.Cmd {
	return func() tea.Msg {
		e, ok := <-ch
		if !ok {
			return nil
		}
		if e.Kind == "end" {
			return applyDoneMsg{e.Err}
		}
		return eventMsg{e}
	}
}

func (m *Model) onEvent(e apply.Event) {
	for i := range m.steps {
		if m.steps[i].ID != e.Step {
			continue
		}
		switch e.Kind {
		case "start":
			m.steps[i].State = "running"
		case "done":
			m.steps[i].State = "done"
		case "fail":
			m.steps[i].State = "fail"
		}
	}
	if e.Kind == "image" && e.Image != nil {
		p := *e.Image
		if _, ok := m.pull[p.Image]; !ok {
			m.pullOrder = append(m.pullOrder, p.Image)
		}
		m.pull[p.Image] = p
		m.shown[p.Image] = max(m.shown[p.Image], p.Fraction())
	}
	if e.Kind == "start" {
		// What a failure shows is the failing step's own output.
		m.logLines = nil
	}
	if e.Kind == "log" && strings.TrimSpace(e.Text) != "" {
		m.logLines = append(m.logLines, e.Text)
		if len(m.logLines) > 400 {
			m.logLines = m.logLines[len(m.logLines)-400:]
		}
	}
}

// startFix installs, starts or completes Docker on its own screen, then looks at the machine again.
func (m Model) startFix(fix apply.DockerFix) (tea.Model, tea.Cmd) {
	m.screen, m.fix, m.fixErr, m.fixLog, m.fixActivity, m.fixStarted = scDocker, fix, nil, nil, "", time.Now()
	m.fixSteps = nil
	for _, s := range apply.DockerSteps(fix) {
		m.fixSteps = append(m.fixSteps, stepView{ID: s.ID, Title: s.Title})
	}
	ch := make(chan apply.Event, 64)
	m.fixEvents = ch
	run := m.cfg.Run
	go func() {
		err := apply.FixDocker(context.Background(), apply.Options{Run: run}, fix, func(e apply.Event) { ch <- e })
		ch <- apply.Event{Kind: "end", Err: err}
		close(ch)
	}()
	return m, tea.Batch(m.spin.Tick, waitFix(ch))
}

func waitFix(ch chan apply.Event) tea.Cmd {
	return func() tea.Msg {
		e, ok := <-ch
		if !ok {
			return nil
		}
		if e.Kind == "end" {
			return fixDoneMsg{e.Err}
		}
		return fixEventMsg{e}
	}
}

func (m *Model) onFixEvent(e apply.Event) {
	for i := range m.fixSteps {
		if m.fixSteps[i].ID != e.Step {
			continue
		}
		switch e.Kind {
		case "start":
			m.fixSteps[i].State = "running"
			m.fixActivity = ""
		case "done":
			m.fixSteps[i].State = "done"
		case "fail":
			m.fixSteps[i].State = "fail"
		}
	}
	if e.Kind == "log" && strings.TrimSpace(e.Text) != "" {
		if what, ok := apply.DockerActivity(e.Text); ok {
			m.fixActivity = what
		}
		m.fixLog = append(m.fixLog, e.Text)
		if len(m.fixLog) > 200 {
			m.fixLog = m.fixLog[len(m.fixLog)-200:]
		}
	}
}

func (m Model) afterApply() (tea.Model, tea.Cmd) {
	switch m.ans.Mode {
	case plan.OwnProxy:
		in := proxy.Inputs{PublicURL: m.ans.PublicURL, Upstream: m.upstream(), ProxyInDocker: m.whereChoice.selected().Value == "docker"}
		sn, err := proxy.Generate(proxy.Kind(m.kindChoice.selected().Value), in)
		if err == nil {
			return m.showSnippet(sn)
		}
		m.note = err.Error()
	case plan.Tailscale:
		in := proxy.Inputs{PublicURL: m.ans.PublicURL, Upstream: fmt.Sprintf("127.0.0.1:%d", m.ans.Port)}
		if sn, err := proxy.Generate(proxy.Tailscale, in); err == nil {
			return m.showSnippet(sn)
		}
	}
	return m.toVerify()
}

// upstream is where the person's proxy reaches Atelier.
func (m Model) upstream() string {
	host := "127.0.0.1"
	if m.ans.BindAddr != "127.0.0.1" {
		host = "<this machine's address>"
		if len(m.info.Addrs) > 0 {
			host = m.info.Addrs[0]
		}
	}
	return fmt.Sprintf("%s:%d", host, m.ans.Port)
}

func (m Model) showSnippet(sn proxy.Snippet) (tea.Model, tea.Cmd) {
	m.snippet = sn
	m.snipVP = viewport.New(m.bodyWidth(), m.bodyHeight())
	var b strings.Builder
	b.WriteString(styTitle.Render(sn.Title) + "\n")
	if sn.File != "" {
		b.WriteString(styFaint.Render("For this file: ") + sn.File + "\n")
	}
	if sn.Body != "" {
		// The long lines are wrapped for the screen; the same text is saved, unwrapped, to a file and can be copied.
		m.snipFile = saveSnippet(m.ans.Dir, sn)
		if m.snipFile != "" {
			b.WriteString(styFaint.Render("Saved here, so you can copy it from the file: ") + m.snipFile + "\n")
		}
		b.WriteString("\n" + styCode.Render(wrap(strings.TrimRight(sn.Body, "\n"), m.bodyWidth()-2)) + "\n")
	}
	if len(sn.Steps) > 0 {
		b.WriteString("\n" + styTitle.Render("Do this") + "\n")
		for i, s := range sn.Steps {
			b.WriteString(fmt.Sprintf("  %s %s\n", styAccent.Render(strconv.Itoa(i+1)+"."), wrap(s, m.bodyWidth()-6)))
		}
	}
	if len(sn.Notes) > 0 {
		b.WriteString("\n" + styTitle.Render("Good to know") + "\n")
		for _, n := range sn.Notes {
			b.WriteString("  • " + wrap(n, m.bodyWidth()-6) + "\n")
		}
	}
	m.snipVP.SetContent(b.String())
	m.screen = scProxySetup
	return m, nil
}

func (m Model) verifyURL() string { return m.plan.URL }

func (m Model) toVerify() (tea.Model, tea.Cmd) {
	m.screen = scVerify
	m.verifying = true
	m.report = verify.Report{}
	target, insecure, run := m.verifyURL(), m.cfg.InsecureTLS, m.cfg.Verify
	return m, tea.Batch(m.spin.Tick, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if run != nil {
			return verifyMsg{run(ctx, target, insecure)}
		}
		return verifyMsg{verify.Run(ctx, verify.Options{PublicURL: target, InsecureTLS: insecure})}
	})
}

func (m Model) toAdmin() (tea.Model, tea.Cmd) {
	m.adminErr = ""
	m.adminForm = newForm(
		textField("username", "Username", "Lowercase letters, digits, dot, dash or underscore.", "", false, func(s string) error {
			return apply.ValidateAdmin(apply.Admin{Username: s, Name: "x", Password: "12345678"})
		}),
		textField("name", "Your name", "Shown in the app.", "", false, func(s string) error {
			if strings.TrimSpace(s) == "" {
				return fmt.Errorf("enter a name")
			}
			return nil
		}),
		textField("password", "Password", "At least 8 characters.", "", true, func(s string) error {
			return apply.ValidateAdmin(apply.Admin{Username: "xx", Name: "x", Password: s})
		}),
		textField("confirm", "Repeat the password", "", "", true, nil),
	)
	m.screen = scAdmin
	return m, m.adminForm.fields[0].Input.Focus()
}

func (m Model) submitAdmin() (tea.Model, tea.Cmd) {
	if !m.adminForm.check() {
		return m, nil
	}
	if m.adminForm.raw("password") != m.adminForm.raw("confirm") {
		m.adminForm.fields[3].err = "the two passwords differ"
		m.adminForm.focus = 3
		m.adminForm.refocus()
		return m, nil
	}
	admin := apply.Admin{Username: m.adminForm.value("username"), Name: m.adminForm.value("name"), Password: m.adminForm.raw("password")}
	base, token, insecure, create := m.plan.URL, m.ans.SetupToken, m.cfg.InsecureTLS, m.cfg.CreateAdmin
	m.adminBusy, m.adminErr = true, ""
	return m, tea.Batch(m.spin.Tick, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if create != nil {
			return adminMsg{create(ctx, base, token, admin, insecure)}
		}
		return adminMsg{apply.CreateAdmin(ctx, apply.HTTPClient(insecure), base, token, admin)}
	})
}

// ---------------------------------------------------------------- views

func (m Model) View() string {
	w, h := m.width, m.height
	switch m.screen {
	case scWelcome:
		body := styMuted.Render("This sets up the Atelier server on this machine: the files, the containers, HTTPS and your first account. It takes a few minutes, shows you every file before writing it, and changes nothing until you say so.")
		return frame(w, h, 0, "", wrap(body, m.bodyWidth()), hint("enter", "begin", "q", "quit"), true)
	case scProbe:
		return frame(w, h, 0, "Looking at this machine", m.spin.View()+" checking Docker, ports, disk and memory…", hint("ctrl+c", "quit"), false)
	case scChecks:
		return m.viewChecks()
	case scExisting:
		return frame(w, h, 0, "Atelier is already set up here", m.exChoice.view(m.bodyWidth()), hint("↑/↓", "choose", "enter", "continue", "q", "quit"), false)
	case scRemove:
		body := styBad.Render("This deletes the containers and all the data of the server in "+m.info.Existing.Dir+": accounts, chats and settings. It cannot be undone.") + "\n\n" + m.removeForm.view(m.bodyWidth())
		if m.removeBusy {
			body += "\n\n" + m.spin.View() + " removing…"
		}
		return frame(w, h, 0, "Remove the earlier setup", wrap(body, m.bodyWidth()), hint("enter", "remove it", "esc", "back"), false)
	case scMode:
		return frame(w, h, 1, "How will people reach Atelier?", m.modeChoice.view(m.bodyWidth()), hint("↑/↓", "choose", "enter", "continue", "q", "quit"), false)
	case scDomain:
		body := m.domainForm.view(m.bodyWidth())
		return frame(w, h, 1, "Where will it live?", body, hint("enter", "continue", "esc", "back"), false)
	case scProxyKind:
		return frame(w, h, 1, "Which reverse proxy?", m.kindChoice.view(m.bodyWidth()), hint("↑/↓", "choose", "enter", "continue", "esc", "back"), false)
	case scProxyWhere:
		return frame(w, h, 1, "Where does your proxy run?", m.whereChoice.view(m.bodyWidth()), hint("↑/↓", "choose", "enter", "continue", "esc", "back"), false)
	case scOptions:
		return frame(w, h, 2, "A few options", m.optForm.view(m.bodyWidth()), hint("↑/↓", "move", "type", "edit", "space", "switch on/off", "enter", "continue", "esc", "back"), false)
	case scReview:
		return frame(w, h, 3, "Review", m.review.View(), hint("↑/↓", "scroll", "enter", "install", "b", "change answers", "q", "quit"), false)
	case scApply:
		return m.viewApply()
	case scDocker:
		return m.viewDocker()
	case scProxySetup:
		hints := hint("↑/↓", "scroll", "enter", "my proxy is ready, test it")
		if m.ans.Mode == plan.Tailscale {
			hints = hint("t", "run the command for me", "enter", "I ran it, test it", "↑/↓", "scroll")
		} else if m.snippet.Body != "" {
			hints = hint("c", "copy the settings", "↑/↓", "scroll", "enter", "my proxy is ready, test it")
		}
		return frame(w, h, 4, "Set up your proxy", m.snipVP.View(), hints, false)
	case scVerify:
		return m.viewVerify()
	case scAdmin:
		body := m.adminForm.view(m.bodyWidth())
		if m.adminBusy {
			body += "\n\n" + m.spin.View() + " creating the account…"
		}
		if m.adminErr != "" {
			body += "\n\n" + styBad.Render("✗ "+wrap(m.adminErr, m.bodyWidth()-4))
		}
		return frame(w, h, 5, "Create your account", body, hint("tab", "next", "enter", "create", "esc", "back"), false)
	case scDone:
		return m.viewDone()
	}
	return ""
}

func (m Model) viewChecks() string {
	var b strings.Builder
	for _, c := range m.checks {
		icon := styGood.Render("✓")
		switch c.Status {
		case system.Warn:
			icon = styWarn.Render("!")
		case system.Bad:
			icon = styBad.Render("✗")
		}
		b.WriteString(fmt.Sprintf("%s %-16s %s\n", icon, c.Name, styMuted.Render(c.Detail)))
		if c.Fix != "" && c.Status != system.OK {
			b.WriteString("    " + styFaint.Render(strings.ReplaceAll(wrap(c.Fix, m.bodyWidth()-6), "\n", "\n    ")) + "\n")
		}
	}
	if m.note != "" {
		b.WriteString("\n" + styWarn.Render(m.note) + "\n")
	}
	hints := hint("enter", "continue", "r", "check again", "q", "quit")
	if system.Blocking(m.checks) {
		hints = hint("r", "check again", "q", "quit")
		if fix := system.DockerFix(m.info); fix != "" {
			hints = hint("enter", fixTitle(apply.DockerFix(fix)), "r", "check again", "q", "quit")
		}
	}
	return frame(m.width, m.height, 0, "This machine", strings.TrimRight(b.String(), "\n"), hints, false)
}

func (m Model) viewApply() string {
	var b strings.Builder
	for _, s := range m.steps {
		b.WriteString(m.stepIcon(s.State) + " " + s.Title + "\n")
		if s.ID == "pull" && len(m.pullOrder) > 0 {
			for _, name := range m.pullOrder {
				b.WriteString(m.imageRow(name) + "\n")
			}
		}
	}
	hints := hint("ctrl+c", "stop")
	if m.applyDone && m.applyErr != nil {
		b.WriteString("\n" + styBad.Render("✗ "+wrap(m.applyErr.Error(), m.bodyWidth()-4)) + "\n")
		b.WriteString(m.tail(m.logLines, 8))
		hints = hint("r", "try again", "b", "change answers", "q", "quit")
	}
	return frame(m.width, m.height, 4, "Installing", strings.TrimRight(b.String(), "\n"), hints, false)
}

func (m Model) stepIcon(state string) string {
	switch state {
	case "running":
		return m.spin.View()
	case "done":
		return styGood.Render("✓")
	case "fail":
		return styBad.Render("✗")
	}
	return styFaint.Render("○")
}

// imageRow is one image of the pull: its short name, a bar and how far it is ("142 MB of 310 MB", "unpacking", "ready").
func (m Model) imageRow(name string) string {
	p := m.pull[name]
	label := shortImage(name)
	const labelWidth, textWidth = 18, 20
	if len(label) > labelWidth-2 {
		label = label[:labelWidth-3] + "…"
	}
	text := styFaint.Render("waiting")
	switch {
	case p.Done:
		text = styGood.Render("ready")
	case p.Size > 0 && p.Downloaded < p.Size:
		text = styMuted.Render(humanBytes(p.Downloaded) + " of " + humanBytes(p.Size))
	case p.Layers > 0 && p.Unpacked < p.Layers:
		text = styMuted.Render("unpacking")
	}
	width := max(m.bodyWidth()-4-labelWidth-2-textWidth, 10)
	return "    " + styCode.Render(fmt.Sprintf("%-*s", labelWidth, label)) + bar(m.shown[name], width) + "  " + text
}

// bar draws a progress bar of width cells, the done part in the accent color.
func bar(fraction float64, width int) string {
	filled := int(fraction*float64(width) + 0.5)
	filled = min(max(filled, 0), width)
	return styAccent.Render(strings.Repeat("━", filled)) + styFaint.Render(strings.Repeat("━", width-filled))
}

// shortImage is the name people know an image by: ghcr.io/theoriuhd/atelier-sandbox:latest is atelier-sandbox.
func shortImage(image string) string {
	name := image[strings.LastIndex(image, "/")+1:]
	if i := strings.Index(name, ":"); i > 0 {
		name = name[:i]
	}
	return name
}

// humanBytes is a size the way Docker writes it: 142 MB, 1.3 GB.
func humanBytes(n int64) string {
	switch {
	case n >= 1e9:
		return fmt.Sprintf("%.1f GB", float64(n)/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%d MB", n/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%d kB", n/1e3)
	}
	return fmt.Sprintf("%d B", n)
}

// tail is the last n lines of a command's output, dim, for when something failed.
func (m Model) tail(lines []string, n int) string {
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	var b strings.Builder
	if len(lines) > 0 {
		b.WriteString("\n")
	}
	for _, l := range lines {
		if len(l) > m.bodyWidth()-2 {
			l = l[:m.bodyWidth()-2]
		}
		b.WriteString(styFaint.Render(l) + "\n")
	}
	return b.String()
}

func fixTitle(fix apply.DockerFix) string {
	switch fix {
	case apply.StartDocker:
		return "start Docker"
	case apply.InstallCompose:
		return "install Docker Compose"
	}
	return "install Docker"
}

// viewDocker shows Docker being installed (or started, or completed): its steps, what the installer is doing in words
// and for how long, and the installer's last lines only when it failed.
func (m Model) viewDocker() string {
	var b strings.Builder
	for _, s := range m.fixSteps {
		b.WriteString(m.stepIcon(s.State) + " " + s.Title + "\n")
		if s.State == "running" {
			what := m.fixActivity
			if what == "" {
				what = "working"
			}
			b.WriteString("    " + styMuted.Render(what+" · "+elapsed(time.Since(m.fixStarted))) + "\n")
		}
	}
	hints := hint("ctrl+c", "stop")
	if m.fixErr != nil {
		b.WriteString("\n" + styBad.Render("✗ "+wrap(m.fixErr.Error(), m.bodyWidth()-4)) + "\n")
		b.WriteString(m.tail(m.fixLog, 8))
		hints = hint("r", "try again", "esc", "back to the checks", "q", "quit")
	} else {
		b.WriteString("\n" + styFaint.Render(wrap("This uses Docker's own installer and takes a minute or two. The machine is checked again when it is done.", m.bodyWidth())) + "\n")
	}
	title := strings.ToUpper(fixTitle(m.fix)[:1]) + fixTitle(m.fix)[1:]
	return frame(m.width, m.height, 0, title, strings.TrimRight(b.String(), "\n"), hints, false)
}

// elapsed is "45s" or "2m 04s".
func elapsed(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	return fmt.Sprintf("%dm %02ds", s/60, s%60)
}

func (m Model) viewVerify() string {
	if m.verifying {
		return frame(m.width, m.height, 4, "Testing "+m.plan.URL, m.spin.View()+" resolving the address, checking the certificate and opening a live connection like a browser…", hint("ctrl+c", "quit"), false)
	}
	var b strings.Builder
	for _, c := range m.report.Checks {
		icon := styGood.Render("✓")
		switch c.Status {
		case verify.Warn:
			icon = styWarn.Render("!")
		case verify.Fail:
			icon = styBad.Render("✗")
		case verify.Skipped:
			icon = styFaint.Render("–")
		}
		width := m.bodyWidth() - 8
		b.WriteString(fmt.Sprintf("%s %s\n", icon, c.Name))
		if c.Detail != "" {
			detail := c.Detail
			if c.Status == verify.Pass && len(detail) > width {
				detail = detail[:width-1] + "…"
			}
			b.WriteString("    " + styMuted.Render(strings.ReplaceAll(wrap(detail, width), "\n", "\n    ")) + "\n")
		}
		if c.Fix != "" && c.Status == verify.Fail {
			b.WriteString("    " + styWarn.Render("→ "+strings.ReplaceAll(wrap(c.Fix, width-2), "\n", "\n      ")) + "\n")
		}
	}
	title := "It works"
	hints := hint("enter", "create the account", "r", "test again")
	if !m.report.OK() {
		title = "Not quite yet"
		hints = hint("r", "test again after the fix", "c", "continue anyway", "q", "quit")
	}
	return frame(m.width, m.height, 4, title, strings.TrimRight(b.String(), "\n"), hints, false)
}

func (m Model) viewDone() string {
	var b strings.Builder
	b.WriteString(styGood.Render("Atelier is running.") + "\n")
	if m.hadAdmin {
		b.WriteString(styMuted.Render("It already had an account: sign in with it.") + "\n")
	}
	b.WriteString("\n")
	b.WriteString("Open  " + styAccent.Render(m.plan.URL) + "\n")
	b.WriteString(styFaint.Render("In the desktop app: Connect to a server, and enter that address.") + "\n\n")
	if qr, err := qrcode.New(m.plan.URL, qrcode.Low); err == nil {
		b.WriteString(styCode.Render(strings.TrimRight(qr.ToSmallString(false), "\n")) + "\n\n")
	}
	b.WriteString(styTitle.Render("Files") + "  " + m.ans.Dir + "\n")
	b.WriteString(styTitle.Render("Update") + "  " + styCode.Render("atelier-setup update") + styFaint.Render("  (or the Update server button in Settings)") + "\n")
	b.WriteString(styTitle.Render("Check") + "  " + styCode.Render("atelier-setup doctor") + styFaint.Render("  if anything stops working"))
	return frame(m.width, m.height, 5, "Done", b.String(), hint("enter", "finish"), false)
}

// saveSnippet writes the proxy settings next to the install, unwrapped, and returns the path ("" if it cannot).
func saveSnippet(dir string, sn proxy.Snippet) string {
	if dir == "" {
		return ""
	}
	folder := filepath.Join(dir, "proxy")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	path := filepath.Join(folder, string(sn.Kind)+".conf")
	if err := os.WriteFile(path, []byte(sn.Body), 0o644); err != nil {
		return ""
	}
	return path
}

// copyToClipboard asks the terminal to copy text (the OSC 52 escape sequence; most modern terminals honour it).
func copyToClipboard(text string) {
	fmt.Fprintf(os.Stdout, "\x1b]52;c;%s\x07", base64.StdEncoding.EncodeToString([]byte(text)))
}
