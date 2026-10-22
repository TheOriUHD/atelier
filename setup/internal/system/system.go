// Package system looks at the machine the server will run on: Docker, free ports, disk, memory, Ollama, Tailscale. The
// wizard shows the result as checks and fills in sensible defaults from it.
package system

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Runner runs commands; tests replace it.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// ExecRunner runs real commands.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// Status of a check.
type Status int

const (
	OK Status = iota
	Warn
	Bad
)

// Check is one line of the "Looking at this machine" screen.
type Check struct {
	Name   string
	Status Status
	Detail string
	// Fix says what to do when the check is not OK.
	Fix string
}

// Info is what was found.
type Info struct {
	OS, Arch, Distro string
	Hostname         string
	Root             bool
	Home             string
	Docker           Docker
	// PortsBusy lists ports that already have something listening.
	PortsBusy  []int
	DiskFreeGB float64
	MemGB      float64
	// Ollama is the address Ollama answers on, or "".
	Ollama    string
	Tailscale Tailscale
	// Addrs are this machine's private IPv4 addresses.
	Addrs []string
	// Existing is an Atelier server already on this machine (running or stopped), found from its containers, or nil.
	Existing *Install
}

// Install is an Atelier server found on this machine.
type Install struct {
	// Dir is the folder of its Compose project, Project the project's name.
	Dir, Project string
	Image        string
	// Running is true when its server container is up.
	Running bool
	// Ports are the host ports its containers publish.
	Ports []int
	// Managed is true when atelier-setup wrote its compose file: only then may setup replace it.
	Managed bool
}

// Docker is the state of Docker.
type Docker struct {
	Installed bool
	// Access is true when the Docker daemon answers for this user.
	Access     bool
	AccessErr  string
	Version    string
	Compose    string
	InstallNow bool
}

// Tailscale is the state of the Tailscale client.
type Tailscale struct {
	Installed bool
	Running   bool
	// DNSName is this machine's name on the tailnet, e.g. box.tail1234.ts.net, without the trailing dot.
	DNSName string
	// HTTPS is true when the tailnet has HTTPS certificates enabled.
	HTTPS bool
}

// Probe looks at the machine. dir is where the install would go (for free disk space); ports are the ones to test.
func Probe(ctx context.Context, r Runner, dir string, ports []int) Info {
	info := Info{OS: runtime.GOOS, Arch: runtime.GOARCH, Root: os.Geteuid() == 0}
	info.Hostname, _ = os.Hostname()
	if u, err := user.Current(); err == nil {
		info.Home = u.HomeDir
	}
	info.Distro = distro()
	info.Docker = probeDocker(ctx, r)
	for _, p := range ports {
		if listening(p) {
			info.PortsBusy = append(info.PortsBusy, p)
		}
	}
	info.DiskFreeGB = diskFreeGB(dir)
	info.MemGB = memGB(ctx, r)
	info.Ollama = ollama(ctx)
	info.Tailscale = probeTailscale(ctx, r)
	info.Addrs = privateAddrs()
	if info.Docker.Access {
		info.Existing = FindInstall(ctx, r)
		if info.Existing != nil {
			// Its own containers hold their ports: those are not a conflict.
			info.PortsBusy = withoutPorts(info.PortsBusy, info.Existing.Ports)
		}
	}
	return info
}

func distro() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	return parseOSRelease(string(b))
}

func parseOSRelease(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return ""
}

func probeDocker(ctx context.Context, r Runner) Docker {
	d := Docker{}
	if _, err := exec.LookPath("docker"); err != nil {
		return d
	}
	d.Installed = true
	out, err := r.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	if err != nil {
		d.AccessErr = out
		return d
	}
	d.Access, d.Version = true, out
	if v, err := r.Run(ctx, "docker", "compose", "version", "--short"); err == nil {
		d.Compose = v
	}
	return d
}

// PortBusy reports whether something on this machine already listens on the port.
func PortBusy(port int) bool { return listening(port) }

func listening(port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func diskFreeGB(dir string) float64 {
	for d := dir; d != "/" && d != "."; d = parent(d) {
		var st unix.Statfs_t
		if err := unix.Statfs(d, &st); err == nil {
			return float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
		}
	}
	var st unix.Statfs_t
	if err := unix.Statfs("/", &st); err == nil {
		return float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
	}
	return 0
}

func parent(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

func memGB(ctx context.Context, r Runner) float64 {
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		return parseMemInfo(string(b))
	}
	if out, err := r.Run(ctx, "sysctl", "-n", "hw.memsize"); err == nil {
		if n, err := strconv.ParseFloat(out, 64); err == nil {
			return n / (1 << 30)
		}
	}
	return 0
}

func parseMemInfo(text string) float64 {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				if kb, err := strconv.ParseFloat(f[1], 64); err == nil {
					return kb / (1 << 20)
				}
			}
		}
	}
	return 0
}

func ollama(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:11434/api/version", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return ""
	}
	return "http://127.0.0.1:11434"
}

