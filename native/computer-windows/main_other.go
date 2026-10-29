//go:build !windows

// atelier-computer-windows only runs on Windows; elsewhere this keeps `go build ./...` and `go vet ./...` working for
// the platform-independent packages (go test runs them on any OS).
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "atelier-computer-windows runs on Windows only")
	os.Exit(1)
}
