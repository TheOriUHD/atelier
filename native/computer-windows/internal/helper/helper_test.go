package helper

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"atelier.dev/computer-windows/internal/control"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
	"atelier.dev/computer-windows/internal/rpc"
)

// ---------------------------------------------------------------- fakes

type fakeSender struct {
	mu     sync.Mutex
	events []input.Event
}

func (f *fakeSender) Send(e []input.Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, e...)
	return nil
}
func (f *fakeSender) SetCursorPos(x, y int)          {}
func (f *fakeSender) CursorPos() (proto.Point, bool) { return proto.Point{X: 5, Y: 6}, true }
func (f *fakeSender) VirtualScreen() input.Screen    { return input.Screen{Width: 1920, Height: 1080} }
func (f *fakeSender) SwapButtons() bool              { return false }
func (f *fakeSender) ScanCode(uint16) uint16         { return 0 }

type fakeHooks struct{ sink func(control.Sample) }

func (h *fakeHooks) Start(sink func(control.Sample)) error { h.sink = sink; return nil }
func (h *fakeHooks) Stop()                                 { h.sink = nil }

type fakeSystem struct {
	sender  *fakeSender
	hooks   *fakeHooks
	capture CaptureRequest

	mu         sync.Mutex
	window     WindowCaptureRequest
	background []string // the bg.* input calls that reached the system, in order
	click      BgClickRequest
}

func (f *fakeSystem) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.background = append(f.background, call)
}

func (f *fakeSystem) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.background)
}

// fakeWindow is the one window the fake knows, "4242".
func fakeWindow(id string) error {
	if id != "4242" {
		return rpc.NotFound("no window %s", id)
	}
	return nil
}

func (f *fakeSystem) Displays() ([]proto.Display, error) {
	return []proto.Display{{ID: `\\.\DISPLAY1`, Name: "Display 1", Scale: 1.5, Primary: true, Width: 2560, Height: 1440}}, nil
}
func (f *fakeSystem) Apps(bool) ([]proto.App, error) { return nil, nil }
func (f *fakeSystem) Frontmost() (*proto.App, error) { return nil, nil }
func (f *fakeSystem) OpenApp(id string, activate bool) (proto.App, error) {
	return proto.App{}, rpc.NotFound("no app %s", id)
}
func (f *fakeSystem) HideApps(ids []string) ([]string, error) { return ids, nil }
func (f *fakeSystem) UnhideApps([]string) error               { return nil }
func (f *fakeSystem) Activate(int) (bool, error)              { return true, nil }
func (f *fakeSystem) Capture(req CaptureRequest) (proto.CaptureResult, error) {
	f.capture = req
	return proto.CaptureResult{Data: "", Mime: "image/png", Width: 1, Height: 1}, nil
}
func (f *fakeSystem) InspectPoint(x, y float64) (proto.InspectResult, error) {
	return proto.InspectResult{}, nil
}
func (f *fakeSystem) InspectFocused() (proto.InspectResult, error) { return proto.InspectResult{}, nil }
func (f *fakeSystem) WindowCapture(req WindowCaptureRequest) (proto.WindowCaptureResult, error) {
	f.mu.Lock()
	f.window = req
	f.mu.Unlock()
	if req.App != "notepad.exe" {
		return proto.WindowCaptureResult{}, rpc.NotFound("%s has no window", req.App)
	}
	return proto.WindowCaptureResult{CaptureResult: proto.CaptureResult{Mime: "image/png", Width: 1, Height: 1}, Window: "4242"}, nil
}
func (f *fakeSystem) BgInspect(window string, x, y float64) (proto.InspectResult, error) {
	return proto.InspectResult{}, fakeWindow(window)
}
func (f *fakeSystem) BgFocused(window string) (proto.InspectResult, error) {
	return proto.InspectResult{}, fakeWindow(window)
}
func (f *fakeSystem) BgClick(ready func() error, req BgClickRequest) error {
	if err := fakeWindow(req.Window); err != nil {
		return err
	}
	f.mu.Lock()
	f.click = req
	f.mu.Unlock()
	f.record("click")
	return ready()
}
func (f *fakeSystem) BgScroll(ready func() error, window string, at proto.Point, dx, dy float64) error {
	if err := fakeWindow(window); err != nil {
		return err
	}
	f.record("scroll")
	return ready()
}
func (f *fakeSystem) BgKey(ready func() error, window string, names []string, repeat int) error {
	if err := fakeWindow(window); err != nil {
		return err
	}
	f.record("key " + strings.Join(names, "+"))
	return ready()
}
func (f *fakeSystem) BgType(ready func() error, window string, text string) error {
	if err := fakeWindow(window); err != nil {
		return err
	}
	f.record("type " + text)
	return ready()
}
func (f *fakeSystem) Sender() input.Sender { return f.sender }
func (f *fakeSystem) Layout() keys.Layout  { return nil }
func (f *fakeSystem) Hooks() control.Hooks { return f.hooks }
func (f *fakeSystem) EscapeDown() bool     { return false }

