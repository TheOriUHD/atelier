// Command atelier-runner owns every filesystem, search, shell, process and PTY operation of one
// workspace. It speaks JSON-RPC 2.0, one object per line, on stdin/stdout; it logs to stderr only.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"atelier.dev/runner/internal/fsops"
	"atelier.dev/runner/internal/glob"
	"atelier.dev/runner/internal/grep"
	"atelier.dev/runner/internal/proc"
	"atelier.dev/runner/internal/pty"
	"atelier.dev/runner/internal/rpc"
	"atelier.dev/runner/internal/shell"
	"atelier.dev/runner/internal/sys"
	"atelier.dev/runner/internal/watch"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

type rootFlags []string

func (r *rootFlags) String() string     { return strings.Join(*r, ",") }
func (r *rootFlags) Set(v string) error { *r = append(*r, v); return nil }

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(0)
	log.SetPrefix("atelier-runner: ")

	var roots rootFlags
	stdio := flag.Bool("stdio", false, "serve JSON-RPC on stdin/stdout")
	flag.Var(&roots, "root", "workspace root (repeatable)")
	flag.Parse()
	if !*stdio {
		fmt.Fprintln(os.Stderr, "usage: atelier-runner --stdio [--root <path>]...")
		os.Exit(2)
	}
	if err := run(roots); err != nil {
		log.Fatal(err)
	}
}

func run(roots []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	// Besides the workspace, only the skills cache is a root: the rest of ~/.atelier (on the desktop, the data
	// folder with every account's database and scratch folders) stays out of a session's reach.
	skillsCache := filepath.Join(home, ".atelier", "skills-cache")
	if err := os.MkdirAll(skillsCache, 0o700); err != nil {
		return err
	}
	scope, err := fsops.NewScope(append(roots, skillsCache)...)
	if err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp("", "atelier-runner-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	srv := rpc.NewServer(os.Stdout)
	shells := shell.NewManager(scope, srv.Notify, tmpDir)
	ptys := pty.NewManager(scope, srv.Notify)
	watches := watch.NewManager(scope, srv.Notify)
	cleanup := func() {
		shells.CloseAll()
		ptys.CloseAll()
		watches.CloseAll()
	}
	register(srv, scope, shells, ptys, watches)
	srv.Initialize = rpc.Method(func(_ context.Context, p rpc.InitializeParams) (rpc.InitializeResult, error) {
		if p.ProtocolVersion != rpc.ProtocolVersion {
			e := rpc.NewError(rpc.CodeVersionMismatch, "VersionMismatch", fmt.Sprintf("runner speaks protocol %d, client %d", rpc.ProtocolVersion, p.ProtocolVersion))
			e.Data["runnerProtocolVersion"] = rpc.ProtocolVersion
			e.Data["runnerVersion"] = version
			return rpc.InitializeResult{}, e
		}
		log.Printf("%s %s connected (runner %s)", p.Client.Name, p.Client.Version, version)
		return rpc.InitializeResult{
			ProtocolVersion: rpc.ProtocolVersion,
			RunnerVersion:   version,
			OS:              runtime.GOOS,
			Arch:            runtime.GOARCH,
			Roots:           scope.Roots(),
			Home:            home,
			Shell:           sys.DefaultShell(),
			PathSep:         string(os.PathSeparator),
			Capabilities:    rpc.Capabilities{Methods: srv.Methods(), ExecShell: shells.Kind()},
		}, nil
	})

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		cleanup()
		_ = os.RemoveAll(tmpDir)
		os.Exit(0)
	}()

	err = srv.Serve(os.Stdin)
	cleanup()
	return err
}

func register(srv *rpc.Server, scope *fsops.Scope, shells *shell.Manager, ptys *pty.Manager, watches *watch.Manager) {
	files := &fsops.FS{Scope: scope}
	m := map[string]rpc.Handler{
		"sys.info": rpc.Method(func(ctx context.Context, _ struct{}) (rpc.SysInfoResult, error) {
			return sys.Info(ctx, scope.Primary(), version), nil
		}),
		"sys.ping": rpc.Method(func(context.Context, struct{}) (rpc.SysPingResult, error) {
			return rpc.SysPingResult{Time: time.Now().UnixMilli()}, nil
		}),
		"sys.addRoot": rpc.Method(func(_ context.Context, p rpc.SysAddRootParams) (rpc.SysAddRootResult, error) {
			if p.Path == "" {
				return rpc.SysAddRootResult{}, rpc.InvalidParams("path is required")
			}
			if _, err := scope.Add(p.Path); err != nil {
				return rpc.SysAddRootResult{}, err
			}
			return rpc.SysAddRootResult{Roots: scope.Roots()}, nil
		}),

		"fs.stat":          rpc.Method(files.Stat),
		"fs.read":          rpc.Method(files.Read),
		"fs.write":         rpc.Method(files.Write),
		"fs.list":          rpc.Method(files.List),
		"fs.mkdir":         rpc.Method(files.Mkdir),
		"fs.remove":        rpc.Method(files.Remove),
		"fs.rename":        rpc.Method(files.Rename),
		"fs.readAncestors": rpc.Method(files.ReadAncestors),
		"fs.glob": rpc.Method(func(ctx context.Context, p rpc.FsGlobParams) (rpc.FsGlobResult, error) {
			return glob.Glob(ctx, scope, p)
		}),
		"fs.grep": rpc.Method(func(ctx context.Context, p rpc.FsGrepParams) (rpc.FsGrepResult, error) {
			return grep.Grep(ctx, scope, p)
		}),
		"fs.watch":   rpc.Method(watches.Watch),
		"fs.unwatch": rpc.Method(watches.Unwatch),

		"shell.open":  rpc.Method(shells.Open),
		"shell.exec":  rpc.Method(shells.Exec),
		"shell.read":  rpc.Method(shells.Read),
		"shell.kill":  rpc.Method(shells.Kill),
		"shell.close": rpc.Method(shells.Close),

		"proc.exec": rpc.Method(func(ctx context.Context, p rpc.ProcExecParams) (rpc.ProcExecResult, error) {
			return proc.Exec(ctx, scope, p)
		}),

		"pty.open":   rpc.Method(ptys.Open),
		"pty.write":  rpc.Method(ptys.Write),
		"pty.resize": rpc.Method(ptys.Resize),
		"pty.close":  rpc.Method(ptys.Close),
	}
	for name, h := range m {
		srv.Handle(name, h)
	}
}
