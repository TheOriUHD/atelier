//go:build windows

package win

// Read-only checks of the Windows layer, for a Windows machine (no desktop needed: they pass in session 0 over SSH).
// Nothing here moves the mouse, presses keys, installs hooks, or opens, hides or activates apps.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/appid"
	"atelier.dev/computer-windows/internal/imaging"
	"atelier.dev/computer-windows/internal/keys"
)

func TestStructLayouts(t *testing.T) {
	sizes := map[string][2]uintptr{
		"INPUT":                            {unsafe.Sizeof(rawInput{}), 40},
		"MOUSEINPUT":                       {unsafe.Sizeof(mouseInput{}), 32},
		"KEYBDINPUT":                       {unsafe.Sizeof(keybdInput{}), 24},
		"MONITORINFOEXW":                   {unsafe.Sizeof(monitorInfoEx{}), 104},
		"DISPLAY_DEVICEW":                  {unsafe.Sizeof(displayDevice{}), 840},
		"DISPLAYCONFIG_PATH_INFO":          {unsafe.Sizeof(displayConfigPathInfo{}), 72},
		"DISPLAYCONFIG_MODE_INFO":          {unsafe.Sizeof(displayConfigModeInfo{}), 64},
		"DISPLAYCONFIG_SOURCE_DEVICE_NAME": {unsafe.Sizeof(displayConfigSourceName{}), 84},
		"DISPLAYCONFIG_TARGET_DEVICE_NAME": {unsafe.Sizeof(displayConfigTargetName{}), 420},
		"BITMAPINFOHEADER":                 {unsafe.Sizeof(bitmapInfoHeader{}), 40},
		"CURSORINFO":                       {unsafe.Sizeof(cursorInfo{}), 24},
		"ICONINFO":                         {unsafe.Sizeof(iconInfo{}), 32},
		"KBDLLHOOKSTRUCT":                  {unsafe.Sizeof(kbdLLHook{}), 24},
		"MSLLHOOKSTRUCT":                   {unsafe.Sizeof(msLLHook{}), 32},
		"MSG":                              {unsafe.Sizeof(msg{}), 48},
		"VARIANT":                          {unsafe.Sizeof(variant{}), 24},
		"RECT":                             {unsafe.Sizeof(rect{}), 16},
	}
	for name, s := range sizes {
		if s[0] != s[1] {
			t.Errorf("%s is %d bytes, Windows says %d", name, s[0], s[1])
		}
	}
	if off := unsafe.Offsetof(msLLHook{}.ExtraInfo); off != 24 {
		t.Errorf("MSLLHOOKSTRUCT.dwExtraInfo at %d", off)
	}
	if off := unsafe.Offsetof(kbdLLHook{}.ExtraInfo); off != 16 {
		t.Errorf("KBDLLHOOKSTRUCT.dwExtraInfo at %d", off)
	}
	if off := unsafe.Offsetof(mouseInput{}.ExtraInfo); off != 24 {
		t.Errorf("MOUSEINPUT.dwExtraInfo at %d", off)
	}
}

