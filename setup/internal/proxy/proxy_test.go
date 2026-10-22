package proxy

import (
	"errors"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// ------------------------------------------------------------------ helpers

const (
	site    = "https://atelier.example.com"
	tsSite  = "https://atelier.tail1234.ts.net"
	typical = "127.0.0.1:7340"
)

// inputsFor is a typical input for a proxy: Tailscale needs a *.ts.net address.
func inputsFor(k Kind) Inputs {
	if k == Tailscale {
		return Inputs{PublicURL: tsSite, Upstream: typical}
	}
	return Inputs{PublicURL: site, Upstream: typical}
}

func generate(t *testing.T, k Kind, in Inputs) Snippet {
	t.Helper()
	s, err := Generate(k, in)
	if err != nil {
		t.Fatalf("Generate(%s, %+v): %v", k, in, err)
	}
	return s
}

// norm collapses runs of white space so that aligned directives compare equal.
func norm(line string) string { return strings.Join(strings.Fields(line), " ") }

func bodyLines(body string) []string { return strings.Split(strings.TrimRight(body, "\n"), "\n") }

func hasLine(body, want string) bool {
	for _, l := range bodyLines(body) {
		if norm(l) == want {
			return true
		}
	}
	return false
}

func requireLines(t *testing.T, body string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !hasLine(body, want) {
			t.Errorf("missing line %q in:\n%s", want, body)
		}
	}
}

func forbidLines(t *testing.T, body string, nots ...string) {
	t.Helper()
	for _, not := range nots {
		if hasLine(body, not) {
			t.Errorf("unexpected line %q in:\n%s", not, body)
		}
	}
}

func contains(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func requireContains(t *testing.T, what string, list []string, subs ...string) {
	t.Helper()
	for _, sub := range subs {
		if !contains(list, sub) {
			t.Errorf("%s has no entry containing %q:\n%s", what, sub, strings.Join(list, "\n"))
		}
	}
}

// requireInOrder checks that each phrase appears in text, each after the one before it.
func requireInOrder(t *testing.T, text string, phrases ...string) {
	t.Helper()
	at := 0
	for _, p := range phrases {
		i := strings.Index(text[at:], p)
		if i < 0 {
			t.Errorf("%q is missing, or comes before the phrase listed before it, in:\n%s", p, text)
			return
		}
		at += i + len(p)
	}
}

var yamlEntry = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]*:( .+)?$`)

// checkYAMLShape catches what makes a hand-written YAML snippet fail to load: tabs, odd indentation, a child indented by
// more than a level, an unquoted value holding ": " or " #", and unbalanced quotes. It is not a YAML parser.
func checkYAMLShape(t *testing.T, name, text string) {
	t.Helper()
	prevIndent, prev := -1, ""
	for n, raw := range bodyLines(text) {
		body := strings.TrimSpace(raw)
		if body == "" || strings.HasPrefix(body, "#") {
			continue
		}
		fail := func(msg string) { t.Errorf("%s, line %d %q: %s", name, n+1, raw, msg) }
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		switch {
		case strings.Contains(raw, "\t"):
			fail("contains a tab")
		case raw != strings.TrimRight(raw, " "):
			fail("trailing space")
		case indent%2 != 0:
			fail("odd indentation")
		case strings.Count(body, `"`)%2 != 0:
			fail("unbalanced quotes")
		case prevIndent >= 0 && indent > prevIndent+2:
			fail("indented by more than one level")
		case prevIndent >= 0 && strings.HasSuffix(prev, ":") && indent != prevIndent+2:
			fail("the children of a key are indented by two spaces")
		case prevIndent >= 0 && !strings.HasSuffix(prev, ":") && indent > prevIndent && !(strings.HasPrefix(prev, "- ") && indent == prevIndent+2):
			fail("indented under a line that opens nothing")
		}
		content := strings.TrimPrefix(body, "- ")
		isItem := content != body
		switch {
		case isItem && strings.HasPrefix(content, `"`):
			// a quoted scalar
		case isItem && !strings.Contains(content, ":"):
			// a plain scalar
		case !yamlEntry.MatchString(content):
			fail("not a `key: value` entry or a list item")
		default:
			_, value, _ := strings.Cut(content, ":")
			value = strings.TrimSpace(value)
			if !strings.HasPrefix(value, `"`) && (strings.Contains(value, ": ") || strings.Contains(value, " #")) {
				fail("an unquoted value that YAML reads as something else")
			}
		}
		prevIndent, prev = indent, body
	}
}

// checkNginxShape checks that every line is a comment, a block opener or closer, or a directive ending in a semicolon,
// and that the braces balance.
func checkNginxShape(t *testing.T, name, text string) {
	t.Helper()
	depth := 0
	for n, raw := range bodyLines(text) {
		body := strings.TrimSpace(raw)
		fail := func(msg string) { t.Errorf("%s, line %d %q: %s", name, n+1, raw, msg) }
		switch {
		case body == "" || strings.HasPrefix(body, "#"):
		case strings.Contains(raw, "\t"):
			fail("contains a tab")
		case strings.HasSuffix(body, "{"):
			depth++
		case body == "}":
			depth--
			if depth < 0 {
				fail("closes a block that was never opened")
			}
		case !strings.HasSuffix(body, ";"):
			fail("a directive must end with a semicolon")
		}
	}
	if depth != 0 {
		t.Errorf("%s: braces do not balance (%d still open)", name, depth)
	}
}

