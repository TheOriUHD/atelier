package proxy

import (
	"fmt"
	"strconv"
)

// The map belongs in the http context; files in conf.d are included there. Replies stream for minutes, so nothing
// may buffer them or close the connection after nginx's default 60 seconds.
const nginxTemplate = `# The map belongs in the http context. Files in /etc/nginx/conf.d/ are included there, so keep it at the top of this file.
# If nginx -t reports a duplicate "connection_upgrade" variable, another file already has this map: delete this copy.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name @@HOST@@;

    return 301 https://@@HOSTPORT@@$request_uri;
}

server {
    listen @@PORT@@ ssl;
    listen [::]:@@PORT@@ ssl;
    http2 on;
    server_name @@HOST@@;

    # Certificate files from certbot. They do not exist until you have obtained the certificate (see the steps).
    ssl_certificate     /etc/letsencrypt/live/@@HOST@@/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/@@HOST@@/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Plain HTTP requests only. Uploads (up to 32 MB per file, about 43 MB as base64) travel inside the WebSocket,
    # which nginx does not count here.
    client_max_body_size @@BODY@@m;

    # Turn this on once HTTPS works for every device: browsers then refuse plain HTTP for this name for a year.
    # add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://@@UPSTREAM@@;
        proxy_http_version 1.1;

        proxy_set_header Host @@HOSTVAR@@;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host @@HOSTVAR@@;

        # WebSocket upgrade for /api/ws and /api/devices/link. Without these two headers the page loads and then spins.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Replies stream for minutes: no 60-second idle timeout, and no buffering of the stream.
        proxy_read_timeout @@TIMEOUT@@s;
        proxy_send_timeout @@TIMEOUT@@s;
        proxy_buffering off;
    }
}
`

func nginx(s spec) Snippet {
	// $host drops the port. When the address has one, $http_host keeps the Host header exactly as the browser sent it.
	hostVar := "$host"
	if !s.defaultPort() {
		hostVar = "$http_host"
	}
	port := strconv.Itoa(s.port)
	snippet := Snippet{
		Title: "nginx server block",
		File:  "/etc/nginx/conf.d/atelier.conf",
		Body: fill(nginxTemplate,
			"HOST", s.host,
			"HOSTPORT", s.hostPort,
			"PORT", port,
			"HOSTVAR", hostVar,
			"UPSTREAM", s.upstream,
			"BODY", strconv.Itoa(maxBodyMB),
			"TIMEOUT", strconv.Itoa(timeoutSeconds),
		),
	}
	dns := fmt.Sprintf("Point the DNS record for `%s` at this machine and open ports 80 and 443 to the internet.", s.host)
	if s.docker {
		snippet.Steps = []string{
			fmt.Sprintf("Get a certificate for `%s` first, because nginx refuses to load the HTTPS block while its certificate files are missing. With certbot on the host and nothing else on port 80, run `sudo certbot certonly --standalone -d %s`. The files must end up under `/etc/letsencrypt/live/%s/`.", s.host, s.host, s.host),
			"Save the configuration as `atelier.conf` next to your Compose file and mount it into the nginx container at `/etc/nginx/conf.d/atelier.conf`, together with `/etc/letsencrypt` at the same path inside the container. Keep the `map` at the top of the file: `conf.d` files are included in the `http` context, which is where it must be.",
			"Publish ports 80 and 443 on the nginx container.",
			dns,
			"Check the configuration with `docker compose exec nginx nginx -t`, replacing `nginx` with the name of your nginx service.",
			"Reload nginx with `docker compose exec nginx nginx -s reload`.",
		}
	} else {
		snippet.Steps = []string{
			fmt.Sprintf("Get a certificate for `%s` first, because nginx refuses to load the HTTPS block while its certificate files are missing. With certbot and nothing else on port 80, run `sudo certbot certonly --standalone -d %s`; if nginx already serves port 80, run `sudo certbot certonly --nginx -d %s` instead.", s.host, s.host, s.host),
			"Save the configuration as `/etc/nginx/conf.d/atelier.conf`. Keep the `map` at the top of the file: `conf.d` files are included in the `http` context, which is where it must be.",
			dns,
			"Check the configuration with `sudo nginx -t`.",
			"Reload nginx with `sudo systemctl reload nginx`.",
		}
	}
	snippet.Notes = []string{
		"The usual mistake: pasting only part of this into an existing server block. Keep the `map` in the `http` context and every `proxy_set_header` line; without the Upgrade and Connection headers the page loads and then spins.",
		fmt.Sprintf("`proxy_read_timeout` and `proxy_send_timeout` are %ds because replies stream for minutes, and nginx's default of 60 seconds cuts them. `proxy_buffering off` lets the stream through as it arrives.", timeoutSeconds),
		fmt.Sprintf("`client_max_body_size %dm` covers a 32 MB upload (about 43 MB as base64) with room to spare. Atelier sends uploads inside the WebSocket, which nginx does not count against it.", maxBodyMB),
		"The certificate comes from certbot and is renewed by it, but nginx only uses the renewed files after a reload. Add `--deploy-hook \"systemctl reload nginx\"` to the certbot command that obtains it.",
		fmt.Sprintf("`http2 on;` needs nginx 1.25.1 or newer. On an older version delete that line and write `listen %s ssl http2;` instead of the first `listen` line of the HTTPS block.", port),
	}
	snippet.Notes = append(snippet.Notes, "If nginx reports \"Address family not supported\" for a `[::]` address, this machine has IPv6 switched off: delete the two `listen [::]` lines.")
	if s.serviceName() {
		snippet.Notes = append(snippet.Notes, fmt.Sprintf("nginx looks up `%s` once when it starts and refuses to start if the name does not resolve, so start Atelier first.", s.upHost))
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "nginx")...)
	return snippet
}
