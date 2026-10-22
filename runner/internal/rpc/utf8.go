package rpc

import "unicode/utf8"

// CompleteUTF8 returns the length of b without a trailing incomplete UTF-8 sequence, so text that
// is cut or streamed in chunks never splits a character across JSON strings.
func CompleteUTF8(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if !utf8.FullRune(b[i:]) {
				return i
			}
			break
		}
	}
	return len(b)
}