// ------------------------------------------------------------------ Kinds and Label

func TestKindsAndLabels(t *testing.T) {
	want := []Kind{Caddy, Nginx, Traefik, NginxProxyManager, CloudflareTunnel, Tailscale}
	if got := Kinds(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Kinds() = %v, want %v", got, want)
	}
	wantLabels := []string{"Caddy", "nginx", "Traefik", "Nginx Proxy Manager", "Cloudflare Tunnel", "Tailscale"}
	seenKind, seenLabel := map[Kind]bool{}, map[string]bool{}
	for i, k := range Kinds() {
		label := Label(k)
		if label != wantLabels[i] {
			t.Errorf("Label(%q) = %q, want %q", k, label, wantLabels[i])
		}
		if seenKind[k] || seenLabel[label] {
			t.Errorf("%q / %q appears twice", k, label)
		}
		seenKind[k], seenLabel[label] = true, true
		if _, ok := generators[k]; !ok {
			t.Errorf("no generator for %q", k)
		}
	}
	if len(generators) != len(want) {
		t.Errorf("%d generators for %d kinds", len(generators), len(want))
	}
	if got := Label("bogus"); got != "bogus" {
		t.Errorf("Label of an unknown kind = %q, want it unchanged", got)
	}
}

func TestKindsReturnsACopy(t *testing.T) {
	k := Kinds()
	k[0] = "changed"
	if Kinds()[0] != Caddy {
		t.Fatal("changing the result of Kinds() changed the list")
	}
}

func TestUnknownKind(t *testing.T) {
	if _, err := Generate("apache", inputsFor(Caddy)); err == nil {
		t.Fatal("an unknown kind was accepted")
	}
}

// ------------------------------------------------------------------ every kind, several inputs

// adapt gives Tailscale the *.ts.net address it needs, keeping the port of the input.
func adapt(k Kind, in Inputs) Inputs {
	if k == Tailscale {
		port := ""
		if i := strings.LastIndex(in.PublicURL, ":"); i > len("https:") {
			port = in.PublicURL[i:]
		}
		in.PublicURL = tsSite + port
	}
	return in
}

var variants = []Inputs{
	{PublicURL: site, Upstream: typical},
	{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true},
	{PublicURL: site, Upstream: "atelier:7340"},
	{PublicURL: site + ":8443", Upstream: "192.168.1.20:7340"},
	{PublicURL: "https://Atelier.Example.COM", Upstream: "[::1]:7340", ProxyInDocker: true},
	{PublicURL: site, Upstream: "localhost:7340", ProxyInDocker: true},
	{PublicURL: site + ":443", Upstream: "nas.local:8080"},
}

func TestEveryKindGenerates(t *testing.T) {
	for _, k := range Kinds() {
		for _, v := range variants {
			in := adapt(k, v)
			t.Run(string(k)+"/"+in.PublicURL+"/"+in.Upstream+"/"+strconv.FormatBool(in.ProxyInDocker), func(t *testing.T) {
				s := generate(t, k, in)
				if s.Kind != k {
					t.Errorf("Kind = %q, want %q", s.Kind, k)
				}
				if s.Title == "" || s.Body == "" || len(s.Steps) == 0 || len(s.Notes) == 0 {
					t.Fatalf("incomplete snippet: %+v", s)
				}
				if (k == NginxProxyManager || k == Tailscale) != (s.File == "") {
					t.Errorf("File = %q: only the proxies set up in a UI or a single command have none", s.File)
				}
				all := s.Body + "\n" + strings.Join(s.Steps, "\n")
				for _, want := range []string{in.Host(), upstreamHost(in), upstreamPort(in)} {
					if !strings.Contains(all, want) {
						t.Errorf("neither the body nor the steps mention %q", want)
					}
				}
				if !strings.HasSuffix(s.Body, "\n") || strings.Contains(s.Body, "\r") {
					t.Error("the body must end with one newline and use \\n line ends")
				}
				for n, l := range bodyLines(s.Body) {
					if l != strings.TrimRight(l, " \t") {
						t.Errorf("body line %d has trailing white space: %q", n+1, l)
					}
				}
				for _, text := range append(append([]string{s.Title, s.Body, s.File}, s.Steps...), s.Notes...) {
					checkText(t, text)
				}
				for what, list := range map[string][]string{"Steps": s.Steps, "Notes": s.Notes} {
					seen := map[string]bool{}
					for _, line := range list {
						if line != strings.TrimSpace(line) || !strings.HasSuffix(line, ".") {
							t.Errorf("%s entry should be a trimmed sentence ending in a full stop: %q", what, line)
						}
						if seen[line] {
							t.Errorf("%s entry appears twice: %q", what, line)
						}
						seen[line] = true
					}
				}
				again := generate(t, k, in)
				if !reflect.DeepEqual(s, again) {
					t.Error("two calls with the same inputs gave different snippets")
				}
			})
		}
	}
}

