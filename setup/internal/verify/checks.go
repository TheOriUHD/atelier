package verify

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// wsAdvice is the fix for every proxy that does not pass WebSocket upgrades.
const wsAdvice = "enable WebSocket support (Nginx Proxy Manager: 'Websockets Support'; nginx: the Upgrade/Connection headers; Cloudflare: WebSockets on)"

// ------------------------------------------------------------------ fixes shared by several checks

func (r *runner) nothingAnswers() string {
	return fmt.Sprintf("Nothing answers at %s: check that the proxy is running, forwards to Atelier's port, and that firewalls allow it.", r.base)
}

func proxyDown(status int) string {
	return fmt.Sprintf("The proxy answered %d: it cannot reach Atelier. Check the upstream address and port in the proxy's configuration.", status)
}

// originFix is the answer to Atelier's bad_origin refusal, on the WebSocket and on sign-in alike.
func (r *runner) originFix() string {
	if r.https {
		return fmt.Sprintf("Atelier refused the browser's address (%s). Set ATELIER_BASE_URL=%s for the Atelier server and restart it. "+
			"If you leave it unset instead, put the reverse proxy's address in ATELIER_TRUSTED_PROXIES.", r.origin, r.origin)
	}
	return fmt.Sprintf("Atelier refused the address %s: open it by the address it was set up with, or set ATELIER_BASE_URL=%s.", r.origin, r.origin)
}

func (r *runner) tlsFix(err error) string {
	reason, _ := tlsFault(err, r.now())
	return fmt.Sprintf("The TLS handshake with %s failed (%s): check the proxy's certificate configuration.", r.host, reason)
}

// cancelled marks a check the caller interrupted. Run replaces its fix, since no setting is to blame.
func cancelled(c Check) Check {
	c.Status, c.Detail, c.Fix = Fail, "cancelled", ""
	return c
}

// ------------------------------------------------------------------ 1. address

func (r *runner) checkAddress() Check {
	c := Check{Name: CheckAddress}
	if r.parseErr != nil {
		c.Status = Fail
		c.Detail = r.parseErr.Error()
		c.Fix = "Enter the public address with its scheme, for example https://atelier.example.com or http://192.168.1.20:7340."
		return c
	}
	if _, err := netip.ParseAddr(r.host); err == nil {
		c.Detail = r.host + " is an IP address"
		return c
	}
	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	addrs, err := r.resolve(ctx, r.host)
	if err == nil && len(addrs) == 0 {
		err = errors.New("no address records")
	}
	if err == nil {
		shown := addrs[:min(len(addrs), 3)]
		c.Detail = fmt.Sprintf("%s resolves to %s", r.host, strings.Join(shown, ", "))
		if len(addrs) > len(shown) {
			c.Detail += ", ..."
		}
		return c
	}
	if classify(err) == failCancelled {
		return cancelled(c)
	}
	c.Status = Fail
	c.Detail = fmt.Sprintf("%s did not resolve: %s", r.host, oneLine(err.Error(), 160))
	var dnsErr *net.DNSError
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &dnsErr) && (dnsErr.IsTimeout || (dnsErr.IsTemporary && !dnsErr.IsNotFound))) {
		c.Fix = fmt.Sprintf("This computer could not look up %s just now: check its network connection and DNS settings.", r.host)
	} else {
		c.Fix = fmt.Sprintf("Create a DNS record for %s that points at this machine's public address (or your reverse proxy's).", r.host)
	}
	return c
}

// ------------------------------------------------------------------ 2. certificate

// A certificate that expires sooner than this is a warning: the proxy should have renewed it long before.
const renewalWindow = 14 * 24 * time.Hour

