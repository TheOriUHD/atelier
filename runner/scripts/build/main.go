// Command build cross-compiles atelier-runner for every supported OS/arch into bin/ and writes
// bin/checksums.json, the manifest the SSH bootstrap verifies uploads against.
//
//	go run ./scripts/build          # all six targets
//	go run ./scripts/build -host    # only the machine's own OS/arch
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"atelier.dev/runner/internal/rpc"
)

var targets = []string{"darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64", "windows/amd64", "windows/arm64"}

type binary struct {
	File   string `json:"file"`
	Sha256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type manifest struct {
	Version         string            `json:"version"`
	ProtocolVersion int               `json:"protocolVersion"`
	Binaries        map[string]binary `json:"binaries"` // key: "<os>-<arch>"
}

func main() {
	log.SetFlags(0)
	host := flag.Bool("host", false, "build only for the current OS/arch")
	version := flag.String("version", "", "version to embed (default: git describe)")
	out := flag.String("out", "bin", "output directory")
	flag.Parse()

	if *version == "" {
		*version = gitVersion()
	}
	list := targets
	if *host {
		list = []string{runtime.GOOS + "/" + runtime.GOARCH}
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}

	m := manifest{Version: *version, ProtocolVersion: rpc.ProtocolVersion, Binaries: map[string]binary{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	failed := false
	for _, t := range list {
		goos, goarch, _ := strings.Cut(t, "/")
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := build(goos, goarch, *version, *out)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				log.Printf("%s/%s: %v", goos, goarch, err)
				failed = true
				return
			}
			m.Binaries[goos+"-"+goarch] = b
			log.Printf("built %s (%d bytes)", b.File, b.Size)
		}()
	}
	wg.Wait()
	if failed {
		os.Exit(1)
	}
	if *host {
		// Keep the entries of other targets from a previous full build.
		if data, err := os.ReadFile(filepath.Join(*out, "checksums.json")); err == nil {
			var prev manifest
			if json.Unmarshal(data, &prev) == nil && prev.Version == m.Version {
				for k, v := range prev.Binaries {
					if _, ok := m.Binaries[k]; !ok {
						m.Binaries[k] = v
					}
				}
			}
		}
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(*out, "checksums.json"), append(data, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
}

func build(goos, goarch, version, out string) (binary, error) {
	name := "atelier-runner-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	path := filepath.Join(out, name)
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w -X main.version="+version, "-o", path, "./cmd/atelier-runner")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+goos, "GOARCH="+goarch)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return binary{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return binary{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return binary{}, err
	}
	return binary{File: name, Sha256: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}

func gitVersion() string {
	out, err := exec.Command("git", "describe", "--tags", "--always", "--dirty").Output()
	if v := strings.TrimSpace(string(out)); err == nil && v != "" {
		return v
	}
	return "dev"
}