// upstreamHost and upstreamPort read the pieces of Upstream the way a person would write them.
func upstreamHost(in Inputs) string {
	h, _, _ := parseUpstream(in.Upstream)
	return h
}

func upstreamPort(in Inputs) string {
	_, p, _ := parseUpstream(in.Upstream)
	return strconv.Itoa(p)
}

// checkText fails on what must not reach a pasted configuration or a screen: leftover markers, formatting errors, and
// anything that is not plain ASCII.
func checkText(t *testing.T, text string) {
	t.Helper()
	for _, bad := range []string{"@@", "%!", "<nil>", "{{", "}}"} {
		if strings.Contains(text, bad) {
			t.Errorf("%q appears in %q", bad, text)
		}
	}
	for _, r := range text {
		if r > unicode.MaxASCII || (r < ' ' && r != '\n' && r != '\t') {
			t.Errorf("%q in %q is not plain ASCII", r, text)
			return
		}
	}
}

// ------------------------------------------------------------------ validation

func TestValidateInputs(t *testing.T) {
	valid := []Inputs{
		{PublicURL: site, Upstream: "127.0.0.1:7340"},
		{PublicURL: site + ":8443", Upstream: "atelier:7340"},
		{PublicURL: site + ":443", Upstream: "atelier_server:7340"},
		{PublicURL: "https://ATELIER.example.com", Upstream: "[::1]:7340"},
		{PublicURL: "HTTPS://a-b.example.co.uk", Upstream: "nas.local:7340"},
		{PublicURL: tsSite, Upstream: "192.168.1.20:7340"},
		{PublicURL: site, Upstream: "localhost:7340"},
		{PublicURL: site, Upstream: "host.docker.internal:65535"},
		{PublicURL: site, Upstream: "127.0.0.1:1"},
		{PublicURL: "https://" + strings.Repeat("a", 63) + ".example.com", Upstream: typical},
	}
	for _, in := range valid {
		if err := ValidateInputs(in); err != nil {
			t.Errorf("ValidateInputs(%+v) = %v, want nil", in, err)
		}
	}

	badPublic := []string{
		"", "   ", "atelier.example.com", "ftp://atelier.example.com",
		"http://atelier.example.com",
		"https://atelier.example.com/", "https://atelier.example.com/app", "https://atelier.example.com/?x=1",
		"https://atelier.example.com?x=1", "https://atelier.example.com#top",
		"https://user@atelier.example.com", "https://user:pw@atelier.example.com",
		"https://atelier.example.com:", "https://atelier.example.com:0", "https://atelier.example.com:65536",
		"https://atelier.example.com:99999", "https://atelier.example.com:abc", "https://atelier.example.com:-1",
		"https://atelier.example.com:80:90",
		"https://", "https://localhost", "https://atelier", "https://localhost:8443",
		"https://192.0.2.20", "https://192.0.2.20:8443", "https://[::1]", "https://[2001:db8::1]:8443", "https://1.2.3",
		"https://-bad.example.com", "https://bad-.example.com", "https://bad_name.example.com",
		"https://ex ample.com", " https://atelier.example.com", "https://atelier.example.com ",
		"https://atelier..example.com", "https://.example.com", "https://atelier.example.com.",
		"https://\u00e4telier.example.com", "https://atelier.example.123",
		"https://" + strings.Repeat("a", 64) + ".example.com",
		"https://" + strings.Repeat("a.", 130) + "com",
	}
	for _, raw := range badPublic {
		err := ValidateInputs(Inputs{PublicURL: raw, Upstream: typical})
		var ie *InputError
		if !errors.As(err, &ie) || ie.Field != "PublicURL" || ie.Message == "" {
			t.Errorf("PublicURL %q: got %v, want an InputError for PublicURL", raw, err)
		}
	}

	badUpstream := []string{
		"", "   ", "127.0.0.1", "atelier", "127.0.0.1:", ":7340", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:70000",
		"127.0.0.1:abc", "127.0.0.1:-1", "127.0.0.1:+80", "http://127.0.0.1:7340", "127.0.0.1:7340/", "127.0.0.1:7340/api",
		"127.0.0.1 :7340", "127.0.0.1: 7340", "::1:7340", "[::1]7340", "999.1.1.1:7340", "1.2.3:7340",
		"bad host:7340", "-x:7340", "a..b:7340", "atelier.:7340", "caf\u00e9:7340", "127.0.0.1:7340:1",
	}
	for _, raw := range badUpstream {
		err := ValidateInputs(Inputs{PublicURL: site, Upstream: raw})
		var ie *InputError
		if !errors.As(err, &ie) || ie.Field != "Upstream" || ie.Message == "" {
			t.Errorf("Upstream %q: got %v, want an InputError for Upstream", raw, err)
		}
	}
}

