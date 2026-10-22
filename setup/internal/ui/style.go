// Package ui is the full-screen wizard: the look, the small widgets and the screens.
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// The palette follows the app: a warm terracotta on a dark, warm ground.
var (
	accent  = lipgloss.AdaptiveColor{Light: "#B4532F", Dark: "#E0825C"}
	accent2 = lipgloss.AdaptiveColor{Light: "#8A3E21", Dark: "#C6613F"}
	text    = lipgloss.AdaptiveColor{Light: "#2B2723", Dark: "#EDE6DF"}
	muted   = lipgloss.AdaptiveColor{Light: "#7A6F66", Dark: "#9C9087"}
	faint   = lipgloss.AdaptiveColor{Light: "#B5ABA2", Dark: "#5C544E"}
	good    = lipgloss.AdaptiveColor{Light: "#2E7D32", Dark: "#7BC67E"}
	warn    = lipgloss.AdaptiveColor{Light: "#A15C00", Dark: "#E6B450"}
	bad     = lipgloss.AdaptiveColor{Light: "#B3261E", Dark: "#F2766B"}

	styTitle  = lipgloss.NewStyle().Bold(true).Foreground(text)
	styMuted  = lipgloss.NewStyle().Foreground(muted)
	styFaint  = lipgloss.NewStyle().Foreground(faint)
	styAccent = lipgloss.NewStyle().Foreground(accent).Bold(true)
	styGood   = lipgloss.NewStyle().Foreground(good)
	styWarn   = lipgloss.NewStyle().Foreground(warn)
	styBad    = lipgloss.NewStyle().Foreground(bad)
	styCode   = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "#3A332D", Dark: "#D9CFC6"})
	styKey    = lipgloss.NewStyle().Foreground(accent).Bold(true)
	// A screen's own heading: the accent color, centered over a short rule, so it never reads like the lines below it.
	styHeading = lipgloss.NewStyle().Foreground(accent).Bold(true)
)

// bannerLines is the logo: figlet's "standard" lettering, one colour step per line.
var bannerLines = []string{
	`    _  _____ _____ _     ___ _____ ____  `,
	`   / \|_   _| ____| |   |_ _| ____|  _ \ `,
	`  / _ \ | | |  _| | |    | ||  _| | |_) |`,
	` / ___ \| | | |___| |___ | || |___|  _ < `,
	`/_/   \_\_| |_____|_____|___|_____|_| \_\`,
}

var gradient = []lipgloss.AdaptiveColor{
	{Light: "#B4532F", Dark: "#F0A07C"},
	{Light: "#B4532F", Dark: "#E98E68"},
	{Light: "#A24A29", Dark: "#E0825C"},
	{Light: "#8A3E21", Dark: "#D4714B"},
	{Light: "#8A3E21", Dark: "#C6613F"},
}

// Banner is the logo in colour.
func Banner() string {
	out := make([]string, len(bannerLines))
	for i, l := range bannerLines {
		out[i] = lipgloss.NewStyle().Foreground(gradient[i%len(gradient)]).Bold(true).Render(l)
	}
	return strings.Join(out, "\n")
}

// Tagline sits under the logo.
func Tagline() string { return styMuted.Render("your AI workspace, on your own server") }

// steps are the stages shown across the top.
var stepNames = []string{"Machine", "Access", "Options", "Review", "Install", "Finish"}

// breadcrumb draws the stages with the current one lit.
func breadcrumb(current int) string {
	parts := make([]string, len(stepNames))
	for i, n := range stepNames {
		switch {
		case i < current:
			parts[i] = styGood.Render("✓ " + n)
		case i == current:
			parts[i] = styAccent.Render("● " + n)
		default:
			parts[i] = styFaint.Render("○ " + n)
		}
	}
	return strings.Join(parts, styFaint.Render("  ─  "))
}

// frame draws the screen: the logo and breadcrumb on top, the body in a rounded box, the key hints at the bottom, all
// centred in width x height.
func frame(width, height int, step int, title, body, hints string, splash bool) string {
	if width < 20 {
		width = 80
	}
	inner := width - 8
	if inner > 100 {
		inner = 100
	}
	var head string
	if splash {
		head = Banner() + "\n" + Tagline()
	} else {
		head = styAccent.Render("ATELIER") + styFaint.Render("  server setup") + "\n" + breadcrumb(step)
	}
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(faint).Padding(1, 2).Width(inner)
	content := body
	if title != "" {
		// The box's text area: its width less the padding on both sides.
		w := inner - 4
		heading := lipgloss.PlaceHorizontal(w, lipgloss.Center, styHeading.Render(title))
		rule := lipgloss.PlaceHorizontal(w, lipgloss.Center, styFaint.Render(strings.Repeat("─", min(lipgloss.Width(title)+8, w))))
		content = heading + "\n" + rule + "\n\n" + body
	}
	parts := []string{head, "", box.Render(content), "", styMuted.Render(hints)}
	all := lipgloss.JoinVertical(lipgloss.Center, parts...)
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, all)
}

// hint formats "key action" pairs for the footer.
func hint(pairs ...string) string {
	var out []string
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, styKey.Render(pairs[i])+" "+styMuted.Render(pairs[i+1]))
	}
	return strings.Join(out, styFaint.Render("  ·  "))
}

func wrap(s string, width int) string {
	return lipgloss.NewStyle().Width(width).Render(s)
}
