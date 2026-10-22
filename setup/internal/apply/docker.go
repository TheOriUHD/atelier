package apply

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// DockerFix is what the wizard can do about Docker on a Linux machine where it runs as root.
type DockerFix string

const (
	// InstallDocker runs Docker's own installer (get.docker.com): the engine, the CLI and the Compose plugin.
	InstallDocker DockerFix = "install"
	// StartDocker starts the daemon of a Docker that is installed but not running.
	StartDocker DockerFix = "start"
	// InstallCompose adds the Compose plugin to a Docker that lacks it.
	InstallCompose DockerFix = "compose"
)

// DockerStep is one step of a fix, as the screen lists it.
type DockerStep struct {
	ID, Title string
	command   string
}

const getDocker = "/tmp/atelier-get-docker.sh"

// startDocker starts the daemon with systemd where systemd runs (not in every container or WSL), else with its init
// script or by itself, and waits until it answers.
const startDocker = "if [ -d /run/systemd/system ]; then systemctl enable --now docker; " +
	"elif command -v service >/dev/null 2>&1 && [ -x /etc/init.d/docker ]; then service docker start; " +
	"else (nohup dockerd >/var/log/dockerd.log 2>&1 &); fi; " +
	"for i in $(seq 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; echo 'Docker did not answer within a minute' >&2; exit 1"

const addCompose = "if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && (apt-get install -y -qq docker-compose-plugin || apt-get install -y -qq docker-compose-v2); " +
	"elif command -v dnf >/dev/null 2>&1; then dnf install -y -q docker-compose-plugin; " +
	"elif command -v yum >/dev/null 2>&1; then yum install -y -q docker-compose-plugin; " +
	"else echo 'no apt-get, dnf or yum here: install the Docker Compose plugin by hand' >&2; exit 1; fi"

// DockerSteps lists what a fix does.
func DockerSteps(fix DockerFix) []DockerStep {
	switch fix {
	case InstallDocker:
		return []DockerStep{
			{ID: "get", Title: "Download Docker's installer", command: "curl -fsSL https://get.docker.com -o " + getDocker},
			{ID: "install", Title: "Install Docker", command: "sh " + getDocker + " && rm -f " + getDocker},
			{ID: "start", Title: "Start Docker", command: startDocker},
		}
	case StartDocker:
		return []DockerStep{{ID: "start", Title: "Start Docker", command: startDocker}}
	case InstallCompose:
		return []DockerStep{{ID: "compose", Title: "Install Docker Compose", command: addCompose}}
	}
	return nil
}

// FixDocker runs a fix step by step, reporting like Execute does.
func FixDocker(ctx context.Context, o Options, fix DockerFix, emit func(Event)) error {
	o.defaults()
	for _, s := range DockerSteps(fix) {
		emit(Event{Step: s.ID, Kind: "start", Text: s.Title})
		var lines []string
		if err := o.Run(ctx, "/", "sh", []string{"-c", s.command}, func(line string) {
			lines = append(lines, line)
			emit(Event{Step: s.ID, Kind: "log", Text: line})
		}); err != nil {
			if why := lastProblem(lines); why != "" {
				err = errors.New(why)
			}
			err = fmt.Errorf("%s failed: %w", strings.ToLower(s.Title[:1])+s.Title[1:], err)
			emit(Event{Step: s.ID, Kind: "fail", Err: err})
			return err
		}
		emit(Event{Step: s.ID, Kind: "done"})
	}
	return nil
}

// DockerActivity turns a line of Docker's installer (it echoes each command it runs, prefixed with "+ ") into what is
// happening, in words; ok is false for lines that say nothing new.
func DockerActivity(line string) (string, bool) {
	l := strings.TrimSpace(line)
	if !strings.HasPrefix(l, "+ ") {
		return "", false
	}
	switch {
	case strings.Contains(l, "docker version"):
		return "Checking Docker", true
	case strings.Contains(l, "docker-ce") || strings.Contains(l, "containerd.io"):
		return "Installing Docker Engine, the CLI and Compose", true
	case strings.Contains(l, "gpg") || strings.Contains(l, "keyrings") || strings.Contains(l, "sources.list") || strings.Contains(l, ".repo") || strings.Contains(l, "config-manager"):
		return "Adding Docker's package source", true
	case strings.Contains(l, "update"):
		return "Updating the package lists", true
	case strings.Contains(l, "install"):
		return "Installing what Docker needs", true
	}
	return "", false
}
