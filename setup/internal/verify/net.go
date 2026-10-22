package verify

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	userAgent = "atelier-setup/verify"
	maxBody   = 8 << 10
)

var errRedirectLoop = errors.New("redirect loop")

// runner holds what the checks share: the parsed address and the HTTP transport.
type runner struct {
	ctx      context.Context
	timeout  time.Duration
	now      func() time.Time
	resolve  func(ctx context.Context, host string) ([]string, error)
	insecure bool

	parseErr error
	https    bool
	host     string // without brackets, lower case
	port     string // explicit or the scheme's default
	base     string // scheme://host[:port], default port omitted: how a browser writes it
	origin   string // the Origin header to send

	rt http.RoundTripper
	tr *http.Transport // rt, when it is one: the certificate check dials and verifies the same way

	// dialErr is set by the Certificate check when it could not reach the server at all, so the Server check reports
	// that instead of waiting for a second timeout.
	dialErr error
}

func newRunner(ctx context.Context, o Options) *runner {
	r := &runner{ctx: ctx, timeout: o.Timeout, now: o.Now, resolve: o.Resolver, insecure: o.InsecureTLS}
	if r.timeout <= 0 {
		r.timeout = 10 * time.Second
	}
	if r.now == nil {
		r.now = time.Now
	}
	if r.resolve == nil {
		r.resolve = net.DefaultResolver.LookupHost
	}
	r.parseErr = r.parse(o.PublicURL)
	if origin := strings.TrimRight(strings.TrimSpace(o.Origin), "/"); origin != "" {
		r.origin = origin
	}
	var base http.RoundTripper
	if o.HTTPClient != nil {
		base = o.HTTPClient.Transport
	}
	r.buildTransport(base)
	return r
}

func (r *runner) parse(raw string) error {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fmt.Errorf("%q is not a usable address", raw)
	}
	r.https = u.Scheme == "https"
	r.host = strings.ToLower(u.Hostname())
	r.port = u.Port()
	defaultPort := "80"
	if r.https {
		defaultPort = "443"
	}
	authority := r.host
	if strings.Contains(authority, ":") {
		authority = "[" + authority + "]"
	}
	if r.port == "" || r.port == defaultPort {
		r.port = defaultPort
	} else {
		authority = net.JoinHostPort(r.host, r.port)
	}
	r.base = u.Scheme + "://" + authority
	r.origin = r.base
	return nil
}

// buildTransport makes the transport every request goes through. An injected *http.Transport is cloned, so the
// caller's dialing and TLS roots apply but its settings are not changed. HTTP/2 is switched off: a browser opens a
// WebSocket over HTTP/1.1 upgrade or the extended CONNECT of HTTP/2, and this check is of the former.
func (r *runner) buildTransport(base http.RoundTripper) {
	var t *http.Transport
	switch b := base.(type) {
	case nil:
		// Direct connections: the proxy settings of this machine have no say in whether its own address works.
		t = &http.Transport{DialContext: (&net.Dialer{}).DialContext}
	case *http.Transport:
		if b == nil {
			t = &http.Transport{DialContext: (&net.Dialer{}).DialContext}
		} else {
			t = b.Clone()
		}
	default:
		r.rt = base
		return
	}
	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{}
	}
	t.TLSClientConfig.NextProtos = []string{"http/1.1"}
	if r.insecure {
		t.TLSClientConfig.InsecureSkipVerify = true
	} else if t.TLSClientConfig.InsecureSkipVerify {
		r.insecure = true // an injected client that skips verification: the Certificate check says Warn too
	}
	t.TLSClientConfig.Time = r.now
	t.ForceAttemptHTTP2 = false
	t.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	t.DisableKeepAlives = true
	r.rt, r.tr = t, t
}

// reply is what came back, with the body cut to a few KB.
type reply struct {
	status int
	header http.Header
	body   []byte
	final  *url.URL
}

// fetch sends one request. It follows redirects only when asked to, and treats a repeated address or ten hops
// as errRedirectLoop. A 101 response closes its connection right away.
func (r *runner) fetch(method, rawURL, body string, header http.Header, follow bool) (reply, error) {
	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return reply{}, err
	}
	for name, values := range header {
		req.Header[name] = values // keeps the spelling, as a browser sends Sec-WebSocket-Key
	}
	req.Header.Set("User-Agent", userAgent)
	client := &http.Client{Transport: r.rt, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if !follow {
			return http.ErrUseLastResponse
		}
		for _, earlier := range via {
			if earlier.URL.String() == next.URL.String() {
				return errRedirectLoop
			}
		}
		if len(via) >= 10 {
			return errRedirectLoop
		}
		return nil
	}}
	resp, err := client.Do(req)
	if err != nil {
		return reply{}, err
	}
	defer resp.Body.Close()
	rep := reply{status: resp.StatusCode, header: resp.Header, final: resp.Request.URL}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		rep.body, _ = io.ReadAll(io.LimitReader(resp.Body, maxBody))
	}
	return rep, nil
}

// ------------------------------------------------------------------ reading replies

func looksLikeHTML(rep reply) bool {
	if strings.Contains(strings.ToLower(rep.header.Get("Content-Type")), "text/html") {
		return true
	}
	head := strings.ToLower(strings.TrimSpace(string(rep.body[:min(len(rep.body), 512)])))
	for _, prefix := range []string{"<!doctype html", "<html", "<head", "<body"} {
		if strings.HasPrefix(head, prefix) {
			return true
		}
	}
	return false
}

