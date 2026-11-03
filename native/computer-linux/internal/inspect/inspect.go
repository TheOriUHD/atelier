// Package inspect shapes what the accessibility tree (AT-SPI) tells about an element into inspect.point and
// inspect.focused's answer (the reading itself is internal/atspi's).
package inspect

import (
	"strings"

	"atelier.dev/computer-linux/internal/proto"
)

// Element is what was read of an accessible element.
type Element struct {
	PID int
	// Role is AT-SPI's name for the role: "push button", "password text", "link", "text".
	Role  string
	Name  string
	Value string
	// Password: the element is a password field (role "password text").
	Password bool
	// Link: the element or one of its 3 nearest ancestors is a hyperlink: its address ('' when it has none).
	Link *string
}

// Title is the name, else a short value (not a password field's), at most 200 characters.
func Title(name, value string, secure bool) *string {
	candidates := []string{name}
	if !secure && len([]rune(value)) <= 200 {
		candidates = append(candidates, value)
	}
	for _, c := range candidates {
		text := strings.TrimSpace(c)
		if text == "" {
			continue
		}
		if r := []rune(text); len(r) > 200 {
			text = string(r[:200])
		}
		return &text
	}
	return nil
}

// Describe is the wire result for an element (nil: nothing known about it, only whose window it is).
func Describe(el *Element, app *proto.App) proto.InspectResult {
	if el == nil {
		return proto.InspectResult{App: app}
	}
	var role *string
	if el.Role != "" {
		r := el.Role
		role = &r
	}
	return proto.InspectResult{
		App:    app,
		Role:   role,
		Title:  Title(el.Name, el.Value, el.Password),
		Secure: el.Password,
		Link:   el.Link,
	}
}
