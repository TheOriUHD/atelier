package verify

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ------------------------------------------------------------------ helpers

var checkNames = []string{CheckAddress, CheckCertificate, CheckServer, CheckWebSocket, CheckSignIn}

func dump(rep Report) string {
	var b strings.Builder
	for _, c := range rep.Checks {
		fmt.Fprintf(&b, "  %-28s %-8s %s\n", c.Name, c.Status, c.Detail)
		if c.Fix != "" {
			fmt.Fprintf(&b, "  %-28s %-8s fix: %s\n", "", "", c.Fix)
		}
	}
	return b.String()
}

// want checks the five statuses in order, and the rules every report keeps: names, one-line details, fixes only
// where something is wrong, and "skipped: " on every skipped check.
func want(t *testing.T, rep Report, statuses ...Status) {
	t.Helper()
	if len(rep.Checks) != len(checkNames) {
		t.Fatalf("got %d checks, want %d:\n%s", len(rep.Checks), len(checkNames), dump(rep))
	}
	for i, c := range rep.Checks {
		switch {
		case c.Name != checkNames[i]:
			t.Errorf("check %d is %q, want %q", i, c.Name, checkNames[i])
		case c.Detail == "" || strings.ContainsAny(c.Detail, "\r\n"):
			t.Errorf("%s: detail %q is not one line", c.Name, c.Detail)
		case (c.Status == Warn || c.Status == Fail) && c.Fix == "":
			t.Errorf("%s: %s without a fix", c.Name, c.Status)
		case (c.Status == Pass || c.Status == Skipped) && c.Fix != "":
			t.Errorf("%s: %s with a fix: %q", c.Name, c.Status, c.Fix)
		case c.Status == Skipped && !strings.HasPrefix(c.Detail, "skipped: "):
			t.Errorf("%s: skipped detail %q", c.Name, c.Detail)
		case strings.ContainsAny(c.Fix, "\r\n"):
			t.Errorf("%s: fix %q is not one line", c.Name, c.Fix)
		}
		if c.Status != statuses[i] {
			t.Errorf("%s is %s, want %s", c.Name, c.Status, statuses[i])
		}
	}
	if t.Failed() {
		t.Fatalf("report:\n%s", dump(rep))
	}
}

func contains(t *testing.T, got, sub string) {
	t.Helper()
	if !strings.Contains(got, sub) {
		t.Errorf("%q does not contain %q", got, sub)
	}
}

func at(when time.Time) func() time.Time { return func() time.Time { return when } }

const day = 24 * time.Hour

func hostPort(ts *httptest.Server) string { return ts.Listener.Addr().String() }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// ------------------------------------------------------------------ everything right

func TestEverythingRightBehindATLSProxy(t *testing.T) {
	f := &fakeAtelier{allowed: "https://example.com"}
	ts := startTLS(t, f, true) // the server offers HTTP/2: the WebSocket check must still use HTTP/1.1
	o := proxied(ts)
	o.Now = at(ts.Certificate().NotAfter.Add(-100 * day))

	rep := Run(context.Background(), o)
	want(t, rep, Pass, Pass, Pass, Pass, Pass)
	if !rep.OK() || len(rep.Failed()) != 0 {
		t.Errorf("OK=%v failed=%v", rep.OK(), rep.Failed())
	}
	if rep.Version != "0.1.11" {
		t.Errorf("version %q", rep.Version)
	}
	if got := rep.Summary(); got != "All 5 checks passed" {
		t.Errorf("summary %q", got)
	}
	if got := rep.Checks[2].Detail; got != "https://example.com/api/health answered 200, Atelier 0.1.11" {
		t.Errorf("health detail %q", got)
	}
	contains(t, rep.Checks[0].Detail, "example.com resolves to 192.0.2.10")
	contains(t, rep.Checks[1].Detail, "valid for 100 days more")

	hits, origin, proto, _ := f.seen("/api/ws")
	if hits != 1 || origin != "https://example.com" || proto != "HTTP/1.1" {
		t.Errorf("WebSocket request: %d hits, origin %q, %s", hits, origin, proto)
	}
	hits, origin, _, body := f.seen("/api/auth/login")
	if hits != 1 || origin != "https://example.com" || body != "{}" {
		t.Errorf("sign-in request: %d hits, origin %q, body %q (it must carry no credentials)", hits, origin, body)
	}
}