func probeTailscale(ctx context.Context, r Runner) Tailscale {
	t := Tailscale{}
	if _, err := exec.LookPath("tailscale"); err != nil {
		return t
	}
	t.Installed = true
	out, err := r.Run(ctx, "tailscale", "status", "--json")
	if err != nil {
		return t
	}
	return parseTailscale(out, t)
}

func parseTailscale(out string, t Tailscale) Tailscale {
	var s struct {
		BackendState string
		Self         struct{ DNSName string }
		CertDomains  []string
	}
	if json.Unmarshal([]byte(out), &s) != nil {
		return t
	}
	t.Running = s.BackendState == "Running"
	t.DNSName = strings.TrimSuffix(s.Self.DNSName, ".")
	t.HTTPS = len(s.CertDomains) > 0
	return t
}

func privateAddrs() []string {
	var out []string
	seen := map[string]bool{}
	add := func(ip net.IP) {
		if ip == nil || ip.To4() == nil || ip.IsLoopback() || !ip.IsPrivate() || seen[ip.String()] {
			return
		}
		seen[ip.String()] = true
		out = append(out, ip.String())
	}
	// The address this machine uses to reach other machines comes first (nothing is sent: a UDP "connection" only picks a route).
	if c, err := net.Dial("udp", "192.0.2.1:9"); err == nil {
		if a, ok := c.LocalAddr().(*net.UDPAddr); ok {
			add(a.IP)
		}
		_ = c.Close()
	}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if virtualInterface(ifc.Name) || ifc.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				add(n.IP)
			}
		}
	}
	return out
}

// virtualInterface is a network made by Docker, a hypervisor or a VPN: its address is not where people reach this machine.
func virtualInterface(name string) bool {
	for _, p := range []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "tailscale", "utun", "lo"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ExistingDir is the folder of the Atelier server on this machine and its image, or "".
func ExistingDir(ctx context.Context, r Runner) (dir, image string) {
	if in := FindInstall(ctx, r); in != nil {
		return in.Dir, in.Image
	}
	return "", ""
}

// FindInstall finds an Atelier server by its Compose service name: both one set up with this program and one set up by hand.
func FindInstall(ctx context.Context, r Runner) *Install {
	out, err := r.Run(ctx, "docker", "ps", "-a", "--filter", "label=com.docker.compose.service=atelier", "--format",
		`{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project"}}|{{.Image}}|{{.State}}|{{.Ports}}`)
	if err != nil {
		return nil
	}
	return parseInstall(out, readFirstLine)
}

func readFirstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 200)
	n, _ := f.Read(buf)
	line, _, _ := strings.Cut(string(buf[:n]), "\n")
	return line
}

// parseInstall reads the lines of `docker ps` for the server service. firstLine reads the first line of a file.
func parseInstall(out string, firstLine func(string) string) *Install {
	for _, line := range strings.Split(out, "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "|", 5)
		if len(f) < 5 || !strings.Contains(f[2], "atelier") {
			continue
		}
		in := &Install{Dir: f[0], Project: f[1], Image: f[2], Running: f[3] == "running", Ports: parsePorts(f[4])}
		if in.Dir != "" {
			in.Managed = strings.HasPrefix(firstLine(filepath.Join(in.Dir, "compose.yaml")), "# Written by atelier-setup")
		}
		return in
	}
	return nil
}

var publishedPort = regexp.MustCompile(`:(\d+)->`)