func TestSpecificValidationMessages(t *testing.T) {
	cases := []struct {
		in   Inputs
		want string
	}{
		{Inputs{PublicURL: "http://atelier.example.com", Upstream: typical}, "https://"},
		{Inputs{PublicURL: site + "/", Upstream: typical}, "slash"},
		{Inputs{PublicURL: site + "/app", Upstream: typical}, "path"},
		{Inputs{PublicURL: site + ":99999", Upstream: typical}, "1 to 65535"},
		{Inputs{PublicURL: "https://localhost", Upstream: typical}, "single word"},
		{Inputs{PublicURL: "https://192.0.2.20", Upstream: typical}, "IP address"},
		{Inputs{PublicURL: site, Upstream: ""}, "host:port"},
		{Inputs{PublicURL: site, Upstream: "127.0.0.1:0"}, "1 to 65535"},
		{Inputs{PublicURL: site, Upstream: "http://127.0.0.1:7340"}, "without http://"},
	}
	for _, c := range cases {
		err := ValidateInputs(c.in)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: got %v, want a message containing %q", c.in, err, c.want)
		}
	}
}

func TestGenerateRefusesBadInputsForEveryKind(t *testing.T) {
	for _, k := range Kinds() {
		for _, in := range []Inputs{
			{PublicURL: "http://atelier.example.com", Upstream: typical},
			{PublicURL: site + "/path", Upstream: typical},
			{PublicURL: site + ":99999", Upstream: typical},
			{PublicURL: site, Upstream: ""},
			{PublicURL: "https://localhost", Upstream: typical},
		} {
			if s, err := Generate(k, adaptBad(k, in)); err == nil || s.Body != "" {
				t.Errorf("Generate(%s, %+v) = %+v, %v; want an error and no snippet", k, in, s, err)
			}
		}
	}
}

// adaptBad leaves a bad address bad: it only gives Tailscale a ts.net host where the address is the thing that is fine.
func adaptBad(k Kind, in Inputs) Inputs {
	if k == Tailscale && in.PublicURL == site {
		in.PublicURL = tsSite
	}
	return in
}

func TestTailscaleNeedsATsNetAddress(t *testing.T) {
	_, err := Generate(Tailscale, Inputs{PublicURL: site, Upstream: typical})
	var ie *InputError
	if !errors.As(err, &ie) || ie.Field != "PublicURL" || !strings.Contains(ie.Message, ".ts.net") {
		t.Fatalf("got %v, want an InputError for PublicURL that names .ts.net", err)
	}
	for _, bad := range []string{"https://ts.net", "https://atelier.ts.net.example.com", "https://atelier.tsxnet"} {
		if _, err := Generate(Tailscale, Inputs{PublicURL: bad, Upstream: typical}); err == nil {
			t.Errorf("Tailscale accepted %q", bad)
		}
	}
	// The other proxies can use a ts.net name (Caddy and nginx get certificates for it with `tailscale cert`).
	if _, err := Generate(Caddy, Inputs{PublicURL: tsSite, Upstream: typical}); err != nil {
		t.Errorf("Caddy refused a ts.net address: %v", err)
	}
}

