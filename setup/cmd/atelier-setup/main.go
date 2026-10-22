// atelier-setup installs and looks after an Atelier server: a full-screen wizard, plus doctor, update and status.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/term"

	"atelier.dev/setup/internal/apply"
	"atelier.dev/setup/internal/notices"
	"atelier.dev/setup/internal/plan"
	"atelier.dev/setup/internal/proxy"
	"atelier.dev/setup/internal/system"
	"atelier.dev/setup/internal/ui"
	"atelier.dev/setup/internal/verify"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

const usage = `atelier-setup: install and look after an Atelier server

  atelier-setup                  the setup wizard (a full-screen terminal interface)
  atelier-setup plan [flags]     print the files and steps for the answers given as flags; changes nothing
  atelier-setup install --yes    install without the wizard, from flags
  atelier-setup doctor           test the server's address like a browser would, and say what to change
  atelier-setup update           pull the newest images and restart what changed
  atelier-setup status           show whether the server is running and healthy
  atelier-setup version
  atelier-setup licenses         the licenses of the third-party code in this program

Flags for plan and install:
  --dir DIR             install folder (default /opt/atelier as root, ~/atelier otherwise)
  --mode MODE           caddy | proxy | tailscale | lan
  --url URL             the address people use, e.g. https://atelier.example.com (caddy, proxy, tailscale)
  --proxy KIND          caddy | nginx | traefik | npm | cloudflared (with --mode proxy; prints its settings)
  --bind ADDR           address the published port listens on (default 127.0.0.1; lan uses 0.0.0.0)
  --port N              published port (default 7340)
  --proxy-addr LIST     addresses your proxy connects from, for ATELIER_TRUSTED_PROXIES
  --no-sandbox          leave out the chat sandbox
  --no-updater          leave out the update service
  --tag TAG             image version (default latest)
  --registry PREFIX     image registry path (default ghcr.io/theoriuhd)
  --local-images        use atelier:local, atelier-sandbox:local and atelier-updater:local, no pull
  --ollama URL          add an Ollama provider
  --admin-user NAME --admin-name NAME --admin-password-file FILE   create the first account (install)
  --insecure-tls        accept a self-signed certificate in the live test
`

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "", "wizard":
		err = wizard(args)
	case "plan":
		err = planCmd(args)
	case "install":
		err = installCmd(args)
	case "doctor":
		err = doctor(args)
	case "update":
		err = updateCmd(args)
	case "status":
		err = status(args)
	case "version", "--version":
		fmt.Println("atelier-setup", version)
	case "licenses":
		fmt.Print(notices.Text)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "\n"+err.Error())
		os.Exit(1)
	}
}

type answersFlags struct {
	dir, mode, url, proxyKind, bind, proxyAddr, tag, registry, ollama string
	port                                                              int
	noSandbox, noUpdater, localImages, insecure, yes                  bool
	adminUser, adminName, adminPasswordFile                           string
}

func (f *answersFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.dir, "dir", "", "")
	fs.StringVar(&f.mode, "mode", "", "")
	fs.StringVar(&f.url, "url", "", "")
	fs.StringVar(&f.proxyKind, "proxy", "", "")
	fs.StringVar(&f.bind, "bind", "", "")
	fs.IntVar(&f.port, "port", 0, "")
	fs.StringVar(&f.proxyAddr, "proxy-addr", "", "")
	fs.BoolVar(&f.noSandbox, "no-sandbox", false, "")
	fs.BoolVar(&f.noUpdater, "no-updater", false, "")
	fs.StringVar(&f.tag, "tag", "", "")
	fs.StringVar(&f.registry, "registry", "", "")
	fs.BoolVar(&f.localImages, "local-images", false, "")
	fs.StringVar(&f.ollama, "ollama", "", "")
	fs.BoolVar(&f.insecure, "insecure-tls", false, "")
	fs.BoolVar(&f.yes, "yes", false, "")
	fs.StringVar(&f.adminUser, "admin-user", "", "")
	fs.StringVar(&f.adminName, "admin-name", "", "")
	fs.StringVar(&f.adminPasswordFile, "admin-password-file", "", "")
}