func TestEverythingRightOnTheLocalNetwork(t *testing.T) {
	f := &fakeAtelier{}
	ts := startPlain(t, f)

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Pass, Pass, Pass)
	contains(t, rep.Checks[0].Detail, "is an IP address")
	contains(t, rep.Checks[1].Detail, "plain http")
	if got := rep.Summary(); got != "All 4 checks passed" {
		t.Errorf("summary %q", got)
	}
	_, origin, _, _ := f.seen("/api/ws")
	if origin != ts.URL {
		t.Errorf("origin %q, want %q", origin, ts.URL)
	}
}

func TestExplicitOrigin(t *testing.T) {
	f := &fakeAtelier{allowed: "https://atelier.example.com"}
	ts := startPlain(t, f)

	rep := Run(context.Background(), Options{PublicURL: ts.URL, Origin: "https://atelier.example.com/"})
	want(t, rep, Pass, Skipped, Pass, Pass, Pass)
	if _, origin, _, _ := f.seen("/api/ws"); origin != "https://atelier.example.com" {
		t.Errorf("origin %q", origin)
	}
}

// ------------------------------------------------------------------ the address the server believes it has

func TestWrongOriginBehindATLSProxy(t *testing.T) {
	// The server was never told the public address (or was told another one): the page loads, then spins.
	for name, jsonRefusal := range map[string]bool{
		"the real server's bare 403 on an upgrade": false,
		"a 403 with the bad_origin JSON":           true,
	} {
		t.Run(name, func(t *testing.T) {
			f := &fakeAtelier{allowed: "http://atelier:7340", jsonRefusal: jsonRefusal}
			ts := startTLS(t, f, false)

			rep := Run(context.Background(), proxied(ts))
			want(t, rep, Pass, Pass, Pass, Fail, Fail)
			if rep.OK() {
				t.Error("OK with failures")
			}
			for _, c := range rep.Failed() {
				contains(t, c.Fix, "Atelier refused the browser's address (https://example.com). Set ATELIER_BASE_URL=https://example.com for the Atelier server and restart it.")
				contains(t, c.Fix, "put the reverse proxy's address in ATELIER_TRUSTED_PROXIES")
			}
			if jsonRefusal {
				contains(t, rep.Checks[3].Detail, "403 bad_origin")
			} else {
				contains(t, rep.Checks[3].Detail, "403 to origin https://example.com, but 101 without an Origin header")
				if hits, _, _, _ := f.seen("/api/ws"); hits != 2 {
					t.Errorf("%d upgrades, want the refused one and one without an Origin", hits)
				}
			}
			contains(t, rep.Checks[4].Detail, "403 bad_origin")
			contains(t, rep.Checks[4].Detail, "Cross-site request refused")
			if got := rep.Summary(); got != "2 checks failed: Live connection (WebSocket), Sign-in requests" {
				t.Errorf("summary %q", got)
			}
		})
	}
}

func TestFirewallThatRefusesEveryUpgrade(t *testing.T) {
	// A 403 that stays when the Origin is left out is not about the address.
	f := &fakeAtelier{override: map[string]http.HandlerFunc{"/api/ws": always(403)}}
	ts := startPlain(t, f)

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Pass, Fail, Pass)
	contains(t, rep.Checks[3].Fix, "Something in front of Atelier answered 403 to the WebSocket handshake")
	if strings.Contains(rep.Checks[3].Fix, "ATELIER_BASE_URL") {
		t.Errorf("blamed the address: %q", rep.Checks[3].Fix)
	}
	if hits, _, _, _ := f.seen("/api/ws"); hits != 2 {
		t.Errorf("%d upgrades, want the refused one and one without an Origin", hits)
	}
}

