package bg

// UI Automation control types (UIAutomationClient.h) a background click decides by.
const (
	CTButton      = 50000
	CTCheckBox    = 50002
	CTHyperlink   = 50005
	CTImage       = 50006
	CTListItem    = 50007
	CTMenuItem    = 50011
	CTRadioButton = 50013
	CTTabItem     = 50019
	CTText        = 50020
)

// Pattern is a UI Automation control pattern a plain left click can be done by.
type Pattern int

const (
	Invoke Pattern = iota + 1
	Toggle
	SelectItem
)

func (p Pattern) String() string {
	switch p {
	case Invoke:
		return "Invoke"
	case Toggle:
		return "Toggle"
	case SelectItem:
		return "SelectionItem"
	}
	return "none"
}

// ClickPatterns are the patterns that do what a single left click does on an element of this control type, in order
// of preference: Invoke for buttons, links and menu items (Toggle for a toggle button), Toggle for checkboxes,
// SelectionItem for tabs, list items and radio buttons. None for anything else, where the click's point matters (a
// text field, a canvas, a tree item's expander): those get mouse messages.
func ClickPatterns(controlType int) []Pattern {
	switch controlType {
	case CTButton:
		return []Pattern{Invoke, Toggle}
	case CTHyperlink, CTMenuItem:
		return []Pattern{Invoke}
	case CTCheckBox:
		return []Pattern{Toggle}
	case CTTabItem, CTListItem, CTRadioButton:
		return []Pattern{SelectItem}
	}
	return nil
}

// PassThrough: an element a click on is a click on its parent: the text or the image inside a button or a link.
func PassThrough(controlType int) bool { return controlType == CTText || controlType == CTImage }

// ClickAncestors is how many levels up from the element at the point a click looks for one of ClickPatterns' controls,
// through PassThrough elements only.
const ClickAncestors = 3
