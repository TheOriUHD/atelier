package appid

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

const firefox = `# a comment
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox Web Browser
Name[de]=Firefox Webbrowser
Name[de_DE]=Firefox Webbrowser (DE)
Exec=env MOZ_ENABLE_WAYLAND=1 "/opt/fire fox/firefox" --new-window %u
StartupWMClass=firefox
Categories=Network;WebBrowser;

[Desktop Action new-window]
Name=New Window
Exec=firefox --new-window
`

func TestParseEntry(t *testing.T) {
	e, ok := ParseEntry("org.mozilla.firefox", []byte(firefox), []string{"de_DE", "de"})
	if !ok {
		t.Fatal("not an application")
	}
	if e.Name != "Firefox Webbrowser (DE)" || e.WMClass != "firefox" || !slices.Equal(e.Categories, []string{"Network", "WebBrowser"}) {
		t.Errorf("%+v", e)
	}
	// The action's Exec in the second group does not replace the entry's.
	if !slices.Equal(e.Exec, []string{"env", "MOZ_ENABLE_WAYLAND=1", "/opt/fire fox/firefox", "--new-window"}) {
		t.Errorf("exec %q", e.Exec)
	}
	plain, _ := ParseEntry("x", []byte(firefox), nil)
	if plain.Name != "Firefox Web Browser" {
		t.Errorf("untranslated: %q", plain.Name)
	}
	for _, not := range []string{"[Desktop Entry]\nType=Link\nName=A\nURL=x\n", "[Desktop Entry]\nType=Application\nName=A\n", "nothing"} {
		if _, ok := ParseEntry("x", []byte(not), nil); ok {
			t.Errorf("%q parsed as an application", not)
		}
	}
}