func TestHostAndHostPort(t *testing.T) {
	cases := []struct{ url, host, hostPort string }{
		{site, "atelier.example.com", "atelier.example.com"},
		{"https://Atelier.EXAMPLE.com", "atelier.example.com", "atelier.example.com"},
		{site + ":443", "atelier.example.com", "atelier.example.com"},
		{site + ":0443", "atelier.example.com", "atelier.example.com"},
		{site + ":8443", "atelier.example.com", "atelier.example.com:8443"},
		{tsSite, "atelier.tail1234.ts.net", "atelier.tail1234.ts.net"},
		{"http://atelier.example.com", "", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		in := Inputs{PublicURL: c.url, Upstream: typical}
		if got := in.Host(); got != c.host {
			t.Errorf("Host(%q) = %q, want %q", c.url, got, c.host)
		}
		if got := in.HostPort(); got != c.hostPort {
			t.Errorf("HostPort(%q) = %q, want %q", c.url, got, c.hostPort)
		}
	}
}

// ------------------------------------------------------------------ Caddy

func TestCaddy(t *testing.T) {
	s := generate(t, Caddy, inputsFor(Caddy))
	if want := "atelier.example.com {\n\treverse_proxy 127.0.0.1:7340\n}\n"; s.Body != want {
		t.Errorf("Body = %q, want %q", s.Body, want)
	}
	if !strings.Contains(s.Body, "atelier.example.com {") || !strings.Contains(s.Body, "reverse_proxy 127.0.0.1:7340") {
		t.Error("the site block or the reverse_proxy line is missing")
	}
	if s.File != "/etc/caddy/Caddyfile" {
		t.Errorf("File = %q", s.File)
	}
	requireContains(t, "Steps", s.Steps, "80 and 443", "DNS", "caddy reload --config /etc/caddy/Caddyfile", "caddy validate")
	requireContains(t, "Notes", s.Notes[:1], "certificate", "80 and 443")
	requireContains(t, "Notes", s.Notes, "WebSockets", "ATELIER_BASE_URL to https://atelier.example.com", "ATELIER_TRUSTED_PROXIES")

	docker := generate(t, Caddy, Inputs{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true})
	if docker.File != "Caddyfile" {
		t.Errorf("File in Docker = %q", docker.File)
	}
	if !strings.Contains(docker.Body, "reverse_proxy atelier:7340") {
		t.Errorf("Body = %q", docker.Body)
	}
	requireContains(t, "Steps", docker.Steps, "docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile", "/etc/caddy/Caddyfile", "443/udp")

	port := generate(t, Caddy, Inputs{PublicURL: site + ":8443", Upstream: "[::1]:7340"})
	if want := "atelier.example.com:8443 {\n\treverse_proxy [::1]:7340\n}\n"; port.Body != want {
		t.Errorf("Body with a port = %q, want %q", port.Body, want)
	}
	requireContains(t, "Notes", port.Notes, "port 8443")
}

// ------------------------------------------------------------------ nginx

func TestNginx(t *testing.T) {
	s := generate(t, Nginx, inputsFor(Nginx))
	if s.File != "/etc/nginx/conf.d/atelier.conf" || s.Title != "nginx server block" {
		t.Errorf("File = %q, Title = %q", s.File, s.Title)
	}
	checkNginxShape(t, "nginx", s.Body)
	requireLines(t, s.Body,
		// the map, for the Upgrade/Connection pair
		"map $http_upgrade $connection_upgrade {",
		"default upgrade;",
		"'' close;",
		// the redirect server
		"listen 80;",
		"listen [::]:80;",
		"server_name atelier.example.com;",
		"return 301 https://atelier.example.com$request_uri;",
		// the HTTPS server
		"listen 443 ssl;",
		"listen [::]:443 ssl;",
		"http2 on;",
		"ssl_certificate /etc/letsencrypt/live/atelier.example.com/fullchain.pem;",
		"ssl_certificate_key /etc/letsencrypt/live/atelier.example.com/privkey.pem;",
		"client_max_body_size 64m;",
		// the proxying
		"location / {",
		"proxy_pass http://127.0.0.1:7340;",
		"proxy_http_version 1.1;",
		"proxy_set_header Host $host;",
		"proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
		"proxy_set_header X-Forwarded-Proto $scheme;",
		"proxy_set_header X-Forwarded-Host $host;",
		"proxy_set_header Upgrade $http_upgrade;",
		"proxy_set_header Connection $connection_upgrade;",
		"proxy_read_timeout 3600s;",
		"proxy_send_timeout 3600s;",
		"proxy_buffering off;",
	)
	if n := strings.Count(s.Body, "\nserver {"); n != 2 {
		t.Errorf("%d server blocks, want 2 (the redirect and HTTPS)", n)
	}
	requireInOrder(t, s.Body, "http context", "map $http_upgrade $connection_upgrade {", "server {", "listen 80;", "server {", "listen 443 ssl;", "location / {")
	if !strings.Contains(s.Body, "duplicate \"connection_upgrade\" variable") {
		t.Error("the body must say what to do when the map is defined twice")
	}
	if !strings.Contains(s.Body, "do not exist until") {
		t.Error("the body must say the certificate files do not exist until they are obtained")
	}
	if !strings.Contains(s.Body, "Strict-Transport-Security") || hasLine(s.Body, `add_header Strict-Transport-Security "max-age=31536000" always;`) {
		t.Error("HSTS should be present as a comment only")
	}

	requireContains(t, "Steps", s.Steps, "certbot", "sudo nginx -t", "sudo systemctl reload nginx", "/etc/nginx/conf.d/atelier.conf", "DNS")
	requireInOrder(t, strings.Join(s.Steps, "\n"), "certbot", "conf.d/atelier.conf", "nginx -t", "reload nginx")
	requireContains(t, "Notes", s.Notes[:1], "map", "http", "Upgrade")
	requireContains(t, "Notes", s.Notes, "60 seconds", "32 MB", "certbot", "1.25.1", "Address family not supported")
}

func TestNginxInDocker(t *testing.T) {
	s := generate(t, Nginx, Inputs{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true})
	requireLines(t, s.Body, "proxy_pass http://atelier:7340;")
	requireContains(t, "Steps", s.Steps, "docker compose exec nginx nginx -t", "docker compose exec nginx nginx -s reload", "/etc/nginx/conf.d/atelier.conf", "/etc/letsencrypt")
	if contains(s.Steps, "systemctl") {
		t.Error("Docker steps mention systemctl")
	}
	requireContains(t, "Notes", s.Notes, "starts and refuses to start", "share a Docker network")
	checkNginxShape(t, "nginx", s.Body)
}

func TestNginxWithAPort(t *testing.T) {
	s := generate(t, Nginx, Inputs{PublicURL: site + ":8443", Upstream: "192.168.1.20:7340"})
	checkNginxShape(t, "nginx", s.Body)
	requireLines(t, s.Body,
		"listen 8443 ssl;",
		"listen [::]:8443 ssl;",
		"server_name atelier.example.com;",
		"return 301 https://atelier.example.com:8443$request_uri;",
		"proxy_pass http://192.168.1.20:7340;",
		"proxy_set_header Host $http_host;",
		"proxy_set_header X-Forwarded-Host $http_host;",
	)
	forbidLines(t, s.Body, "proxy_set_header Host $host;", "listen 443 ssl;")
	requireContains(t, "Notes", s.Notes, "listen 8443 ssl http2;")
}

// ------------------------------------------------------------------ Traefik

func between(t *testing.T, text, start, end string) string {
	t.Helper()
	i, j := strings.Index(text, start), strings.Index(text, end)
	if i < 0 || j < 0 || j < i {
		t.Fatalf("markers %q / %q not found in order in:\n%s", start, end, text)
	}
	return text[i+len(start) : j]
}

// traefikParts splits the body into the labels (option A) and the file provider's YAML (option B).
func traefikParts(t *testing.T, body string) (labels, file string) {
	t.Helper()
	labels = between(t, body, traefikLabelsMarker, traefikFileMarker)
	file = body[strings.Index(body, traefikFileMarker)+len(traefikFileMarker):]
	return strings.TrimLeft(labels, "\n"), strings.TrimLeft(file, "\n")
}

func parseLabels(t *testing.T, text string) map[string]string {
	t.Helper()
	labels := map[string]string{}
	for _, l := range bodyLines(text) {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, `- "`) {
			continue
		}
		l = strings.TrimSuffix(strings.TrimPrefix(l, `- "`), `"`)
		key, value, ok := strings.Cut(l, "=")
		if !ok || key == "" || value == "" {
			t.Errorf("label %q is not key=value", l)
			continue
		}
		if !strings.HasPrefix(key, "traefik.") {
			t.Errorf("label key %q does not start with traefik.", key)
		}
		if _, dup := labels[key]; dup {
			t.Errorf("label %q appears twice", key)
		}
		labels[key] = value
	}
	return labels
}

