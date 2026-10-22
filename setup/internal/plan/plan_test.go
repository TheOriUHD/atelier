package plan

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files")

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden file %s (run go test -update): %v", path, err)
	}
	if string(want) != got {
		t.Errorf("%s differs from the golden file; run go test -update and review the diff.\n--- got ---\n%s", name, got)
	}
}

func answers(mode Mode) Answers {
	a := Defaults(true, "/root")
	a.Mode = mode
	a.SetupToken = "tok_123"
	switch mode {
	case BundledCaddy:
		a.PublicURL = "https://atelier.example.com"
	case OwnProxy:
		a.PublicURL = "https://atelier.example.com"
		a.ProxyAddrs = "192.168.77.16"
		a.BindAddr = "0.0.0.0"
	case Tailscale:
		a.PublicURL = "https://box.tail1234.ts.net"
		a.BindAddr = "127.0.0.1"
	case LAN:
		a.BindAddr = "0.0.0.0"
	}
	return a
}

func file(t *testing.T, p Plan, suffix string) File {
	t.Helper()
	for _, f := range p.Files {
		if strings.HasSuffix(f.Path, suffix) {
			return f
		}
	}
	t.Fatalf("no file %s in the plan", suffix)
	return File{}
}

func TestComposePerMode(t *testing.T) {
	for _, mode := range Modes() {
		t.Run(string(mode), func(t *testing.T) {
			p, err := Build(answers(mode))
			if err != nil {
				t.Fatal(err)
			}
			golden(t, string(mode)+".compose.yaml", file(t, p, "compose.yaml").Body)
		})
	}
}

func TestCaddyfileAndEnv(t *testing.T) {
	p, err := Build(answers(BundledCaddy))
	if err != nil {
		t.Fatal(err)
	}
	if got := file(t, p, "Caddyfile").Body; got != "atelier.example.com {\n\treverse_proxy atelier:7340\n}\n" {
		t.Errorf("Caddyfile = %q", got)
	}
	env := file(t, p, ".env")
	if env.Mode != 0o600 || !env.Secret || !strings.Contains(env.Body, "ATELIER_SETUP_TOKEN=tok_123") {
		t.Errorf(".env = %+v", env)
	}
	for _, mode := range []Mode{OwnProxy, Tailscale, LAN} {
		q, _ := Build(answers(mode))
		for _, f := range q.Files {
			if strings.HasSuffix(f.Path, "Caddyfile") {
				t.Errorf("%s writes a Caddyfile", mode)
			}
		}
	}
}

func TestOptionsAndImages(t *testing.T) {
	a := answers(OwnProxy)
	a.Sandbox, a.Updater = false, false
	p, _ := Build(a)
	body := file(t, p, "compose.yaml").Body
	for _, absent := range []string{"sandbox:", "updater:", "ATELIER_UPDATER_URL", "ATELIER_SANDBOX_HOST", "sandbox-keys"} {
		if strings.Contains(body, absent) {
			t.Errorf("compose still has %q with both options off", absent)
		}
	}
	a = answers(LAN)
	a.Images = Images{Local: true}
	p, _ = Build(a)
	body = file(t, p, "compose.yaml").Body
	if !strings.Contains(body, "image: atelier:local") || !strings.Contains(body, "image: atelier-sandbox:local") {
		t.Errorf("local images not used:\n%s", body)
	}
	for _, s := range p.Steps {
		if s.ID == "pull" {
			t.Error("local images are pulled")
		}
	}
	a.Images = Images{Prefix: "ghcr.io/theoriuhd/", Tag: "v0.2.2"}
	p, _ = Build(a)
	if !strings.Contains(file(t, p, "compose.yaml").Body, "image: ghcr.io/theoriuhd/atelier:v0.2.2") {
		t.Error("a pinned tag and a prefix with a trailing slash are not used as given")
	}
}

func TestUpstreamAndURL(t *testing.T) {
	p, _ := Build(answers(OwnProxy))
	if p.URL != "https://atelier.example.com" || p.Upstream != "<this machine's address>:7340" {
		t.Errorf("url %q upstream %q", p.URL, p.Upstream)
	}
	a := answers(OwnProxy)
	a.BindAddr = "127.0.0.1"
	a.Port = 8080
	p, _ = Build(a)
	if p.Upstream != "127.0.0.1:8080" || !strings.Contains(file(t, p, "compose.yaml").Body, "'127.0.0.1:8080:7340'") {
		t.Errorf("upstream %q", p.Upstream)
	}
}

func TestValidation(t *testing.T) {
	bad := map[string]func(*Answers){
		"http address":        func(a *Answers) { a.PublicURL = "http://atelier.example.com" },
		"path in the address": func(a *Answers) { a.PublicURL = "https://atelier.example.com/app" },
		"no dot in the host":  func(a *Answers) { a.PublicURL = "https://atelier" },
		"relative folder":     func(a *Answers) { a.Dir = "atelier" },
		"bad proxy address":   func(a *Answers) { a.Mode = OwnProxy; a.ProxyAddrs = "caddy" },
		"bad port":            func(a *Answers) { a.Mode = OwnProxy; a.Port = 70000 },
		"no mode":             func(a *Answers) { a.Mode = "" },
		"no registry":         func(a *Answers) { a.Images = Images{} },
	}
	for name, change := range bad {
		a := answers(BundledCaddy)
		change(&a)
		if _, err := Build(a); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	a := answers(OwnProxy)
	a.ProxyAddrs = "10.0.0.0/8, 192.168.77.16"
	if _, err := Build(a); err != nil {
		t.Errorf("a list of addresses and ranges: %v", err)
	}
}

func TestParsePublicURL(t *testing.T) {
	u, err := ParsePublicURL(" https://Atelier.Example.com:8443/ ")
	if err != nil || u.Host != "Atelier.Example.com:8443" {
		t.Errorf("%v %v", u, err)
	}
}
