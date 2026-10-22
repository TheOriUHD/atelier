package system

import (
	"strings"
	"testing"
)

func TestParsers(t *testing.T) {
	if got := parseOSRelease("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.5 LTS\"\n"); got != "Ubuntu 24.04.5 LTS" {
		t.Errorf("os-release = %q", got)
	}
	if got := parseMemInfo("MemTotal:       24118868 kB\nMemFree: 1 kB\n"); got < 22.9 || got > 23.1 {
		t.Errorf("meminfo = %v", got)
	}
	ts := parseTailscale(`{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."},"CertDomains":["box.tail1234.ts.net"]}`, Tailscale{Installed: true})
	if !ts.Running || ts.DNSName != "box.tail1234.ts.net" || !ts.HTTPS {
		t.Errorf("tailscale = %+v", ts)
	}
	if off := parseTailscale(`{"BackendState":"Stopped"}`, Tailscale{Installed: true}); off.Running {
		t.Error("a stopped client reads as running")
	}
}

func find(cs []Check, name string) *Check {
	for i := range cs {
		if cs[i].Name == name {
			return &cs[i]
		}
	}
	return nil
}

func TestChecks(t *testing.T) {
	good := Info{OS: "linux", Arch: "amd64", Distro: "Ubuntu 24.04", Docker: Docker{Installed: true, Access: true, Version: "29.1", Compose: "2.40"}, DiskFreeGB: 80, MemGB: 23}
	cs := Checks(good)
	if Blocking(cs) {
		t.Errorf("a good machine blocks: %+v", cs)
	}
	if find(cs, "Ports 80, 443") != nil {
		t.Error("free ports are listed as a problem")
	}

	// A busy port is a note, not a stop: only one of the setups needs 80 and 443.
	busy := good
	busy.PortsBusy = []int{443}
	cs = Checks(busy)
	if c := find(cs, "Ports 80, 443"); c == nil || c.Status != Warn || Blocking(cs) {
		t.Errorf("busy port: %+v (blocking %v)", c, Blocking(cs))
	}

	none := Info{Docker: Docker{}}
	if c := find(Checks(none), "Docker"); c == nil || c.Status != Bad || !strings.Contains(c.Fix, "install") {
		t.Errorf("no docker: %+v", c)
	}
	denied := Info{Docker: Docker{Installed: true, AccessErr: "permission denied while trying to connect to the Docker daemon socket"}}
	if c := find(Checks(denied), "Docker"); c == nil || !strings.Contains(c.Fix, "sudo") {
		t.Errorf("no access: %+v", c)
	}
	stopped := Info{Docker: Docker{Installed: true, AccessErr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"}}
	if c := find(Checks(stopped), "Docker"); c == nil || c.Detail != "installed, but not running" || !strings.Contains(c.Fix, InstallCommand) {
		t.Errorf("stopped docker: %+v", c)
	}

	small := good
	small.DiskFreeGB, small.MemGB = 2, 1
	cs = Checks(small)
	if c := find(cs, "Disk space"); c == nil || c.Status != Bad {
		t.Errorf("disk: %+v", c)
	}
	if c := find(cs, "Memory"); c == nil || c.Status != Warn {
		t.Errorf("memory: %+v", c)
	}
	managed := good
	managed.Existing = &Install{Dir: "/opt/atelier", Image: "atelier:local", Running: true, Managed: true}
	if c := find(Checks(managed), "Earlier setup"); c == nil || c.Status != Warn || !strings.Contains(c.Detail, "running") {
		t.Errorf("managed: %+v", c)
	}
	foreign := good
	foreign.Existing = &Install{Dir: "/home/sam/atelier-server", Image: "atelier:local"}
	c := find(Checks(foreign), "Existing server")
	if c == nil || c.Status != Warn || !strings.Contains(c.Fix, "will not touch it") || Blocking(Checks(foreign)) {
		t.Errorf("foreign: %+v", c)
	}
}

func TestVirtualInterfacesAreNotWherePeopleReachTheMachine(t *testing.T) {
	for _, n := range []string{"docker0", "br-3f2a", "veth12ab", "virbr0", "tailscale0", "lo", "utun4"} {
		if !virtualInterface(n) {
			t.Errorf("%s counts as a real network", n)
		}
	}
	for _, n := range []string{"eth0", "ens18", "enp3s0", "en0", "wlan0"} {
		if virtualInterface(n) {
			t.Errorf("%s counts as virtual", n)
		}
	}
}

func TestFindingAnEarlierInstall(t *testing.T) {
	line := func(dir, state, ports string) string {
		return dir + "|atelier|atelier:local|" + state + "|" + ports
	}
	written := func(path string) string {
		if strings.HasPrefix(path, "/opt/atelier/") {
			return "# Written by atelier-setup. Change it by hand if you like"
		}
		return "services:"
	}
	in := parseInstall(line("/opt/atelier", "running", "0.0.0.0:80->80/tcp, [::]:80->80/tcp, 443/tcp"), written)
	if in == nil || !in.Managed || !in.Running || in.Dir != "/opt/atelier" {
		t.Fatalf("install = %+v", in)
	}
	if len(in.Ports) != 1 || in.Ports[0] != 80 {
		t.Errorf("ports = %v", in.Ports)
	}
	if by := parseInstall(line("/home/sam/atelier-server", "exited", ""), written); by == nil || by.Managed || by.Running {
		t.Errorf("hand-made install = %+v", by)
	}
	if parseInstall("/x|other|nginx:stable|running|", written) != nil {
		t.Error("an unrelated container counts as Atelier")
	}
	if parseInstall("", written) != nil {
		t.Error("nothing running found something")
	}
	if got := withoutPorts([]int{80, 443, 7340}, []int{80, 443}); len(got) != 1 || got[0] != 7340 {
		t.Errorf("without its own ports = %v", got)
	}
}

// Run as root on Linux, the wizard fixes Docker itself and says so; anywhere else it says how to let it.
func TestDockerFixesAreOfferedWhereThisProgramCanMakeThem(t *testing.T) {
	stopped := Docker{Installed: true, AccessErr: "Cannot connect to the Docker daemon. Is the docker daemon running?"}
	for _, c := range []struct {
		name    string
		info    Info
		fix     string
		message string
	}{
		{"missing, root", Info{OS: "linux", Root: true}, "install", "Press Enter to install it"},
		{"missing, user", Info{OS: "linux"}, "", InstallCommand},
		{"missing, Mac", Info{OS: "darwin", Root: true}, "", "Docker Desktop"},
		{"stopped, root", Info{OS: "linux", Root: true, Docker: stopped}, "start", "Press Enter to start it"},
		{"stopped, Docker 29", Info{OS: "linux", Root: true, Docker: Docker{Installed: true, AccessErr: "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory"}}, "start", "Press Enter to start it"},
		{"no compose, root", Info{OS: "linux", Root: true, Docker: Docker{Installed: true, Access: true, Version: "29"}}, "compose", "Press Enter to install the Docker Compose plugin"},
		{"denied, user", Info{OS: "linux", Docker: Docker{Installed: true, AccessErr: "permission denied"}}, "", InstallCommand},
		{"fine", Info{OS: "linux", Root: true, Docker: Docker{Installed: true, Access: true, Version: "29", Compose: "5.6"}}, "", ""},
	} {
		if got := DockerFix(c.info); got != c.fix {
			t.Errorf("%s: fix %q, want %q", c.name, got, c.fix)
		}
		var text string
		for _, ch := range Checks(c.info) {
			if ch.Status == Bad {
				text += ch.Fix
			}
		}
		if !strings.Contains(text, c.message) {
			t.Errorf("%s: %q lacks %q", c.name, text, c.message)
		}
	}
}
