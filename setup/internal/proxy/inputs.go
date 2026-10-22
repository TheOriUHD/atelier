package proxy

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Inputs describes the proxy and Atelier. Generate validates all of it.
type Inputs struct {
	// PublicURL is the address people type: "https://atelier.example.com". HTTPS only, a host name (with an optional
	// port), no path and no trailing slash. For Tailscale it is the *.ts.net address.
	PublicURL string
	// Upstream is host:port where the proxy itself reaches Atelier: "127.0.0.1:7340", "192.168.1.20:7340" or
	// "atelier:7340" (a service name on a Docker network).
	Upstream string
	// ProxyInDocker says the proxy runs in a container. Then 127.0.0.1 is the proxy's own container, and a service
	// name only resolves when both containers share a network.
	ProxyInDocker bool
}

// InputError says which field of Inputs is wrong, in words for the person who typed it.
type InputError struct {
	Field   string // "PublicURL" or "Upstream"
	Message string
}

func (e *InputError) Error() string { return e.Message }

var (
	publicLabel   = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	upstreamLabel = regexp.MustCompile(`^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$`)
	allDigits     = regexp.MustCompile(`^[0-9]+$`)
	digitsAndDots = regexp.MustCompile(`^[0-9.]+$`)
)

// ValidateInputs checks both fields. The first problem found is returned as an *InputError.
func ValidateInputs(in Inputs) error {
	if _, err := parsePublic(in.PublicURL); err != nil {
		return err
	}
	if _, _, err := parseUpstream(in.Upstream); err != nil {
		return err
	}
	return nil
}

// Host is the host name of PublicURL, lower-case and without a port. It is "" when PublicURL is invalid.
func (in Inputs) Host() string {
	a, err := parsePublic(in.PublicURL)
	if err != nil {
		return ""
	}
	return a.host
}

// HostPort is the host name of PublicURL, with ":port" only when the port is not the HTTPS default 443. It is ""
// when PublicURL is invalid.
func (in Inputs) HostPort() string {
	a, err := parsePublic(in.PublicURL)
	if err != nil {
		return ""
	}
	return a.hostPort()
}

type publicAddr struct {
	host string
	port int // 0: the default, 443
}

func (a publicAddr) hostPort() string {
	if a.port == 0 {
		return a.host
	}
	return net.JoinHostPort(a.host, strconv.Itoa(a.port))
}

func publicErr(format string, args ...any) error {
	return &InputError{Field: "PublicURL", Message: fmt.Sprintf(format, args...)}
}

func parsePublic(raw string) (publicAddr, error) {
	if strings.TrimSpace(raw) == "" {
		return publicAddr{}, publicErr("Enter the address people will type, for example https://atelier.example.com.")
	}
	if strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
		return publicAddr{}, publicErr("The address has a space in it. Enter it as https://atelier.example.com.")
	}
	lower := strings.ToLower(raw)
	switch {
	case strings.HasPrefix(lower, "http://"):
		return publicAddr{}, publicErr("The address must start with https://, not http://. A proxy has to serve Atelier over HTTPS.")
	case !strings.HasPrefix(lower, "https://"):
		return publicAddr{}, publicErr("The address must start with https://, for example https://atelier.example.com.")
	}
	rest := raw[len("https://"):]
	if strings.ContainsAny(rest, "?#") {
		return publicAddr{}, publicErr("Leave out everything after the host name: no query and no #fragment.")
	}
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		if i == len(rest)-1 {
			return publicAddr{}, publicErr("Remove the slash at the end: https://atelier.example.com, not https://atelier.example.com/.")
		}
		return publicAddr{}, publicErr("The address is the host name only, with no path after it.")
	}
	if strings.Contains(rest, "@") {
		return publicAddr{}, publicErr("The address must not contain a user name or password.")
	}
	if strings.HasPrefix(rest, "[") {
		return publicAddr{}, publicErr("Use a host name, not an IP address. Certificates and passkeys need a name such as atelier.example.com.")
	}
	host, portText, hasPort := strings.Cut(rest, ":")
	if msg := checkPublicHost(host); msg != "" {
		return publicAddr{}, publicErr("%s", msg)
	}
	addr := publicAddr{host: strings.ToLower(host)}
	if hasPort {
		port, ok := parsePort(portText)
		if !ok {
			return publicAddr{}, publicErr("The port after the host name must be a number from 1 to 65535, not %q.", portText)
		}
		if port != 443 {
			addr.port = port
		}
	}
	return addr, nil
}

