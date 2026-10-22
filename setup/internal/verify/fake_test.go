package verify

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAtelier answers like the real server's routes, as far as the checks can tell: /api/health, /api/ws (101 for
// the origin it believes it has, a refusal for any other), and /api/auth/login (400 invalid_input, or 403 bad_origin).
// It also refuses requests that no browser would send, so a check that is sloppy about the handshake fails here
// instead of passing.
//
// The real server (checked against apps/server/dist) answers a refused upgrade with a bare "403 Forbidden" and
// Content-Length: 0, and the JSON body {"code":"bad_origin"} only when the request is no upgrade (a proxy that
// dropped the Upgrade header). That is the default here; jsonRefusal gives the JSON body on upgrades too.
type fakeAtelier struct {
	// allowed is the origin the server believes it has (ATELIER_BASE_URL). Empty: its own address.
	allowed string
	// jsonRefusal: refuse an upgrade with the bad_origin JSON instead of a bare 403.
	jsonRefusal bool
	// override replaces the handler of a path, to play a proxy that misbehaves.
	override map[string]http.HandlerFunc

	mu     sync.Mutex
	hits   map[string]int
	origin map[string]string // the Origin header last seen per path
	proto  map[string]string // the HTTP version last seen per path
	body   map[string]string // the request body last seen per path
}

func (f *fakeAtelier) record(r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hits == nil {
		f.hits, f.origin, f.proto, f.body = map[string]int{}, map[string]string{}, map[string]string{}, map[string]string{}
	}
	f.hits[r.URL.Path]++
	f.origin[r.URL.Path] = r.Header.Get("Origin")
	f.proto[r.URL.Path] = r.Proto
	f.body[r.URL.Path] = string(body)
}

func (f *fakeAtelier) seen(path string) (hits int, origin, proto, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits[path], f.origin[path], f.proto[path], f.body[path]
}

func (f *fakeAtelier) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.record(r)
	if h := f.override[r.URL.Path]; h != nil {
		h(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/health":
		writeJSON(w, 200, `{"ok":true,"app":"atelier","version":"0.1.11"}`)
	case "/api/ws":
		f.serveWebSocket(w, r)
	case "/api/auth/login":
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			writeJSON(w, 405, `{"code":"method_not_allowed"}`)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != f.allowed {
			writeJSON(w, 403, `{"code":"bad_origin","message":"Cross-site request refused."}`)
			return
		}
		writeJSON(w, 400, `{"code":"invalid_input","message":"Required"}`)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeAtelier) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" && o != f.allowed {
		hijacker, canHijack := w.(http.Hijacker)
		if f.jsonRefusal || !canHijack || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			writeJSON(w, 403, `{"code":"bad_origin","message":"Cross-site WebSocket refused."}`)
			return
		}
		if conn, _, err := hijacker.Hijack(); err == nil {
			io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
			conn.Close()
		}
		return
	}
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	hijacker, canHijack := w.(http.Hijacker)
	switch {
	case r.ProtoMajor != 1 || !canHijack:
		writeJSON(w, 500, `{"code":"http2","message":"a WebSocket upgrade needs HTTP/1.1"}`)
		return
	case r.Method != http.MethodGet,
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket"),
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade"),
		r.Header.Get("Sec-WebSocket-Version") != "13",
		err != nil || len(key) != 16:
		writeJSON(w, 400, `{"code":"bad_handshake"}`)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		base64.StdEncoding.EncodeToString(sum[:]))
	rw.Flush()
	// The check closes the connection at once; do not linger if it does not.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	io.Copy(io.Discard, conn)
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	io.WriteString(w, body)
}

func writeHTML(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, "<!doctype html><html><body>Welcome to nginx!</body></html>")
}

func always(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { http.Error(w, http.StatusText(status), status) }
}

// startPlain serves f over plain HTTP at 127.0.0.1.
func startPlain(t *testing.T, f *fakeAtelier) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(f)
	if f.allowed == "" {
		f.allowed = "http://" + ts.Listener.Addr().String()
	}
	ts.Start()
	t.Cleanup(ts.Close)
	return ts
}

// startTLS serves f over TLS with httptest's self-signed certificate (valid for example.com, 127.0.0.1 and ::1 until 2084).
func startTLS(t *testing.T, f *fakeAtelier, http2 bool) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(f)
	ts.EnableHTTP2 = http2
	ts.Config.ErrorLog = log.New(io.Discard, "", 0)
	if f.allowed == "" {
		f.allowed = "https://" + ts.Listener.Addr().String()
	}
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts
}

// proxied returns options for https://example.com as a reverse proxy would present it: the name resolves, the
// certificate is trusted, and every connection ends up at ts. Pass the fake the origin "https://example.com".
func proxied(ts *httptest.Server) Options {
	transport := ts.Client().Transport.(*http.Transport).Clone()
	address := ts.Listener.Addr().String()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	return Options{
		PublicURL:  "https://example.com",
		HTTPClient: &http.Client{Transport: transport},
		Resolver:   func(context.Context, string) ([]string, error) { return []string{"192.0.2.10"}, nil },
	}
}

// closedPort is an address nothing listens on.
func closedPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}
