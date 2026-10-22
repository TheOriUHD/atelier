package notices

import (
	"strings"
	"testing"
)

func TestTheLicensesAreEmbedded(t *testing.T) {
	for _, want := range []string{"github.com/charmbracelet/bubbletea", "Permission is hereby granted"} {
		if !strings.Contains(Text, want) {
			t.Errorf("the embedded notices lack %q", want)
		}
	}
}
