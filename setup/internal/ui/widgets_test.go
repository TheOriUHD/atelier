package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// The note for the highlighted choice sits under the list, apart from it, and the list does not move or change height
// as the highlight does.
func TestChoiceNoteSitsApartAndKeepsTheLayoutStill(t *testing.T) {
	c := newChoice([]option{
		{Value: "a", Label: "First choice", Desc: "A short note."},
		{Value: "b", Label: "Second choice", Desc: "A much longer note that has to wrap onto a second line when the box is narrow, so the heights differ."},
		{Value: "c", Label: "Third choice"},
	}, "a")
	first := c.view(40)
	c.update(tea.KeyMsg{Type: tea.KeyDown})
	second := c.view(40)
	c.update(tea.KeyMsg{Type: tea.KeyDown})
	third := c.view(40)

	for name, v := range map[string]string{"first": first, "second": second, "third": third} {
		lines := strings.Split(v, "\n")
		if got, want := len(lines), len(strings.Split(first, "\n")); got != want {
			t.Errorf("%s: %d lines, want %d (the layout moved)", name, got, want)
		}
		// The three options come first, then a blank line and a rule, then the note.
		if !strings.Contains(lines[0], "First choice") || !strings.Contains(lines[1], "Second choice") || !strings.Contains(lines[2], "Third choice") {
			t.Errorf("%s: the options are not the first three lines:\n%s", name, v)
		}
		if lines[3] != "" || !strings.HasPrefix(lines[4], "─") {
			t.Errorf("%s: no blank line and rule between the options and the note:\n%s", name, v)
		}
	}
	if !strings.Contains(first, "A short note.") || strings.Contains(first, "much longer note") {
		t.Errorf("first shows the wrong note:\n%s", first)
	}
	if !strings.Contains(second, "much longer note") || strings.Contains(second, "A short note.") {
		t.Errorf("second shows the wrong note:\n%s", second)
	}
	if strings.Contains(third, "note") {
		t.Errorf("third has no note but shows one:\n%s", third)
	}
}

// A list where no row has a note draws no rule at all.
func TestChoiceWithoutNotesDrawsNoRule(t *testing.T) {
	c := newChoice([]option{{Value: "a", Label: "One"}, {Value: "b", Label: "Two"}}, "a")
	if v := c.view(40); strings.Contains(v, "─") {
		t.Errorf("a rule under a list without notes:\n%s", v)
	}
}
