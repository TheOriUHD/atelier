//go:build unix

package sys

import (
	"golang.org/x/sys/unix"

	"atelier.dev/runner/internal/rpc"
)

func diskInfo(path string) rpc.DiskInfo {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return rpc.DiskInfo{Path: path}
	}
	bs := uint64(st.Bsize)
	return rpc.DiskInfo{Path: path, Total: uint64(st.Blocks) * bs, Free: uint64(st.Bavail) * bs}
}