type lines struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lines) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lines) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Count(l.buf.String(), "\n")
}

func (l *lines) messages() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.buf.String()), "\n") {
		var m map[string]any
		_ = json.Unmarshal([]byte(line), &m)
		out = append(out, m)
	}
	return out
}

func newHelper() (*Helper, *lines, *fakeSystem) {
	l := &lines{}
	sys := &fakeSystem{sender: &fakeSender{}, hooks: &fakeHooks{}}
	h := New(rpc.NewOutput(l), sys)
	h.Input().SetSleep(func(time.Duration) {})
	return h, l, sys
}

// call sends a request and waits for its answer.
func call(t *testing.T, h *Helper, l *lines, request string) map[string]any {
	t.Helper()
	var sent map[string]any
	_ = json.Unmarshal([]byte(request), &sent)
	h.Server.Receive([]byte(request))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, m := range l.messages() {
			if m["id"] == sent["id"] && m["id"] != nil {
				return m
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("no answer to %s", request)
	return nil
}

func errorCode(m map[string]any) int {
	if e, ok := m["error"].(map[string]any); ok {
		return int(e["code"].(float64))
	}
	return 0
}

const initialize = `{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1,"client":{"name":"test","version":"0"}}}`

// ---------------------------------------------------------------- tests

func TestNothingBeforeInitialize(t *testing.T) {
	h, l, _ := newHelper()
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":7,"method":"displays.list"}`)); code != proto.NotInitialized {
		t.Errorf("displays.list: %d", code)
	}
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":8,"method":"nope"}`)); code != proto.NotInitialized {
		t.Errorf("nope: %d", code)
	}
}

func TestInitialize(t *testing.T) {
	h, l, _ := newHelper()
	reply := call(t, h, l, initialize)
	r := reply["result"].(map[string]any)
	if r["protocolVersion"] != float64(1) || r["helperVersion"] != proto.HelperVersion || r["platform"] != "win32" {
		t.Errorf("initialize: %v", r)
	}
	s := r["supports"].(map[string]any)
	if s["background"] != true || s["fullControl"] != true || s["filter"] != true {
		t.Errorf("supports: %v", s)
	}
	if code := errorCode(call(t, h, l, strings.Replace(initialize, `"init"`, `"again"`, 1))); code != proto.InvalidRequest {
		t.Errorf("a second initialize: %d", code)
	}
}

func TestWrongProtocolVersionLeavesItUninitialized(t *testing.T) {
	h, l, _ := newHelper()
	reply := call(t, h, l, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}`)
	e := reply["error"].(map[string]any)
	data := e["data"].(map[string]any)
	if errorCode(reply) != proto.Unsupported || data["protocolVersion"] != float64(1) || data["helperVersion"] != proto.HelperVersion {
		t.Errorf("wrong version: %v", reply)
	}
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":2,"method":"permissions.status"}`)); code != proto.NotInitialized {
		t.Errorf("after the refusal: %d", code)
	}
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":3,"method":"initialize"}`)); code != proto.InvalidParams {
		t.Errorf("initialize without params: %d", code)
	}
}

