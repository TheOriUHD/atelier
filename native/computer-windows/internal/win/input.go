//go:build windows

package win

import (
	"fmt"
	"unsafe"

	"atelier.dev/computer-windows/internal/control"
	"atelier.dev/computer-windows/internal/input"
	"atelier.dev/computer-windows/internal/keys"
	"atelier.dev/computer-windows/internal/proto"
)

// rawInput is an INPUT: a type and a union whose biggest member, MOUSEINPUT, is 32 bytes on 64-bit Windows.
type rawInput struct {
	Type uint32
	_    uint32
	Data [4]uint64
}

type mouseInput struct {
	DX, DY    int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

type keybdInput struct {
	VK, Scan  uint16
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

func init() {
	if unsafe.Sizeof(rawInput{}) != 40 || unsafe.Sizeof(mouseInput{}) != 32 || unsafe.Sizeof(keybdInput{}) != 24 {
		panic("INPUT layout")
	}
}

// sender is input.Sender through SendInput; every event carries input.Tag.
type sender struct{}

func (sender) Send(events []input.Event) error {
	if len(events) == 0 {
		return nil
	}
	buf := make([]rawInput, len(events))
	for i, e := range events {
		if e.Mouse {
			buf[i].Type = INPUT_MOUSE
			mi := (*mouseInput)(unsafe.Pointer(&buf[i].Data))
			*mi = mouseInput{DX: e.DX, DY: e.DY, MouseData: e.Data, Flags: e.Flags, ExtraInfo: input.Tag}
		} else {
			buf[i].Type = INPUT_KEYBOARD
			ki := (*keybdInput)(unsafe.Pointer(&buf[i].Data))
			*ki = keybdInput{VK: e.VK, Scan: e.Scan, Flags: e.Flags, ExtraInfo: input.Tag}
		}
	}
	n, _, err := procSendInput.Call(uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])), unsafe.Sizeof(buf[0]))
	if int(n) != len(buf) {
		return fmt.Errorf("SendInput sent %d of %d events: %v", n, len(buf), err)
	}
	return nil
}

func (sender) SetCursorPos(x, y int) { procSetCursorPos.Call(uintptr(int32(x)), uintptr(int32(y))) }

func (sender) CursorPos() (proto.Point, bool) {
	p, ok := cursorPos()
	return proto.Point{X: float64(p.X), Y: float64(p.Y)}, ok
}

func (sender) VirtualScreen() input.Screen {
	return input.Screen{
		X: systemMetric(SM_XVIRTUALSCREEN), Y: systemMetric(SM_YVIRTUALSCREEN),
		Width: systemMetric(SM_CXVIRTUALSCREEN), Height: systemMetric(SM_CYVIRTUALSCREEN),
	}
}

func (sender) SwapButtons() bool { return systemMetric(SM_SWAPBUTTON) != 0 }

func (sender) ScanCode(vk uint16) uint16 {
	r, _, _ := procMapVirtualKeyExW.Call(uintptr(vk), 0 /* MAPVK_VK_TO_VSC */, foregroundLayout())
	return uint16(r)
}

// foregroundLayout is the keyboard layout of the foreground window's thread (what typing goes to), else this one's.
func foregroundLayout() uintptr {
	if fg := foregroundWindow(); fg != 0 {
		if _, thread := windowPID(fg); thread != 0 {
			if hkl, _, _ := procGetKeyboardLayout.Call(uintptr(thread)); hkl != 0 {
				return hkl
			}
		}
	}
	hkl, _, _ := procGetKeyboardLayout.Call(0)
	return hkl
}

// layout is keys.Layout through VkKeyScanExW.
type layout struct{ hkl uintptr }

func (l layout) VkKeyScan(r rune) (uint8, uint8, bool) {
	if r > 0xFFFF {
		return 0, 0, false
	}
	res, _, _ := procVkKeyScanExW.Call(uintptr(r), l.hkl)
	v := int16(uint16(res))
	if v == -1 {
		return 0, 0, false
	}
	return uint8(v & 0xFF), uint8((v >> 8) & 0xFF), true
}

// ---------------------------------------------------------------- System's input side

func (s *System) Sender() input.Sender { return s.send }

func (s *System) Layout() keys.Layout { return layout{hkl: foregroundLayout()} }

func (s *System) Hooks() control.Hooks { return &hooks{} }

func (s *System) EscapeDown() bool {
	r, _, _ := procGetAsyncKeyState.Call(keys.VK_ESCAPE)
	return uint16(r)&0x8000 != 0
}