func TestProxyThatDropsTheUpgradeHeaderAnswersWithJSON(t *testing.T) {
	// Without the Upgrade header the request is no upgrade: Atelier answers it as a plain request, with the JSON body.
	drop := func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("Upgrade")
		f := &fakeAtelier{allowed: "https://elsewhere.example"}
		f.serveWebSocket(w, r)
	}
	ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/ws": drop}})

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Pass, Fail, Pass)
	contains(t, rep.Checks[3].Detail, "403 bad_origin")
	contains(t, rep.Checks[3].Fix, "Atelier refused the address "+ts.URL)
}

func TestWrongOriginOnPlainHTTP(t *testing.T) {
	f := &fakeAtelier{allowed: "http://atelier.lan:7340"}
	ts := startPlain(t, f)

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Pass, Fail, Fail)
	for _, c := range rep.Failed() {
		contains(t, c.Fix, "Atelier refused the address "+ts.URL)
		contains(t, c.Fix, "ATELIER_BASE_URL="+ts.URL)
		if strings.Contains(c.Fix, "ATELIER_TRUSTED_PROXIES") {
			t.Errorf("plain http has no TLS proxy to trust: %q", c.Fix)
		}
	}
}

// ------------------------------------------------------------------ the proxy in between

func TestWebSocketThroughAProxyThatGetsItWrong(t *testing.T) {
	html := func(status int) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { writeHTML(w, status) }
	}
	redirect := func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://other.example/api/ws", http.StatusMovedPermanently)
	}
	cases := []struct {
		name    string
		handler http.HandlerFunc
		fix     string
	}{
		{"an HTML page with 200", html(200), "The proxy answered with a web page instead of opening a WebSocket: enable WebSocket support (Nginx Proxy Manager: 'Websockets Support'; nginx: the Upgrade/Connection headers; Cloudflare: WebSockets on)."},
		{"400", always(400), "The proxy answered 400 instead of opening a WebSocket: enable WebSocket support"},
		{"426", always(426), "The proxy answered 426 instead of opening a WebSocket: enable WebSocket support"},
		{"501", always(501), "The proxy answered 501 instead of opening a WebSocket: enable WebSocket support"},
		{"404", always(404), "/api/ws is not forwarded: the proxy must pass every path to Atelier."},
		{"502", always(502), "The proxy answered 502: it cannot reach Atelier. Check the upstream address and port in the proxy's configuration."},
		{"503", always(503), "The proxy answered 503: it cannot reach Atelier."},
		{"504", always(504), "The proxy answered 504: it cannot reach Atelier."},
		{"401", always(401), "Something in front of Atelier answered 401 to the WebSocket handshake"},
		{"a redirect", redirect, "redirects the WebSocket to https://other.example/api/ws"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/ws": tc.handler}})
			rep := Run(context.Background(), Options{PublicURL: ts.URL})
			want(t, rep, Pass, Skipped, Pass, Fail, Pass) // the rest of the server is fine
			contains(t, rep.Checks[3].Fix, tc.fix)
		})
	}
}

func TestWebSocketCutDuringTheHandshake(t *testing.T) {
	cut := func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}
	ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/ws": cut}})

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Pass, Fail, Pass)
	contains(t, rep.Checks[3].Fix, "The connection was cut during the WebSocket handshake")
	contains(t, rep.Checks[3].Fix, "enable WebSocket support")
}

func TestProxyCannotReachAtelier(t *testing.T) {
	for _, status := range []int{502, 503, 504} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := &fakeAtelier{override: map[string]http.HandlerFunc{
				"/api/health": always(status), "/api/ws": always(status), "/api/auth/login": always(status),
			}}
			ts := startPlain(t, f)

			rep := Run(context.Background(), Options{PublicURL: ts.URL})
			want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
			contains(t, rep.Checks[2].Fix, fmt.Sprintf("The proxy answered %d: it cannot reach Atelier. Check the upstream address and port in the proxy's configuration.", status))
			contains(t, rep.Checks[3].Detail, "skipped: the server did not answer as Atelier")
			if hits, _, _, _ := f.seen("/api/ws"); hits != 0 {
				t.Errorf("the WebSocket was tried %d times although the server did not answer", hits)
			}
			if hits, _, _, _ := f.seen("/api/auth/login"); hits != 0 {
				t.Errorf("sign-in was tried %d times although the server did not answer", hits)
			}
		})
	}
}

