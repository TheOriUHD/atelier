// Package apply carries out a plan: it writes the files (keeping a copy of what was there), runs Docker Compose and waits
// until the server is healthy. It also makes the first admin, and does the small jobs of the other commands (update,
// status). Every command it runs is reported line by line, so the screen can show it.
package apply

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"atelier.dev/setup/internal/plan"
)

// Event is something that happened while applying.
type Event struct {
	Step string
	// Kind is "start", "log", "image" (a pull's progress), "done" or "fail".
	Kind  string
	Text  string
	Err   error
	Image *ImageProgress
}

// RunFunc runs a command in dir and reports each line of its output. Tests replace it.
type RunFunc func(ctx context.Context, dir, name string, args []string, out func(string)) error

// Options tune Execute.
type Options struct {
	Run RunFunc
	// HealthTimeout is how long to wait for the server to become healthy (default 3 minutes).
	HealthTimeout time.Duration
	// Now is used for backup file names.
	Now func() time.Time
	// PollEvery is the pause between health checks (default 2 seconds).
	PollEvery time.Duration
}

func (o *Options) defaults() {
	if o.Run == nil {
		o.Run = ExecRun
	}
	if o.HealthTimeout == 0 {
		o.HealthTimeout = 3 * time.Minute
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.PollEvery == 0 {
		o.PollEvery = 2 * time.Second
	}
}

// ExecRun runs a real command, passing its output line by line.
func ExecRun(ctx context.Context, dir, name string, args []string, out func(string)) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	r, w := io.Pipe()
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			out(strings.TrimRight(sc.Text(), "\r"))
		}
		close(done)
	}()
	err := cmd.Wait()
	_ = w.Close()
	<-done
	return err
}

// Execute runs the steps of the plan up to "healthy". Verifying the address and making the admin come after, because
// they need the person's attention.
func Execute(ctx context.Context, p plan.Plan, a plan.Answers, o Options, emit func(Event)) error {
	o.defaults()
	for _, s := range p.Steps {
		switch s.ID {
		case "files":
			emit(Event{Step: s.ID, Kind: "start", Text: s.Title})
			if err := writeFiles(p.Files, o.Now(), func(t string) { emit(Event{Step: s.ID, Kind: "log", Text: t}) }); err != nil {
				emit(Event{Step: s.ID, Kind: "fail", Err: err})
				return err
			}
			emit(Event{Step: s.ID, Kind: "done"})
		case "pull":
			if err := pull(ctx, o, a.Dir, s, emit); err != nil {
				return err
			}
		case "up":
			if err := docker(ctx, o, a.Dir, s, []string{"compose", "up", "-d", "--remove-orphans"}, emit); err != nil {
				return err
			}
		case "healthy":
			emit(Event{Step: s.ID, Kind: "start", Text: s.Title})
			if err := waitHealthy(ctx, o, a.Dir, func(t string) { emit(Event{Step: s.ID, Kind: "log", Text: t}) }); err != nil {
				emit(Event{Step: s.ID, Kind: "fail", Err: err})
				return err
			}
			emit(Event{Step: s.ID, Kind: "done"})
		}
	}
	return nil
}

func docker(ctx context.Context, o Options, dir string, s plan.Step, args []string, emit func(Event)) error {
	emit(Event{Step: s.ID, Kind: "start", Text: s.Title})
	var lines []string
	err := o.Run(ctx, dir, "docker", args, func(line string) {
		lines = append(lines, line)
		emit(Event{Step: s.ID, Kind: "log", Text: line})
	})
	if err != nil {
		if why := lastProblem(lines); why != "" {
			err = errors.New(why)
		}
		err = fmt.Errorf("docker %s failed: %w", strings.Join(args, " "), err)
		emit(Event{Step: s.ID, Kind: "fail", Err: err})
		return err
	}
	emit(Event{Step: s.ID, Kind: "done"})
	return nil
}

func writeFiles(files []plan.File, now time.Time, log func(string)) error {
	for _, f := range files {
		if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
			return fmt.Errorf("cannot create %s: %w", filepath.Dir(f.Path), err)
		}
		if old, err := os.ReadFile(f.Path); err == nil {
			if string(old) == f.Body {
				log("unchanged " + f.Path)
				continue
			}
			backup := f.Path + ".bak-" + now.Format("20060102-150405")
			if err := os.WriteFile(backup, old, 0o600); err != nil {
				return fmt.Errorf("cannot back up %s: %w", f.Path, err)
			}
			log("kept the old " + filepath.Base(f.Path) + " as " + filepath.Base(backup))
		}
		if err := os.WriteFile(f.Path, []byte(f.Body), os.FileMode(f.Mode)); err != nil {
			return fmt.Errorf("cannot write %s: %w", f.Path, err)
		}
		// WriteFile keeps the mode of a file that existed: make it what the plan says.
		if err := os.Chmod(f.Path, os.FileMode(f.Mode)); err != nil {
			return err
		}
		log("wrote " + f.Path)
	}
	return nil
}