// TestDIBRoundTrip draws a known picture into one memory DIB, copies it with BitBlt into another (as a screenshot
// copies from the screen) and reads it the way grab does: top-down rows of BGRA.
func TestDIBRoundTrip(t *testing.T) {
	createSolidBrush := gdi32.NewProc("CreateSolidBrush")
	fillRect := user32.NewProc("FillRect")
	const w, h = 8, 4
	dib := func() (dc, bitmap uintptr, bits *byte) {
		dc, _, _ = procCreateCompatibleDC.Call(0)
		info := bitmapInfo{Header: bitmapInfoHeader{Width: w, Height: -h, Planes: 1, BitCount: 32, Compression: BI_RGB}}
		info.Header.Size = uint32(unsafe.Sizeof(info.Header))
		bitmap, _, _ = procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&info)), DIB_RGB_COLORS, uintptr(unsafe.Pointer(&bits)), 0, 0)
		if dc == 0 || bitmap == 0 || bits == nil {
			t.Fatal("CreateDIBSection failed")
		}
		procSelectObject.Call(dc, bitmap)
		return dc, bitmap, bits
	}
	src, srcBitmap, _ := dib()
	defer procDeleteDC.Call(src)
	defer procDeleteObject.Call(srcBitmap)
	dst, dstBitmap, dstBits := dib()
	defer procDeleteDC.Call(dst)
	defer procDeleteObject.Call(dstBitmap)

	// Red over the top-left 4×2, blue elsewhere (COLORREF is 0x00BBGGRR).
	red, _, _ := createSolidBrush.Call(0x000000FF)
	blue, _, _ := createSolidBrush.Call(0x00FF0000)
	defer procDeleteObject.Call(red)
	defer procDeleteObject.Call(blue)
	all := rect{0, 0, w, h}
	corner := rect{0, 0, 4, 2}
	fillRect.Call(src, uintptr(unsafe.Pointer(&all)), blue)
	fillRect.Call(src, uintptr(unsafe.Pointer(&corner)), red)
	if !boolCall(procBitBlt, dst, 0, 0, w, h, src, 0, 0, SRCCOPY) {
		t.Fatal("BitBlt between memory DCs failed")
	}
	procGdiFlush.Call()
	pixels := unsafe.Slice(dstBits, w*h*4)
	imaging.FillBlackBGRA(pixels, w, h, w*4, []imaging.IntRect{{X0: 6, Y0: 3, X1: 8, Y1: 4}})
	img := imaging.FromBGRA(pixels, w, h, w*4)
	if c := img.RGBAAt(0, 0); c.R != 255 || c.B != 0 {
		t.Errorf("top-left is red: %v", c)
	}
	if c := img.RGBAAt(5, 3); c.B != 255 || c.R != 0 {
		t.Errorf("bottom is blue (rows are top-down): %v", c)
	}
	if c := img.RGBAAt(7, 3); c.R != 0 || c.G != 0 || c.B != 0 || c.A != 255 {
		t.Errorf("masked corner is black: %v", c)
	}
}

func TestProcessIDs(t *testing.T) {
	info := readProcess(uint32(os.Getpid()))
	exe, _ := os.Executable()
	if !info.ok || info.family != "" || info.id != strings.ToLower(filepath.Base(exe)) || !strings.EqualFold(info.exe, exe) {
		t.Errorf("this process: %+v (exe %s)", info, exe)
	}
	if readProcess(0).ok || readProcess(4).ok {
		t.Error("the idle and System processes aren't apps")
	}
	// A process this account can't open still gets its exe name from the snapshot.
	names := processNames()
	if !strings.EqualFold(names[uint32(os.Getpid())], filepath.Base(exe)) {
		t.Errorf("snapshot: %q", names[uint32(os.Getpid())])
	}
	if pc := newProcCache(); pc.get(uint32(os.Getpid())).id != info.id {
		t.Error("cache")
	}
}

func TestFileDescription(t *testing.T) {
	system, _ := windows.GetSystemDirectory()
	if d := fileDescription(filepath.Join(system, "cmd.exe")); d == "" {
		t.Error("cmd.exe has a FileDescription")
	} else {
		t.Logf("cmd.exe: %q", d)
	}
	if d := fileDescription(`C:\no\such.exe`); d != "" {
		t.Errorf("a missing file: %q", d)
	}
}

