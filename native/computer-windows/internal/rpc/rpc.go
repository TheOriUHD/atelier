// Package rpc is newline-delimited JSON-RPC 2.0 over stdio, as the macOS helper's RPC.swift does it: framing, the
// initialize gate, dispatch and replies.
package rpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"

	"atelier.dev/computer-windows/internal/proto"
)

// Error is a JSON-RPC error object.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// NewError makes an error with a code from proto.
func NewError(code int, message string) *Error { return &Error{Code: code, Message: message} }

func Errorf(code int, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

var (
	ErrParse          = NewError(proto.ParseError, "parse error")
	ErrNotInitialized = NewError(proto.NotInitialized, "initialize must be the first call")
	ErrStopped        = NewError(proto.Stopped, "stopped: the person held Esc; input is refused until control.resume")
)

func InvalidRequest(message string) *Error { return NewError(proto.InvalidRequest, message) }
func MethodNotFound(method string) *Error {
	return NewError(proto.MethodNotFound, "unknown method "+method)
}
func InvalidParams(format string, args ...any) *Error {
	return Errorf(proto.InvalidParams, format, args...)
}
func Internal(format string, args ...any) *Error { return Errorf(proto.Internal, format, args...) }
func NotFound(format string, args ...any) *Error { return Errorf(proto.NotFound, format, args...) }
func Unsupported(format string, args ...any) *Error {
	return Errorf(proto.Unsupported, format, args...)
}

// IsStopped reports a -32031.
func IsStopped(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == proto.Stopped
}

// wire turns any error into a JSON-RPC error: an *Error as it is, anything else as Internal.
func wire(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return Internal("internal error: %v", err)
}

// ---------------------------------------------------------------- output

// Output writes one JSON object per line. Writes are serialized: responses come from many goroutines, notifications
// from the control watch.
type Output struct {
	mu sync.Mutex
	w  io.Writer
}

func NewOutput(w io.Writer) *Output { return &Output{w: w} }

// Encode marshals a message without HTML escaping (paths and base64 stay as they are). Never contains a newline.
func Encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil // Encode ends it with "\n".
}