func TestSomethingElseAnswers(t *testing.T) {
	json := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, body) }
	}
	cases := []struct {
		name    string
		handler http.HandlerFunc
		detail  string
		fix     string
	}{
		{"another app's JSON", json(`{"ok":true,"app":"grafana"}`), "JSON that is not Atelier's", "is not served by Atelier. Check the proxy's host name and upstream."},
		{"a web page", func(w http.ResponseWriter, r *http.Request) { writeHTML(w, 200) }, "an HTML page", "is not served by Atelier. Check the proxy's host name and upstream."},
		{"404", always(404), "404", "is not served by Atelier. Check the proxy's host name and upstream."},
		{"a login in front", always(401), "401", "Something in front of Atelier answered 401"},
		{"a 500", always(500), "500", "answered 500: look at the proxy's log and Atelier's log"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeAtelier{override: map[string]http.HandlerFunc{"/api/health": tc.handler}}
			ts := startPlain(t, f)

			rep := Run(context.Background(), Options{PublicURL: ts.URL})
			want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
			contains(t, rep.Checks[2].Detail, tc.detail)
			contains(t, rep.Checks[2].Fix, tc.fix)
			if rep.Version != "" {
				t.Errorf("version %q from something that is not Atelier", rep.Version)
			}
		})
	}
}

func TestRedirectsThatNeverEnd(t *testing.T) {
	hops := 0
	loops := map[string]http.HandlerFunc{
		"to itself": func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/api/health", http.StatusFound) },
		// Never the same address twice, so only the limit on the number of hops ends it.
		"a new address every time": func(w http.ResponseWriter, r *http.Request) {
			hops++
			http.Redirect(w, r, fmt.Sprintf("/api/health?hop=%d", hops), http.StatusFound)
		},
	}
	for name, handler := range loops {
		t.Run(name, func(t *testing.T) {
			ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/health": handler}})
			rep := Run(context.Background(), Options{PublicURL: ts.URL})
			want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
			contains(t, rep.Checks[2].Fix, "redirects in a loop")
		})
	}
}

func TestRedirectToAnotherAddress(t *testing.T) {
	target := startPlain(t, &fakeAtelier{})
	redirect := func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/api/health", http.StatusMovedPermanently)
	}
	ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/health": redirect}})

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Warn, Pass, Pass)
	contains(t, rep.Checks[2].Fix, ts.URL+" redirects to "+target.URL)
	contains(t, rep.Checks[2].Fix, "ATELIER_BASE_URL")
	if rep.Version != "0.1.11" {
		t.Errorf("version %q", rep.Version)
	}
	if !rep.OK() {
		t.Error("a warning must not fail the report")
	}
}

// ------------------------------------------------------------------ nothing answers

func TestConnectionRefused(t *testing.T) {
	addr := closedPort(t)

	t.Run("http", func(t *testing.T) {
		rep := Run(context.Background(), Options{PublicURL: "http://" + addr})
		want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
		contains(t, rep.Checks[2].Fix, "Nothing answers at http://"+addr+": check that the proxy is running, forwards to Atelier's port, and that firewalls allow it.")
		contains(t, rep.Checks[2].Detail, "connection refused")
	})
	t.Run("https", func(t *testing.T) {
		rep := Run(context.Background(), Options{PublicURL: "https://" + addr, InsecureTLS: true})
		want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
		contains(t, rep.Checks[1].Detail, "skipped: cannot connect to "+addr)
		contains(t, rep.Checks[2].Fix, "Nothing answers at https://"+addr)
	})
}