func TestKnownFoldersAndExpansion(t *testing.T) {
	r := newResolver()
	system, _ := windows.GetSystemDirectory()
	if p, ok := r.KnownFolder("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}"); !ok || !strings.EqualFold(p, system) {
		t.Errorf("FOLDERID_System: %q", p)
	}
	if _, ok := r.KnownFolder("{00000000-0000-0000-0000-000000000000}"); ok {
		t.Error("an unknown folder")
	}
	if got := expandEnv(`%SystemRoot%\x.exe`); !strings.EqualFold(got, os.Getenv("SystemRoot")+`\x.exe`) {
		t.Errorf("expand: %q", got)
	}
	id, path := appid.FromStartApp(appid.StartApp{Name: "Command Prompt", AppID: `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\cmd.exe`}, r)
	if id != "cmd.exe" || !strings.EqualFold(path, filepath.Join(system, "cmd.exe")) {
		t.Errorf("cmd: %s %s", id, path)
	}
}

func TestKeyboardLayout(t *testing.T) {
	l := layout{hkl: foregroundLayout()}
	if l.hkl == 0 {
		t.Skip("no keyboard layout")
	}
	if vk, state, ok := l.VkKeyScan('a'); !ok || vk != 'A' || state != 0 {
		t.Errorf("a: %#x %d %v", vk, state, ok)
	}
	if vk, state, ok := l.VkKeyScan('A'); !ok || vk != 'A' || state&1 == 0 {
		t.Errorf("A needs shift: %#x %d %v", vk, state, ok)
	}
	if _, _, ok := l.VkKeyScan('😀'); ok {
		t.Error("an emoji has no key")
	}
	s := sender{}
	if scan := s.ScanCode('A'); scan != 0x1E {
		t.Logf("scan code of A: %#x (0x1E on most layouts)", scan)
	}
	if scan := s.ScanCode(keys.VK_ESCAPE); scan != 0x01 {
		t.Errorf("scan code of Esc: %#x", scan)
	}
	if scan := s.ScanCode(keys.VK_CONTROL); scan != 0x1D {
		t.Errorf("scan code of ctrl: %#x", scan)
	}
}

func TestUIAutomationStarts(t *testing.T) {
	w, err := takeWorker()
	if err != nil {
		t.Fatalf("UI Automation: %v", err)
	}
	putWorker(w)
	if el, err := uiaInspect(uiaFocused, 0, 0); err != nil {
		t.Logf("focused element: %v (no desktop?)", err)
	} else if el != nil {
		t.Logf("focused: pid %d, control type %d", el.PID, el.ControlType)
	}
}

func TestStartMenu(t *testing.T) {
	if testing.Short() {
		t.Skip("runs PowerShell")
	}
	apps, err := loadStartMenu()
	if err != nil {
		t.Fatal(err)
	}
	if len(apps) == 0 {
		t.Fatal("no Start menu apps")
	}
	seen := map[string]bool{}
	for _, a := range apps {
		key := strings.ToLower(a.ID)
		if seen[key] {
			t.Errorf("twice: %s", a.ID)
		}
		seen[key] = true
	}
	t.Logf("%d Start menu apps", len(apps))
}

func TestDisplaysAndWindows(t *testing.T) {
	displays := listDisplays()
	if len(displays) == 0 {
		t.Fatal("no displays")
	}
	primary := 0
	for _, d := range displays {
		if d.Primary {
			primary++
			if d.X != 0 || d.Y != 0 {
				t.Errorf("the primary is at 0,0: %+v", d)
			}
		}
		if d.ID == "" || d.Width <= 0 || d.Height <= 0 || d.Scale <= 0 {
			t.Errorf("display: %+v", d)
		}
		if found, ok := findDisplay(strings.ToLower(d.ID)); !ok || found.ID != d.ID {
			t.Errorf("findDisplay %s, lowercase", d.ID)
		}
	}
	if primary != 1 {
		t.Errorf("%d primary displays", primary)
	}
	if !displays[0].Primary {
		t.Error("the primary comes first")
	}
	// Enumerating windows works with or without a desktop; nothing here is the helper's own.
	for _, w := range topWindows() {
		if w.hwnd == 0 || !w.visible {
			t.Errorf("window: %+v", w)
		}
	}
}