func TestTraefik(t *testing.T) {
	s := generate(t, Traefik, inputsFor(Traefik))
	labelsText, fileText := traefikParts(t, s.Body)

	// (a) Docker labels
	checkYAMLShape(t, "labels", labelsText)
	wantStart := "services:\n  atelier:\n    labels:\n"
	if !strings.HasPrefix(labelsText, wantStart) {
		t.Errorf("labels block starts with %q, want %q", labelsText[:min(len(labelsText), len(wantStart))], wantStart)
	}
	wantLabels := map[string]string{
		"traefik.enable":                                         "true",
		"traefik.http.routers.atelier.rule":                      "Host(`atelier.example.com`)",
		"traefik.http.routers.atelier.entrypoints":               "websecure",
		"traefik.http.routers.atelier.tls":                       "true",
		"traefik.http.routers.atelier.tls.certresolver":          "letsencrypt",
		"traefik.http.services.atelier.loadbalancer.server.port": "7340",
	}
	if got := parseLabels(t, labelsText); !reflect.DeepEqual(got, wantLabels) {
		t.Errorf("labels = %v\nwant     %v", got, wantLabels)
	}

	// (b) file provider
	checkYAMLShape(t, "file provider", fileText)
	wantFile := strings.Join([]string{
		"http:",
		"  routers:",
		"    atelier:",
		"      rule: \"Host(`atelier.example.com`)\"",
		"      entryPoints:",
		"        - websecure",
		"      service: atelier",
		"      tls:",
		"        certResolver: letsencrypt",
		"  services:",
		"    atelier:",
		"      loadBalancer:",
		"        servers:",
		"          - url: \"http://127.0.0.1:7340\"",
		"",
	}, "\n")
	if fileText != wantFile {
		t.Errorf("file provider block:\n%s\nwant:\n%s", fileText, wantFile)
	}

	// the router in the file names the service defined beside it
	if !strings.Contains(fileText, "service: atelier") || !strings.Contains(fileText, "    atelier:\n      loadBalancer:") {
		t.Error("the router's service is not defined in the file")
	}
	if s.File != "compose.yaml" {
		t.Errorf("File = %q", s.File)
	}
	requireContains(t, "Steps", s.Steps, "websecure", "letsencrypt", "docker compose up -d", "/etc/traefik/dynamic/atelier.yml", "traefik.docker.network")
	requireContains(t, "Notes", s.Notes[:1], "websecure", "letsencrypt", "404")
	requireContains(t, "Notes", s.Notes, "WebSockets", "`web` entrypoint")
}