func (f answersFlags) images() *plan.Images {
	if !f.localImages && f.tag == "" && f.registry == "" {
		return nil
	}
	img := plan.DefaultImages()
	if f.registry != "" {
		img.Prefix = f.registry
	}
	if f.tag != "" {
		img.Tag = f.tag
	}
	img.Local = f.localImages
	return &img
}

func (f answersFlags) answers() plan.Answers {
	home, _ := os.UserHomeDir()
	a := plan.Defaults(os.Geteuid() == 0, home)
	if f.dir != "" {
		a.Dir = f.dir
	}
	if f.mode != "" {
		a.Mode = plan.Mode(f.mode)
	}
	if f.url != "" {
		a.PublicURL = strings.TrimRight(f.url, "/")
		if a.Mode != plan.LAN && !strings.Contains(a.PublicURL, "://") {
			a.PublicURL = "https://" + a.PublicURL
		}
	}
	// A proxy or Tailscale on this machine reaches Atelier on 127.0.0.1; the plain address listens on every address.
	a.BindAddr = "127.0.0.1"
	if a.Mode == plan.LAN {
		a.BindAddr = "0.0.0.0"
	} else if f.bind != "" {
		a.BindAddr = f.bind
	}
	if f.port != 0 {
		a.Port = f.port
	}
	a.ProxyAddrs = f.proxyAddr
	a.Sandbox, a.Updater = !f.noSandbox, !f.noUpdater
	if img := f.images(); img != nil {
		a.Images = *img
	}
	a.OllamaURL = f.ollama
	a.SetupToken = apply.NewToken()
	return a
}

// ---------------------------------------------------------------- wizard

func wizard(args []string) error {
	fs := flag.NewFlagSet("wizard", flag.ContinueOnError)
	var f answersFlags
	f.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return fmt.Errorf("the wizard needs a terminal. Run it directly, or use `atelier-setup install --yes` with flags (see --help)")
	}
	m := ui.New(ui.Config{Dir: f.dir, Images: f.images(), InsecureTLS: f.insecure, Version: version})
	_, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	return err
}

// ---------------------------------------------------------------- plan and install without the wizard

func planCmd(args []string) error {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	var f answersFlags
	f.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	a := f.answers()
	p, err := plan.Build(a)
	if err != nil {
		return err
	}
	printPlan(p, a, f)
	return nil
}

func printPlan(p plan.Plan, a plan.Answers, f answersFlags) {
	fmt.Println("Steps")
	for i, s := range p.Steps {
		fmt.Printf("  %d. %s\n     %s\n", i+1, s.Title, s.Command)
	}
	fmt.Println("\nAddress:", p.URL)
	for _, file := range p.Files {
		fmt.Printf("\n--- %s ---\n", file.Path)
		if file.Secret {
			fmt.Println("(contains secrets, not shown)")
			continue
		}
		fmt.Print(file.Body)
	}
	if a.Mode == plan.OwnProxy && f.proxyKind != "" {
		in := proxy.Inputs{PublicURL: a.PublicURL, Upstream: p.Upstream}
		if sn, err := proxy.Generate(proxy.Kind(f.proxyKind), in); err == nil {
			fmt.Printf("\n--- %s ---\n%s\n", sn.Title, sn.Body)
			for i, s := range sn.Steps {
				fmt.Printf("  %d. %s\n", i+1, s)
			}
		}
	}
}