// parsePorts reads host ports from docker's "0.0.0.0:80->80/tcp, [::]:80->80/tcp, 443/tcp".
func parsePorts(s string) []int {
	var out []int
	seen := map[int]bool{}
	for _, m := range publishedPort.FindAllStringSubmatch(s, -1) {
		if n, err := strconv.Atoi(m[1]); err == nil && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

func withoutPorts(busy, owned []int) []int {
	var out []int
	for _, p := range busy {
		if !contains(owned, p) {
			out = append(out, p)
		}
	}
	return out
}

// InstallCommand starts the setup; with sudo it can install, start and fix Docker by itself.
const InstallCommand = "curl -fsSL https://updates.atelierhq.dev/install | sudo sh"

// DockerFix is what this program can do about Docker here: "install", "start" or "compose", or "" when Docker is fine
// or the fix is not its to make (not Linux, or not running as root).
func DockerFix(info Info) string {
	if info.OS != "linux" || !info.Root {
		return ""
	}
	switch {
	case !info.Docker.Installed:
		return "install"
	case !info.Docker.Access && dockerDown(info):
		return "start"
	case info.Docker.Access && info.Docker.Compose == "":
		return "compose"
	}
	return ""
}

// dockerDown tells a daemon that isn't there from one this user may not use: only the second says "permission denied".
// (The wording of the first changes between Docker versions: "Cannot connect to the Docker daemon", "failed to connect to
// the docker API … if the daemon is running".)
func dockerDown(info Info) bool {
	return !strings.Contains(strings.ToLower(info.Docker.AccessErr), "permission denied")
}

// Checks turns what was found into the lines the wizard shows. Only what stops every install blocks; a port is only a
// problem for the setups that use it, which the wizard checks when they are chosen.
func Checks(info Info) []Check {
	var cs []Check
	cs = append(cs, Check{Name: "System", Status: OK, Detail: fmt.Sprintf("%s, %s", firstNonEmpty(info.Distro, info.OS), info.Arch)})
	fix := DockerFix(info)
	// What to say when this program can't make the fix itself.
	withSudo := "Quit (q) and start the setup with sudo, so it can do this for you:\n" + InstallCommand
	switch {
	case !info.Docker.Installed:
		how := "Atelier runs in Docker. Press Enter to install it with Docker's own installer (get.docker.com)."
		switch {
		case info.OS == "darwin":
			how = "Atelier runs in Docker. Install Docker Desktop or OrbStack, start it, then press R to check again."
		case fix == "":
			how = "Atelier runs in Docker. " + withSudo
		}
		cs = append(cs, Check{Name: "Docker", Status: Bad, Detail: "not installed", Fix: how})
	case !info.Docker.Access && dockerDown(info):
		how := "Press Enter to start it."
		switch {
		case info.OS == "darwin":
			how = "Start Docker Desktop (or OrbStack), then press R to check again."
		case fix == "":
			how = withSudo
		}
		cs = append(cs, Check{Name: "Docker", Status: Bad, Detail: "installed, but not running", Fix: how})
	case !info.Docker.Access:
		cs = append(cs, Check{Name: "Docker", Status: Bad, Detail: "installed, but this user cannot use it", Fix: withSudo + "\nOr add your user to the docker group, log in again and run atelier-setup."})
	default:
		cs = append(cs, Check{Name: "Docker", Status: OK, Detail: "version " + info.Docker.Version})
		if info.Docker.Compose == "" {
			how := "Press Enter to install the Docker Compose plugin."
			if fix == "" {
				how = "Install the docker-compose-plugin package (Compose v2), or " + strings.ToLower(withSudo[:1]) + withSudo[1:]
			}
			cs = append(cs, Check{Name: "Docker Compose", Status: Bad, Detail: "the compose plugin is missing", Fix: how})
		} else {
			cs = append(cs, Check{Name: "Docker Compose", Status: OK, Detail: "version " + info.Docker.Compose})
		}
	}
	if busy := contains(info.PortsBusy, 80) || contains(info.PortsBusy, 443); busy {
		cs = append(cs, Check{Name: "Ports 80, 443", Status: Warn, Detail: "in use by something else", Fix: "Only the \"domain with HTTPS\" choice needs them. The other choices work as they are."})
	}
	switch {
	case info.DiskFreeGB > 0 && info.DiskFreeGB < 5:
		cs = append(cs, Check{Name: "Disk space", Status: Bad, Detail: fmt.Sprintf("%.1f GB free", info.DiskFreeGB), Fix: "Atelier and its images need about 5 GB. Free some space or choose another folder."})
	case info.DiskFreeGB > 0:
		cs = append(cs, Check{Name: "Disk space", Status: OK, Detail: fmt.Sprintf("%.0f GB free", info.DiskFreeGB)})
	}
	switch {
	case info.MemGB > 0 && info.MemGB < 1.5:
		cs = append(cs, Check{Name: "Memory", Status: Warn, Detail: fmt.Sprintf("%.1f GB", info.MemGB), Fix: "Atelier runs best with 2 GB or more, plus what your models need."})
	case info.MemGB > 0:
		cs = append(cs, Check{Name: "Memory", Status: OK, Detail: fmt.Sprintf("%.0f GB", info.MemGB)})
	}
	if info.Ollama != "" {
		cs = append(cs, Check{Name: "Ollama", Status: OK, Detail: "answering on " + info.Ollama})
	}
	if info.Tailscale.Installed {
		d := "installed"
		if info.Tailscale.Running {
			d = "connected as " + info.Tailscale.DNSName
		}
		cs = append(cs, Check{Name: "Tailscale", Status: OK, Detail: d})
	}
	if in := info.Existing; in != nil {
		state := "stopped"
		if in.Running {
			state = "running"
		}
		if in.Managed {
			cs = append(cs, Check{Name: "Earlier setup", Status: Warn, Detail: fmt.Sprintf("an Atelier server set up with this program is here (%s, %s)", in.Dir, state), Fix: "You can reinstall over it and keep its accounts and chats, or remove it and start fresh."})
		} else {
			cs = append(cs, Check{Name: "Existing server", Status: Warn, Detail: fmt.Sprintf("an Atelier server you set up yourself is here (%s, %s)", in.Dir, state), Fix: "Setup will not touch it. Choose other ports if you install next to it."})
		}
	}
	return cs
}

// Blocking reports whether any check stops the install.
func Blocking(cs []Check) bool {
	for _, c := range cs {
		if c.Status == Bad {
			return true
		}
	}
	return false
}

func contains(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