func TestTraefikUpstream(t *testing.T) {
	s := generate(t, Traefik, Inputs{PublicURL: site, Upstream: "atelier:8080", ProxyInDocker: true})
	labelsText, fileText := traefikParts(t, s.Body)
	if got := parseLabels(t, labelsText)["traefik.http.services.atelier.loadbalancer.server.port"]; got != "8080" {
		t.Errorf("service port label = %q, want 8080", got)
	}
	if !strings.Contains(fileText, `- url: "http://atelier:8080"`) {
		t.Errorf("file provider url wrong:\n%s", fileText)
	}
	port := generate(t, Traefik, Inputs{PublicURL: site + ":8443", Upstream: typical})
	requireContains(t, "Notes", port.Notes, "entrypoint named `websecure` has to listen on 8443")
	_, file := traefikParts(t, port.Body)
	if !strings.Contains(file, "Host(`atelier.example.com`)") {
		t.Error("the Host rule must not carry the port")
	}
}

// ------------------------------------------------------------------ Nginx Proxy Manager

func TestNginxProxyManager(t *testing.T) {
	s := generate(t, NginxProxyManager, inputsFor(NginxProxyManager))
	if s.File != "" {
		t.Errorf("File = %q, want none (entered in a UI)", s.File)
	}
	checkNginxShape(t, "npm advanced", s.Body)
	requireLines(t, s.Body, "proxy_read_timeout 3600s;", "proxy_send_timeout 3600s;", "proxy_buffering off;", "client_max_body_size 64m;")
	// NPM sets these itself (and a server-level proxy_set_header would be ignored by its location), so they are not repeated.
	if strings.Contains(s.Body, "proxy_set_header") || strings.Contains(s.Body, "proxy_pass") {
		t.Errorf("the Advanced tab text must not repeat what Nginx Proxy Manager sets:\n%s", s.Body)
	}

	steps := strings.Join(s.Steps, "\n")
	requireInOrder(t, steps,
		"Hosts, then Proxy Hosts", "Add Proxy Host",
		"Domain Names", "`atelier.example.com`",
		"Scheme", "`http`",
		"Forward Hostname / IP", "`127.0.0.1`", "Forward Port", "`7340`",
		`"Websockets Support"`,
		"SSL tab", `"Request a new SSL Certificate"`, `"Force SSL"`, `"HTTP/2 Support"`,
		"Advanced tab", `"Custom Nginx Configuration"`,
		"Save",
	)
	if !strings.Contains(s.Notes[0], `"Websockets Support"`) {
		t.Errorf("the first note should be about Websockets Support: %q", s.Notes[0])
	}

	docker := generate(t, NginxProxyManager, Inputs{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true})
	if !contains(docker.Steps, "Forward Hostname / IP to `atelier`") || !contains(docker.Steps, "Forward Port to `7340`") {
		t.Errorf("Steps = %v", docker.Steps)
	}
	requireContains(t, "Notes", docker.Notes, "share a Docker network")

	lan := generate(t, NginxProxyManager, Inputs{PublicURL: site + ":8443", Upstream: "192.168.1.20:7340", ProxyInDocker: true})
	requireContains(t, "Steps", lan.Steps, "Forward Hostname / IP to `192.168.1.20`")
	requireContains(t, "Notes", lan.Notes, "8443:443", "different machines")
}

// ------------------------------------------------------------------ Cloudflare Tunnel

func TestCloudflared(t *testing.T) {
	s := generate(t, CloudflareTunnel, inputsFor(CloudflareTunnel))
	checkYAMLShape(t, "cloudflared", s.Body)
	lines := bodyLines(s.Body)
	if last := lines[len(lines)-1]; last != "  - service: http_status:404" {
		t.Errorf("the last line is %q, want the catch-all 404 rule", last)
	}
	requireLines(t, s.Body, "tunnel: <TUNNEL_ID>", "credentials-file: /etc/cloudflared/<TUNNEL_ID>.json", "ingress:", "- hostname: atelier.example.com", "service: http://127.0.0.1:7340")
	rules, hostnames := 0, 0
	for _, l := range lines {
		if strings.HasPrefix(l, "  - ") {
			rules++
		}
		if strings.Contains(l, "hostname:") {
			hostnames++
		}
	}
	if rules != 2 || hostnames != 1 {
		t.Errorf("%d ingress rules and %d hostnames, want 2 and 1", rules, hostnames)
	}
	requireInOrder(t, s.Body, "ingress:", "hostname: atelier.example.com", "service: http://127.0.0.1:7340", "service: http_status:404")
	if s.File != "/etc/cloudflared/config.yml" {
		t.Errorf("File = %q", s.File)
	}

	steps := strings.Join(s.Steps, "\n")
	requireInOrder(t, steps, "Zero Trust", "Networks", "Tunnels", "Public Hostname", "`atelier.example.com`", "`HTTP`", "`127.0.0.1:7340`")
	requireContains(t, "Steps", s.Steps, "cloudflared tunnel create", "cloudflared tunnel route dns atelier atelier.example.com", "<TUNNEL_ID>")
	requireContains(t, "Notes", s.Notes, "WebSockets work", "ATELIER_BASE_URL stays the public address, https://atelier.example.com", "Cloudflare Access", "service token", "runs cloudflared")

	docker := generate(t, CloudflareTunnel, Inputs{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true})
	requireLines(t, docker.Body, "service: http://atelier:7340")
	checkYAMLShape(t, "cloudflared", docker.Body)
}

