package appid

import "testing"

const libraryFolders = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps"
		{
			"227300"		"21474836480"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}`

func TestSteamLibraries(t *testing.T) {
	got := SteamLibraries([]byte(libraryFolders), `C:\Program Files (x86)\Steam`)
	want := []string{`C:\Program Files (x86)\Steam`, `D:\SteamLibrary`}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("libraries = %q, want %q", got, want)
	}
}

func TestParseSteamManifest(t *testing.T) {
	acf := []byte(`"AppState"
{
	"appid"		"227300"
	"universe"		"1"
	"name"		"Euro Truck Simulator 2"
	"StateFlags"		"4"
	"installdir"		"Euro Truck Simulator 2"
}`)
	g, ok := ParseSteamManifest(acf, `D:\SteamLibrary\`)
	if !ok || g.AppID != "227300" || g.Name != "Euro Truck Simulator 2" || g.Dir != `D:\SteamLibrary\steamapps\common\Euro Truck Simulator 2` {
		t.Fatalf("game = %+v, %v", g, ok)
	}
	app := g.Installed()
	if app.ID != "startapp:steam://rungameid/227300" || app.AppID != "steam://rungameid/227300" || app.Name != "Euro Truck Simulator 2" {
		t.Fatalf("installed = %+v", app)
	}
	// Steam's own runtimes are no games.
	if _, ok := ParseSteamManifest([]byte(`"AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" "installdir" "Steamworks Shared" }`), `C:\Steam`); ok {
		t.Fatal("a redistributable counted as a game")
	}
}