func installCmd(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	var f answersFlags
	f.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !f.yes {
		return fmt.Errorf("install changes this machine: pass --yes to go ahead (or run the wizard, which asks), or use `plan` to look first")
	}
	a := f.answers()
	p, err := plan.Build(a)
	if err != nil {
		return err
	}
	if a.Mode == plan.LAN {
		info := system.Probe(context.Background(), system.ExecRunner{}, a.Dir, nil)
		host := "localhost"
		if len(info.Addrs) > 0 {
			host = info.Addrs[0]
		}
		a.PublicURL = fmt.Sprintf("http://%s:%d", host, a.Port)
		p, _ = plan.Build(a)
		p.URL = a.PublicURL
	}
	printPlan(p, a, f)
	fmt.Println()
	err = apply.Execute(context.Background(), p, a, apply.Options{}, func(e apply.Event) {
		switch e.Kind {
		case "start":
			fmt.Printf("▸ %s\n", e.Text)
		case "log":
			fmt.Printf("    %s\n", e.Text)
		case "fail":
			fmt.Printf("✗ %s failed: %v\n", e.Step, e.Err)
		}
	})
	if err != nil {
		return err
	}
	rep := verify.Run(context.Background(), verify.Options{PublicURL: p.URL, InsecureTLS: f.insecure})
	printReport(rep)
	if f.adminUser != "" {
		pw, err := os.ReadFile(f.adminPasswordFile)
		if err != nil {
			return fmt.Errorf("cannot read the password file: %w", err)
		}
		admin := apply.Admin{Username: f.adminUser, Name: f.adminName, Password: strings.TrimRight(string(pw), "\r\n")}
		if admin.Name == "" {
			admin.Name = admin.Username
		}
		if err := apply.CreateAdmin(context.Background(), apply.HTTPClient(f.insecure), p.URL, a.SetupToken, admin); err != nil {
			return fmt.Errorf("the server is running, but the first account was not created: %w", err)
		}
		_ = apply.ClearToken(a.Dir)
		fmt.Println("✓ created the account", admin.Username)
	} else {
		fmt.Printf("\nOpen %s to create the first account. The setup token is in %s/.env\n", p.URL, a.Dir)
	}
	if !rep.OK() {
		return fmt.Errorf("the server is installed, but the live test found problems (above)")
	}
	return nil
}

func printReport(r verify.Report) {
	fmt.Println()
	for _, c := range r.Checks {
		mark := map[verify.Status]string{verify.Pass: "✓", verify.Warn: "!", verify.Fail: "✗", verify.Skipped: "–"}[c.Status]
		fmt.Printf("%s %-28s %s\n", mark, c.Name, c.Detail)
		if c.Fix != "" && c.Status == verify.Fail {
			fmt.Printf("    → %s\n", c.Fix)
		}
	}
	fmt.Println(r.Summary())
}

// ---------------------------------------------------------------- doctor, update, status

func findDir(explicit string) string {
	if explicit != "" {
		return explicit
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if dir, _ := system.ExistingDir(ctx, system.ExecRunner{}); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	for _, d := range []string{".", "/opt/atelier", filepath.Join(home, "atelier")} {
		if _, err := os.Stat(filepath.Join(d, "compose.yaml")); err == nil {
			abs, _ := filepath.Abs(d)
			return abs
		}
	}
	return ""
}

func doctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	dir := fs.String("dir", "", "")
	url := fs.String("url", "", "")
	insecure := fs.Bool("insecure-tls", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	d := findDir(*dir)
	target := *url
	if target == "" && d != "" {
		target = apply.BaseURL(filepath.Join(d, "compose.yaml"))
		if target == "" {
			target = apply.PublishedURL(filepath.Join(d, "compose.yaml"))
		}
	}
	if target == "" {
		return fmt.Errorf("cannot tell which address to test: pass --url https://your-address")
	}
	fmt.Println("Testing", target)
	if d != "" {
		fmt.Println("Install folder", d)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = apply.ExecRun(ctx, d, "docker", []string{"compose", "ps"}, func(l string) { fmt.Println("  " + l) })
		var refused []string
		_ = apply.ExecRun(ctx, d, "docker", []string{"compose", "logs", "--tail", "200", "atelier"}, func(l string) {
			if strings.Contains(l, "Refused ") {
				refused = append(refused, l)
			}
		})
		if len(refused) > 0 {
			fmt.Println("\nThe server's log has refusals:")
			for _, l := range refused[max(0, len(refused)-3):] {
				fmt.Println("  " + l)
			}
		}
	}
	rep := verify.Run(context.Background(), verify.Options{PublicURL: target, InsecureTLS: *insecure})
	printReport(rep)
	if !rep.OK() {
		return fmt.Errorf("found problems (above)")
	}
	return nil
}

func updateCmd(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	dir := fs.String("dir", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	d := findDir(*dir)
	if d == "" {
		return fmt.Errorf("cannot find the install folder: pass --dir")
	}
	return apply.Update(context.Background(), apply.Options{}, d, func(l string) { fmt.Println(l) })
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	dir := fs.String("dir", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	d := findDir(*dir)
	if d == "" {
		return fmt.Errorf("cannot find the install folder: pass --dir")
	}
	c := exec.Command("docker", "compose", "ps")
	c.Dir, c.Stdout, c.Stderr = d, os.Stdout, os.Stderr
	return c.Run()
}
