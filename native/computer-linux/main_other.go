//go:build !linux

// atelier-computer-linux only runs on Linux; elsewhere this keeps `go build ./...` and `go vet ./...` working for the
// platform-independent packages (go test runs them on any OS).
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "atelier-computer-linux runs on Linux only")
	os.Exit(1)
}
