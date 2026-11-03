//go:build linux

package x11

import (
	"os"
	"testing"

	"atelier.dev/computer-linux/internal/helper"
)

// How long the calls the assistant makes most often take against a real server: go test -bench . ./internal/x11
func benchSystem(b *testing.B) *System {
	b.Helper()
	if os.Getenv("DISPLAY") == "" {
		b.Skip("no X display")
	}
	s, err := NewSystem(nil)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(s.Close)
	return s
}

func BenchmarkCaptureScaledJPEG(b *testing.B) {
	s := benchSystem(b)
	displays, _ := s.Displays()
	for i := 0; i < b.N; i++ {
		if _, err := s.Capture(helper.CaptureRequest{Display: displays[0].ID, MaxWidth: 1280, MaxHeight: 800, Format: "jpeg", Quality: 0.8}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCaptureWithMask(b *testing.B) {
	s := benchSystem(b)
	displays, _ := s.Displays()
	for i := 0; i < b.N; i++ {
		if _, err := s.Capture(helper.CaptureRequest{Display: displays[0].ID, HasApps: true, Apps: []string{"one"}, MaxWidth: 1280, MaxHeight: 800, Format: "jpeg", Quality: 0.8}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkAppsRunning(b *testing.B) {
	s := benchSystem(b)
	for i := 0; i < b.N; i++ {
		if _, err := s.Apps(false); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkInspectPoint(b *testing.B) {
	s := benchSystem(b)
	for i := 0; i < b.N; i++ {
		if _, err := s.InspectPoint(300, 200); err != nil {
			b.Fatal(err)
		}
	}
}