func TestServerThatNeverAnswers(t *testing.T) {
	hang := func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}
	ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/health": hang}})

	rep := Run(context.Background(), Options{PublicURL: ts.URL, Timeout: 150 * time.Millisecond})
	want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
	contains(t, rep.Checks[2].Fix, "Nothing answers at "+ts.URL)
	contains(t, rep.Checks[2].Detail, "no answer within 150ms")
}

func TestConnectionClosedWithoutAnAnswer(t *testing.T) {
	drop := func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}
	ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/health": drop}})

	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Skipped, Fail, Skipped, Skipped)
	contains(t, rep.Checks[2].Fix, "accepts the connection but closes it without answering")
}

// ------------------------------------------------------------------ DNS

func TestAddressDoesNotResolve(t *testing.T) {
	network := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("a request was sent to %s although the name does not resolve", r.URL)
		return nil, errors.New("unexpected")
	})}
	cases := map[string]struct {
		err error
		fix string
	}{
		"no such host": {&net.DNSError{Err: "no such host", Name: "atelier.example.com", IsNotFound: true},
			"Create a DNS record for atelier.example.com that points at this machine's public address (or your reverse proxy's)."},
		"another error": {errors.New("lookup failed"),
			"Create a DNS record for atelier.example.com that points at this machine's public address (or your reverse proxy's)."},
		"no addresses": {nil,
			"Create a DNS record for atelier.example.com that points at this machine's public address (or your reverse proxy's)."},
		"the lookup itself times out": {&net.DNSError{Err: "i/o timeout", Name: "atelier.example.com", IsTimeout: true},
			"This computer could not look up atelier.example.com just now: check its network connection and DNS settings."},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			calls := 0
			rep := Run(context.Background(), Options{
				PublicURL:  "https://atelier.example.com",
				HTTPClient: network,
				Resolver: func(_ context.Context, host string) ([]string, error) {
					calls++
					if host != "atelier.example.com" {
						t.Errorf("looked up %q", host)
					}
					return nil, tc.err
				},
			})
			want(t, rep, Fail, Skipped, Skipped, Skipped, Skipped)
			if rep.Checks[0].Fix != tc.fix {
				t.Errorf("fix %q, want %q", rep.Checks[0].Fix, tc.fix)
			}
			if calls != 1 {
				t.Errorf("%d lookups", calls)
			}
			contains(t, rep.Checks[1].Detail, "skipped: the address does not resolve")
			if got := rep.Summary(); got != "1 check failed: Address resolves" {
				t.Errorf("summary %q", got)
			}
		})
	}
}

func TestAddressIsNotUsable(t *testing.T) {
	for _, address := range []string{"", "atelier.example.com", "ftp://atelier.example.com", "localhost:7340", "https://", "http://[::1"} {
		t.Run(address, func(t *testing.T) {
			rep := Run(context.Background(), Options{PublicURL: address})
			want(t, rep, Fail, Skipped, Skipped, Skipped, Skipped)
			contains(t, rep.Checks[0].Fix, "Enter the public address with its scheme")
			contains(t, rep.Checks[1].Detail, "skipped: the address is not usable")
		})
	}
}

// ------------------------------------------------------------------ certificates

func TestCertificateExpiresSoon(t *testing.T) {
	cases := []struct {
		left time.Duration
		in   string
	}{
		{5 * day, "in 5 days"},
		{day + time.Hour, "in 1 day"},
		{3 * time.Hour, "in less than a day"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			f := &fakeAtelier{allowed: "https://example.com"}
			ts := startTLS(t, f, false)
			o := proxied(ts)
			o.Now = at(ts.Certificate().NotAfter.Add(-tc.left))

			rep := Run(context.Background(), o)
			want(t, rep, Pass, Warn, Pass, Pass, Pass) // the address works; it only needs attention
			contains(t, rep.Checks[1].Detail, "expires "+tc.in)
			contains(t, rep.Checks[1].Fix, "The certificate for example.com expires "+tc.in+": check that the proxy renews it automatically.")
			if !rep.OK() {
				t.Error("a warning must not fail the report")
			}
			if got := rep.Summary(); got != "All 5 checks passed (1 with a warning)" {
				t.Errorf("summary %q", got)
			}
		})
	}
}

