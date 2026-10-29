package rpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"atelier.dev/computer-windows/internal/proto"
)

// lines is a fake stdout.
type lines struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lines) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	text := l.buf.String()
	if text == "" {
		return nil
	}
	return strings.SplitAfter(strings.TrimSuffix(text, "\n"), "\n")
}

// messages waits for at least n lines and decodes them, checking one object per line.
func messages(t *testing.T, l *lines, n int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(l.all()) < n && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	var out []map[string]any
	for _, line := range l.all() {
		line = strings.TrimSuffix(line, "\n")
		if strings.Contains(line, "\n") {
			t.Fatalf("a newline inside a message: %q", line)
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		out = append(out, m)
	}
	return out
}

func code(m map[string]any) int {
	e, ok := m["error"].(map[string]any)
	if !ok {
		return 0
	}
	return int(e["code"].(float64))
}

func fakeServer(t *testing.T) (*Server, *lines) {
	l := &lines{}
	s := NewServer(NewOutput(l))
	s.OnInitialize(func(Params) (any, error) { return proto.Empty{}, nil })
	s.Receive([]byte(`{"id":0,"method":"initialize"}`))
	return s, l
}

func TestFraming(t *testing.T) {
	s, l := fakeServer(t)
	s.Register("echo", Inline, func(p Params) (any, error) { return p.fields, nil })
	s.Receive([]byte("this is not json"))
	s.Receive([]byte("[1,2]"))
	s.Receive([]byte(`{"id":{"x":1},"method":"echo"}`))
	s.Receive([]byte(`{"id":3}`))
	s.Receive([]byte(`{"method":"echo","params":{}}`)) // A notification: no answer.
	s.Receive([]byte(`{"id":null,"method":"echo"}`))   // Also a notification.
	s.Receive([]byte("   "))
	s.Receive([]byte(`{"id":"s-1","method":"echo","params":{"a":[1,2.5,"x",true,null]}}`))
	s.Receive([]byte(`{"id":4,"method":"echo","params":[1,2]}`))
	s.Receive([]byte(`{"id":12345678901,"method":"echo"}`))
	all := messages(t, l, 8)
	if len(all) != 8 {
		t.Fatalf("got %d messages, want 8 (initialize + 7)", len(all))
	}
	if code(all[1]) != proto.ParseError || all[1]["id"] != nil {
		t.Errorf("not JSON: %v", all[1])
	}
	if code(all[2]) != proto.InvalidRequest {
		t.Errorf("an array: %v", all[2])
	}
	if code(all[3]) != proto.InvalidRequest || all[3]["id"] != nil {
		t.Errorf("an object id: %v", all[3])
	}
	if code(all[4]) != proto.InvalidRequest || all[4]["id"] != float64(3) {
		t.Errorf("no method: %v", all[4])
	}
	if all[5]["id"] != "s-1" || all[5]["jsonrpc"] != "2.0" {
		t.Errorf("echo: %v", all[5])
	}
	echoed := all[5]["result"].(map[string]any)["a"].([]any)
	if len(echoed) != 5 || echoed[1] != 2.5 {
		t.Errorf("echoed params: %v", echoed)
	}
	if code(all[6]) != proto.InvalidParams || all[6]["id"] != float64(4) {
		t.Errorf("params as an array: %v", all[6])
	}
	if !strings.Contains(l.all()[7], `"id":12345678901`) {
		t.Errorf("a big id is echoed as it was: %s", l.all()[7])
	}
}

func TestNotInitializedAndInitializeOnce(t *testing.T) {
	l := &lines{}
	s := NewServer(NewOutput(l))
	calls := 0
	s.OnInitialize(func(p Params) (any, error) {
		calls++
		if _, err := p.Int("protocolVersion"); err != nil {
			return nil, err
		}
		return proto.Empty{}, nil
	})
	s.Register("x", Inline, func(Params) (any, error) { return proto.Empty{}, nil })
	s.Receive([]byte(`{"id":1,"method":"x"}`))
	s.Receive([]byte(`{"id":2,"method":"nope"}`))
	s.Receive([]byte(`{"id":3,"method":"initialize"}`)) // Missing its params: refused, still uninitialized.
	s.Receive([]byte(`{"id":4,"method":"x"}`))
	s.Receive([]byte(`{"id":5,"method":"initialize","params":{"protocolVersion":1}}`))
	s.Receive([]byte(`{"id":6,"method":"initialize","params":{"protocolVersion":1}}`))
	s.Receive([]byte(`{"id":7,"method":"nope"}`))
	all := messages(t, l, 7)
	want := []int{proto.NotInitialized, proto.NotInitialized, proto.InvalidParams, proto.NotInitialized, 0, proto.InvalidRequest, proto.MethodNotFound}
	for i, w := range want {
		if code(all[i]) != w {
			t.Errorf("message %d: code %d, want %d: %v", i, code(all[i]), w, all[i])
		}
	}
	if calls != 2 {
		t.Errorf("initialize ran %d times, want 2", calls)
	}
}

func TestHandlerErrors(t *testing.T) {
	s, l := fakeServer(t)
	s.Register("stopped", Inline, func(Params) (any, error) { return nil, ErrStopped })
	s.Register("data", Inline, func(Params) (any, error) {
		e := Unsupported("no")
		e.Data = map[string]any{"protocolVersion": 1}
		return nil, e
	})
	s.Register("boom", Inline, func(Params) (any, error) { return nil, errors.New("x") })
	s.Register("panic", Inline, func(Params) (any, error) { panic("oops") })
	s.Receive([]byte(`{"id":1,"method":"stopped"}`))
	s.Receive([]byte(`{"id":2,"method":"data"}`))
	s.Receive([]byte(`{"id":3,"method":"boom"}`))
	s.Receive([]byte(`{"id":4,"method":"panic"}`))
	all := messages(t, l, 5)
	if code(all[1]) != proto.Stopped || all[1]["error"].(map[string]any)["data"] != nil {
		t.Errorf("stopped: %v", all[1])
	}
	if data := all[2]["error"].(map[string]any)["data"].(map[string]any); code(all[2]) != proto.Unsupported || data["protocolVersion"] != float64(1) {
		t.Errorf("data: %v", all[2])
	}
	if code(all[3]) != proto.Internal || code(all[4]) != proto.Internal {
		t.Errorf("internal: %v %v", all[3], all[4])
	}
}

func TestShutdownAndKinds(t *testing.T) {
	s, l := fakeServer(t)
	var mu sync.Mutex
	var order []string
	s.Register("slow", Queued, func(Params) (any, error) {
		time.Sleep(50 * time.Millisecond)
		mu.Lock()
		order = append(order, "slow")
		mu.Unlock()
		return proto.Empty{}, nil
	})
	s.Register("fast", Queued, func(Params) (any, error) {
		mu.Lock()
		order = append(order, "fast")
		mu.Unlock()
		return proto.Empty{}, nil
	})
	s.Register("later", Async, func(Params) (any, error) { return proto.Point{X: 1.5, Y: -2}, nil })
	s.Receive([]byte(`{"id":1,"method":"slow"}`))
	s.Receive([]byte(`{"id":2,"method":"fast"}`))
	s.Receive([]byte(`{"id":3,"method":"later"}`))
	all := messages(t, l, 4)
	mu.Lock()
	if strings.Join(order, ",") != "slow,fast" {
		t.Errorf("queued order: %v", order)
	}
	mu.Unlock()
	var later map[string]any
	for _, m := range all {
		if m["id"] == float64(3) {
			later = m
		}
	}
	if later == nil || later["result"].(map[string]any)["x"] != 1.5 {
		t.Errorf("async result: %v", all)
	}
	if s.Receive([]byte(`{"id":9,"method":"shutdown"}`)) != Stop {
		t.Error("shutdown doesn't stop")
	}
	last := messages(t, l, 5)[4]
	if last["id"] != float64(9) || len(last["result"].(map[string]any)) != 0 {
		t.Errorf("shutdown answer: %v", last)
	}
}

func TestNotifications(t *testing.T) {
	s, l := fakeServer(t)
	s.Notify(proto.NControlEsc, proto.EscParams{Phase: "stopped", HeldMs: 1003})
	s.Notify(proto.NControlUserInput, proto.UserInputParams{Kind: "mouse"})
	all := messages(t, l, 3)
	if _, has := all[1]["id"]; has || all[1]["method"] != "control.esc" {
		t.Errorf("esc: %v", all[1])
	}
	if p := all[1]["params"].(map[string]any); p["phase"] != "stopped" || p["heldMs"] != float64(1003) {
		t.Errorf("esc params: %v", p)
	}
	if p := all[2]["params"].(map[string]any); all[2]["method"] != "control.userInput" || p["kind"] != "mouse" {
		t.Errorf("userInput: %v", all[2])
	}
}

func TestEncodingKeepsSlashesAndNulls(t *testing.T) {
	data, err := Encode(proto.App{ID: "chrome.exe", Name: "Chrome", Path: proto.Ptr(`C:\Program Files/x<y>`)})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.HasSuffix(text, "\n") || strings.Count(text, "\n") != 1 {
		t.Errorf("one line: %q", text)
	}
	if !strings.Contains(text, `Files/x<y>`) {
		t.Errorf("slashes and brackets stay as they are: %s", text)
	}
	if !strings.Contains(text, `"pid":null`) || !strings.Contains(text, `"category":null`) {
		t.Errorf("nullable fields are written as null: %s", text)
	}
	inspected, _ := Encode(proto.InspectResult{})
	var m map[string]any
	_ = json.Unmarshal(inspected, &m)
	if len(m) != 5 || m["app"] != nil || m["link"] != nil {
		t.Errorf("inspect result: %s", inspected)
	}
}

func TestParams(t *testing.T) {
	p := MustParams(`{"x":10,"y":20.5,"button":"right","count":2,"modifiers":["cmd"],"n":null,"s":"str","o":{"a":1},"bad":"1"}`)
	if v, err := p.Float("y"); err != nil || v != 20.5 {
		t.Errorf("Float: %v %v", v, err)
	}
	if v, err := p.Int("count"); err != nil || v != 2 {
		t.Errorf("Int: %v %v", v, err)
	}
	if _, err := p.Int("y"); err == nil {
		t.Error("20.5 isn't an integer")
	}
	if _, err := p.Float("bad"); err == nil || !strings.Contains(err.Error(), "bad must be a number") {
		t.Errorf("a string isn't a number: %v", err)
	}
	if _, err := p.Float("missing"); err == nil || !strings.Contains(err.Error(), "missing missing") {
		t.Errorf("missing: %v", err)
	}
	if _, err := p.Float("n"); err == nil || !strings.Contains(err.Error(), "not null") {
		t.Errorf("null: %v", err)
	}
	if _, ok, err := p.OptFloat("n"); ok || err != nil {
		t.Errorf("an optional null is absent: %v %v", ok, err)
	}
	if v, err := p.Enum("button", "left", "right", "middle"); err != nil || v != "right" {
		t.Errorf("Enum: %v %v", v, err)
	}
	if _, err := p.Enum("s", "left", "right"); err == nil {
		t.Error("an unknown enum value")
	}
	if v, err := p.Strings("modifiers"); err != nil || len(v) != 1 || v[0] != "cmd" {
		t.Errorf("Strings: %v %v", v, err)
	}
	if _, err := p.Strings("s"); err == nil {
		t.Error("a string isn't an array")
	}
	o, err := p.Object("o")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.Float("b"); err == nil || !strings.Contains(err.Error(), "missing o.b") {
		t.Errorf("nested paths: %v", err)
	}
	if _, err := p.Bool("x"); err == nil {
		t.Error("a number isn't a boolean")
	}
	if _, err := ParseParams(json.RawMessage(`[1]`)); err == nil {
		t.Error("an array isn't params")
	}
	if p, err := ParseParams(nil); err != nil || p.Has("x") {
		t.Error("absent params are {}")
	}
}