// apiCode reads the code of Atelier's {"code":"…","message":"…"} error bodies.
func apiCode(rep reply) string {
	var e struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(rep.body, &e) != nil {
		return ""
	}
	return e.Code
}

// isBadOrigin: Atelier's refusal of an Origin it does not recognise, on /api/ws and on every sign-in route.
func isBadOrigin(rep reply) bool {
	if rep.status != http.StatusForbidden {
		return false
	}
	return apiCode(rep) == "bad_origin" || strings.Contains(string(rep.body), "bad_origin")
}

func bodyKind(rep reply) string {
	switch {
	case len(rep.body) == 0:
		return "an empty body"
	case looksLikeHTML(rep):
		return "an HTML page"
	case json.Valid(rep.body):
		return "JSON that is not Atelier's"
	}
	return "text that is not Atelier's"
}

// describeReply is the status and what the body was, for a Detail line.
func describeReply(rep reply) string {
	s := strconv.Itoa(rep.status)
	if code := apiCode(rep); code != "" {
		s += " " + code
	} else if len(rep.body) > 0 {
		s += " (" + bodyKind(rep) + ")"
	}
	if loc := rep.header.Get("Location"); loc != "" && rep.status >= 300 && rep.status < 400 {
		s += " to " + oneLine(loc, 120)
	}
	return s
}

func oneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if runes := []rune(s); len(runes) > limit {
		s = string(runes[:limit]) + "..."
	}
	return s
}

func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

func date(t time.Time) string { return t.UTC().Format("2006-01-02") }

// ------------------------------------------------------------------ reading errors

type failure int

const (
	failOther       failure = iota
	failUnreachable         // refused, no route, no such host for the dialer, dial timeout
	failTimeout             // connected, but no answer in time
	failClosed              // connected, then closed or reset without an answer
	failTLS                 // the TLS handshake or certificate
	failLoop                // redirects that never end
	failCancelled           // the caller gave up
)

func classify(err error) failure {
	if err == nil {
		return failOther
	}
	var oe *net.OpError
	var de *net.DNSError
	var ne net.Error
	msg := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, errRedirectLoop):
		return failLoop
	case errors.Is(err, context.Canceled):
		return failCancelled
	case isTLSError(err):
		return failTLS
	case errors.As(err, &oe) && oe.Op == "dial", errors.As(err, &de), errors.Is(err, syscall.ECONNREFUSED), strings.Contains(msg, "refused"):
		return failUnreachable
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return failTimeout
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE),
		strings.Contains(msg, "connection reset"), strings.Contains(msg, "broken pipe"), strings.Contains(msg, "closed"):
		return failClosed
	}
	return failOther
}

func isTLSError(err error) bool {
	var verify *tls.CertificateVerificationError
	var header tls.RecordHeaderError
	var alert tls.AlertError
	var unknown x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	if errors.As(err, &verify) || errors.As(err, &header) || errors.As(err, &alert) ||
		errors.As(err, &unknown) || errors.As(err, &invalid) || errors.As(err, &hostname) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "tls: ") || strings.Contains(msg, "x509: ")
}

// describe is a short reason for an error from the network: "connection refused", "no answer within 10s".
func describe(err error, timeout time.Duration) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var oe *net.OpError
	var ne net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "no answer within " + timeout.String()
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "the connection was closed without an answer"
	case errors.As(err, &oe) && oe.Err != nil:
		if oe.Timeout() {
			return "no answer within " + timeout.String()
		}
		inner := oe.Err
		var syscallErr *os.SyscallError
		if errors.As(inner, &syscallErr) {
			inner = syscallErr.Err
		}
		return inner.Error()
	case errors.As(err, &ne) && ne.Timeout():
		return "no answer within " + timeout.String()
	}
	return oneLine(err.Error(), 160)
}

// tlsFault explains a failed handshake or certificate check in words. notTLS: the other end does not speak TLS at
// all (a plain HTTP port reached with https://).
func tlsFault(err error, now time.Time) (reason string, notTLS bool) {
	var header tls.RecordHeaderError
	var unknown x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	switch {
	case errors.As(err, &header):
		return "the other end does not speak TLS", true
	case errors.As(err, &hostname):
		var names []string
		if c := hostname.Certificate; c != nil {
			names = append(names, c.DNSNames...)
			for _, ip := range c.IPAddresses {
				names = append(names, ip.String())
			}
			if len(names) == 0 && c.Subject.CommonName != "" {
				names = append(names, c.Subject.CommonName)
			}
		}
		if len(names) > 4 {
			names = append(names[:4], "...")
		}
		if len(names) == 0 {
			return "it is issued for another name than " + hostname.Host, false
		}
		return fmt.Sprintf("it is issued for %s, not %s", strings.Join(names, ", "), hostname.Host), false
	case errors.As(err, &invalid) && invalid.Reason == x509.Expired && invalid.Cert != nil:
		if now.Before(invalid.Cert.NotBefore) {
			return "not valid before " + date(invalid.Cert.NotBefore), false
		}
		return "expired on " + date(invalid.Cert.NotAfter), false
	case errors.As(err, &unknown):
		return "it is self-signed, or issued by an authority this computer does not trust", false
	}
	msg := err.Error()
	for _, prefix := range []string{"tls: failed to verify certificate: ", "x509: ", "tls: "} {
		msg = strings.TrimPrefix(msg, prefix)
	}
	return oneLine(msg, 160), false
}
