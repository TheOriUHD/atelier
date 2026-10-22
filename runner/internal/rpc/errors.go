package rpc

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"syscall"
)

// Error is a JSON-RPC error object. Application errors set Data["code"] to a stable name.
type Error struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// NewError builds an application error whose data.code is name.
func NewError(code int, name, message string) *Error {
	return &Error{Code: code, Message: message, Data: map[string]any{"code": name}}
}

func InvalidParams(format string, args ...any) *Error {
	return &Error{Code: CodeInvalidParams, Message: fmt.Sprintf(format, args...)}
}

// IOError reports a filesystem failure with an errno-style name in data.code.
func IOError(name, message string) *Error { return NewError(CodeIO, name, message) }

func ShellRestarted(message string) *Error {
	return NewError(CodeShellRestarted, "ShellRestarted", message)
}

var errnoNames = map[syscall.Errno]string{
	syscall.ENOENT:       "ENOENT",
	syscall.EEXIST:       "EEXIST",
	syscall.ENOTDIR:      "ENOTDIR",
	syscall.EISDIR:       "EISDIR",
	syscall.ENOTEMPTY:    "ENOTEMPTY",
	syscall.EACCES:       "EACCES",
	syscall.EPERM:        "EPERM",
	syscall.ELOOP:        "ELOOP",
	syscall.ENAMETOOLONG: "ENAMETOOLONG",
	syscall.EXDEV:        "EXDEV",
	syscall.EBUSY:        "EBUSY",
	syscall.EROFS:        "EROFS",
	syscall.ENOSPC:       "ENOSPC",
}

// FromError converts any handler error into a wire error.
func FromError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: CodeCancelled, Message: "Cancelled"}
	}
	if errors.Is(err, exec.ErrNotFound) {
		return IOError("ENOENT", err.Error())
	}
	var pathErr *fs.PathError
	var linkErr *os.LinkError
	var sysErr *os.SyscallError
	if errors.As(err, &pathErr) || errors.As(err, &linkErr) || errors.As(err, &sysErr) {
		var errno syscall.Errno
		if errors.As(err, &errno) {
			if name, ok := errnoNames[errno]; ok {
				return IOError(name, err.Error())
			}
		}
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return IOError("ENOENT", err.Error())
		case errors.Is(err, fs.ErrExist):
			return IOError("EEXIST", err.Error())
		case errors.Is(err, fs.ErrPermission):
			return IOError("EACCES", err.Error())
		}
		return IOError("EIO", err.Error())
	}
	return &Error{Code: CodeInternal, Message: err.Error()}
}
