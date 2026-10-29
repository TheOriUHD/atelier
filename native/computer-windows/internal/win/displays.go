//go:build windows

package win

import (
	"fmt"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"atelier.dev/computer-windows/internal/proto"
)

type monitorInfoEx struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
	Device  [32]uint16
}

type displayDevice struct {
	Size         uint32
	DeviceName   [32]uint16
	DeviceString [128]uint16
	StateFlags   uint32
	DeviceID     [128]uint16
	DeviceKey    [128]uint16
}

type luid struct {
	Low  uint32
	High int32
}

// DISPLAYCONFIG_PATH_INFO: 72 bytes.
type displayConfigPathInfo struct {
	SourceAdapter    luid
	SourceID         uint32
	SourceModeIdx    uint32
	SourceStatus     uint32
	TargetAdapter    luid
	TargetID         uint32
	TargetModeIdx    uint32
	OutputTechnology uint32
	Rotation         uint32
	Scaling          uint32
	RefreshNum       uint32
	RefreshDen       uint32
	ScanLineOrdering uint32
	TargetAvailable  int32
	TargetStatus     uint32
	Flags            uint32
}

// DISPLAYCONFIG_MODE_INFO: 64 bytes; the union isn't read.
type displayConfigModeInfo struct {
	InfoType uint32
	ID       uint32
	Adapter  luid
	Data     [6]uint64
}

type displayConfigHeader struct {
	Type    uint32
	Size    uint32
	Adapter luid
	ID      uint32
}

type displayConfigSourceName struct {
	Header     displayConfigHeader
	GdiDevName [32]uint16
}

type displayConfigTargetName struct {
	Header            displayConfigHeader
	Flags             uint32
	OutputTechnology  uint32
	EdidManufactureID uint16
	EdidProductCodeID uint16
	ConnectorInstance uint32
	FriendlyName      [64]uint16
	DevicePath        [128]uint16
}

const (
	displayConfigGetSourceName = 1
	displayConfigGetTargetName = 2
)

// friendlyNames are the monitors' own names ("DELL U2720Q") by GDI device name (`\\.\DISPLAY1`), from the display
// configuration.
func friendlyNames() map[string]string {
	names := map[string]string{}
	var nPaths, nModes uint32
	if r, _, _ := procGetDisplayConfigBufferSizes.Call(QDC_ONLY_ACTIVE_PATHS, uintptr(unsafe.Pointer(&nPaths)), uintptr(unsafe.Pointer(&nModes))); r != ERROR_SUCCESS || nPaths == 0 {
		return names
	}
	paths := make([]displayConfigPathInfo, nPaths)
	modes := make([]displayConfigModeInfo, max(nModes, 1))
	if r, _, _ := procQueryDisplayConfig.Call(QDC_ONLY_ACTIVE_PATHS, uintptr(unsafe.Pointer(&nPaths)), uintptr(unsafe.Pointer(&paths[0])),
		uintptr(unsafe.Pointer(&nModes)), uintptr(unsafe.Pointer(&modes[0])), 0); r != ERROR_SUCCESS {
		return names
	}
	for _, path := range paths[:nPaths] {
		source := displayConfigSourceName{Header: displayConfigHeader{Type: displayConfigGetSourceName, Adapter: path.SourceAdapter, ID: path.SourceID}}
		source.Header.Size = uint32(unsafe.Sizeof(source))
		if r, _, _ := procDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&source))); r != ERROR_SUCCESS {
			continue
		}
		target := displayConfigTargetName{Header: displayConfigHeader{Type: displayConfigGetTargetName, Adapter: path.TargetAdapter, ID: path.TargetID}}
		target.Header.Size = uint32(unsafe.Sizeof(target))
		if r, _, _ := procDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&target))); r != ERROR_SUCCESS {
			continue
		}
		device := windows.UTF16ToString(source.GdiDevName[:])
		if name := strings.TrimSpace(windows.UTF16ToString(target.FriendlyName[:])); name != "" && names[device] == "" {
			names[device] = name
		}
	}
	return names
}

// deviceString is the adapter's description of a display device, when there is no friendly name.
func deviceString(device string) string {
	name, err := windows.UTF16PtrFromString(device)
	if err != nil {
		return ""
	}
	var dd displayDevice
	dd.Size = uint32(unsafe.Sizeof(dd))
	// The monitor attached to the adapter output (index 0), whose DeviceString names it ("Generic PnP Monitor").
	if boolCall(procEnumDisplayDevicesW, uintptr(unsafe.Pointer(name)), 0, uintptr(unsafe.Pointer(&dd)), 0) {
		return strings.TrimSpace(windows.UTF16ToString(dd.DeviceString[:]))
	}
	return ""
}

type monitor struct {
	handle  uintptr
	device  string
	bounds  rect
	primary bool
	dpi     uint32
}

func monitors() []monitor {
	var list []monitor
	enumMonitors(func(h uintptr) bool {
		info := monitorInfoEx{}
		info.Size = uint32(unsafe.Sizeof(info))
		if !boolCall(procGetMonitorInfoW, h, uintptr(unsafe.Pointer(&info))) {
			return true
		}
		var dpiX, dpiY uint32
		dpi := uint32(96)
		if procGetDpiForMonitor.Find() == nil {
			if r, _, _ := procGetDpiForMonitor.Call(h, MDT_EFFECTIVE_DPI, uintptr(unsafe.Pointer(&dpiX)), uintptr(unsafe.Pointer(&dpiY))); r == 0 && dpiX > 0 {
				dpi = dpiX
			}
		}
		list = append(list, monitor{
			handle: h, device: windows.UTF16ToString(info.Device[:]), bounds: info.Monitor,
			primary: info.Flags&MONITORINFOF_PRIMARY != 0, dpi: dpi,
		})
		return true
	})
	return list
}

// listDisplays: every monitor, the primary first. The id is the GDI device name (`\\.\DISPLAY1`); coordinates are
// physical pixels of the virtual screen; scale is DPI / 96.
func listDisplays() []proto.Display {
	list := monitors()
	friendly := friendlyNames()
	displays := make([]proto.Display, 0, len(list))
	used := map[string]int{}
	for i, m := range list {
		name := friendly[m.device]
		if name == "" {
			name = deviceString(m.device)
		}
		if name == "" || strings.EqualFold(name, "Generic PnP Monitor") || strings.EqualFold(name, "Generic Non-PnP Monitor") {
			name = fmt.Sprintf("Display %d", i+1)
		}
		// Two monitors of the same model: "DELL U2720Q", "DELL U2720Q (2)".
		used[name]++
		if n := used[name]; n > 1 {
			name = fmt.Sprintf("%s (%d)", name, n)
		}
		displays = append(displays, proto.Display{
			ID: m.device, Name: name, Scale: float64(m.dpi) / 96, Primary: m.primary,
			X: float64(m.bounds.Left), Y: float64(m.bounds.Top),
			Width: float64(m.bounds.Right - m.bounds.Left), Height: float64(m.bounds.Bottom - m.bounds.Top),
		})
	}
	sort.SliceStable(displays, func(a, b int) bool { return displays[a].Primary && !displays[b].Primary })
	return displays
}

// findDisplay is a display by its id, without regard to case (main may lowercase what it is given).
func findDisplay(id string) (proto.Display, bool) {
	for _, d := range listDisplays() {
		if strings.EqualFold(d.ID, strings.TrimSpace(id)) {
			return d, true
		}
	}
	return proto.Display{}, false
}
