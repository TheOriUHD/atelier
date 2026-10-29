package inspect

import (
	"strings"
	"testing"

	"atelier.dev/computer-windows/internal/proto"
)

func TestControlTypeNames(t *testing.T) {
	for id, want := range map[int]string{50000: "Button", Edit: "Edit", Hyperlink: "Hyperlink", 50033: "Pane", 50040: "AppBar"} {
		if got := ControlTypeName(id); got == nil || *got != want {
			t.Errorf("%d: %v", id, got)
		}
	}
	if ControlTypeName(0) != nil || ControlTypeName(49999) != nil {
		t.Error("an unknown control type has no name")
	}
}

func TestTitle(t *testing.T) {
	str := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	cases := []struct {
		name, value string
		secure      bool
		want        string
	}{
		{"Save", "v", false, "Save"},
		{"  ", "hello", false, "hello"},
		{"", "hunter2", true, "<nil>"}, // A password field's value is never a title.
		{"Password", "hunter2", true, "Password"},
		{"", strings.Repeat("a", 201), false, "<nil>"}, // A long value (a document) isn't one either.
		{strings.Repeat("t", 500), "", false, strings.Repeat("t", 200)},
	}
	for _, c := range cases {
		if got := str(Title(c.name, c.value, c.secure)); got != c.want {
			t.Errorf("%q %q %v: %q", c.name, c.value, c.secure, got)
		}
	}
}

func TestDescribe(t *testing.T) {
	app := &proto.App{ID: "chrome.exe", Name: "Google Chrome"}
	field := &Element{PID: 1, ControlType: Edit, Name: "Password", Value: "", Password: true}
	r := Describe(field, app)
	if !r.Secure || r.Role == nil || *r.Role != "Edit" || r.Link != nil || r.App != app || *r.Title != "Password" {
		t.Errorf("password field: %+v", r)
	}
	empty := ""
	link := &Element{PID: 1, ControlType: 50020, Name: "Docs", Link: &empty}
	if r := Describe(link, nil); r.Link == nil || *r.Link != "" || *r.Role != "Text" {
		t.Errorf("text in a link without an address: %+v", r)
	}
	if r := Describe(nil, app); r.Secure || r.Role != nil || r.Title != nil || r.Link != nil || r.App != app {
		t.Errorf("nothing known: %+v", r)
	}
}