func TestCertificateNotValid(t *testing.T) {
	cert := func(ts *httptest.Server) (before, after time.Time) {
		return ts.Certificate().NotBefore, ts.Certificate().NotAfter
	}
	cases := []struct {
		name   string
		tweak  func(o *Options, ts *httptest.Server)
		reason string
	}{
		{"expired", func(o *Options, ts *httptest.Server) {
			_, after := cert(ts)
			o.Now = at(after.Add(2 * day))
		}, "expired on 2084-01-29"},
		{"not yet valid", func(o *Options, ts *httptest.Server) {
			before, _ := cert(ts)
			o.Now = at(before.Add(-day))
		}, "not valid before 1970-01-01"},
		{"issued for another name", func(o *Options, ts *httptest.Server) {
			o.PublicURL = "https://wiki.example.org"
		}, "it is issued for example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeAtelier{allowed: "https://example.com"}
			ts := startTLS(t, f, false)
			o := proxied(ts)
			tc.tweak(&o, ts)

			rep := Run(context.Background(), o)
			want(t, rep, Pass, Fail, Skipped, Skipped, Skipped)
			host := strings.TrimPrefix(o.PublicURL, "https://")
			contains(t, rep.Checks[1].Fix, fmt.Sprintf("The certificate for %s is not valid (", host))
			contains(t, rep.Checks[1].Fix, tc.reason)
			contains(t, rep.Checks[1].Fix, "): check the proxy's certificate configuration.")
			contains(t, rep.Checks[2].Detail, "skipped: the certificate check failed")
			if hits, _, _, _ := f.seen("/api/health"); hits != 0 {
				t.Errorf("the server was asked %d times although a browser would refuse the certificate", hits)
			}
		})
	}
}

func TestCertificateNotTrusted(t *testing.T) {
	f := &fakeAtelier{}
	ts := startTLS(t, f, false)

	// The default client trusts the system's authorities only, and the test server's certificate is self-signed.
	rep := Run(context.Background(), Options{PublicURL: ts.URL})
	want(t, rep, Pass, Fail, Skipped, Skipped, Skipped)
	contains(t, rep.Checks[1].Fix, "is not valid (")
	if hits, _, _, _ := f.seen("/api/health"); hits != 0 {
		t.Errorf("the server was asked %d times", hits)
	}

	// The wizard's own tests accept it, with a warning, and everything else is checked as usual.
	rep = Run(context.Background(), Options{PublicURL: ts.URL, InsecureTLS: true})
	want(t, rep, Pass, Warn, Pass, Pass, Pass)
	if got := rep.Checks[1].Detail; got != "self-signed or untrusted certificate (accepted for this test)" {
		t.Errorf("detail %q", got)
	}
	if !rep.OK() {
		t.Error("an accepted self-signed certificate must not fail the report")
	}
	if _, _, proto, _ := f.seen("/api/ws"); proto != "HTTP/1.1" {
		t.Errorf("WebSocket over %s", proto)
	}
}

func TestInsecureTLSStillForcesHTTP1(t *testing.T) {
	f := &fakeAtelier{}
	ts := startTLS(t, f, true)

	rep := Run(context.Background(), Options{PublicURL: ts.URL, InsecureTLS: true})
	want(t, rep, Pass, Warn, Pass, Pass, Pass)
	for _, path := range []string{"/api/health", "/api/ws", "/api/auth/login"} {
		if _, _, proto, _ := f.seen(path); proto != "HTTP/1.1" {
			t.Errorf("%s over %s", path, proto)
		}
	}
}

func TestHTTPSToAPlainHTTPPort(t *testing.T) {
	ts := startPlain(t, &fakeAtelier{})
	address := hostPort(ts)

	rep := Run(context.Background(), Options{PublicURL: "https://" + address, InsecureTLS: true})
	want(t, rep, Pass, Fail, Skipped, Skipped, Skipped)
	contains(t, rep.Checks[1].Fix, address+" does not answer HTTPS: use http:// in the address")
}