func checkPublicHost(h string) string {
	switch {
	case h == "":
		return "The address has no host name. Enter it as https://atelier.example.com."
	case net.ParseIP(h) != nil || digitsAndDots.MatchString(h):
		return "Use a host name, not an IP address. Certificates and passkeys need a name such as atelier.example.com."
	case len(h) > 253:
		return "The host name is longer than 253 characters."
	case !strings.Contains(h, "."):
		return fmt.Sprintf("%q is a single word. Use a full name such as atelier.example.com: a name without a dot cannot get a certificate.", h)
	}
	parts := strings.Split(h, ".")
	for _, l := range parts {
		if !publicLabel.MatchString(l) {
			return fmt.Sprintf("%q is not a valid host name. Use letters, digits and hyphens between the dots: no spaces, underscores, accents or empty parts.", h)
		}
	}
	if allDigits.MatchString(parts[len(parts)-1]) {
		return fmt.Sprintf("%q is not a valid host name: the last part cannot be only digits.", h)
	}
	return ""
}

func upstreamErr(format string, args ...any) error {
	return &InputError{Field: "Upstream", Message: fmt.Sprintf(format, args...)}
}

// parseUpstream returns the host (lower-case, without brackets) and port of "host:port".
func parseUpstream(raw string) (string, int, error) {
	if strings.TrimSpace(raw) == "" {
		return "", 0, upstreamErr("Enter where the proxy reaches Atelier as host:port, for example 127.0.0.1:7340.")
	}
	if strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
		return "", 0, upstreamErr("The upstream has a space in it. Enter it as host:port, for example 127.0.0.1:7340.")
	}
	if strings.Contains(raw, "/") {
		return "", 0, upstreamErr("The upstream is host:port only, without http:// or a path, for example 127.0.0.1:7340.")
	}
	host, portText, err := net.SplitHostPort(raw)
	if err != nil || host == "" {
		return "", 0, upstreamErr("The upstream must look like host:port, for example 127.0.0.1:7340 or atelier:7340.")
	}
	port, ok := parsePort(portText)
	if !ok {
		return "", 0, upstreamErr("The port after the host must be a number from 1 to 65535, not %q.", portText)
	}
	if net.ParseIP(host) == nil {
		if digitsAndDots.MatchString(host) {
			return "", 0, upstreamErr("%q is not a valid IP address.", host)
		}
		if len(host) > 253 {
			return "", 0, upstreamErr("The host name is longer than 253 characters.")
		}
		for _, l := range strings.Split(host, ".") {
			if !upstreamLabel.MatchString(l) {
				return "", 0, upstreamErr("%q is not a valid host name or IP address.", host)
			}
		}
	}
	return strings.ToLower(host), port, nil
}

func parsePort(s string) (int, bool) {
	if !allDigits.MatchString(s) || len(s) > 5 {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= 1 && n <= 65535
}

// spec is validated Inputs with everything the generators use already worked out.
type spec struct {
	kind     Kind
	host     string // atelier.example.com
	hostPort string // atelier.example.com, or atelier.example.com:8443 when the port is not 443
	origin   string // https://atelier.example.com
	port     int    // the port people use: 443 unless the address names another
	upHost   string // 127.0.0.1
	upPort   int    // 7340
	upstream string // 127.0.0.1:7340, [::1]:7340 for IPv6
	docker   bool
}

func newSpec(k Kind, in Inputs) (spec, error) {
	pub, err := parsePublic(in.PublicURL)
	if err != nil {
		return spec{}, err
	}
	upHost, upPort, err := parseUpstream(in.Upstream)
	if err != nil {
		return spec{}, err
	}
	if k == Tailscale && !strings.HasSuffix(pub.host, ".ts.net") {
		return spec{}, publicErr("A Tailscale address ends in .ts.net, for example https://atelier.tail1234.ts.net. Run `tailscale serve status` or look at the DNS page of the Tailscale admin console for yours.")
	}
	port := pub.port
	if port == 0 {
		port = 443
	}
	return spec{
		kind:     k,
		host:     pub.host,
		hostPort: pub.hostPort(),
		origin:   "https://" + pub.hostPort(),
		port:     port,
		upHost:   upHost,
		upPort:   upPort,
		upstream: net.JoinHostPort(upHost, strconv.Itoa(upPort)),
		docker:   in.ProxyInDocker,
	}, nil
}

func (s spec) defaultPort() bool { return s.port == 443 }

// loopback reports an upstream on the machine the proxy runs on (or, for a proxy in a container, in the container).
func (s spec) loopback() bool {
	if s.upHost == "localhost" {
		return true
	}
	ip := net.ParseIP(s.upHost)
	return ip != nil && ip.IsLoopback()
}

// serviceName reports an upstream that is a single word, such as a Docker service name: atelier.
func (s spec) serviceName() bool {
	return net.ParseIP(s.upHost) == nil && !strings.Contains(s.upHost, ".") && s.upHost != "localhost"
}
