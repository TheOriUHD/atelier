//go:build unix

package shell

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestLoginEnvSnapshot(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("no /bin/bash")
	}
	home := t.TempDir()
	profile := "echo noise from the profile\nexport ATELIER_PROFILE=loaded\nexport PATH=\"$HOME/tools:$PATH\"\n"
	if err := os.WriteFile(filepath.Join(home, ".bash_profile"), []byte(profile), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("SHELL", "/bin/bash")
	env := loginEnv(context.Background())
	if !slices.Contains(env, "ATELIER_PROFILE=loaded") {
		t.Fatalf("profile variables missing from %v", env)
	}
	if !slices.ContainsFunc(env, func(kv string) bool { return strings.HasPrefix(kv, "PATH="+filepath.Join(home, "tools")+":") }) {
		t.Errorf("PATH from the profile missing")
	}
	if slices.ContainsFunc(env, func(kv string) bool { return strings.HasPrefix(kv, "PWD=") || strings.HasPrefix(kv, "SHLVL=") }) {
		t.Errorf("per-process variables leaked into the snapshot")
	}
}
