//go:build linux

// atelier-computer-linux: the Linux computer-use helper. Computer protocol v1 over stdio
// (packages/protocol/src/computer.ts), like native/computer-macos and native/computer-windows. It talks X11 in pure Go
// (no X libraries, no cgo), so one static binary serves every distribution; a session with no X server (pure Wayland,
// a text console) can't be served, and says so when it is asked to start.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"atelier.dev/computer-linux/internal/helper"
	"atelier.dev/computer-linux/internal/rpc"
	"atelier.dev/computer-linux/internal/x11"
)

func main() {
	// Apps the helper opens shouldn't inherit Electron's switches (ELECTRON_RUN_AS_NODE would break other Electron apps).
	for _, name := range []string{"ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"} {
		_ = os.Unsetenv(name)
	}

	out := rpc.NewOutput(os.Stdout)
	sys, err := x11.NewSystem(nil)
	if err != nil {
		// Stays up to say why on initialize; main shows it in Settings.
		fmt.Fprintf(os.Stderr, "atelier-computer-linux: %v\n", err)
		helper.RunUnavailable(os.Stdin, out, err)
		os.Exit(0)
	}
	defer sys.Close()
	h := helper.New(out, sys)

	// SIGTERM and SIGINT let go of held input and exit 0, like stdin's EOF and shutdown.
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