// ------------------------------------------------------------------ sign-in

func TestSignInAnswersSomethingElse(t *testing.T) {
	cases := map[string]struct {
		handler http.HandlerFunc
		status  string
	}{
		"500":              {always(500), "500"},
		"a 400 web page":   {func(w http.ResponseWriter, r *http.Request) { writeHTML(w, 400) }, "400"},
		"a redirect":       {func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/login", 302) }, "302"},
		"405 from a proxy": {always(405), "405"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			ts := startPlain(t, &fakeAtelier{override: map[string]http.HandlerFunc{"/api/auth/login": tc.handler}})
			rep := Run(context.Background(), Options{PublicURL: ts.URL})
			want(t, rep, Pass, Skipped, Pass, Pass, Warn)
			contains(t, rep.Checks[4].Fix, "Sign-in answered "+tc.status)
			contains(t, rep.Checks[4].Detail, tc.status)
			if !rep.OK() {
				t.Error("a warning must not fail the report")
			}
		})
	}
}

// ------------------------------------------------------------------ cancellation

func TestCancelledRunIsNotAPass(t *testing.T) {
	f := &fakeAtelier{}
	ts := startPlain(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	rep := Run(ctx, Options{PublicURL: ts.URL})
	want(t, rep, Fail, Skipped, Skipped, Skipped, Skipped)
	if rep.OK() {
		t.Error("a run that was cancelled before it began reports OK")
	}
	if rep.Checks[0].Fix != cancelledFix {
		t.Errorf("fix %q", rep.Checks[0].Fix)
	}
	if hits, _, _, _ := f.seen("/api/health"); hits != 0 {
		t.Errorf("%d requests after cancellation", hits)
	}
}

// ------------------------------------------------------------------ report helpers

func TestStatusStrings(t *testing.T) {
	for status, want := range map[Status]string{Pass: "pass", Warn: "warn", Fail: "fail", Skipped: "skipped", Status(9): "status(9)"} {
		if got := status.String(); got != want {
			t.Errorf("%d is %q, want %q", int(status), got, want)
		}
	}
}

func TestReportSummary(t *testing.T) {
	check := func(name string, status Status) Check { return Check{Name: name, Status: status} }
	cases := []struct {
		name   string
		checks []Check
		want   string
		ok     bool
	}{
		{"nothing ran", nil, "No checks ran", true},
		{"all passed", []Check{check("a", Pass), check("b", Pass), check("c", Pass), check("d", Pass), check("e", Pass)}, "All 5 checks passed", true},
		{"skipped ones do not count", []Check{check("a", Pass), check("b", Skipped), check("c", Pass)}, "All 2 checks passed", true},
		{"one warning", []Check{check("a", Pass), check("b", Warn), check("c", Pass)}, "All 3 checks passed (1 with a warning)", true},
		{"two warnings", []Check{check("a", Warn), check("b", Warn), check("c", Pass)}, "All 3 checks passed (2 with a warning)", true},
		{"one failed", []Check{check("a", Pass), check("Certificate", Fail), check("c", Skipped)}, "1 check failed: Certificate", false},
		{"two failed", []Check{check("a", Pass), check("Live connection (WebSocket)", Fail), check("Sign-in requests", Fail)}, "2 checks failed: Live connection (WebSocket), Sign-in requests", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := Report{Checks: tc.checks}
			if got := rep.Summary(); got != tc.want {
				t.Errorf("summary %q, want %q", got, tc.want)
			}
			if rep.OK() != tc.ok {
				t.Errorf("OK %v", rep.OK())
			}
		})
	}
	rep := Report{Checks: []Check{check("a", Fail), check("b", Pass), check("c", Fail)}}
	if failed := rep.Failed(); len(failed) != 2 || failed[0].Name != "a" || failed[1].Name != "c" {
		t.Errorf("Failed() %v", failed)
	}
}