func TestUnknownMethodAndBadParams(t *testing.T) {
	h, l, sys := newHelper()
	call(t, h, l, initialize)
	cases := []struct {
		request string
		code    int
		message string
	}{
		{`{"jsonrpc":"2.0","id":"a","method":"no.such.method"}`, proto.MethodNotFound, ""},
		{`{"jsonrpc":"2.0","id":"b","method":"apps.list","params":{}}`, proto.InvalidParams, "installed"},
		{`{"jsonrpc":"2.0","id":"c","method":"inspect.point","params":{"x":"left","y":1}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"d","method":"capture.display","params":{"display":"1","maxWidth":0,"maxHeight":10,"format":"jpeg"}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"e","method":"capture.display","params":{"display":"1","maxWidth":10,"maxHeight":10,"format":"gif"}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"f","method":"permissions.status","params":[1,2]}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"g","method":"mouse.click","params":{"x":1,"y":1,"button":"left","count":4,"modifiers":[]}}`, proto.InvalidParams, "count"},
		{`{"jsonrpc":"2.0","id":"h","method":"mouse.click","params":{"x":1,"y":1,"button":"left","count":1,"modifiers":["hyper"]}}`, proto.InvalidParams, "modifier"},
		{`{"jsonrpc":"2.0","id":"i","method":"key.press","params":{"keys":["ctrl","nosuchkey"]}}`, proto.InvalidParams, "nosuchkey"},
		{`{"jsonrpc":"2.0","id":"j","method":"key.hold","params":{"keys":["a"],"ms":10001}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"k","method":"apps.activate","params":{"pid":0}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"l","method":"mouse.down","params":{"x":1,"y":1,"button":"fourth"}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"m","method":"apps.open","params":{"id":"nothing.exe","activate":false}}`, proto.NotFound, ""},
		{`{"jsonrpc":"2.0","id":"n","method":"capture.display","params":{"display":"1","maxWidth":10,"maxHeight":10,"format":"jpeg","region":{"x":0,"y":0,"width":0,"height":5}}}`, proto.InvalidParams, "region"},
		{`{"jsonrpc":"2.0","id":"o","method":"mouse.scroll","params":{"x":1,"y":1,"dx":0,"dy":20000}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"p","method":"permissions.request","params":{"kind":"camera"}}`, proto.InvalidParams, ""},
	}
	for _, c := range cases {
		reply := call(t, h, l, c.request)
		if errorCode(reply) != c.code {
			t.Errorf("%s: code %d, want %d (%v)", c.request, errorCode(reply), c.code, reply)
			continue
		}
		if c.message != "" && !strings.Contains(reply["error"].(map[string]any)["message"].(string), c.message) {
			t.Errorf("%s: message %v should mention %q", c.request, reply["error"], c.message)
		}
	}
	// A good capture request reaches the system checked and filled in.
	reply := call(t, h, l, `{"jsonrpc":"2.0","id":"z","method":"capture.display","params":{"display":"\\\\.\\DISPLAY1","apps":[],"maxWidth":1280,"maxHeight":800,"format":"png"}}`)
	if errorCode(reply) != 0 {
		t.Fatalf("capture: %v", reply)
	}
	if !sys.capture.HasApps || len(sys.capture.Apps) != 0 || sys.capture.HasExclude || sys.capture.Quality != 0.8 || sys.capture.MaxWidth != 1280 || sys.capture.Display != `\\.\DISPLAY1` {
		t.Errorf("capture request: %+v", sys.capture)
	}
}

func TestPermissionsAreGranted(t *testing.T) {
	h, l, _ := newHelper()
	call(t, h, l, initialize)
	for _, request := range []string{
		`{"jsonrpc":"2.0","id":2,"method":"permissions.status","params":{}}`,
		`{"jsonrpc":"2.0","id":3,"method":"permissions.request","params":{"kind":"screenRecording"}}`,
	} {
		r := call(t, h, l, request)["result"].(map[string]any)
		if r["accessibility"] != true || r["screenRecording"] != true {
			t.Errorf("%s: %v", request, r)
		}
	}
}

