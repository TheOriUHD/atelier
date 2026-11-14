//go:build windows

package win

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"atelier.dev/computer-windows/internal/appid"
)

// steamRoot is where Steam is installed: as Steam itself records it for the person, else for the machine, else its
// usual folder; empty when there is no Steam.
func steamRoot() string {
	read := func(root registry.Key, path, name string) string {
		k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
		if err != nil {
			return ""
		}
		defer k.Close()
		v, _, err := k.GetStringValue(name)
		if err != nil {
			return ""
		}
		return filepath.Clean(strings.ReplaceAll(v, "/", `\`))
	}
	for _, dir := range []string{
		read(registry.CURRENT_USER, `Software\Valve\Steam`, "SteamPath"),
		read(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Valve\Steam`, "InstallPath"),
		read(registry.LOCAL_MACHINE, `SOFTWARE\Valve\Steam`, "InstallPath"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Steam"),
	} {
		if dir != "" && dir != "." {
			if _, err := os.Stat(filepath.Join(dir, "steamapps")); err == nil {
				return dir
			}
		}
	}
	return ""
}

// steamApps are the games installed through Steam, in every library folder, as installed apps (see appid/steam.go).
func steamApps() []appid.Installed {
	root := steamRoot()
	if root == "" {
		return nil
	}
	folders, _ := os.ReadFile(filepath.Join(root, "steamapps", "libraryfolders.vdf"))
	var apps []appid.Installed
	for _, library := range appid.SteamLibraries(folders, root) {
		manifests, _ := filepath.Glob(filepath.Join(library, "steamapps", "appmanifest_*.acf"))
		for _, path := range manifests {
			data, err := os.ReadFile(path)
			if err != nil || len(data) > 1<<20 {
				continue
			}
			game, ok := appid.ParseSteamManifest(data, library)
			if !ok {
				continue
			}
			if _, err := os.Stat(game.Dir); err != nil {
				continue
			}
			apps = append(apps, game.Installed())
		}
	}
	return apps
}

// under says whether path is inside dir (both Windows paths, compared without case).
func under(path, dir string) bool {
	if path == "" || dir == "" {
		return false
	}
	p, d := strings.ToLower(filepath.Clean(path)), strings.ToLower(strings.TrimRight(filepath.Clean(dir), `\`))
	return strings.HasPrefix(p, d+`\`)
}
