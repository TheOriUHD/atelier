// Package watch implements fs.watch: fsnotify watches (recursive ones skip ignored directories),
// reported as fs.changed notifications debounced by 100 ms.
package watch

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/walk"
)

const (
	debounce = 100 * time.Millisecond
	maxDelay = time.Second // a steady stream of changes is still reported this often
)

type Manager struct {
	scope  *fsops.Scope
	notify func(method string, params any)

	mu      sync.Mutex
	watches map[string]*watcher
	seq     int
}

func NewManager(scope *fsops.Scope, notify func(string, any)) *Manager {
	return &Manager{scope: scope, notify: notify, watches: map[string]*watcher{}}
}

type watcher struct {
	id        string
	fw        *fsnotify.Watcher
	top       string
	recursive bool
	notify    func(string, any)

	mu      sync.Mutex
	pending []rpc.FsChangeEvent
	index   map[string]int // path -> position in pending
	timer   *time.Timer
	first   time.Time
}

func (m *Manager) Watch(_ context.Context, p rpc.FsWatchParams) (rpc.FsWatchResult, error) {
	path, err := m.scope.Resolve(p.Path)
	if err != nil {
		return rpc.FsWatchResult{}, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return rpc.FsWatchResult{}, err
	}
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return rpc.FsWatchResult{}, err
	}
	m.mu.Lock()
	m.seq++
	w := &watcher{id: fmt.Sprintf("watch-%d", m.seq), fw: fw, top: m.scope.RootOf(path), recursive: p.Recursive && fi.IsDir(), notify: m.notify, index: map[string]int{}}
	m.watches[w.id] = w
	m.mu.Unlock()
	if w.recursive {
		err = w.addTree(path)
	} else {
		err = fw.Add(path)
	}
	if err != nil {
		_, _ = m.Unwatch(context.Background(), rpc.FsUnwatchParams{WatchID: w.id})
		return rpc.FsWatchResult{}, err
	}
	go w.loop()
	return rpc.FsWatchResult{WatchID: w.id}, nil
}

// Unwatch stops a watch. Unknown ids are ignored, so it is idempotent.
func (m *Manager) Unwatch(_ context.Context, p rpc.FsUnwatchParams) (any, error) {
	m.mu.Lock()
	w := m.watches[p.WatchID]
	delete(m.watches, p.WatchID)
	m.mu.Unlock()
	if w != nil {
		_ = w.fw.Close()
		w.mu.Lock()
		if w.timer != nil {
			w.timer.Stop()
		}
		w.mu.Unlock()
	}
	return nil, nil
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.watches))
	for id := range m.watches {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_, _ = m.Unwatch(context.Background(), rpc.FsUnwatchParams{WatchID: id})
	}
}

// addTree watches dir and every directory below it that the ignore rules do not exclude.
func (w *watcher) addTree(dir string) error {
	if err := w.fw.Add(dir); err != nil {
		return err
	}
	return walk.Walk(context.Background(), dir, w.top, walk.Options{Ignore: true, Dirs: true}, func(e walk.Entry) bool {
		if e.IsDir() {
			_ = w.fw.Add(e.Path)
		}
		return true
	})
}

func (w *watcher) loop() {
	for {
		select {
		case ev, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(ev)
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			log.Printf("watch %s: %v", w.id, err)
		}
	}
}

func (w *watcher) handle(ev fsnotify.Event) {
	var op string
	switch {
	case ev.Has(fsnotify.Create):
		op = "create"
		if w.recursive {
			if fi, err := os.Lstat(ev.Name); err == nil && fi.IsDir() {
				_ = w.addTree(ev.Name)
			}
		}
	case ev.Has(fsnotify.Write):
		op = "write"
	case ev.Has(fsnotify.Remove):
		op = "remove"
	case ev.Has(fsnotify.Rename):
		op = "rename"
	default:
		return // chmod only
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if i, seen := w.index[ev.Name]; seen {
		// A file created and then written within one batch is still new to the client.
		if !(w.pending[i].Op == "create" && op == "write") {
			w.pending[i].Op = op
		}
	} else {
		w.index[ev.Name] = len(w.pending)
		w.pending = append(w.pending, rpc.FsChangeEvent{Path: ev.Name, Op: op})
	}
	now := time.Now()
	switch {
	case w.timer == nil:
		w.first = now
		w.timer = time.AfterFunc(debounce, w.flush)
	case now.Sub(w.first) < maxDelay:
		w.timer.Reset(debounce)
	}
}

func (w *watcher) flush() {
	w.mu.Lock()
	events := w.pending
	w.pending, w.index, w.timer = nil, map[string]int{}, nil
	w.mu.Unlock()
	if len(events) > 0 {
		w.notify("fs.changed", rpc.FsChangedNotification{WatchID: w.id, Events: events})
	}
}
