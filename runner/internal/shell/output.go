package shell

import (
	"fmt"
	"sync"
	"unicode/utf8"

	"atelier.dev/runner/internal/rpc"
)

const (
	headCap = 256 << 10 // first bytes of output always kept
	tailCap = 768 << 10 // last bytes of output kept
)

// output captures a command's interleaved stdout and stderr: the head, plus a sliding tail.
// Offsets are absolute byte positions in the full stream.
type output struct {
	mu    sync.Mutex
	head  []byte
	tail  []byte
	total int64
}

func (o *output) write(p []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.total += int64(len(p))
	if room := headCap - len(o.head); room > 0 {
		n := min(room, len(p))
		o.head = append(o.head, p[:n]...)
		p = p[n:]
	}
	o.tail = append(o.tail, p...)
	if len(o.tail) > 2*tailCap { // trim in batches to keep appends amortized
		o.tail = append([]byte(nil), o.tail[len(o.tail)-tailCap:]...)
	}
}

// since returns one contiguous run of output starting at off, the offset to continue from, and
// whether output between off and the returned data was dropped. Unless final, a trailing
// incomplete UTF-8 sequence is held back for the next call.
func (o *output) since(off int64, final bool) ([]byte, int64, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	off = max(off, 0)
	headLen, tailStart := int64(len(o.head)), o.total-int64(len(o.tail))
	var data []byte
	skipped := false
	switch {
	case off < headLen:
		data = o.head[off:]
		if tailStart == headLen {
			data = append(data[:len(data):len(data)], o.tail...)
		}
	case off < tailStart:
		data, off, skipped = o.tail, tailStart, true
	case off < o.total:
		data = o.tail[off-tailStart:]
	}
	if skipped {
		for len(data) > 0 && !utf8.RuneStart(data[0]) {
			data, off = data[1:], off+1
		}
	}
	if !final {
		data = data[:rpc.CompleteUTF8(data)]
	}
	return append([]byte(nil), data...), off + int64(len(data)), skipped
}

// text returns the captured output, marking where the middle was dropped.
func (o *output) text() (string, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.total <= headCap+tailCap {
		return string(o.head) + string(o.tail), false
	}
	tail := o.tail[len(o.tail)-tailCap:]
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	head := o.head[:rpc.CompleteUTF8(o.head)]
	dropped := o.total - int64(len(head)) - int64(len(tail))
	return fmt.Sprintf("%s\n[... %d bytes of output truncated ...]\n%s", head, dropped, tail), true
}

// stream feeds output and, for foreground commands, forwards it as shell.output notifications
// until the capture size is reached. Chunks never split a UTF-8 sequence.
type stream struct {
	out    *output
	execID string
	notify func(method string, params any)
	carry  []byte
	sent   int
}

func (s *stream) Write(p []byte) (int, error) {
	s.out.write(p)
	if s.notify == nil || s.sent >= headCap+tailCap {
		return len(p), nil
	}
	data := append(s.carry, p...)
	n := rpc.CompleteUTF8(data)
	s.emit(data[:n])
	s.carry = append([]byte(nil), data[n:]...)
	return len(p), nil
}

func (s *stream) flush() {
	if s.notify != nil && s.sent < headCap+tailCap {
		s.emit(s.carry)
	}
	s.carry = nil
}

func (s *stream) emit(chunk []byte) {
	if len(chunk) > 0 {
		s.notify("shell.output", rpc.ShellOutputNotification{ExecID: s.execID, Chunk: string(chunk)})
		s.sent += len(chunk)
	}
}
