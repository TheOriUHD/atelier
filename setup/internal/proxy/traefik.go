package proxy

import (
	"fmt"
	"strconv"
	"strings"
)

// Traefik passes WebSockets without configuration, does not buffer, keeps the Host header and sets X-Forwarded-*.
// The entrypoint and certificate resolver names are the person's own: websecure and letsencrypt are the usual ones.
const (
	traefikEntryPoint   = "websecure"
	traefikCertResolver = "letsencrypt"
)

const traefikLabelsMarker = "# Option A, Docker labels: add them to the atelier service of your Compose file."
const traefikFileMarker = "# Option B, file provider: save this as its own file in the directory Traefik's file provider watches, for example /etc/traefik/dynamic/atelier.yml. Use A or B, not both."

const traefikLabelsTemplate = `services:
  atelier:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.atelier.rule=@@RULE@@"
      - "traefik.http.routers.atelier.entrypoints=@@ENTRYPOINT@@"
      - "traefik.http.routers.atelier.tls=true"
      - "traefik.http.routers.atelier.tls.certresolver=@@RESOLVER@@"
      - "traefik.http.services.atelier.loadbalancer.server.port=@@PORT@@"
`

const traefikFileTemplate = `http:
  routers:
    atelier:
      rule: "@@RULE@@"
      entryPoints:
        - @@ENTRYPOINT@@
      service: atelier
      tls:
        certResolver: @@RESOLVER@@
  services:
    atelier:
      loadBalancer:
        servers:
          - url: "http://@@UPSTREAM@@"
`

func traefik(s spec) Snippet {
	// Host() matches the host name only; a port in the public address is the entrypoint's business.
	rule := "Host(`" + s.host + "`)"
	values := []string{
		"RULE", rule,
		"ENTRYPOINT", traefikEntryPoint,
		"RESOLVER", traefikCertResolver,
		"PORT", strconv.Itoa(s.upPort),
		"UPSTREAM", s.upstream,
	}
	body := strings.Join([]string{
		traefikLabelsMarker,
		fill(traefikLabelsTemplate, values...),
		traefikFileMarker,
		fill(traefikFileTemplate, values...),
	}, "\n")

	snippet := Snippet{
		Title: "Traefik labels and file configuration",
		File:  "compose.yaml",
		Body:  body,
		Steps: []string{
			fmt.Sprintf("Check the three names that are yours: `%s` must be the name of Traefik's HTTPS entrypoint and `%s` the name of its certificate resolver, both in Traefik's static configuration. Change them in the configuration here if yours differ.", traefikEntryPoint, traefikCertResolver),
			"With Docker, add the labels of option A to the atelier service in your Compose file and run `docker compose up -d`. Traefik reads them through the Docker provider and the port comes from Upstream; its host part is not used, because Traefik finds the container itself.",
			"Traefik and the atelier container must share a Docker network. If Atelier is on more than one network, add the label `traefik.docker.network=<network Traefik shares with Atelier>`.",
			"Without Docker labels, save option B in the directory your file provider watches, for example `/etc/traefik/dynamic/atelier.yml`. Traefik loads it without a restart, and the `url` in it must be reachable from where Traefik runs.",
			fmt.Sprintf("Point the DNS record for `%s` at the machine where Traefik runs, and make sure ports 80 and 443 reach it.", s.host),
		},
	}
	snippet.Notes = []string{
		fmt.Sprintf("The usual mistake: `%s` and `%s` are names from your own Traefik configuration. If they do not match it, the router never matches and you get a 404, or Traefik serves its default certificate.", traefikEntryPoint, traefikCertResolver),
		"Traefik passes WebSockets without any setting, does not buffer, keeps the Host header and sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host, so the router needs nothing else for Atelier.",
		"Redirecting port 80 to HTTPS is set on the `web` entrypoint in Traefik's static configuration, not on this router.",
	}
	if !s.defaultPort() {
		snippet.Notes = append(snippet.Notes, fmt.Sprintf("The address has port %d. `Host()` ignores ports, so the entrypoint named `%s` has to listen on %d.", s.port, traefikEntryPoint, s.port))
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "Traefik")...)
	return snippet
}
