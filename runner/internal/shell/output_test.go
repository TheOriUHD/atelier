package shell

import (
	"fmt"
	"strings"
	"testing"
)

func TestOutputSince(t *testing.T) {
	var o output
	o.write([]byte("hello "))
	o.write([]byte("w\xc3")) // "é" split across writes
	data, next, skipped := o.since(0, false)
	if string(data) != "hello w" || next != 7 || skipped {
		t.Fatalf("partial rune must be held back: %q %d %v", data, next, skipped)
	}
	o.write([]byte("\xa9!"))
	data, next, _ = o.since(next, true)
	if string(data) != "é!" || next != 10 {
		t.Fatalf("continuation: %q %d", data, next)
	}
	if data, next, _ := o.since(next, true); len(data) != 0 || next != 10 {
		t.Fatalf("at end: %q %d", data, next)
	}
}

func TestOutputDropsTheMiddle(t *testing.T) {
	var o output
	o.write([]byte(strings.Repeat("h", headCap)))
	o.write([]byte(strings.Repeat("m", 3*tailCap)))
	o.write([]byte(strings.Repeat("t", tailCap)))
	data, next, skipped := o.since(headCap, true)
	if !skipped || next != o.total || strings.Contains(string(data), "h") {
		t.Fatalf("reading from inside the dropped range: skipped=%v next=%d/%d", skipped, next, o.total)
	}
	text, truncated := o.text()
	if !truncated || !strings.HasPrefix(text, strings.Repeat("h", headCap)+"\n[... ") || !strings.HasSuffix(text, strings.Repeat("t", tailCap)) {
		t.Fatalf("text: truncated=%v len=%d", truncated, len(text))
	}
	if !strings.Contains(text, fmt.Sprintf("[... %d bytes of output truncated ...]", 3*tailCap)) {
		t.Errorf("marker: %q", text[headCap:headCap+60])
	}
}
