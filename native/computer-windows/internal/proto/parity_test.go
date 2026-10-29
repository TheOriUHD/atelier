package proto

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// proto.go mirrors packages/protocol/src/computer.ts by hand; this keeps the two from drifting apart (like the Swift
// helper's ProtocolParityTests).
func contract(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "protocol", "src", "computer.ts")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("computer.ts not found at %s: %v", path, err)
	}
	return string(data)
}

func block(t *testing.T, text, start string) string {
	t.Helper()
	begin := strings.Index(text, start)
	if begin < 0 {
		t.Fatalf("no %q in computer.ts", start)
	}
	rest := text[begin+len(start):]
	end := strings.Index(rest, "\n}")
	if end < 0 {
		t.Fatalf("no end of %q", start)
	}
	return rest[:end]
}

func sorted(values []string) []string {
	out := slices.Clone(values)
	slices.Sort(out)
	return out
}

func TestMethods(t *testing.T) {
	methods := block(t, contract(t), "export interface ComputerMethods {")
	var names []string
	for _, m := range regexp.MustCompile(`(?m)^\s+'?([A-Za-z.]+)'?: \{ params:`).FindAllStringSubmatch(methods, -1) {
		names = append(names, m[1])
	}
	if len(names) == 0 {
		t.Fatal("found no methods in ComputerMethods")
	}
	if got, want := sorted(Methods), sorted(names); !slices.Equal(got, want) {
		t.Errorf("methods differ\n go: %v\n ts: %v", got, want)
	}
}

func TestErrorCodes(t *testing.T) {
	codes := block(t, contract(t), "export const ComputerErrorCode = {")
	ts := map[string]int{}
	for _, m := range regexp.MustCompile(`(?m)^\s+([A-Za-z]+): (-?\d+),`).FindAllStringSubmatch(codes, -1) {
		n, _ := strconv.Atoi(m[2])
		ts[m[1]] = n
	}
	if len(ts) != len(ErrorCodes) {
		t.Errorf("error codes differ\n go: %v\n ts: %v", ErrorCodes, ts)
	}
	for name, code := range ts {
		if ErrorCodes[name] != code {
			t.Errorf("%s: go %d, ts %d", name, ErrorCodes[name], code)
		}
	}
}

func TestVersion(t *testing.T) {
	m := regexp.MustCompile(`COMPUTER_PROTOCOL_VERSION = (\d+);`).FindStringSubmatch(contract(t))
	if m == nil {
		t.Fatal("no COMPUTER_PROTOCOL_VERSION")
	}
	if m[1] != strconv.Itoa(ProtocolVersion) {
		t.Errorf("version: go %d, ts %s", ProtocolVersion, m[1])
	}
}

func TestNotifications(t *testing.T) {
	var names []string
	for _, m := range regexp.MustCompile(`\{ method: '([A-Za-z.]+)'; params:`).FindAllStringSubmatch(contract(t), -1) {
		names = append(names, m[1])
	}
	if got, want := sorted(Notifications), sorted(names); !slices.Equal(got, want) {
		t.Errorf("notifications differ\n go: %v\n ts: %v", got, want)
	}
}

func TestUserInputKinds(t *testing.T) {
	m := regexp.MustCompile(`method: 'control\.userInput'; params: \{ kind: ([^}]+) \}`).FindStringSubmatch(contract(t))
	if m == nil {
		t.Fatal("no control.userInput in ComputerNotification")
	}
	var kinds []string
	for _, k := range regexp.MustCompile(`'([a-z]+)'`).FindAllStringSubmatch(m[1], -1) {
		kinds = append(kinds, k[1])
	}
	if got, want := sorted(UserInputKinds), sorted(kinds); !slices.Equal(got, want) {
		t.Errorf("control.userInput kinds differ\n go: %v\n ts: %v", got, want)
	}
}
