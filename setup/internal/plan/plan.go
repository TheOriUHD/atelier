// Package plan turns the wizard's answers into the files and steps of an Atelier server install. Nothing here touches the
// machine: the same plan is shown for review, written by apply, and printed by --plan.
package plan

import (
	"bytes"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
)

// Mode is how people will reach the server.
type Mode string

const (
	// BundledCaddy runs Caddy in the same Compose project: it gets the certificate and forwards to Atelier.
	BundledCaddy Mode = "caddy"
	// OwnProxy leaves HTTPS to a reverse proxy the person already runs; Atelier publishes a port for it.
	OwnProxy Mode = "proxy"
	// Tailscale publishes the port on this machine only and serves it on the tailnet with `tailscale serve`.
	Tailscale Mode = "tailscale"
	// LAN publishes plain HTTP on the local network, with no HTTPS.
	LAN Mode = "lan"
)

// Modes in display order.
func Modes() []Mode { return []Mode{LAN, BundledCaddy, OwnProxy, Tailscale} }

// Label is what the wizard calls a mode.
func (m Mode) Label() string {
	switch m {
	case LAN:
		return "This machine's address, no domain needed"
	case BundledCaddy:
		return "A domain name with HTTPS (Caddy handles it)"
	case OwnProxy:
		return "Behind my own reverse proxy"
	case Tailscale:
		return "Only on my Tailscale network"
	}
	return string(m)
}

// Images says where the three images come from.
type Images struct {
	// Prefix is the registry path, e.g. "ghcr.io/theoriuhd"; images are <prefix>/atelier, -sandbox and -updater.
	Prefix string
	// Tag is "latest" or a version such as "v0.2.2".
	Tag string
	// Local uses images already on this machine (atelier:local, atelier-sandbox:local, atelier-updater:local): no pull.
	Local bool
}

// DefaultImages are the released images.
func DefaultImages() Images { return Images{Prefix: "ghcr.io/theoriuhd", Tag: "latest"} }

func (i Images) name(base string) string {
	if i.Local {
		return base + ":local"
	}
	return fmt.Sprintf("%s/%s:%s", strings.TrimRight(i.Prefix, "/"), base, i.Tag)
}

// Answers is everything the wizard asks.
type Answers struct {
	// Dir is where compose.yaml and .env go, e.g. /opt/atelier.
	Dir  string
	Mode Mode
	// PublicURL is the address people type: https://atelier.example.com (BundledCaddy, OwnProxy, Tailscale). For LAN
	// it is derived from the machine's address and Port, and may be empty.
	PublicURL string
	// BindAddr is where the published port listens (OwnProxy, Tailscale, LAN): 127.0.0.1 when the proxy is on this
	// machine, 0.0.0.0 otherwise.
	BindAddr string
	// Port is the published port on the host (OwnProxy, Tailscale, LAN). Atelier itself always listens on 7340 inside.
	Port int
	// ProxyAddrs are the addresses the reverse proxy connects from, for ATELIER_TRUSTED_PROXIES (OwnProxy). Optional:
	// ATELIER_BASE_URL already makes origin checks pass; these make client addresses right in rate limits.
	ProxyAddrs string
	Sandbox    bool
	Updater    bool
	Images     Images
	// SetupToken lets the wizard create the first admin; it is removed from .env afterwards.
	SetupToken string
	// OllamaURL, when set, is written to settings.json as an Ollama provider.
	OllamaURL string
}

// Defaults returns the answers a person gets when they accept everything.
func Defaults(root bool, home string) Answers {
	dir := filepath.Join(home, "atelier")
	if root {
		dir = "/opt/atelier"
	}
	return Answers{Dir: dir, Mode: LAN, BindAddr: "0.0.0.0", Port: 7340, Sandbox: true, Updater: true, Images: DefaultImages()}
}

// File is one file the install writes.
type File struct {
	Path string
	Mode uint32
	Body string
	// Secret files are shown with their values hidden.
	Secret bool
}

// Step is one thing the install does, in order. ID names what apply runs; Command is shown on the review screen.
type Step struct {
	ID      string
	Title   string
	Command string
}

// Plan is the install.
type Plan struct {
	Files []File
	Steps []Step
	// URL is the address to open, and the one the live test checks.
	URL string
	// Upstream is where a reverse proxy reaches Atelier (OwnProxy).
	Upstream string
}

