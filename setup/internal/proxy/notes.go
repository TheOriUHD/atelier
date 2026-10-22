package proxy

import "fmt"

// sharedNotes are the caveats every proxy has: how the proxy reaches Atelier, and the two settings on Atelier's side.
// who is the proxy as the person calls it ("nginx", "Caddy", ...).
func sharedNotes(s spec, who string) []string {
	notes := upstreamNotes(s, who)
	notes = append(notes,
		fmt.Sprintf("If %s and Atelier run on different machines, set Upstream to Atelier's address on your network, for example 192.168.1.20:7340, publish port 7340 on that address, and let only the machine with %s reach it. Never open port 7340 to the internet.", who, who),
		fmt.Sprintf("Set ATELIER_BASE_URL to %s, exactly what people type in the browser, and put the address %s connects from in ATELIER_TRUSTED_PROXIES. Atelier believes X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host only from those addresses, and without them every visitor looks like the proxy to the rate limits.", s.origin, who),
	)
	return notes
}

// upstreamNotes explain the upstream address when it is one that does not work from where the proxy runs.
func upstreamNotes(s spec, who string) []string {
	switch {
	case s.docker && s.loopback():
		return []string{fmt.Sprintf("%s runs in a container, where %s is the container itself and not the machine around it. Set Upstream to the Atelier container's name on a Docker network both containers share, for example atelier:7340, or to the machine's address on your network.", who, s.upHost)}
	case s.docker && s.serviceName():
		return []string{fmt.Sprintf("%s and the `%s` container must share a Docker network, for example by being in the same Compose file, or the name `%s` does not resolve.", who, s.upHost, s.upHost)}
	case !s.docker && s.serviceName():
		return []string{fmt.Sprintf("`%s` is a Docker service name, which only resolves inside a Docker network and not for %s running on the machine itself. Publish Atelier's port on loopback only (`127.0.0.1:%d:%d` in Compose) and set Upstream to `127.0.0.1:%d`.", s.upHost, who, s.upPort, s.upPort, s.upPort)}
	}
	return nil
}