func waitHealthy(ctx context.Context, o Options, dir string, log func(string)) error {
	deadline := time.Now().Add(o.HealthTimeout)
	last := ""
	for {
		var id string
		_ = o.Run(ctx, dir, "docker", []string{"compose", "ps", "-q", "atelier"}, func(l string) {
			if id == "" {
				id = strings.TrimSpace(l)
			}
		})
		status := "starting"
		if id != "" {
			_ = o.Run(ctx, dir, "docker", []string{"inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id}, func(l string) {
				if s := strings.TrimSpace(l); s != "" {
					status = s
				}
			})
		}
		if status != last {
			log("atelier is " + status)
			last = status
		}
		if status == "healthy" {
			return nil
		}
		if status == "exited" || status == "dead" {
			return errors.New("the server stopped right after starting: run `docker compose logs atelier` in " + dir)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the server did not become healthy within %s (it is %s): run `docker compose logs atelier` in %s", o.HealthTimeout, status, dir)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(o.PollEvery):
		}
	}
}

// NewToken makes a one-time setup token.
func NewToken() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Admin is the first account.
type Admin struct {
	Username, Name, Password string
}

var usernameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,31}$`)

// ValidateAdmin applies the server's own rules, so the person finds out before sending.
func ValidateAdmin(a Admin) error {
	if !usernameRe.MatchString(strings.ToLower(strings.TrimSpace(a.Username))) {
		return errors.New("username: 2 to 32 characters: letters, digits, dot, dash or underscore")
	}
	if strings.TrimSpace(a.Name) == "" || len(a.Name) > 80 {
		return errors.New("name: 1 to 80 characters")
	}
	if len(a.Password) < 8 {
		return errors.New("password: at least 8 characters")
	}
	if len(a.Password) > 256 {
		return errors.New("password: at most 256 characters")
	}
	return nil
}

// CreateAdmin makes the first account through the server's own sign-up endpoint, sending the address people use as the
// Origin so the server's cross-site check passes the way it does for a browser. client may be nil.
func CreateAdmin(ctx context.Context, client *http.Client, baseURL, setupToken string, a Admin) error {
	if err := ValidateAdmin(a); err != nil {
		return err
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"username": strings.TrimSpace(a.Username), "name": strings.TrimSpace(a.Name), "password": a.Password, "setupToken": setupToken})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/auth/setup", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", u.Scheme+"://"+u.Host)
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", baseURL, err)
	}
	defer res.Body.Close()
	var reply struct{ Code, Message string }
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&reply)
	if res.StatusCode == http.StatusOK {
		return nil
	}
	if reply.Code == "bad_origin" {
		return errors.New("the server refused the address " + u.Scheme + "://" + u.Host + " as cross-site: set ATELIER_BASE_URL to it in compose.yaml and restart")
	}
	if reply.Message != "" {
		return errors.New(reply.Message)
	}
	return fmt.Errorf("the server answered %d", res.StatusCode)
}

var tokenLine = regexp.MustCompile(`(?m)^ATELIER_SETUP_TOKEN=.*$`)

// ClearToken blanks the setup token in <dir>/.env once the admin exists: it has done its job.
func ClearToken(dir string) error {
	path := filepath.Join(dir, ".env")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return os.WriteFile(path, tokenLine.ReplaceAll(b, []byte("ATELIER_SETUP_TOKEN=")), 0o600)
}

// Update pulls the newest images and recreates what changed.
func Update(ctx context.Context, o Options, dir string, out func(string)) error {
	o.defaults()
	for _, args := range [][]string{{"compose", "pull"}, {"compose", "up", "-d"}} {
		out("$ docker " + strings.Join(args, " "))
		if err := o.Run(ctx, dir, "docker", args, out); err != nil {
			return fmt.Errorf("docker %s failed: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

// lastProblem is the last line of a command's output that reads like the reason it failed ("Error response from
// daemon: …", "E: Unable to locate package …"), so the message says it instead of "exit status 1".
func lastProblem(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		low := strings.ToLower(l)
		if strings.HasPrefix(l, "E: ") || strings.Contains(low, "error") || strings.Contains(low, "failed") || strings.Contains(low, "denied") {
			return l
		}
	}
	return ""
}

// BaseURL reads ATELIER_BASE_URL from a compose file, or "".
func BaseURL(composePath string) string {
	b, err := os.ReadFile(composePath)
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`(?m)^\s*ATELIER_BASE_URL:\s*(\S+)\s*$`).FindSubmatch(b)
	if m == nil {
		return ""
	}
	return strings.Trim(string(m[1]), `"'`)
}

// HTTPClient is the client for talking to the new server; insecure accepts a self-signed certificate (the wizard's own
// tests).
func HTTPClient(insecure bool) *http.Client {
	c := &http.Client{Timeout: 30 * time.Second}
	if insecure {
		c.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	return c
}

var portLine = regexp.MustCompile(`(?m)^\s*-\s*['"]?(?:([0-9.]+):)?(\d+):7340['"]?\s*$`)

// PublishedURL is the address a LAN install answers on, read from the compose file's ports, or "".
func PublishedURL(composePath string) string {
	b, err := os.ReadFile(composePath)
	if err != nil {
		return ""
	}
	m := portLine.FindSubmatch(b)
	if m == nil {
		return ""
	}
	host := string(m[1])
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + host + ":" + string(m[2])
}
