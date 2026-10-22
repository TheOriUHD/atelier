package proxy

import "fmt"

// A locally managed tunnel. The last rule is mandatory: cloudflared refuses a configuration whose ingress does not end
// in a rule without a hostname.
const cloudflaredTemplate = `# Replace <TUNNEL_ID> with the ID that "cloudflared tunnel create atelier" prints, here and in the credentials path.
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: @@HOST@@
    service: http://@@UPSTREAM@@
  # Required as the last rule: anything that matches no hostname above gets a 404.
  - service: http_status:404
`

func cloudflared(s spec) Snippet {
	snippet := Snippet{
		Title: "cloudflared tunnel configuration",
		File:  "/etc/cloudflared/config.yml",
		Body:  fill(cloudflaredTemplate, "HOST", s.host, "UPSTREAM", s.upstream),
		Steps: []string{
			"With a tunnel you manage in a file: on the machine that will run cloudflared, run `cloudflared tunnel login`, then `cloudflared tunnel create atelier`. It prints the tunnel ID and writes a credentials file named after it.",
			"Save the configuration as `/etc/cloudflared/config.yml` (or `~/.cloudflared/config.yml` for your own user). Replace `<TUNNEL_ID>` in both places with that ID, and fix the `credentials-file` path if the file is somewhere else.",
			fmt.Sprintf("Create the DNS record with `cloudflared tunnel route dns atelier %s`. The domain has to be on Cloudflare.", s.host),
			"Start the tunnel with `cloudflared tunnel run atelier`, or run `sudo cloudflared service install` so it starts at boot and reads `/etc/cloudflared/config.yml`.",
			fmt.Sprintf("With a tunnel you manage in the dashboard instead, there is no file: open Zero Trust, then Networks, then Tunnels, choose the tunnel and open Public Hostname (newer dashboards may call it Published application routes). Add a public hostname for `%s`, leave Path empty, set Type to `HTTP` and URL to `%s`, and save.", s.host, s.upstream),
		},
	}
	snippet.Notes = []string{
		fmt.Sprintf("The usual mistake: the service address is looked up from the machine or container that runs cloudflared, not from your browser or the Cloudflare dashboard. A 502 from Cloudflare means cloudflared could not reach `%s` from there.", s.upstream),
		"WebSockets work through a tunnel without any setting, so the app's live connection needs nothing else.",
		fmt.Sprintf("Cloudflare ends TLS and cloudflared talks plain HTTP to Atelier on your network. ATELIER_BASE_URL stays the public address, %s, not the http:// address in the configuration.", s.origin),
		"Atelier sees the connection from the machine or container that runs cloudflared, not from Cloudflare or the visitor. Cloudflare adds the visitor's address to X-Forwarded-For.",
		"Cloudflare Access can sit in front of the hostname, but only a browser can sign in to it, so the desktop apps and API clients then need a service token or a bypass policy.",
	}
	if !s.defaultPort() {
		snippet.Notes = append(snippet.Notes, fmt.Sprintf("The address has port %d. Cloudflare serves HTTPS on 443 and on 2053, 2083, 2087, 2096 and 8443; any other port will not be reachable. The ingress rule takes the host name only.", s.port))
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "cloudflared")...)
	return snippet
}
