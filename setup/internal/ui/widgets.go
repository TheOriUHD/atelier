package ui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// option is one line of a choice list.
type option struct {
	Value string
	Label string
	Desc  string
	// Note is shown dim beside a disabled option, saying why it cannot be chosen.
	Note     string
	Disabled bool
}

// choice is a list where one line is picked with the arrow keys.
type choice struct {
	opts   []option
	cursor int
}

func newChoice(opts []option, selected string) choice {
	c := choice{opts: opts}
	for i, o := range opts {
		if o.Value == selected && !o.Disabled {
			c.cursor = i
		}
	}
	c.settle(1)
	return c
}

// settle moves off a disabled line in direction d.
func (c *choice) settle(d int) {
	for n := 0; n < len(c.opts) && c.opts[c.cursor].Disabled; n++ {
		c.cursor = (c.cursor + d + len(c.opts)) % len(c.opts)
	}
}

func (c *choice) update(msg tea.KeyMsg) {
	switch msg.String() {
	case "up", "k":
		c.cursor = (c.cursor - 1 + len(c.opts)) % len(c.opts)
		c.settle(-1)
	case "down", "j":
		c.cursor = (c.cursor + 1) % len(c.opts)
		c.settle(1)
	}
}

func (c choice) selected() option { return c.opts[c.cursor] }

func (c choice) view(width int) string {
	var b strings.Builder
	for i, o := range c.opts {
		marker, label := "  ", styMuted.Render(o.Label)
		switch {
		case o.Disabled:
			label = styFaint.Render(o.Label)
		case i == c.cursor:
			marker, label = styAccent.Render("› "), styTitle.Render(o.Label)
		}
		b.WriteString(marker + label)
		if o.Disabled && o.Note != "" {
			b.WriteString("  " + styFaint.Render("("+o.Note+")"))
		}
		b.WriteString("\n")
	}
	descs := make([]string, len(c.opts))
	for i, o := range c.opts {
		descs[i] = o.Desc
	}
	return strings.TrimRight(b.String(), "\n") + explanation(c.opts[c.cursor].Desc, descs, width)
}

// explanation is the plain-language note for the highlighted row. It sits apart from the list, under a thin rule and in
// a quieter tone, and it keeps the height of the longest note, so the rows above never move and the note is not taken
// for another row. Nothing is drawn when no row has a note.
func explanation(current string, all []string, width int) string {
	lines := 0
	for _, t := range all {
		if t != "" {
			lines = max(lines, strings.Count(wrap(t, width), "\n")+1)
		}
	}
	if lines == 0 {
		return ""
	}
	note := ""
	if current != "" {
		note = styMuted.Render(wrap(current, width))
	}
	// An empty note still takes the line after the rule, so it needs one newline fewer than its height.
	pad := lines - 1
	if current != "" {
		pad = lines - (strings.Count(note, "\n") + 1)
	}
	return "\n\n" + styFaint.Render(strings.Repeat("─", width)) + "\n" + note + strings.Repeat("\n", max(pad, 0))
}

// field is one line of a form: a text input or an on/off switch.
type field struct {
	Key      string
	Label    string
	Help     string
	Toggle   bool
	On       bool
	Input    textinput.Model
	Validate func(string) error
	err      string
}

func textField(key, label, help, value string, secret bool, validate func(string) error) field {
	in := textinput.New()
	in.Prompt = ""
	in.SetValue(value)
	in.CharLimit = 256
	in.Width = 48
	if secret {
		in.EchoMode = textinput.EchoPassword
		in.EchoCharacter = '•'
	}
	return field{Key: key, Label: label, Help: help, Input: in, Validate: validate}
}

func toggleField(key, label, help string, on bool) field {
	return field{Key: key, Label: label, Help: help, Toggle: true, On: on}
}

// form is a list of fields; Tab and the arrow keys move between them.
type form struct {
	fields []field
	focus  int
	// submitOnEnter makes Enter continue from any field, not only the last: for a menu of settings where every
	// row already has an answer, so Enter means "done" and the arrows, typing and Space do the choosing.
	submitOnEnter bool
}

func newForm(fields ...field) *form {
	f := &form{fields: fields}
	f.refocus()
	return f
}

func (f *form) refocus() {
	for i := range f.fields {
		if f.fields[i].Toggle {
			continue
		}
		if i == f.focus {
			f.fields[i].Input.Focus()
		} else {
			f.fields[i].Input.Blur()
		}
	}
}

// update handles a key. It returns true when Enter submits the form: on any field when submitOnEnter is set,
// otherwise on the last one.
func (f *form) update(msg tea.Msg) (submit bool, cmd tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "tab", "down":
			f.focus = (f.focus + 1) % len(f.fields)
			f.refocus()
			return false, nil
		case "shift+tab", "up":
			f.focus = (f.focus - 1 + len(f.fields)) % len(f.fields)
			f.refocus()
			return false, nil
		case "enter":
			if f.submitOnEnter || f.focus == len(f.fields)-1 {
				return true, nil
			}
			f.focus++
			f.refocus()
			return false, nil
		case " ":
			if f.fields[f.focus].Toggle {
				f.fields[f.focus].On = !f.fields[f.focus].On
				return false, nil
			}
		}
	}
	cur := &f.fields[f.focus]
	if cur.Toggle {
		return false, nil
	}
	cur.err = ""
	cur.Input, cmd = cur.Input.Update(msg)
	return false, cmd
}

// check runs every validator; it returns false (and marks the fields) when something is wrong.
func (f *form) check() bool {
	ok := true
	for i := range f.fields {
		fl := &f.fields[i]
		fl.err = ""
		if fl.Toggle || fl.Validate == nil {
			continue
		}
		if err := fl.Validate(fl.Input.Value()); err != nil {
			fl.err = err.Error()
			if ok {
				f.focus = i
				f.refocus()
			}
			ok = false
		}
	}
	return ok
}

func (f *form) value(key string) string {
	for _, fl := range f.fields {
		if fl.Key == key {
			return strings.TrimSpace(fl.Input.Value())
		}
	}
	return ""
}

func (f *form) raw(key string) string {
	for _, fl := range f.fields {
		if fl.Key == key {
			return fl.Input.Value()
		}
	}
	return ""
}

func (f *form) on(key string) bool {
	for _, fl := range f.fields {
		if fl.Key == key {
			return fl.On
		}
	}
	return false
}

func (f *form) view(width int) string {
	var b strings.Builder
	for i, fl := range f.fields {
		focused := i == f.focus
		label := styMuted.Render(fl.Label)
		if focused {
			label = styTitle.Render(fl.Label)
		}
		if fl.Toggle {
			box, marker := styFaint.Render("[ ]"), "  "
			switch {
			case fl.On && focused:
				box = styAccent.Render("[✓]")
			case fl.On:
				box = styGood.Render("[✓]")
			case focused:
				box = styAccent.Render("[ ]")
			}
			if focused {
				marker = styAccent.Render("› ")
			}
			b.WriteString(marker + box + " " + label + "\n")
		} else {
			b.WriteString(label + "\n")
			line := fl.Input.View()
			if focused {
				line = styAccent.Render("› ") + line
			} else {
				line = "  " + styCode.Render(line)
			}
			b.WriteString(line + "\n")
		}
		if fl.err != "" {
			b.WriteString("  " + styBad.Render("✗ "+fl.err) + "\n")
		}
		b.WriteString("\n")
	}
	helps := make([]string, len(f.fields))
	for i, fl := range f.fields {
		helps[i] = fl.Help
	}
	return strings.TrimRight(b.String(), "\n") + explanation(f.fields[f.focus].Help, helps, width)
}