func TestSplitExecDropsFieldCodesAndKeepsQuotes(t *testing.T) {
	cases := map[string][]string{
		`vlc --started-from-file %U`:         {"vlc", "--started-from-file"},
		`"/usr/bin/my app" "a \"quoted\" b"`: {"/usr/bin/my app", `a "quoted" b`},
		`sh -c "echo 100%%"`:                 {"sh", "-c", "echo 100%"},
		`app %f %i %c %k`:                    {"app"},
		`app  two   spaces`:                  {"app", "two", "spaces"},
	}
	for in, want := range cases {
		if got := SplitExec(in); !slices.Equal(got, want) {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
}

func TestLocales(t *testing.T) {
	if got := Locales("", "de_DE.UTF-8@euro", "C"); !slices.Equal(got, []string{"de_DE", "de"}) {
		t.Errorf("%v", got)
	}
}

func TestDataDirsListTheUsersFirst(t *testing.T) {
	env := map[string]string{"HOME": "/home/a", "XDG_DATA_DIRS": "/usr/share:/usr/local/share"}
	dirs := DataDirs(func(k string) string { return env[k] })
	if dirs[0] != "/home/a/.local/share" || !slices.Contains(dirs, "/usr/share") || !slices.Contains(dirs, "/var/lib/flatpak/exports/share") {
		t.Errorf("%v", dirs)
	}
}

func entries() *Index {
	parse := func(id, class, exec string) Entry {
		e, _ := ParseEntry(id, []byte("[Desktop Entry]\nType=Application\nName="+id+"\nExec="+exec+"\nStartupWMClass="+class+"\n"), nil)
		return e
	}
	return NewIndex([]Entry{
		parse("org.mozilla.firefox", "", "firefox %u"),
		parse("org.keepassxc.KeePassXC", "", "keepassxc %f"),
		parse("code", "Code", "/usr/share/code/code --no-sandbox %F"),
		parse("idle3", "", "python3 -m idlelib"),
		parse("org.gnome.Terminal", "", "gnome-terminal"),
	})
}

func TestMatchTriesTheStrongestEvidenceFirst(t *testing.T) {
	ix := entries()
	cases := []struct {
		w    Window
		want string
	}{
		{Window{GtkAppID: "org.gnome.Terminal"}, "org.gnome.Terminal"},
		{Window{DesktopFile: "org.keepassxc.KeePassXC.desktop"}, "org.keepassxc.KeePassXC"},
		{Window{Class: "Code"}, "code"},
		{Window{Class: "org.mozilla.firefox"}, "org.mozilla.firefox"},
		{Window{Class: "Firefox", Instance: "Navigator"}, "org.mozilla.firefox"},
		{Window{Class: "KeePassXC"}, "org.keepassxc.KeePassXC"},
		{Window{Exe: "gnome-terminal-server", Class: "Gnome-terminal"}, "org.gnome.Terminal"},
		{Window{Exe: "keepassxc"}, "org.keepassxc.KeePassXC"},
	}
	for _, c := range cases {
		got, ok := ix.Match(c.w)
		if !ok || got.ID != c.want {
			t.Errorf("%+v: %q %v, want %q", c.w, got.ID, ok, c.want)
		}
	}
	// A runtime that runs anything says nothing about the app.
	if got, ok := ix.Match(Window{Exe: "python3", Class: "Whatever"}); ok {
		t.Errorf("python3 matched %q", got.ID)
	}
	if got, ok := ix.Match(Window{Exe: "python3", Class: "idle3"}); !ok || got.ID != "idle3" {
		t.Errorf("a class still matches: %+v %v", got, ok)
	}
}

func TestIdentityWithoutAnEntryIsTheWindowClass(t *testing.T) {
	if id, name := Identity(nil, Window{Class: "XTerm", Instance: "xterm", Exe: "xterm"}); id != "xterm" || name != "XTerm" {
		t.Errorf("%q %q", id, name)
	}
	if id, name := Identity(nil, Window{Exe: "Weird"}); id != "weird" || name != "Weird" {
		t.Errorf("%q %q", id, name)
	}
	e := Entry{ID: "org.mozilla.firefox", Name: "Firefox"}
	if id, name := Identity(&e, Window{Class: "x"}); id != "org.mozilla.firefox" || name != "Firefox" {
		t.Errorf("%q %q", id, name)
	}
}

func TestInstalledAppsLeaveOutWhatMenusDoNot(t *testing.T) {
	list := InstalledApps([]Entry{
		{ID: "a", Name: "A"}, {ID: "A", Name: "dup"}, {ID: "h", Name: "H", Hidden: true}, {ID: "n", Name: "N", NoDisplay: true}, {ID: "t", Name: "T", Terminal: true},
	})
	if len(list) != 1 || list[0].ID != "a" {
		t.Errorf("%+v", list)
	}
}

func TestMergeKeepsOneEntryPerIdWithTheRunningOneWinning(t *testing.T) {
	apps := Merge(
		[]Running{{ID: "Firefox", Name: "Firefox", PID: 4, Active: true}},
		[]Installed{{ID: "firefox", Name: "Firefox (menu)", Path: "/usr/share/applications/firefox.desktop"}, {ID: "alpha", Name: "Alpha"}},
	)
	if len(apps) != 2 || apps[0].ID != "alpha" || apps[1].ID != "Firefox" || !apps[1].Running || apps[1].Path == nil {
		t.Errorf("%+v", apps)
	}
	if apps[0].Running || apps[0].PID != nil {
		t.Errorf("an installed app isn't running: %+v", apps[0])
	}
}

func TestLoadEntriesReadsFoldersInPriorityOrderWithSubfolders(t *testing.T) {
	home, system := t.TempDir(), t.TempDir()
	write := func(root, name, body string) {
		path := filepath.Join(root, "applications", name)
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	app := func(name string) string { return "[Desktop Entry]\nType=Application\nName=" + name + "\nExec=x\n" }
	write(home, "one.desktop", app("One (user)"))
	write(system, "one.desktop", app("One (system)"))
	write(system, "kde/two.desktop", app("Two"))
	write(system, "readme.txt", "no")
	env := map[string]string{"XDG_DATA_HOME": home, "XDG_DATA_DIRS": system}
	list := LoadEntries(func(k string) string { return env[k] }, nil)
	names := map[string]string{}
	for _, e := range list {
		names[e.ID] = e.Name
	}
	if names["one"] != "One (user)" || names["kde-two"] != "Two" || len(list) != 2 {
		t.Errorf("%v", names)
	}
}
