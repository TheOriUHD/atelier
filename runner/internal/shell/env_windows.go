//go:build windows

package shell

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"os"
	"strings"
	"unicode/utf16"
)

// loginEnv: Windows has no login-shell environment to capture; Git Bash and PowerShell both
// start from the process environment (MSYS converts PATH itself).
func loginEnv(context.Context) []string { return os.Environ() }

func commandArgs(kind, command, cwdFile string) []string {
	if kind != "powershell" {
		return bashArgs("pwd -W", command, cwdFile) // -W prints C:/… instead of /c/…
	}
	script := "$__atelier_cwd = '" + strings.ReplaceAll(cwdFile, "'", "''") + "'\n" +
		"try {\n" + command + "\n} finally { [IO.File]::WriteAllText($__atelier_cwd, (Get-Location).ProviderPath) }\n" +
		"if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n"
	units := utf16.Encode([]rune(script))
	buf := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[2*i:], u)
	}
	return []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(buf)}
}
