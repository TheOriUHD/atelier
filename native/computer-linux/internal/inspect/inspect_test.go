package inspect

import (
	"strings"
	"testing"

	"atelier.dev/computer-linux/internal/proto"
)

func TestDescribeWithoutAnElementOnlyNamesTheApp(t *testing.T) {
	app := &proto.App{ID: "xterm", Name: "XTerm"}
	got := Describe(nil, app)
	if got.App != app || got.Role != nil || got.Title != nil || got.Secure || got.Link != nil {
		t.Errorf("%+v", got)
	}
}

func TestAPasswordFieldIsSecureAndNeverReadsItsValue(t *testing.T) {
	got := Describe(&Element{Role: "password text", Name: "", Value: "hunter2", Password: true}, nil)
	if !got.Secure || got.Title != nil {
		t.Errorf("a password field: %+v", got)
	}
	named := Describe(&Element{Role: "password text", Name: "Password", Value: "hunter2", Password: true}, nil)
	if named.Title == nil || *named.Title != "Password" {
		t.Errorf("its label is fine: %+v", named)
	}
}

func TestTitleIsTheNameElseAShortValue(t *testing.T) {
	if got := Title("", "short", false); got == nil || *got != "short" {
		t.Errorf("value: %v", got)
	}
	if got := Title("", strings.Repeat("x", 201), false); got != nil {
		t.Errorf("a long value is no title: %v", *got)
	}
	if got := Title(strings.Repeat("é", 300), "", false); got == nil || len([]rune(*got)) != 200 {
		t.Errorf("a long name is cut to 200 characters")
	}
}

func TestALinkCarriesItsAddress(t *testing.T) {
	url := "https://example.com/"
	got := Describe(&Element{Role: "link", Name: "Example", Link: &url}, nil)
	if got.Link == nil || *got.Link != url || got.Role == nil || *got.Role != "link" {
		t.Errorf("%+v", got)
	}
}