func (r *runner) checkCertificate() Check {
	c := Check{Name: CheckCertificate}
	if !r.https {
		c.Status = Skipped
		c.Detail = "skipped: plain http, there is no certificate to check"
		return c
	}
	// Dial and verify the way the requests will: the same dialer and the same roots.
	cfg := &tls.Config{}
	dial := (&net.Dialer{}).DialContext
	if r.tr != nil {
		cfg = r.tr.TLSClientConfig.Clone()
		if r.tr.DialContext != nil {
			dial = r.tr.DialContext
		}
	}
	cfg.ServerName = r.host
	cfg.NextProtos = []string{"http/1.1"}
	cfg.InsecureSkipVerify = r.insecure
	cfg.Time = r.now

	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	hostPort := net.JoinHostPort(r.host, r.port)
	conn, err := dial(ctx, "tcp", hostPort)
	if err != nil {
		if classify(err) == failCancelled {
			return cancelled(c)
		}
		// Not a certificate problem: the next check says what is wrong with the connection.
		r.dialErr = err
		c.Status = Skipped
		c.Detail = fmt.Sprintf("skipped: cannot connect to %s (%s)", hostPort, describe(err, r.timeout))
		return c
	}
	defer conn.Close()
	tc := tls.Client(conn, cfg)
	if err := tc.HandshakeContext(ctx); err != nil {
		return r.handshakeFailed(c, hostPort, err)
	}
	if r.insecure {
		c.Status = Warn
		c.Detail = "self-signed or untrusted certificate (accepted for this test)"
		c.Fix = fmt.Sprintf("Browsers will warn about the certificate for %s: use one from a public authority (Caddy gets one from Let's Encrypt by itself), or install your own authority on every device.", r.host)
		return c
	}
	peers := tc.ConnectionState().PeerCertificates
	if len(peers) == 0 {
		c.Status = Fail
		c.Detail = hostPort + " presented no certificate"
		c.Fix = fmt.Sprintf("The certificate for %s is not valid (none was presented): check the proxy's certificate configuration.", r.host)
		return c
	}
	leaf := peers[0]
	left := leaf.NotAfter.Sub(r.now())
	days := int(left / (24 * time.Hour))
	if left < renewalWindow {
		in := "in " + plural(days, "day")
		if days < 1 {
			in = "in less than a day"
		}
		c.Status = Warn
		c.Detail = fmt.Sprintf("expires %s, on %s", in, date(leaf.NotAfter))
		c.Fix = fmt.Sprintf("The certificate for %s expires %s: check that the proxy renews it automatically.", r.host, in)
		return c
	}
	c.Detail = fmt.Sprintf("valid for %s more (until %s)", plural(days, "day"), date(leaf.NotAfter))
	if issuer := issuerName(leaf); issuer != "" {
		c.Detail += ", issued by " + issuer
	}
	return c
}

func issuerName(cert *x509.Certificate) string {
	if cert.Issuer.CommonName != "" {
		return cert.Issuer.CommonName
	}
	if len(cert.Issuer.Organization) > 0 {
		return cert.Issuer.Organization[0]
	}
	return ""
}

func (r *runner) handshakeFailed(c Check, hostPort string, err error) Check {
	switch classify(err) {
	case failCancelled:
		return cancelled(c)
	case failTimeout:
		// Connected, but silent: the next check reports that nothing answers.
		r.dialErr = err
		c.Status = Skipped
		c.Detail = fmt.Sprintf("skipped: the TLS handshake with %s timed out", hostPort)
		return c
	}
	c.Status = Fail
	reason, notTLS := tlsFault(err, r.now())
	switch {
	case notTLS:
		c.Detail = hostPort + " answered, but not with TLS"
		c.Fix = fmt.Sprintf("%s does not answer HTTPS: use http:// in the address, or point the proxy's HTTPS listener at this port.", hostPort)
	case isCertificateError(err):
		c.Detail = fmt.Sprintf("the certificate from %s is not valid: %s", hostPort, reason)
		c.Fix = fmt.Sprintf("The certificate for %s is not valid (%s): check the proxy's certificate configuration.", r.host, reason)
	default:
		if classify(err) != failTLS {
			reason = describe(err, r.timeout)
		}
		c.Detail = fmt.Sprintf("TLS handshake with %s failed: %s", hostPort, reason)
		c.Fix = fmt.Sprintf("The TLS handshake with %s failed (%s): check the proxy's certificate configuration.", r.host, reason)
	}
	return c
}

func isCertificateError(err error) bool {
	var verify *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	return errors.As(err, &verify) || errors.As(err, &unknown) || errors.As(err, &invalid) || errors.As(err, &hostname)
}

// ------------------------------------------------------------------ 3. server

