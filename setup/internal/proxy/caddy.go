package proxy

import "fmt"

// Caddy proxies WebSockets, sets X-Forwarded-For/Proto/Host, keeps the Host header and gets its own certificates,
// so the block is the same one the repository's deploy/Caddyfile uses.
const caddyTemplate = "@@SITE@@ {\n\treverse_proxy @@UPSTREAM@@\n}\n"

func caddy(s spec) Snippet {
	snippet := Snippet{
		Title: "Caddyfile site block",
		Body:  fill(caddyTemplate, "SITE", s.hostPort, "UPSTREAM", s.upstream),
	}
	dns := fmt.Sprintf("Point the DNS record for `%s` (A for IPv4, AAAA for IPv6) at this machine's public IP address, and open ports 80 and 443 to the internet.", s.host)
	if s.docker {
		snippet.File = "Caddyfile"
		snippet.Steps = []string{
			"Save the block as `Caddyfile` next to your Compose file, or add it to the Caddyfile you already have, and mount that file into the Caddy container at `/etc/caddy/Caddyfile`.",
			"Publish ports 80 and 443 on the Caddy container, and 443/udp if you want HTTP/3.",
			dns,
			"Reload Caddy with `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`, replacing `caddy` with the name of your Caddy service. If the container is not running yet, start it with `docker compose up -d`.",
		}
	} else {
		snippet.File = "/etc/caddy/Caddyfile"
		snippet.Steps = []string{
			"Add the block to `/etc/caddy/Caddyfile`, or save it as its own file and pull it in with an `import` line there.",
			dns,
			"Check the file with `caddy validate --config /etc/caddy/Caddyfile`.",
			"Reload Caddy with `sudo systemctl reload caddy` for a packaged install, or `caddy reload --config /etc/caddy/Caddyfile` if you started Caddy yourself.",
		}
	}
	snippet.Notes = []string{
		fmt.Sprintf("The usual mistake: Caddy cannot get a certificate when DNS for `%s` does not point at this machine or ports 80 and 443 are not reachable from the internet. The browser then shows a certificate error, and Caddy's log says which check failed.", s.host),
		"Caddy passes WebSockets, sends the browser's Host header on unchanged and sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host itself, so this block needs nothing else for Atelier.",
	}
	if !s.defaultPort() {
		snippet.Notes = append(snippet.Notes, fmt.Sprintf("The address has port %d, so Caddy listens there instead of on 443. The certificate authority still checks over port 80 or 443 of this machine, so at least one of them must reach Caddy.", s.port))
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "Caddy")...)
	return snippet
}