var hostRe = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$`)

// ParsePublicURL checks an https address with a real host name: scheme, host and optional port, nothing else.
func ParsePublicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("enter the full address, for example https://atelier.example.com")
	}
	if u.Scheme != "https" {
		return nil, fmt.Errorf("the address must start with https://")
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("use only the host name, with no path: https://atelier.example.com")
	}
	if !hostRe.MatchString(u.Hostname()) || len(u.Hostname()) > 253 {
		return nil, fmt.Errorf("%q is not a valid host name", u.Hostname())
	}
	if p := u.Port(); p != "" {
		if n := atoi(p); n < 1 || n > 65535 {
			return nil, fmt.Errorf("the port must be between 1 and 65535")
		}
	}
	return &url.URL{Scheme: "https", Host: u.Host}, nil
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return -1
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// Validate reports the first thing wrong with the answers.
func (a Answers) Validate() error {
	if a.Dir == "" || !filepath.IsAbs(a.Dir) {
		return fmt.Errorf("the install folder must be an absolute path")
	}
	switch a.Mode {
	case BundledCaddy, OwnProxy, Tailscale:
		if _, err := ParsePublicURL(a.PublicURL); err != nil {
			return err
		}
	case LAN:
	default:
		return fmt.Errorf("choose how people will reach the server")
	}
	if a.Mode != BundledCaddy && (a.Port < 1 || a.Port > 65535) {
		return fmt.Errorf("the port must be between 1 and 65535")
	}
	if a.Mode == BundledCaddy && a.Port != 0 && a.Port != 7340 {
		return fmt.Errorf("the bundled setup does not publish Atelier's port")
	}
	if a.BindAddr != "" && net.ParseIP(a.BindAddr) == nil {
		return fmt.Errorf("%q is not an IP address", a.BindAddr)
	}
	if !a.Images.Local && a.Images.Prefix == "" {
		return fmt.Errorf("no image registry set")
	}
	for _, p := range strings.Split(a.ProxyAddrs, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, _, err := net.ParseCIDR(p); err != nil && net.ParseIP(p) == nil {
			return fmt.Errorf("%q is not an IP address or CIDR range", p)
		}
	}
	return nil
}

// Build makes the plan for the answers.
func Build(a Answers) (Plan, error) {
	if err := a.Validate(); err != nil {
		return Plan{}, err
	}
	p := Plan{}
	host := ""
	if a.Mode == BundledCaddy {
		u, _ := ParsePublicURL(a.PublicURL)
		host = u.Hostname()
		p.URL = "https://" + u.Host
	}
	if a.Mode == OwnProxy || a.Mode == Tailscale {
		u, _ := ParsePublicURL(a.PublicURL)
		p.URL = "https://" + u.Host
		bind := a.BindAddr
		if bind == "" || bind == "0.0.0.0" {
			bind = "<this machine's address>"
		}
		p.Upstream = fmt.Sprintf("%s:%d", bind, a.Port)
	}
	if a.Mode == LAN {
		p.URL = a.PublicURL
		if p.URL == "" {
			p.URL = fmt.Sprintf("http://<this machine's address>:%d", a.Port)
		}
	}

	data := struct {
		A         Answers
		Host      string
		Atelier   string
		Sandbox   string
		Updater   string
		BaseURL   string
		Trusted   string
		Ports     string
		HasCaddy  bool
		Published bool
	}{
		A:         a,
		Host:      host,
		Atelier:   a.Images.name("atelier"),
		Sandbox:   a.Images.name("atelier-sandbox"),
		Updater:   a.Images.name("atelier-updater"),
		HasCaddy:  a.Mode == BundledCaddy,
		Published: a.Mode != BundledCaddy,
	}
	switch a.Mode {
	case BundledCaddy:
		data.BaseURL = p.URL
		data.Trusted = "172.16.0.0/12"
	case OwnProxy:
		data.BaseURL = p.URL
		data.Trusted = strings.ReplaceAll(strings.TrimSpace(a.ProxyAddrs), " ", "")
	case Tailscale:
		data.BaseURL = p.URL
	}
	bind := a.BindAddr
	if bind == "" {
		bind = "127.0.0.1"
	}
	if a.Mode == LAN {
		bind = "0.0.0.0"
	}
	data.Ports = fmt.Sprintf("%s:%d:7340", bind, a.Port)

	var compose bytes.Buffer
	if err := composeTemplate.Execute(&compose, data); err != nil {
		return Plan{}, err
	}
	p.Files = append(p.Files, File{Path: filepath.Join(a.Dir, "compose.yaml"), Mode: 0o644, Body: compose.String()})
	if a.Mode == BundledCaddy {
		p.Files = append(p.Files, File{Path: filepath.Join(a.Dir, "Caddyfile"), Mode: 0o644, Body: fmt.Sprintf("%s {\n\treverse_proxy atelier:7340\n}\n", host)})
	}
	env := fmt.Sprintf("# Written by atelier-setup. The updater service recreates the containers from this folder.\nCOMPOSE_PROJECT_NAME=atelier\nATELIER_SETUP_TOKEN=%s\n", a.SetupToken)
	p.Files = append(p.Files, File{Path: filepath.Join(a.Dir, ".env"), Mode: 0o600, Body: env, Secret: true})

	p.Steps = append(p.Steps,
		Step{ID: "files", Title: "Write the configuration", Command: "write " + strings.Join(names(p.Files), ", ") + " in " + a.Dir},
	)
	if !a.Images.Local {
		p.Steps = append(p.Steps, Step{ID: "pull", Title: "Download the images", Command: "docker compose pull"})
	}
	p.Steps = append(p.Steps,
		Step{ID: "up", Title: "Start Atelier", Command: "docker compose up -d"},
		Step{ID: "healthy", Title: "Wait until it is healthy", Command: "docker compose ps"},
		Step{ID: "verify", Title: "Test the address like a browser would", Command: "GET " + p.URL + "/api/health, then a WebSocket handshake"},
		Step{ID: "admin", Title: "Create the first account", Command: "POST " + p.URL + "/api/auth/setup"},
	)
	return p, nil
}

func names(files []File) []string {
	out := make([]string, len(files))
	for i, f := range files {
		out[i] = filepath.Base(f.Path)
	}
	return out
}

var composeTemplate = template.Must(template.New("compose").Parse(`# Written by atelier-setup. Change it by hand if you like; "atelier-setup update" keeps your edits.
services:
  atelier:
    image: {{.Atelier}}
    restart: unless-stopped
    environment:
{{- if .BaseURL}}
      ATELIER_BASE_URL: {{.BaseURL}}
{{- end}}
{{- if .Trusted}}
      ATELIER_TRUSTED_PROXIES: {{.Trusted}}
{{- end}}
      ATELIER_SETUP_TOKEN: ${ATELIER_SETUP_TOKEN:-}
{{- if .A.Sandbox}}
      ATELIER_SANDBOX_HOST: sandbox
      ATELIER_SANDBOX_KEYS: /sandbox-keys/authorized_keys
{{- end}}
{{- if .A.Updater}}
      ATELIER_UPDATER_URL: http://updater:7341
{{- end}}
    volumes:
      - atelier-data:/data
{{- if .A.Sandbox}}
      - sandbox-keys:/sandbox-keys
{{- end}}
{{- if .A.Updater}}
      - updater-secret:/updater
{{- end}}
{{- if .Published}}
    ports:
      - '{{.Ports}}'
{{- else}}
    expose:
      - '7340'
{{- end}}
{{- if .A.Sandbox}}

  # Where chats clone repositories and run commands: no secrets and no server data in it. Every account gets a Unix user of
  # its own in it, and folders only that user can enter.
  sandbox:
    image: {{.Sandbox}}
    restart: unless-stopped
    depends_on: [atelier]
    volumes:
      - sandbox-home:/home/sandbox
      - sandbox-keys:/keys:ro
    expose:
      - '2222'
    mem_limit: 2g
    cpus: 2
    pids_limit: 512
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, SYS_CHROOT]
{{- end}}
{{- if .A.Updater}}

  # Lets an admin press "Update server" in Settings. The Docker socket is root on this machine, so it only pulls and
  # recreates the services of this folder. Delete this service (and ATELIER_UPDATER_URL above) to update by hand.
  updater:
    image: {{.Updater}}
    restart: unless-stopped
    depends_on: [atelier]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - updater-secret:/updater:ro
      - .:/project:ro
    expose:
      - '7341'
    mem_limit: 256m
{{- end}}
{{- if .HasCaddy}}

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
{{- end}}

volumes:
  atelier-data:
{{- if .A.Sandbox}}
  sandbox-keys:
  sandbox-home:
{{- end}}
{{- if .A.Updater}}
  updater-secret:
{{- end}}
{{- if .HasCaddy}}
  caddy-data:
{{- end}}
`))
