package appid

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// lnk builds a shell link the way Windows lays one out ([MS-SHLLINK]): the header, an optional ID list, an optional
// LinkInfo (ANSI and, with unicodeBase, Unicode local base path), the relative path, and an optional
// EnvironmentVariableDataBlock.
type lnk struct {
	idList      []byte
	localBase   string
	unicodeBase string
	suffix      string
	relative    string
	envTarget   string
}

func (l lnk) bytes() []byte {
	var b bytes.Buffer
	le := func(v any) { _ = binary.Write(&b, binary.LittleEndian, v) }
	flags := uint32(isUnicode)
	if l.idList != nil {
		flags |= hasLinkTargetIDList
	}
	if l.localBase != "" {
		flags |= hasLinkInfo
	}
	if l.relative != "" {
		flags |= hasRelativePath
	}
	le(uint32(lnkHeaderSize))
	b.Write(lnkCLSID)
	le(flags)
	b.Write(make([]byte, lnkHeaderSize-b.Len()))
	if l.idList != nil {
		le(uint16(len(l.idList)))
		b.Write(l.idList)
	}
	if l.localBase != "" {
		headerSize := 0x1C
		if l.unicodeBase != "" {
			headerSize = 0x24
		}
		var strs bytes.Buffer
		baseOffset := headerSize
		strs.WriteString(l.localBase + "\x00")
		suffixOffset := headerSize + strs.Len()
		strs.WriteString(l.suffix + "\x00")
		var unicodeBaseOffset, unicodeSuffixOffset int
		if l.unicodeBase != "" {
			unicodeBaseOffset = headerSize + strs.Len()
			for _, u := range utf16.Encode([]rune(l.unicodeBase + "\x00")) {
				_ = binary.Write(&strs, binary.LittleEndian, u)
			}
			unicodeSuffixOffset = headerSize + strs.Len()
			for _, u := range utf16.Encode([]rune(l.suffix + "\x00")) {
				_ = binary.Write(&strs, binary.LittleEndian, u)
			}
		}
		le(uint32(headerSize + strs.Len())) // LinkInfoSize
		le(uint32(headerSize))
		le(uint32(volumeIDAndLocalBasePath))
		le(uint32(0)) // VolumeIDOffset (no volume ID: the parser doesn't need one)
		le(uint32(baseOffset))
		le(uint32(0)) // CommonNetworkRelativeLinkOffset
		le(uint32(suffixOffset))
		if l.unicodeBase != "" {
			le(uint32(unicodeBaseOffset))
			le(uint32(unicodeSuffixOffset))
		}
		b.Write(strs.Bytes())
	}
	if l.relative != "" {
		units := utf16.Encode([]rune(l.relative))
		le(uint16(len(units)))
		le(units)
	}
	if l.envTarget != "" {
		le(uint32(0x314))
		le(uint32(environmentBlockSig))
		ansi := make([]byte, 260)
		copy(ansi, l.envTarget)
		b.Write(ansi)
		wide := make([]uint16, 260)
		copy(wide, utf16.Encode([]rune(l.envTarget)))
		le(wide)
	}
	le(uint32(0)) // TerminalBlock
	return b.Bytes()
}

func TestLnkLocalBasePath(t *testing.T) {
	data := lnk{idList: []byte{0x14, 0, 0x1F, 0x50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0}, localBase: `C:\Program Files\Example\`, suffix: "Example.exe"}.bytes()
	target, err := LnkTarget(data)
	if err != nil || target != `C:\Program Files\Example\Example.exe` {
		t.Errorf("%q %v", target, err)
	}
}

func TestLnkUnicodeBasePathWins(t *testing.T) {
	data := lnk{localBase: `C:\Programme\?ditor\e.exe`, unicodeBase: `C:\Programme\Éditor\e.exe`}.bytes()
	if target, err := LnkTarget(data); err != nil || target != `C:\Programme\Éditor\e.exe` {
		t.Errorf("%q %v", target, err)
	}
}

func TestLnkEnvironmentAndRelativeFallbacks(t *testing.T) {
	data := lnk{envTarget: `%ProgramFiles%\Office\WINWORD.EXE`, relative: `..\..\Office\WINWORD.EXE`}.bytes()
	if target, err := LnkTarget(data); err != nil || target != `%ProgramFiles%\Office\WINWORD.EXE` {
		t.Errorf("environment block: %q %v", target, err)
	}
	data = lnk{relative: `..\..\..\Tools\tool.exe`}.bytes()
	if target, err := LnkTarget(data); err != nil || BaseName(target) != "tool.exe" {
		t.Errorf("relative path: %q %v", target, err)
	}
}

func TestLnkRejectsOtherFiles(t *testing.T) {
	for _, data := range [][]byte{nil, []byte("MZ\x90\x00"), bytes.Repeat([]byte{0x4C, 0, 0, 0}, 30)} {
		if _, err := LnkTarget(data); err == nil {
			t.Errorf("%q isn't a shortcut", data)
		}
	}
	// A shortcut cut short.
	full := lnk{localBase: `C:\x\y.exe`}.bytes()
	if _, err := LnkTarget(full[:lnkHeaderSize+6]); err == nil {
		t.Error("a truncated LinkInfo")
	}
}

// testdata/notepad.lnk is a shortcut made by Windows itself (WScript.Shell's CreateShortcut, on the test VM), its extra
// data blocks (the link tracker's machine name, the owner's SID) and volume serial number taken out.
func TestLnkMadeByWindows(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "notepad.lnk"))
	if err != nil {
		t.Skip("no testdata/notepad.lnk")
	}
	target, err := LnkTarget(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(target, `C:\Windows\System32\notepad.exe`) || strings.ToLower(BaseName(target)) != "notepad.exe" {
		t.Errorf("target: %q", target)
	}
}
