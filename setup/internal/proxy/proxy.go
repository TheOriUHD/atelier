// Package proxy writes the reverse-proxy configuration Atelier needs, for the proxies people actually run.
//
// Atelier's server listens on plain HTTP (port 7340). A proxy in front of it terminates HTTPS and must:
//   - pass WebSocket upgrades (the app's live connection is /api/ws, desktop devices use /api/devices/link),
//   - not time out or buffer the long-lived streams that carry replies, which run for minutes,
//   - keep the Host header the browser used and send X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host.
//
// Atelier believes the X-Forwarded-* headers only from addresses in ATELIER_TRUSTED_PROXIES, and with
// ATELIER_BASE_URL set to the public address its origin checks pass whatever the proxy sends.
//
// Everything here is plain text generation from validated inputs; nothing touches the machine.
package proxy

import (
	"fmt"
	"strings"
)

// Kind names a reverse proxy.
type Kind string

const (
	Caddy             Kind = "caddy"
	Nginx             Kind = "nginx"
	Traefik           Kind = "traefik"
	NginxProxyManager Kind = "npm"
	CloudflareTunnel  Kind = "cloudflared"
	Tailscale         Kind = "tailscale"
)

// Snippet is what to show the person for one proxy.
type Snippet struct {
	Kind  Kind
	Title string   // "nginx server block"
	File  string   // suggested file name or path; "" when the configuration is entered in a UI
	Body  string   // the configuration text to copy
	Steps []string // plain sentences, in order, for the person to follow; commands and paths are in `backticks`
	Notes []string // caveats; the first is the one thing people trip over most for this proxy
}

var kinds = []Kind{Caddy, Nginx, Traefik, NginxProxyManager, CloudflareTunnel, Tailscale}

var labels = map[Kind]string{
	Caddy:             "Caddy",
	Nginx:             "nginx",
	Traefik:           "Traefik",
	NginxProxyManager: "Nginx Proxy Manager",
	CloudflareTunnel:  "Cloudflare Tunnel",
	Tailscale:         "Tailscale",
}

// Kinds lists every proxy in display order.
func Kinds() []Kind { return append([]Kind(nil), kinds...) }

// Label is the name to show for a proxy. An unknown kind is returned as it is.
func Label(k Kind) string {
	if l, ok := labels[k]; ok {
		return l
	}
	return string(k)
}

var generators = map[Kind]func(spec) Snippet{
	Caddy:             caddy,
	Nginx:             nginx,
	Traefik:           traefik,
	NginxProxyManager: nginxProxyManager,
	CloudflareTunnel:  cloudflared,
	Tailscale:         tailscale,
}

// Generate validates the inputs and writes the configuration for one proxy.
func Generate(k Kind, in Inputs) (Snippet, error) {
	generate, ok := generators[k]
	if !ok {
		return Snippet{}, fmt.Errorf("proxy: unknown kind %q", string(k))
	}
	s, err := newSpec(k, in)
	if err != nil {
		return Snippet{}, err
	}
	snippet := generate(s)
	snippet.Kind = k
	return snippet, nil
}

// maxBodyMB is the request-body limit proxies are given. The server has no HTTP body limit of its own: its HTTP
// requests are small JSON (sign-in, passkeys) and uploads travel inside the WebSocket as base64. The largest
// upload is 32 MB per file (MAX_UPLOAD_BYTES in packages/ui/src/features/chat/use-attachments.ts), about 43 MB
// encoded, so 64 MB covers it with room to spare if a proxy counts it anyway.
const maxBodyMB = 64

// timeoutSeconds is how long proxies keep a quiet connection open. Replies stream for minutes.
const timeoutSeconds = 3600

// fill replaces @@NAME@@ markers in a template. Pairs are NAME, value, NAME, value, ...
func fill(template string, pairs ...string) string {
	args := make([]string, 0, len(pairs))
	for i := 0; i+1 < len(pairs); i += 2 {
		args = append(args, "@@"+pairs[i]+"@@", pairs[i+1])
	}
	return strings.NewReplacer(args...).Replace(template)
}
