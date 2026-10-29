package helper

import (
	"slices"
	"strings"
	"testing"
	"time"

	"atelier.dev/computer-windows/internal/control"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
)

func TestBackgroundParams(t *testing.T) {
	h, l, sys := newHelper()
	call(t, h, l, initialize)
	cases := []struct {
		request string
		code    int
		message string
	}{
		// window.capture
		{`{"jsonrpc":"2.0","id":"a","method":"window.capture","params":{"maxWidth":10,"maxHeight":10,"format":"png"}}`, proto.InvalidParams, "app"},
		{`{"jsonrpc":"2.0","id":"b","method":"window.capture","params":{"app":" ","maxWidth":10,"maxHeight":10,"format":"png"}}`, proto.InvalidParams, "app"},
		{`{"jsonrpc":"2.0","id":"c","method":"window.capture","params":{"app":"notepad.exe","maxWidth":0,"maxHeight":10,"format":"png"}}`, proto.InvalidParams, "maxWidth"},
		{`{"jsonrpc":"2.0","id":"d","method":"window.capture","params":{"app":"notepad.exe","maxWidth":10,"maxHeight":10,"format":"gif"}}`, proto.InvalidParams, "format"},
		{`{"jsonrpc":"2.0","id":"e","method":"window.capture","params":{"app":"notepad.exe","maxWidth":10,"maxHeight":10,"format":"jpeg","quality":2}}`, proto.InvalidParams, "quality"},
		{`{"jsonrpc":"2.0","id":"f","method":"window.capture","params":{"app":"nothing.exe","maxWidth":10,"maxHeight":10,"format":"png"}}`, proto.NotFound, ""},
		// a window: a non-empty string; one that names no window is NotFound
		{`{"jsonrpc":"2.0","id":"g","method":"bg.inspect","params":{"window":4242,"x":1,"y":1}}`, proto.InvalidParams, "window"},
		{`{"jsonrpc":"2.0","id":"h","method":"bg.inspect","params":{"window":"","x":1,"y":1}}`, proto.InvalidParams, "window"},
		{`{"jsonrpc":"2.0","id":"i","method":"bg.inspect","params":{"window":"4242","x":"left","y":1}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"j","method":"bg.inspect","params":{"window":"1","x":1,"y":1}}`, proto.NotFound, ""},
		{`{"jsonrpc":"2.0","id":"k","method":"bg.focused","params":{}}`, proto.InvalidParams, "window"},
		{`{"jsonrpc":"2.0","id":"l","method":"bg.focused","params":{"window":"nope"}}`, proto.NotFound, ""},
		// bg.click
		{`{"jsonrpc":"2.0","id":"m","method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"left","count":4,"modifiers":[]}}`, proto.InvalidParams, "count"},
		{`{"jsonrpc":"2.0","id":"n","method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"fourth","count":1,"modifiers":[]}}`, proto.InvalidParams, "button"},
		{`{"jsonrpc":"2.0","id":"o","method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"left","count":1,"modifiers":["hyper"]}}`, proto.InvalidParams, "modifier"},
		{`{"jsonrpc":"2.0","id":"p","method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"left","count":1,"modifiers":["alt"]}}`, proto.Unsupported, "alt"},
		{`{"jsonrpc":"2.0","id":"q","method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"left","count":1}}`, proto.InvalidParams, "modifiers"},
		{`{"jsonrpc":"2.0","id":"r","method":"bg.click","params":{"window":"9","x":1,"y":1,"button":"left","count":1,"modifiers":[]}}`, proto.NotFound, ""},
		// bg.scroll
		{`{"jsonrpc":"2.0","id":"s","method":"bg.scroll","params":{"window":"4242","x":1,"y":1,"dx":0,"dy":20000}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"t","method":"bg.scroll","params":{"window":"4242","x":1,"y":1,"dx":0}}`, proto.InvalidParams, "dy"},
		// bg.key
		{`{"jsonrpc":"2.0","id":"u","method":"bg.key","params":{"window":"4242","keys":[]}}`, proto.InvalidParams, ""},
		{`{"jsonrpc":"2.0","id":"v","method":"bg.key","params":{"window":"4242","keys":["ctrl","nosuchkey"]}}`, proto.InvalidParams, "nosuchkey"},
		{`{"jsonrpc":"2.0","id":"w","method":"bg.key","params":{"window":"4242","keys":["return"],"repeat":101}}`, proto.InvalidParams, "repeat"},
		{`{"jsonrpc":"2.0","id":"x","method":"bg.key","params":{"window":"4242","keys":["ctrl","s"]}}`, proto.Unsupported, "ctrl+s"},
		{`{"jsonrpc":"2.0","id":"y","method":"bg.key","params":{"window":"4242","keys":["shift","tab"]}}`, proto.Unsupported, "shift+tab"},
		// bg.type
		{`{"jsonrpc":"2.0","id":"z","method":"bg.type","params":{"window":"4242","text":5}}`, proto.InvalidParams, "text"},
		{`{"jsonrpc":"2.0","id":"za","method":"bg.type","params":{"window":"4242"}}`, proto.InvalidParams, "text"},
		{`{"jsonrpc":"2.0","id":"zb","method":"bg.type","params":{"window":"77","text":"hi"}}`, proto.NotFound, ""},
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
	if got := sys.calls(); len(got) != 0 {
		t.Errorf("bad params reached the system: %v", got)
	}

	// Good calls reach the system checked and filled in.
	reply := call(t, h, l, `{"jsonrpc":"2.0","id":1,"method":"window.capture","params":{"app":"notepad.exe","maxWidth":1280,"maxHeight":800,"format":"jpeg"}}`)
	if r, ok := reply["result"].(map[string]any); !ok || r["window"] != "4242" || r["title"] != nil {
		t.Errorf("window.capture: %v", reply)
	}
	if sys.window.App != "notepad.exe" || sys.window.Quality != 0.8 || sys.window.MaxWidth != 1280 || sys.window.Format != "jpeg" {
		t.Errorf("window.capture request: %+v", sys.window)
	}
	for _, request := range []string{
		`{"jsonrpc":"2.0","id":2,"method":"bg.click","params":{"window":"4242","x":10.4,"y":20,"button":"right","count":2,"modifiers":["cmd","shift"]}}`,
		`{"jsonrpc":"2.0","id":3,"method":"bg.scroll","params":{"window":"4242","x":10,"y":20,"dx":0,"dy":3}}`,
		`{"jsonrpc":"2.0","id":4,"method":"bg.key","params":{"window":"4242","keys":["cmd","a"]}}`,
		`{"jsonrpc":"2.0","id":5,"method":"bg.type","params":{"window":"4242","text":"héllo"}}`,
		`{"jsonrpc":"2.0","id":6,"method":"bg.type","params":{"window":"4242","text":""}}`,
		`{"jsonrpc":"2.0","id":7,"method":"bg.inspect","params":{"window":"4242","x":1,"y":2}}`,
		`{"jsonrpc":"2.0","id":8,"method":"bg.focused","params":{"window":"4242"}}`,
	} {
		if reply := call(t, h, l, request); errorCode(reply) != 0 {
			t.Errorf("%s: %v", request, reply)
		}
	}
	// In order (they are queued with the other input), and empty text sends nothing.
	if got, want := sys.calls(), []string{"click", "scroll", "key cmd+a", "type héllo"}; !slices.Equal(got, want) {
		t.Errorf("background calls: %v, want %v", got, want)
	}
	if c := sys.click; c.Button != input.Right || c.Count != 2 || c.At.X != 10.4 || c.MK != 0x0008|0x0004 ||
		!slices.Equal(c.Modifiers, []keys.Modifier{keys.Ctrl, keys.Shift}) {
		t.Errorf("click request: %+v", c)
	}
}

func TestBackgroundInputIsRefusedAfterTheEscStop(t *testing.T) {
	h, l, sys := newHelper()
	call(t, h, l, initialize)
	call(t, h, l, `{"jsonrpc":"2.0","id":1,"method":"control.begin"}`)
	sys.hooks.sink(control.Sample{Kind: control.SampleEscDown})
	deadline := time.Now().Add(3 * time.Second)
	for !h.Input().IsStopped() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !h.Input().IsStopped() {
		t.Fatal("holding Esc didn't stop input")
	}
	for _, request := range []string{
		`{"jsonrpc":"2.0","id":2,"method":"bg.click","params":{"window":"4242","x":1,"y":1,"button":"left","count":1,"modifiers":[]}}`,
		`{"jsonrpc":"2.0","id":3,"method":"bg.scroll","params":{"window":"4242","x":1,"y":1,"dx":0,"dy":1}}`,
		`{"jsonrpc":"2.0","id":4,"method":"bg.key","params":{"window":"4242","keys":["return"]}}`,
		`{"jsonrpc":"2.0","id":5,"method":"bg.type","params":{"window":"4242","text":"x"}}`,
	} {
		if code := errorCode(call(t, h, l, request)); code != proto.Stopped {
			t.Errorf("%s after the stop: %d", request, code)
		}
	}
	if got := sys.calls(); len(got) != 0 {
		t.Errorf("input reached the system after the stop: %v", got)
	}
	// Bad params are still bad params; looking is still allowed.
	if code := errorCode(call(t, h, l, `{"jsonrpc":"2.0","id":6,"method":"bg.key","params":{"window":"4242","keys":[]}}`)); code != proto.InvalidParams {
		t.Errorf("bad params after the stop: %d", code)
	}
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":7,"method":"bg.focused","params":{"window":"4242"}}`); errorCode(reply) != 0 {
		t.Errorf("bg.focused after the stop: %v", reply)
	}
	call(t, h, l, `{"jsonrpc":"2.0","id":8,"method":"control.resume"}`)
	if reply := call(t, h, l, `{"jsonrpc":"2.0","id":9,"method":"bg.key","params":{"window":"4242","keys":["return"]}}`); errorCode(reply) != 0 {
		t.Errorf("bg.key after resume: %v", reply)
	}
}
