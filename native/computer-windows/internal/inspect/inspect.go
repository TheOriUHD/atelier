// Package inspect shapes what UI Automation tells about an element into inspect.point / inspect.focused's answer (the
// reading itself is internal/win's).
package inspect

import (
	"strings"

	"atelier.dev/computer-windows/internal/proto"
)

// UI Automation control type ids (UIAutomationClient.h).
const (
	Edit      = 50004
	Hyperlink = 50005
)

var controlTypes = map[int]string{
	50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox", 50004: "Edit", 50005: "Hyperlink",
	50006: "Image", 50007: "ListItem", 50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
	50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar", 50015: "Slider", 50016: "Spinner",
	50017: "StatusBar", 50018: "Tab", 50019: "TabItem", 50020: "Text", 50021: "ToolBar", 50022: "ToolTip",
	50023: "Tree", 50024: "TreeItem", 50025: "Custom", 50026: "Group", 50027: "Thumb", 50028: "DataGrid",
	50029: "DataItem", 50030: "Document", 50031: "SplitButton", 50032: "Window", 50033: "Pane", 50034: "Header",
	50035: "HeaderItem", 50036: "Table", 50037: "TitleBar", 50038: "Separator", 50039: "SemanticZoom",
	50040: "AppBar",
}

// ControlTypeName is a control type's readable name (`Hyperlink`, `Edit`, `Button`); nil for none or one it doesn't
// know.
func ControlTypeName(id int) *string {
	if name, ok := controlTypes[id]; ok {
		return &name
	}
	return nil
}

// Element is what was read of a UI Automation element.
type Element struct {
	PID         int
	ControlType int
	Name        string
	// Value is the element's value (ValuePattern), never read for a password field.
	Value    string
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
	return proto.InspectResult{
		App:    app,
		Role:   ControlTypeName(el.ControlType),
		Title:  Title(el.Name, el.Value, el.Password),
		Secure: el.Password,
		Link:   el.Link,
	}
}
