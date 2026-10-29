package appid

import (
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

// Shell link (.lnk) parsing, as much of [MS-SHLLINK] as finding a shortcut's target takes: the LinkInfo's local base
// path (Unicode when the shortcut has it), else the EnvironmentVariableDataBlock's target, else the relative path.

const (
	lnkHeaderSize       = 0x4C
	hasLinkTargetIDList = 0x00000001
	hasLinkInfo         = 0x00000002
	hasName             = 0x00000004
	hasRelativePath     = 0x00000008
	isUnicode           = 0x00000080

	volumeIDAndLocalBasePath = 0x00000001
	environmentBlockSig      = 0xA0000001
)

// lnkCLSID is 00021401-0000-0000-C000-000000000046 as it is stored.
var lnkCLSID = []byte{0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}

var errNotLnk = errors.New("not a shell link")

// LnkTarget is a shortcut's target path. Environment variables in it (`%ProgramFiles%\…`) are left as they are.
func LnkTarget(data []byte) (string, error) {
	if len(data) < lnkHeaderSize || binary.LittleEndian.Uint32(data) != lnkHeaderSize || string(data[4:20]) != string(lnkCLSID) {
		return "", errNotLnk
	}
	flags := binary.LittleEndian.Uint32(data[0x14:])
	pos := lnkHeaderSize
	if flags&hasLinkTargetIDList != 0 {
		if pos+2 > len(data) {
			return "", errNotLnk
		}
		pos += 2 + int(binary.LittleEndian.Uint16(data[pos:]))
	}
	var target string
	if flags&hasLinkInfo != 0 {
		if pos+4 > len(data) {
			return "", errNotLnk
		}
		size := int(binary.LittleEndian.Uint32(data[pos:]))
		if size < 0x1C || pos+size > len(data) {
			return "", errNotLnk
		}
		target = linkInfoPath(data[pos : pos+size])
		pos += size
	}
	// StringData: NAME_STRING, then RELATIVE_PATH; each a character count and the characters.
	var relative string
	unicode := flags&isUnicode != 0
	readString := func() (string, bool) {
		if pos+2 > len(data) {
			return "", false
		}
		count := int(binary.LittleEndian.Uint16(data[pos:]))
		pos += 2
		n := count
		if unicode {
			n *= 2
		}
		if pos+n > len(data) {
			return "", false
		}
		s := decode(data[pos:pos+n], unicode)
		pos += n
		return s, true
	}
	if flags&hasName != 0 {
		if _, ok := readString(); !ok {
			return target, nil
		}
	}
	if flags&hasRelativePath != 0 {
		relative, _ = readString()
	}
	if target != "" {
		return target, nil
	}
	if env := environmentTarget(data); env != "" {
		return env, nil
	}
	if relative != "" {
		return relative, nil
	}
	return "", errors.New("the shortcut names no file")
}

// linkInfoPath is LocalBasePath + CommonPathSuffix, the Unicode ones when the header has them.
func linkInfoPath(info []byte) string {
	headerSize := int(binary.LittleEndian.Uint32(info[4:]))
	flags := binary.LittleEndian.Uint32(info[8:])
	if flags&volumeIDAndLocalBasePath == 0 {
		return ""
	}
	if headerSize >= 0x24 && len(info) >= 0x24 {
		baseOffset := int(binary.LittleEndian.Uint32(info[0x1C:]))
		suffixOffset := int(binary.LittleEndian.Uint32(info[0x20:]))
		if base := utf16At(info, baseOffset); base != "" {
			return base + utf16At(info, suffixOffset)
		}
	}
	baseOffset := int(binary.LittleEndian.Uint32(info[0x10:]))
	suffixOffset := int(binary.LittleEndian.Uint32(info[0x18:]))
	return ansiAt(info, baseOffset) + ansiAt(info, suffixOffset)
}

// environmentTarget is the target of an EnvironmentVariableDataBlock (signature 0xA0000001), found by scanning the
// extra data blocks at the end of the file.
func environmentTarget(data []byte) string {
	// The block is 0x314 bytes: size, signature, TargetAnsi[260], TargetUnicode[520 bytes].
	for i := lnkHeaderSize; i+0x314 <= len(data); i++ {
		if binary.LittleEndian.Uint32(data[i:]) != 0x314 || binary.LittleEndian.Uint32(data[i+4:]) != environmentBlockSig {
			continue
		}
		block := data[i : i+0x314]
		if s := utf16String(block[8+260:]); s != "" {
			return s
		}
		return ansiString(block[8 : 8+260])
	}
	return ""
}

// ansiAt is the NUL-terminated code-page string at offset (0: none).
func ansiAt(b []byte, offset int) string {
	if offset <= 0 || offset >= len(b) {
		return ""
	}
	return ansiString(b[offset:])
}

// ansiString reads code-page text up to a NUL: ASCII is right, anything else is read as Latin-1 (good enough for an
// exe's file name).
func ansiString(b []byte) string {
	runes := make([]rune, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		runes = append(runes, rune(c))
	}
	return string(runes)
}

// utf16At is the NUL-terminated UTF-16 string at offset (0: none).
func utf16At(b []byte, offset int) string {
	if offset <= 0 || offset >= len(b) {
		return ""
	}
	return utf16String(b[offset:])
}

func utf16String(b []byte) string {
	var units []uint16
	for i := 0; i+1 < len(b); i += 2 {
		u := binary.LittleEndian.Uint16(b[i:])
		if u == 0 {
			break
		}
		units = append(units, u)
	}
	return string(utf16.Decode(units))
}

func decode(b []byte, unicode bool) string {
	if !unicode {
		return ansiString(b)
	}
	return utf16String(b)
}