// checkServer asks /api/health, which Atelier answers without a sign-in with {"ok":true,"app":"atelier","version":"…"}.
func (r *runner) checkServer() (Check, string) {
	c := Check{Name: CheckServer}
	target := r.base + "/api/health"
	var rep reply
	err := r.dialErr
	if err == nil {
		rep, err = r.fetch(http.MethodGet, target, "", http.Header{"Accept": {"application/json"}}, true)
	}
	if err != nil {
		if classify(err) == failCancelled {
			return cancelled(c), ""
		}
		c.Status = Fail
		c.Detail = fmt.Sprintf("%s failed: %s", target, describe(err, r.timeout))
		switch classify(err) {
		case failLoop:
			c.Fix = fmt.Sprintf("%s redirects in a loop: check the proxy's redirect rules, for example an http to https redirect that is also applied to https.", r.base)
		case failTLS:
			c.Fix = r.tlsFix(err)
		case failClosed:
			c.Fix = fmt.Sprintf("%s accepts the connection but closes it without answering: check that the proxy forwards to Atelier's port and that Atelier is running.", r.base)
		default:
			c.Fix = r.nothingAnswers()
		}
		return c, ""
	}

	var health struct {
		OK      bool   `json:"ok"`
		App     string `json:"app"`
		Version string `json:"version"`
	}
	isAtelier := rep.status >= 200 && rep.status < 300 && json.Unmarshal(rep.body, &health) == nil && health.App == "atelier"
	if isAtelier {
		c.Detail = fmt.Sprintf("%s answered %d, Atelier %s", target, rep.status, health.Version)
		c.Detail = strings.TrimSuffix(c.Detail, " ")
		if rep.final != nil && normalOrigin(rep.final) != r.base {
			c.Status = Warn
			c.Detail += ", after redirecting to " + normalOrigin(rep.final)
			c.Fix = fmt.Sprintf("%s redirects to %s: use that address as the public address, and as ATELIER_BASE_URL.", r.base, normalOrigin(rep.final))
		}
		return c, health.Version
	}

	c.Status = Fail
	c.Detail = fmt.Sprintf("%s answered %s", target, describeReply(rep))
	switch {
	case rep.status == http.StatusBadGateway, rep.status == http.StatusServiceUnavailable, rep.status == http.StatusGatewayTimeout:
		c.Fix = proxyDown(rep.status)
	case rep.status == http.StatusUnauthorized, rep.status == http.StatusForbidden, rep.status == http.StatusProxyAuthRequired:
		c.Fix = fmt.Sprintf("Something in front of Atelier answered %d (proxy authentication, SSO or an access gate): let /api/ through without it, because Atelier has its own sign-in.", rep.status)
	case rep.status >= 500:
		c.Fix = fmt.Sprintf("%s answered %d: look at the proxy's log and Atelier's log for the cause.", r.base, rep.status)
	default:
		c.Fix = fmt.Sprintf("%s is not served by Atelier. Check the proxy's host name and upstream.", r.base)
	}
	return c, ""
}

// normalOrigin writes a URL's origin the way r.base does: lower case, default port omitted.
func normalOrigin(u *url.URL) string {
	host, port := strings.ToLower(u.Hostname()), u.Port()
	authority := host
	if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	if port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
		authority = net.JoinHostPort(host, port)
	}
	return u.Scheme + "://" + authority
}

// ------------------------------------------------------------------ 4. WebSocket

// upgrade opens the WebSocket handshake a browser sends to /api/ws. An empty origin leaves the header out, as the
// desktop app does.
func (r *runner) upgrade(origin string) (reply, error) {
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	header := http.Header{
		"Connection":            {"Upgrade"},
		"Upgrade":               {"websocket"},
		"Sec-WebSocket-Version": {"13"},
		"Sec-WebSocket-Key":     {base64.StdEncoding.EncodeToString(key)},
	}
	if origin != "" {
		header["Origin"] = []string{origin}
	}
	return r.fetch(http.MethodGet, r.base+"/api/ws", "", header, false)
}

