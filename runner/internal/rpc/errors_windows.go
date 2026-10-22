package rpc

import "syscall"

// Windows has its own error numbers for what POSIX names ENOTEMPTY and friends; Go folds some of them into
// fs.ErrExist or fs.ErrPermission, which would hide the more precise name from the caller.
func init() {
	errnoNames[syscall.Errno(145)] = "ENOTEMPTY" // ERROR_DIR_NOT_EMPTY
	errnoNames[syscall.Errno(32)] = "EBUSY"      // ERROR_SHARING_VIOLATION
	errnoNames[syscall.Errno(33)] = "EBUSY"      // ERROR_LOCK_VIOLATION
	errnoNames[syscall.Errno(267)] = "ENOTDIR"   // ERROR_DIRECTORY
}
