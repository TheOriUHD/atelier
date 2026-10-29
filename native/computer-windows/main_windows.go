//go:build windows

// atelier-computer-windows: the Windows computer-use helper. Computer protocol v1 over stdio
// (packages/protocol/src/computer.ts), like native/computer-macos. Built as a GUI program (-H windowsgui), so starting
// it opens no console window; main gives it pipes for stdin, stdout and stderr.
package main

import (
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"atelier.dev/computer-windows/internal/helper"
	"atelier.dev/computer-windows/internal/rpc"
	"atelier.dev/computer-windows/internal/win"
)

func main() {
	// The main thread looks at its message queue once (win.Init), so it stays this goroutine's.
	runtime.LockOSThread()
	win.Init()
	// Apps the helper opens shouldn't inherit Electron's switches (ELECTRON_RUN_AS_NODE would break other Electron apps).
	for _, name := range []string{"ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"} {
		_ = os.Unsetenv(name)
	}

	out := rpc.NewOutput(os.Stdout)
	h := helper.New(out, win.NewSystem())

	// Console control events (Go installs the SetConsoleCtrlHandler: Ctrl+C and Ctrl+Break are os.Interrupt; close,
	// log-off and shutdown are SIGTERM) let go of held input and exit 0, like stdin's EOF and shutdown.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		h.Finish()
		os.Exit(0)
	}()

	h.Run(os.Stdin)
	os.Exit(0)
}
