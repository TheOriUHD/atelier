package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"runtime/debug"
	"sort"
	"sync"
)

// Handler serves one request. ctx is cancelled by $/cancel, on shutdown and when stdin closes.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// Method adapts a typed function into a Handler that decodes params into P.
func Method[P, R any](fn func(context.Context, P) (R, error)) Handler {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p P
		if len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, InvalidParams("invalid params: %v", err)
			}
		}
		r, err := fn(ctx, p)
		if err != nil {
			return nil, err
		}
		return r, nil
	}
}

// Server speaks newline-delimited JSON-RPC 2.0. Requests run concurrently; writes are serialized.
type Server struct {
	// Initialize answers the mandatory first call. Until it succeeds, every other request fails.
	Initialize Handler

	handlers map[string]Handler

	wmu sync.Mutex
	out io.Writer

	mu          sync.Mutex
	initialized bool
	inflight    map[string]context.CancelFunc
	wg          sync.WaitGroup
	ctx         context.Context
	cancel      context.CancelFunc
}

func NewServer(out io.Writer) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{handlers: map[string]Handler{}, out: out, inflight: map[string]context.CancelFunc{}, ctx: ctx, cancel: cancel}
}

func (s *Server) Handle(method string, h Handler) { s.handlers[method] = h }

// Methods lists every request method the server answers, including initialize and shutdown.
func (s *Server) Methods() []string {
	names := []string{"initialize", "shutdown"}
	for name := range s.handlers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Notify sends a notification. Safe for concurrent use.
func (s *Server) Notify(method string, params any) {
	s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

func (s *Server) write(msg any) {
	line, err := json.Marshal(msg)
	if err != nil {
		log.Printf("encode: %v", err)
		return
	}
	line = append(line, '\n')
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.out.Write(line); err != nil {
		log.Printf("write: %v", err)
	}
}

func (s *Server) reply(id json.RawMessage, result any, err error) {
	if err != nil {
		s.write(response{JSONRPC: "2.0", ID: id, Error: FromError(err)})
		return
	}
	if result == nil {
		// `result` must be present on success; omitempty would drop a nil.
		s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": nil})
		return
	}
	s.write(response{JSONRPC: "2.0", ID: id, Result: result})
}

type message struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Serve reads requests until EOF or a shutdown request, then cancels in-flight work and waits for it.
func (s *Server) Serve(in io.Reader) error {
	defer func() {
		s.cancel()
		s.wg.Wait()
	}()
	r := bufio.NewReaderSize(in, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 && s.dispatch(line) {
			return nil
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// dispatch handles one frame and reports whether the server should stop.
func (s *Server) dispatch(line []byte) (stop bool) {
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		s.write(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &Error{Code: CodeParseError, Message: "parse error"}})
		return false
	}
	if len(m.ID) == 0 || bytes.Equal(m.ID, []byte("null")) {
		if m.Method == "$/cancel" {
			var p CancelParams
			if json.Unmarshal(m.Params, &p) == nil {
				s.mu.Lock()
				if cancel := s.inflight[string(p.ID)]; cancel != nil {
					cancel()
				}
				s.mu.Unlock()
			}
		}
		return false
	}
	s.mu.Lock()
	initialized := s.initialized
	s.mu.Unlock()

	switch {
	case m.Method == "":
		s.reply(m.ID, nil, &Error{Code: CodeInvalidRequest, Message: "missing method"})
	case m.Method == "initialize":
		if initialized {
			s.reply(m.ID, nil, &Error{Code: CodeInvalidRequest, Message: "already initialized"})
			return false
		}
		result, err := s.Initialize(s.ctx, m.Params)
		if err == nil {
			s.mu.Lock()
			s.initialized = true
			s.mu.Unlock()
		}
		s.reply(m.ID, result, err)
	case !initialized:
		s.reply(m.ID, nil, NewError(CodeNotInitialized, "NotInitialized", "initialize must be the first call"))
	case m.Method == "shutdown":
		s.cancel()
		s.wg.Wait()
		s.reply(m.ID, nil, nil)
		return true
	default:
		h := s.handlers[m.Method]
		if h == nil {
			s.reply(m.ID, nil, &Error{Code: CodeMethodNotFound, Message: "unknown method " + m.Method})
			return false
		}
		s.run(m, h)
	}
	return false
}

func (s *Server) run(m message, h Handler) {
	ctx, cancel := context.WithCancel(s.ctx)
	key := string(m.ID)
	s.mu.Lock()
	s.inflight[key] = cancel
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			s.mu.Lock()
			delete(s.inflight, key)
			s.mu.Unlock()
			cancel()
		}()
		result, err := safeCall(ctx, h, m.Params)
		if err != nil && ctx.Err() != nil {
			err = ctx.Err()
		}
		s.reply(m.ID, result, err)
	}()
}

func safeCall(ctx context.Context, h Handler, params json.RawMessage) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic: %v\n%s", r, debug.Stack())
			err = &Error{Code: CodeInternal, Message: fmt.Sprintf("internal error: %v", r)}
		}
	}()
	return h(ctx, params)
}
