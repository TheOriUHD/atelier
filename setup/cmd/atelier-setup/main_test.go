package main

import (
	"flag"
	"testing"

	"atelier.dev/setup/internal/plan"
)

func parse(t *testing.T, args ...string) answersFlags {
	t.Helper()
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	var f answersFlags
	f.register(fs)
	if err := fs.Parse(args); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestFlagsBecomeAnswers(t *testing.T) {
	a := parse(t, "--mode", "proxy", "--url", "atelier.example.com/", "--bind", "127.0.0.1", "--port", "8080", "--proxy-addr", "10.0.0.1", "--no-updater", "--tag", "v0.2.2", "--dir", "/srv/atelier").answers()
	if a.Mode != plan.OwnProxy || a.PublicURL != "https://atelier.example.com" || a.Port != 8080 || a.BindAddr != "127.0.0.1" {
		t.Errorf("answers = %+v", a)
	}
	if !a.Sandbox || a.Updater || a.Images.Tag != "v0.2.2" || a.Dir != "/srv/atelier" || a.ProxyAddrs != "10.0.0.1" || a.SetupToken == "" {
		t.Errorf("answers = %+v", a)
	}
	if _, err := plan.Build(a); err != nil {
		t.Errorf("the answers do not make a plan: %v", err)
	}
}

func TestLANListensOnAllAddressesAndLocalImagesNeedNoRegistry(t *testing.T) {
	a := parse(t, "--mode", "lan", "--local-images", "--bind", "127.0.0.1").answers()
	if a.BindAddr != "0.0.0.0" || !a.Images.Local {
		t.Errorf("answers = %+v", a)
	}
	if parse(t).images() != nil {
		t.Error("no image flags still overrides the defaults")
	}
	if img := parse(t, "--registry", "registry.example.com/me").images(); img == nil || img.Prefix != "registry.example.com/me" || img.Tag != "latest" {
		t.Errorf("images = %+v", img)
	}
}
