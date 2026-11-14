package appid

import (
	"regexp"
	"strings"
)

// Games installed through Steam often have no Start menu entry (or only an internet shortcut, which isn't an exe), so
// they are read from Steam's own lists: steamapps/libraryfolders.vdf names the library folders, and each library's
// steamapps/appmanifest_<id>.acf names a game, its id and its folder under steamapps/common.

// SteamPrefix is the start of a Steam game's launch address, opened through the shell like any URL.
const SteamPrefix = "steam://rungameid/"

// steamTools are Steam's own installs that aren't games: runtimes and redistributables.
var steamTools = map[string]bool{"228980": true, "1070560": true, "1391110": true, "1628350": true, "250820": true}

var (
	vdfPath       = regexp.MustCompile(`"path"\s+"((?:[^"\\]|\\.)*)"`)
	acfAppID      = regexp.MustCompile(`"appid"\s+"(\d+)"`)
	acfName       = regexp.MustCompile(`"name"\s+"((?:[^"\\]|\\.)*)"`)
	acfInstallDir = regexp.MustCompile(`"installdir"\s+"((?:[^"\\]|\\.)*)"`)
)

// vdfString undoes the file's escaping: `\\` for a backslash, `\"` for a quote.
func vdfString(s string) string {
	return strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(s)
}

// SteamLibraries are the library folders in libraryfolders.vdf, Steam's own folder first, each once (without case).
func SteamLibraries(libraryFolders []byte, steamRoot string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimRight(strings.TrimSpace(p), `\/`)
		if p != "" && !seen[strings.ToLower(p)] {
			seen[strings.ToLower(p)] = true
			out = append(out, p)
		}
	}
	add(steamRoot)
	for _, m := range vdfPath.FindAllSubmatch(libraryFolders, -1) {
		add(vdfString(string(m[1])))
	}
	return out
}

// SteamGame is a game an appmanifest names: its Steam id, its name and its folder (under steamapps/common).
type SteamGame struct {
	AppID string
	Name  string
	Dir   string
}

// ParseSteamManifest reads one appmanifest_<id>.acf of the library at `library`; ok is false for Steam's own tools
// and for a manifest without an id, a name or a folder.
func ParseSteamManifest(acf []byte, library string) (SteamGame, bool) {
	id, name, dir := acfAppID.FindSubmatch(acf), acfName.FindSubmatch(acf), acfInstallDir.FindSubmatch(acf)
	if id == nil || name == nil || dir == nil || steamTools[string(id[1])] {
		return SteamGame{}, false
	}
	g := SteamGame{AppID: string(id[1]), Name: strings.TrimSpace(vdfString(string(name[1]))), Dir: strings.TrimRight(library, `\/`) + `\steamapps\common\` + vdfString(string(dir[1]))}
	if g.Name == "" || strings.HasPrefix(strings.ToLower(g.Name), "steamworks") {
		return SteamGame{}, false
	}
	return g, true
}

// Installed is the game as an installed app: opened through Steam by its address, and known by its folder once it runs
// (its exe isn't named anywhere). An internet shortcut Steam put in the Start menu has the same id.
func (g SteamGame) Installed() Installed {
	return Installed{ID: StartAppPrefix + SteamPrefix + g.AppID, Name: g.Name, AppID: SteamPrefix + g.AppID, Dir: g.Dir}
}