// Send writes a message as one line. A write that fails (main went away) is dropped: stdin's EOF follows.
func (o *Output) Send(v any) error {
	line, err := Encode(v)
	if err != nil {
		return err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.w.Write(line)
	return nil
}

// Flush waits for a write in progress (writes are synchronous, so that is all there is to wait for).
func (o *Output) Flush() {
	o.mu.Lock()
	defer o.mu.Unlock()
}

// ---------------------------------------------------------------- server

// Kind is how a method runs. Inline methods are quick and run on the reader goroutine, in order (state changes such
// as control.resume take effect before the next line is read). Queued methods (mouse and keys) run one at a time, in
// order, on the input worker. Async methods (apps, screenshots, inspection) run concurrently.
type Kind int

const (
	Inline Kind = iota
	Queued
	Async
)

// Handler runs a method with its params.
type Handler func(p Params) (any, error)

type method struct {
	kind    Kind
	handler Handler
}

// Outcome of one line.
type Outcome int

const (
	Proceed Outcome = iota
	Stop
)

type Server struct {
	out        *Output
	methods    map[string]method
	initialize Handler
	// Only touched by the reader goroutine.
	initialized bool
	queue       chan func()
	startQueue  sync.Once
}

func NewServer(out *Output) *Server {
	return &Server{out: out, methods: map[string]method{}, queue: make(chan func(), 512)}
}

func (s *Server) Register(name string, kind Kind, handler Handler) {
	s.methods[name] = method{kind: kind, handler: handler}
}

func (s *Server) OnInitialize(handler Handler) { s.initialize = handler }

// RegisteredMethods are every method this server answers, initialize and shutdown included.
func (s *Server) RegisteredMethods() []string {
	names := []string{proto.MInitialize, proto.MShutdown}
	for name := range s.methods {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Notify sends a notification (no id).
func (s *Server) Notify(method string, params any) {
	if err := s.out.Send(proto.Notification{JSONRPC: "2.0", Method: method, Params: params}); err != nil {
		Logf("notification %s: %v", method, err)
	}
}

// Receive handles one line; Stop after shutdown has been answered.
func (s *Server) Receive(line []byte) Outcome {
	text := bytes.TrimSpace(line)
	if len(text) == 0 {
		return Proceed
	}
	if !json.Valid(text) {
		s.replyError(nil, ErrParse)
		return Proceed
	}
	if text[0] != '{' {
		s.replyError(nil, InvalidRequest("a request must be an object (batches aren't supported)"))
		return Proceed
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(text, &fields); err != nil {
		s.replyError(nil, ErrParse)
		return Proceed
	}
	rawID, hasID := fields["id"]
	if !hasID || isNull(rawID) {
		return Proceed // A notification: main sends none, and none needs an answer.
	}
	switch rawID[0] {
	case '"', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		s.replyError(nil, InvalidRequest("id must be a string or a number"))
		return Proceed
	}
	id := rawID
	var name string
	if raw, ok := fields["method"]; !ok || json.Unmarshal(raw, &name) != nil {
		s.replyError(id, InvalidRequest("missing method"))
		return Proceed
	}
	params, perr := ParseParams(fields["params"])
	if perr != nil {
		s.replyError(id, perr)
		return Proceed
	}

	if name == proto.MInitialize {
		if s.initialized {
			s.replyError(id, InvalidRequest("already initialized"))
			return Proceed
		}
		if s.initialize == nil {
			s.replyError(id, Internal("initialize isn't set up"))
			return Proceed
		}
		if s.run(id, s.initialize, params) {
			s.initialized = true
		}
		return Proceed
	}
	if !s.initialized {
		s.replyError(id, ErrNotInitialized)
		return Proceed
	}
	if name == proto.MShutdown {
		s.reply(id, proto.Empty{})
		return Stop
	}
	m, ok := s.methods[name]
	if !ok {
		s.replyError(id, MethodNotFound(name))
		return Proceed
	}
	switch m.kind {
	case Inline:
		s.run(id, m.handler, params)
	case Queued:
		s.startQueue.Do(func() {
			go func() {
				for job := range s.queue {
					job()
				}
			}()
		})
		s.queue <- func() { s.run(id, m.handler, params) }
	case Async:
		go s.run(id, m.handler, params)
	}
	return Proceed
}

// run calls a handler and answers; true when it succeeded. A panic in a handler is an internal error, not a crash.
func (s *Server) run(id json.RawMessage, handler Handler, params Params) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			Logf("panic in a handler: %v", r)
			s.replyError(id, Internal("internal error: %v", r))
			ok = false
		}
	}()
	result, err := handler(params)
	if err != nil {
		s.replyError(id, wire(err))
		return false
	}
	s.reply(id, result)
	return true
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

var null = json.RawMessage("null")

func (s *Server) reply(id json.RawMessage, result any) {
	data, err := Encode(result)
	if err != nil {
		s.replyError(id, Internal("could not encode the result: %v", err))
		return
	}
	data = bytes.TrimRight(data, "\n")
	if len(data) == 0 {
		data = null
	}
	if id == nil {
		id = null
	}
	if err := s.out.Send(response{JSONRPC: "2.0", ID: id, Result: data}); err != nil {
		Logf("could not send a result: %v", err)
	}
}

func (s *Server) replyError(id json.RawMessage, e *Error) {
	if id == nil {
		id = null
	}
	if err := s.out.Send(response{JSONRPC: "2.0", ID: id, Error: e}); err != nil {
		Logf("could not send an error: %v", err)
	}
}

func isNull(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) == 0 || bytes.Equal(t, null)
}

// Logf writes a log line to stderr (main shows it in its log).
func Logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "atelier-computer: "+format+"\n", args...)
}
