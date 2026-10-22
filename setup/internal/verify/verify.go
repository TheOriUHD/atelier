// Package verify tests the public address of an Atelier server the way a browser would, and turns every failure
// into one plain sentence that names the setting to change.
//
// The checks exist because a server can be perfectly healthy while the page spins forever: the browser's
// WebSocket to /api/ws is refused with HTTP 403 {"code":"bad_origin"} when the address in the browser's bar is not
// the one Atelier believes it has (ATELIER_BASE_URL, ATELIER_TRUSTED_PROXIES), or the proxy in between does not pass
// WebSocket upgrades at all. The wizard runs Run after an install, and `atelier-setup doctor` runs it on demand.
//
// Run never sends credentials: the sign-in probe posts an empty JSON object, which Atelier answers with 400 and
// which can therefore never log anybody in.
package verify

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Status is the outcome of one check.
type Status int

const (
	Pass Status = iota
	Warn
	Fail
	Skipped
)

func (s Status) String() string {
	switch s {
	case Pass:
		return "pass"
	case Warn:
		return "warn"
	case Fail:
		return "fail"
	case Skipped:
		return "skipped"
	}
	return "status(" + strconv.Itoa(int(s)) + ")"
}

// The names of the checks, in the order Run reports them.
const (
	CheckAddress     = "Address resolves"
	CheckCertificate = "Certificate"
	CheckServer      = "Server answers"
	CheckWebSocket   = "Live connection (WebSocket)"
	CheckSignIn      = "Sign-in requests"
)

// Check is one line of a report.
type Check struct {
	Name   string
	Status Status
	// Detail is what was observed, on one line.
	Detail string
	// Fix is one plain instruction naming the setting or place to change. Empty on Pass and Skipped.
	Fix string
}

// Report is the result of Run. It always lists all five checks, in order; checks that could not run because an
// earlier one failed are Skipped.
type Report struct {
	Checks []Check
	// Version is the server's version when /api/health answered as Atelier.
	Version string
}

// OK reports whether no check failed. Warnings and skipped checks do not count against it.
func (r Report) OK() bool { return len(r.Failed()) == 0 }

// Failed lists the checks that failed, in order.
func (r Report) Failed() []Check {
	var failed []Check
	for _, c := range r.Checks {
		if c.Status == Fail {
			failed = append(failed, c)
		}
	}
	return failed
}

// Summary is one line: "All 5 checks passed" or "2 checks failed: Live connection (WebSocket), Sign-in requests".
func (r Report) Summary() string {
	if failed := r.Failed(); len(failed) > 0 {
		names := make([]string, len(failed))
		for i, c := range failed {
			names[i] = c.Name
		}
		noun := "checks"
		if len(failed) == 1 {
			noun = "check"
		}
		return fmt.Sprintf("%d %s failed: %s", len(failed), noun, strings.Join(names, ", "))
	}
	ran, warned := 0, 0
	for _, c := range r.Checks {
		if c.Status != Skipped {
			ran++
		}
		if c.Status == Warn {
			warned++
		}
	}
	var s string
	switch ran {
	case 0:
		return "No checks ran"
	case 1:
		s = "The check passed"
	default:
		s = fmt.Sprintf("All %d checks passed", ran)
	}
	switch warned {
	case 0:
	case 1:
		s += " (1 with a warning)"
	default:
		s += fmt.Sprintf(" (%d with a warning)", warned)
	}
	return s
}

// Options says what to test.
type Options struct {
	// PublicURL is the address people use: "https://atelier.example.com", or "http://192.168.1.20:7340" in LAN mode.
	// Only its scheme, host and port count.
	PublicURL string
	// Origin is the Origin header to send, the address a browser would show in its bar. Default: the origin of PublicURL.
	Origin string
	// Timeout limits each request, DNS lookup and TLS handshake. Default 10 seconds.
	Timeout time.Duration
	// InsecureTLS accepts certificates that are self-signed or from an authority this computer does not trust (the
	// wizard's own tests). The Certificate check then says Warn instead of Fail.
	InsecureTLS bool
	// HTTPClient supplies the network behaviour: only its Transport is used (its dialing, TLS roots and proxy
	// settings), forced to HTTP/1.1, which is what a WebSocket handshake needs. Redirects and timeouts are handled by
	// the checks themselves. Optional; tests inject one. Default: direct connections with the system resolver and roots.
	HTTPClient *http.Client
	// Resolver looks up a host name for the first check. Default net.DefaultResolver.LookupHost.
	Resolver func(ctx context.Context, host string) ([]string, error)
	// Now is the clock for certificate expiry. Default time.Now.
	Now func() time.Time
}

// cancelledFix replaces the usual fix when the caller gave up: no setting is to blame.
const cancelledFix = "The checks were interrupted: run them again."

// Run performs the five checks in order. A failed check makes the ones that depend on it Skipped:
// an address that does not resolve skips everything after it, an invalid certificate skips the requests (a browser
// would refuse them), and a server that does not answer as Atelier skips the WebSocket and sign-in checks. The
// WebSocket and sign-in checks do not depend on each other.
func Run(ctx context.Context, o Options) Report {
	r := newRunner(ctx, o)
	var rep Report

	step := func(name string, f func() Check) Check {
		var c Check
		if err := ctx.Err(); err != nil {
			c = Check{Name: name, Status: Fail, Detail: "cancelled before it ran: " + err.Error()}
		} else {
			c = f()
		}
		if c.Status == Fail && ctx.Err() != nil {
			c.Fix = cancelledFix
		}
		rep.Checks = append(rep.Checks, c)
		return c
	}
	skip := func(why string, names ...string) {
		for _, name := range names {
			rep.Checks = append(rep.Checks, Check{Name: name, Status: Skipped, Detail: "skipped: " + why})
		}
	}

	if step(CheckAddress, r.checkAddress).Status == Fail {
		why := "the address does not resolve"
		if r.parseErr != nil {
			why = "the address is not usable"
		}
		skip(why, CheckCertificate, CheckServer, CheckWebSocket, CheckSignIn)
		return rep
	}
	if step(CheckCertificate, r.checkCertificate).Status == Fail {
		skip("the certificate check failed", CheckServer, CheckWebSocket, CheckSignIn)
		return rep
	}
	server := step(CheckServer, func() Check {
		c, version := r.checkServer()
		rep.Version = version
		return c
	})
	if server.Status == Fail {
		skip("the server did not answer as Atelier", CheckWebSocket, CheckSignIn)
		return rep
	}
	step(CheckWebSocket, r.checkWebSocket)
	step(CheckSignIn, r.checkSignIn)
	return rep
}
