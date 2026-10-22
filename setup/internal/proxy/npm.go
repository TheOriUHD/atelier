package proxy

import (
	"fmt"
	"strconv"
)

// Nginx Proxy Manager already forwards Host and the X-Forwarded headers, and "Websockets Support" adds the Upgrade
// and Connection headers. What it does not set is a long timeout, no buffering and a body limit. The Advanced tab's
// text goes into the host's server block, where these directives are inherited by the proxied location.
const npmTemplate = `# Replies stream for minutes: no 60-second idle timeout, and no buffering of the stream.
proxy_read_timeout @@TIMEOUT@@s;
proxy_send_timeout @@TIMEOUT@@s;
proxy_buffering off;

# Plain HTTP requests only. Uploads (up to 32 MB per file, about 43 MB as base64) travel inside the WebSocket.
client_max_body_size @@BODY@@m;
`

func nginxProxyManager(s spec) Snippet {
	snippet := Snippet{
		Title: "Nginx Proxy Manager proxy host",
		Body: fill(npmTemplate,
			"TIMEOUT", strconv.Itoa(timeoutSeconds),
			"BODY", strconv.Itoa(maxBodyMB),
		),
		Steps: []string{
			"In Nginx Proxy Manager, open Hosts, then Proxy Hosts, and click Add Proxy Host.",
			fmt.Sprintf("On the Details tab, set Domain Names to `%s`.", s.host),
			"Set Scheme to `http`.",
			fmt.Sprintf("Set Forward Hostname / IP to `%s` and Forward Port to `%d`.", s.upHost, s.upPort),
			"Turn on \"Websockets Support\". Leave \"Block Common Exploits\" on if you like and \"Cache Assets\" off.",
			"On the SSL tab, choose \"Request a new SSL Certificate\" under SSL Certificate, turn on \"Force SSL\" and \"HTTP/2 Support\", enter your email address and agree to the Let's Encrypt Terms of Service.",
			"On the Advanced tab, paste the configuration into \"Custom Nginx Configuration\".",
			fmt.Sprintf("Click Save. Nginx Proxy Manager requests the certificate when you save, so `%s` must already point at it and ports 80 and 443 must reach it.", s.host),
		},
	}
	snippet.Notes = []string{
		"The usual mistake: leaving \"Websockets Support\" off. The page then loads and spins forever, because the live connection is a WebSocket.",
		"The Advanced tab holds only what Nginx Proxy Manager does not set itself. It already forwards the Host and X-Forwarded headers, and \"Websockets Support\" adds the Upgrade and Connection headers.",
		"If the certificate request fails, the usual causes are DNS that does not point at Nginx Proxy Manager, ports 80 and 443 that do not reach it, or another proxy in front. For a name that is only reachable inside your network, turn on \"Use a DNS Challenge\" on the SSL tab.",
	}
	if !s.defaultPort() {
		snippet.Notes = append(snippet.Notes, fmt.Sprintf("Nginx Proxy Manager answers HTTPS on port 443 inside its container and the host form has no port. For port %d, map that port to the container's 443 in Docker, for example `%d:443`.", s.port, s.port))
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "Nginx Proxy Manager")...)
	return snippet
}