// ------------------------------------------------------------------ Tailscale

func TestTailscale(t *testing.T) {
	s := generate(t, Tailscale, inputsFor(Tailscale))
	if got, want := strings.TrimSpace(s.Body), "tailscale serve --bg --https=443 http://127.0.0.1:7340"; got != want {
		t.Errorf("Body = %q, want %q", got, want)
	}
	if s.File != "" {
		t.Errorf("File = %q", s.File)
	}
	requireContains(t, "Steps", s.Steps, "HTTPS Certificates", "MagicDNS", "tailscale serve status", "https://atelier.tail1234.ts.net", "tailscale status", "tailscale cert", "tailscale serve reset")
	requireContains(t, "Notes", s.Notes[:1], "HTTPS Certificates", "ATELIER_BASE_URL")
	requireContains(t, "Notes", s.Notes, "tailnet", "Funnel", "not recommended", "1.52")

	port := generate(t, Tailscale, Inputs{PublicURL: tsSite + ":8443", Upstream: "192.168.1.20:7340"})
	if got, want := strings.TrimSpace(port.Body), "tailscale serve --bg --https=8443 http://192.168.1.20:7340"; got != want {
		t.Errorf("Body = %q, want %q", got, want)
	}
	name := generate(t, Tailscale, Inputs{PublicURL: tsSite, Upstream: "atelier:7340"})
	requireContains(t, "Notes", name.Notes, "Docker service name")
}

// ------------------------------------------------------------------ upstream advice

func TestUpstreamAdvice(t *testing.T) {
	const (
		containerItself = "is the container itself"
		serviceName     = "is a Docker service name"
		shareNetwork    = "share a Docker network"
	)
	cases := []struct {
		in        Inputs
		want, not []string
	}{
		{Inputs{PublicURL: site, Upstream: "127.0.0.1:7340", ProxyInDocker: true}, []string{containerItself}, []string{serviceName, shareNetwork}},
		{Inputs{PublicURL: site, Upstream: "localhost:7340", ProxyInDocker: true}, []string{containerItself}, []string{serviceName, shareNetwork}},
		{Inputs{PublicURL: site, Upstream: "atelier:7340", ProxyInDocker: true}, []string{shareNetwork}, []string{containerItself, serviceName}},
		{Inputs{PublicURL: site, Upstream: "atelier:7340"}, []string{serviceName, "127.0.0.1:7340:7340"}, []string{containerItself, shareNetwork}},
		{Inputs{PublicURL: site, Upstream: "127.0.0.1:7340"}, nil, []string{containerItself, serviceName, shareNetwork}},
		{Inputs{PublicURL: site, Upstream: "192.168.1.20:7340", ProxyInDocker: true}, nil, []string{containerItself, serviceName, shareNetwork}},
		{Inputs{PublicURL: site, Upstream: "host.docker.internal:7340", ProxyInDocker: true}, nil, []string{containerItself, serviceName, shareNetwork}},
	}
	for _, c := range cases {
		for _, k := range Kinds() {
			s := generate(t, k, adapt(k, c.in))
			for _, w := range c.want {
				if !contains(s.Notes, w) {
					t.Errorf("%s %+v: no note containing %q", k, c.in, w)
				}
			}
			for _, n := range c.not {
				if contains(s.Notes, n) {
					t.Errorf("%s %+v: unexpected note containing %q", k, c.in, n)
				}
			}
			// Every proxy says what to do when it runs on another machine, and what Atelier's two settings must be.
			requireContains(t, string(k)+" Notes", s.Notes, "different machines", "ATELIER_TRUSTED_PROXIES", "ATELIER_BASE_URL")
		}
	}
}

func TestEveryKindMentionsTheOneThingPeopleTripOver(t *testing.T) {
	first := map[Kind][]string{
		Caddy:             {"certificate"},
		Nginx:             {"map", "Upgrade"},
		Traefik:           {"websecure", "letsencrypt"},
		NginxProxyManager: {"Websockets Support"},
		CloudflareTunnel:  {"127.0.0.1"},
		Tailscale:         {"HTTPS Certificates"},
	}
	for k, subs := range first {
		s := generate(t, k, inputsFor(k))
		for _, sub := range subs {
			if !strings.Contains(s.Notes[0], sub) {
				t.Errorf("%s: first note %q should mention %q", k, s.Notes[0], sub)
			}
		}
		if !strings.HasPrefix(s.Notes[0], "The usual mistake") {
			t.Errorf("%s: first note should start with \"The usual mistake\": %q", k, s.Notes[0])
		}
	}
}
