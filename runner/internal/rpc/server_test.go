package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

type frame struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
}

type harness struct {
	t      *testing.T
	srv    *Server
	in     *io.PipeWriter
	frames chan frame
	done   chan error
}

// newHarness builds a server; register handlers on h.srv, then call h.serve.
func newHarness(t *testing.T) *harness {
	t.Helper()
	outR, outW := io.Pipe()
	srv := NewServer(outW)
	srv.Initialize = Method(func(_ context.Context, p InitializeParams) (map[string]int, error) {
		if p.ProtocolVersion != ProtocolVersion {
			return nil, NewError(CodeVersionMismatch, "VersionMismatch", "mismatch")
		}
		return map[string]int{"protocolVersion": ProtocolVersion}, nil
	})
	h := &harness{t: t, srv: srv, frames: make(chan frame, 64), done: make(chan error, 1)}
	go func() {
		sc := bufio.NewScanner(outR)
		for sc.Scan() {
			var f frame
			if err := json.Unmarshal(sc.Bytes(), &f); err != nil {
				t.Errorf("server wrote a non-JSON line %q", sc.Text())
			}
			h.frames <- f
		}
	}()
	return h
}

func (h *harness) serve() {
	inR, inW := io.Pipe()
	h.in = inW
	go func() { h.done <- h.srv.Serve(inR) }()
	h.t.Cleanup(func() { _ = inW.Close() })
}

func (h *harness) send(line string) {
	h.t.Helper()
	if _, err := io.WriteString(h.in, line+"\n"); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) next() frame {
	h.t.Helper()
	select {
	case f := <-h.frames:
		return f
	case <-time.After(5 * time.Second):
		h.t.Fatal("no frame from the server")
		return frame{}
	}
}

func (h *harness) initialize() {
	h.t.Helper()
	h.send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"test","version":"0"}}}`)
	if f := h.next(); f.Error != nil {
		h.t.Fatalf("initialize: %+v", f.Error)
	}
}

func TestHandshake(t *testing.T) {
	h := newHarness(t)
	h.srv.Handle("echo", Method(func(_ context.Context, p map[string]string) (map[string]string, error) { return p, nil }))
	h.serve()

	h.send(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{}}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeNotInitialized {
		t.Fatalf("call before initialize: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":99}}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeVersionMismatch {
		t.Fatalf("version mismatch: %+v", f)
	}
	h.initialize()
	h.send(`{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":1}}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeInvalidRequest {
		t.Fatalf("second initialize: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":"s-4","method":"echo","params":{"a":"b"}}`)
	if f := h.next(); string(f.ID) != `"s-4"` || string(f.Result) != `{"a":"b"}` {
		t.Fatalf("echo with a string id: %+v", f)
	}
}

func TestErrors(t *testing.T) {
	h := newHarness(t)
	h.srv.Handle("typed", Method(func(_ context.Context, p struct{ N int }) (int, error) { return p.N, nil }))
	h.srv.Handle("panics", Method(func(context.Context, struct{}) (int, error) { panic("boom") }))
	h.srv.Handle("nil", Method(func(context.Context, struct{}) (any, error) { return nil, nil }))
	h.serve()
	h.initialize()

	h.send(`{not json`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeParseError || string(f.ID) != "null" {
		t.Fatalf("parse error: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":1,"method":"nope"}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeMethodNotFound {
		t.Fatalf("unknown method: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":2,"method":"typed","params":{"N":"not a number"}}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeInvalidParams {
		t.Fatalf("bad params: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":3,"method":"panics"}`)
	if f := h.next(); f.Error == nil || f.Error.Code != CodeInternal {
		t.Fatalf("panic: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","id":4,"method":"nil"}`)
	if f := h.next(); f.Error != nil || string(f.Result) != "null" {
		t.Fatalf("null result: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","method":"typed","params":{"N":1}}`) // a notification gets no reply
	h.send(`{"jsonrpc":"2.0","id":5,"method":"typed","params":{"N":5}}`)
	if f := h.next(); string(f.ID) != "5" || string(f.Result) != "5" {
		t.Fatalf("after a notification: %+v", f)
	}
}

func TestCancelConcurrencyAndShutdown(t *testing.T) {
	h := newHarness(t)
	started := make(chan struct{}, 4)
	h.srv.Handle("block", Method(func(ctx context.Context, _ struct{}) (int, error) {
		started <- struct{}{}
		<-ctx.Done()
		return 0, ctx.Err()
	}))
	h.srv.Handle("emit", Method(func(context.Context, struct{}) (int, error) {
		h.srv.Notify("note", map[string]int{"x": 1})
		return 1, nil
	}))
	h.serve()
	h.initialize()

	h.send(`{"jsonrpc":"2.0","id":1,"method":"block"}`)
	<-started
	// A blocked request does not hold up others; notifications precede the response that caused them.
	h.send(`{"jsonrpc":"2.0","id":2,"method":"emit"}`)
	if f := h.next(); f.Method != "note" || string(f.Params) != `{"x":1}` {
		t.Fatalf("notification: %+v", f)
	}
	if f := h.next(); string(f.ID) != "2" {
		t.Fatalf("concurrent request: %+v", f)
	}
	h.send(`{"jsonrpc":"2.0","method":"$/cancel","params":{"id":1}}`)
	if f := h.next(); string(f.ID) != "1" || f.Error == nil || f.Error.Code != CodeCancelled {
		t.Fatalf("cancel: %+v", f)
	}

	h.send(`{"jsonrpc":"2.0","id":3,"method":"block"}`)
	<-started
	h.send(`{"jsonrpc":"2.0","id":4,"method":"shutdown"}`)
	if f := h.next(); string(f.ID) != "3" || f.Error == nil || f.Error.Code != CodeCancelled {
		t.Fatalf("in-flight request on shutdown: %+v", f)
	}
	if f := h.next(); string(f.ID) != "4" || f.Error != nil || string(f.Result) != "null" {
		t.Fatalf("shutdown reply: %+v", f)
	}
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after shutdown")
	}
}