func TestShutdownAnswersThenStops(t *testing.T) {
	h, l, _ := newHelper()
	call(t, h, l, initialize)
	if h.Server.Receive([]byte(`{"jsonrpc":"2.0","id":9,"method":"shutdown"}`)) != rpc.Stop {
		t.Fatal("shutdown doesn't stop")
	}
	reply := l.messages()[1]
	if reply["id"] != float64(9) || len(reply["result"].(map[string]any)) != 0 {
		t.Errorf("shutdown: %v", reply)
	}
}

func TestRunEndsAtEOF(t *testing.T) {
	h, l, _ := newHelper()
	done := make(chan struct{})
	go func() {
		h.Run(strings.NewReader(initialize + "\n" + `{"jsonrpc":"2.0","id":2,"method":"permissions.status"}`))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run didn't end at EOF")
	}
	if l.count() != 2 {
		t.Errorf("answers: %d", l.count())
	}
}

func TestEveryContractMethodIsAnswered(t *testing.T) {
	h, _, _ := newHelper()
	got := h.Server.RegisteredMethods()
	want := slices.Clone(proto.Methods)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("registered %v\nwant %v", got, want)
	}
}

func TestTheEscStopRefusesInputUntilResume(t *testing.T) {
	h, l, sys := newHelper()
	call(t, h, l, initialize)
	call(t, h, l, `{"jsonrpc":"2.0","id":1,"method":"control.begin"}`)
	if sys.hooks.sink == nil {
		t.Fatal("control.begin didn't install the hooks")
	}
	// The person holds Esc a second: the monitor's loop gets the samples, and the stop latches before it tells main.
	sys.hooks.sink(control.Sample{Kind: control.SampleEscDown})
	deadline := time.Now().Add(3 * time.Second)
	for !h.Input().IsStopped() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !h.Input().IsStopped() {
		t.Fatal("holding Esc didn't stop input")
	}
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":2,"method":"mouse.move","params":{"x":10,"y":10}}`)); code != proto.Stopped {
		t.Errorf("input after the stop: %d", code)
	}
	// Bad params are still bad params.
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":3,"method":"key.press","params":{"keys":[]}}`)); code != proto.InvalidParams {
		t.Errorf("bad params after the stop: %d", code)
	}
	var phases []string
	for _, m := range l.messages() {
		if m["method"] == "control.esc" {
			phases = append(phases, m["params"].(map[string]any)["phase"].(string))
		}
	}
	if strings.Join(phases, ",") != "down,stopped" {
		t.Errorf("esc notifications: %v", phases)
	}
	call(t, h, l, `{"jsonrpc":"2.0","id":4,"method":"control.resume"}`)
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":5,"method":"mouse.move","params":{"x":10,"y":10}}`); errorCode(reply) != 0 {
		t.Errorf("input after resume: %v", reply)
	}
	call(t, h, l, `{"jsonrpc":"2.0","id":6,"method":"control.end"}`)
	if sys.hooks.sink != nil {
		t.Error("control.end didn't remove the hooks")
	}
}

func TestKeysAndClicksReachTheSender(t *testing.T) {
	h, l, sys := newHelper()
	call(t, h, l, initialize)
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":1,"method":"key.press","params":{"keys":["cmd","s"]}}`); errorCode(reply) != 0 {
		t.Fatalf("key.press: %v", reply)
	}
	sys.sender.mu.Lock()
	var vks []uint16
	for _, e := range sys.sender.events {
		vks = append(vks, e.VK)
	}
	sys.sender.mu.Unlock()
	// cmd is ctrl on Windows: ctrl down, s down, s up, ctrl up.
	if !slices.Equal(vks, []uint16{keys.VK_CONTROL, 'S', 'S', keys.VK_CONTROL}) {
		t.Errorf("cmd+s: %#x", vks)
	}
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":2,"method":"cursor.position"}`); reply["result"].(map[string]any)["x"] != float64(5) {
		t.Errorf("cursor.position: %v", reply)
	}
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":3,"method":"input.releaseAll"}`); errorCode(reply) != 0 {
		t.Errorf("input.releaseAll: %v", reply)
	}
}