// checkWebSocket opens the upgrade a browser opens at /api/ws, with the Origin header a browser would send. Atelier
// answers 101 for the address it believes it has and 403 for any other; what a proxy does wrong shows up as the
// other statuses.
//
// Atelier's own 403 to an upgrade has no body (the WebSocket library writes the status line and closes the
// connection), so the {"code":"bad_origin"} JSON is only seen when a proxy turns the upgrade into a plain request.
// A 403 without that body is therefore asked again without an Origin header, which Atelier accepts: if that opens,
// the Origin was the reason, and a firewall that refuses every upgrade is told apart from it.
func (r *runner) checkWebSocket() Check {
	c := Check{Name: CheckWebSocket}
	target := r.base + "/api/ws"
	rep, err := r.upgrade(r.origin)
	if err != nil {
		if classify(err) == failCancelled {
			return cancelled(c)
		}
		c.Status = Fail
		c.Detail = fmt.Sprintf("%s failed: %s", target, describe(err, r.timeout))
		switch classify(err) {
		case failUnreachable:
			c.Fix = r.nothingAnswers()
		case failTLS:
			c.Fix = r.tlsFix(err)
		default:
			c.Fix = "The connection was cut during the WebSocket handshake: a proxy or firewall in between drops upgrades; raise its timeouts and enable WebSocket support."
		}
		return c
	}

	refusedByOrigin := isBadOrigin(rep)
	if rep.status == http.StatusForbidden && !refusedByOrigin {
		if again, err := r.upgrade(""); err == nil && again.status == http.StatusSwitchingProtocols {
			c.Detail = fmt.Sprintf("%s answered 403 to origin %s, but 101 without an Origin header", target, r.origin)
			refusedByOrigin = true
		}
	}
	if rep.status == http.StatusSwitchingProtocols {
		c.Detail = fmt.Sprintf("%s answered 101 Switching Protocols to origin %s", target, r.origin)
		return c
	}
	c.Status = Fail
	if c.Detail == "" {
		c.Detail = fmt.Sprintf("%s answered %s to origin %s", target, describeReply(rep), r.origin)
	}
	switch {
	case refusedByOrigin:
		c.Fix = r.originFix()
	case rep.status >= 300 && rep.status < 400:
		where := rep.header.Get("Location")
		if rep.final != nil && where != "" {
			if next, err := rep.final.Parse(where); err == nil {
				where = next.String()
			}
		}
		c.Fix = fmt.Sprintf("%s redirects the WebSocket to %s: use that address as the public address, and as ATELIER_BASE_URL.", target, where)
	case rep.status == http.StatusBadGateway, rep.status == http.StatusServiceUnavailable, rep.status == http.StatusGatewayTimeout:
		c.Fix = proxyDown(rep.status)
	case rep.status == http.StatusUnauthorized, rep.status == http.StatusForbidden, rep.status == http.StatusProxyAuthRequired:
		c.Fix = fmt.Sprintf("Something in front of Atelier answered %d to the WebSocket handshake (proxy authentication, a firewall or a WAF rule): allow WebSocket upgrades on /api/ws without it.", rep.status)
	case rep.status == http.StatusNotFound:
		c.Fix = "/api/ws is not forwarded: the proxy must pass every path to Atelier."
	case rep.status == http.StatusOK && looksLikeHTML(rep):
		c.Fix = "The proxy answered with a web page instead of opening a WebSocket: " + wsAdvice + "."
	default:
		c.Fix = fmt.Sprintf("The proxy answered %d instead of opening a WebSocket: %s.", rep.status, wsAdvice)
	}
	return c
}

// ------------------------------------------------------------------ 5. sign-in

// checkSignIn posts an empty JSON object to the sign-in route. It is a probe of the origin check, which runs before
// the body is read: Atelier answers 403 bad_origin for a wrong Origin and 400 invalid_input for the right one. The
// body has no credentials, so nothing can sign in.
func (r *runner) checkSignIn() Check {
	c := Check{Name: CheckSignIn}
	target := r.base + "/api/auth/login"
	header := http.Header{
		"Content-Type": {"application/json"},
		"Accept":       {"application/json"},
		"Origin":       {r.origin},
	}
	rep, err := r.fetch(http.MethodPost, target, "{}", header, false)
	if err != nil {
		if classify(err) == failCancelled {
			return cancelled(c)
		}
		c.Status = Warn
		c.Detail = fmt.Sprintf("POST %s failed: %s", target, describe(err, r.timeout))
		c.Fix = "Check that the proxy forwards POST requests on /api/auth/login to Atelier."
		return c
	}
	switch {
	case isBadOrigin(rep):
		c.Status = Fail
		c.Detail = fmt.Sprintf("POST %s answered %s to origin %s: sign-in would answer 'Cross-site request refused'", target, describeReply(rep), r.origin)
		c.Fix = r.originFix()
	case rep.status == http.StatusBadRequest && !looksLikeHTML(rep):
		c.Detail = fmt.Sprintf("POST %s answered %s: the origin %s is accepted", target, describeReply(rep), r.origin)
	default:
		c.Status = Warn
		c.Detail = fmt.Sprintf("POST %s answered %s", target, describeReply(rep))
		c.Fix = fmt.Sprintf("Sign-in answered %d where Atelier answers 400 to an empty request: check that the proxy forwards POST requests on /api/auth/login to Atelier.", rep.status)
	}
	return c
}
