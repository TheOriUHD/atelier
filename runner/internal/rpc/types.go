package rpc

// Wire types of runner protocol v1. Mirrored by hand from packages/protocol/src/runner.ts;
// keep the two files in sync (field names, optionality, comments on units).

import "encoding/json"

// ProtocolVersion is bumped on any incompatible change to the method set or shapes below.
const ProtocolVersion = 1

// Error codes. Application errors also carry a stable string in data.code.
const (
	CodeParseError           = -32700
	CodeInvalidRequest       = -32600
	CodeMethodNotFound       = -32601
	CodeInvalidParams        = -32602
	CodeInternal             = -32603
	CodeNotInitialized       = -32002
	CodeIO                   = -32000 // data.code is the errno name: ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY, EACCES, EPERM, EIO, …
	CodePathOutsideWorkspace = -32010
	CodeConflict             = -32011
	CodeShellRestarted       = -32012 // unknown shell, exec or pty id (e.g. after a runner restart)
	CodeVersionMismatch      = -32020
	CodeCancelled            = -32800
)

// ---------------------------------------------------------------- sys

type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type InitializeParams struct {
	ProtocolVersion int        `json:"protocolVersion"`
	Client          ClientInfo `json:"client"`
}

type Capabilities struct {
	Methods   []string `json:"methods"`
	ExecShell string   `json:"execShell"` // "bash" | "sh" | "powershell": what shell.exec runs commands with
}

type InitializeResult struct {
	ProtocolVersion int          `json:"protocolVersion"`
	RunnerVersion   string       `json:"runnerVersion"`
	OS              string       `json:"os"`
	Arch            string       `json:"arch"`
	Roots           []string     `json:"roots"`
	Home            string       `json:"home"`
	Shell           string       `json:"shell"`
	PathSep         string       `json:"pathSep"`
	Capabilities    Capabilities `json:"capabilities"`
}

type CPUInfo struct {
	Count int    `json:"count"`
	Model string `json:"model"`
}

type MemInfo struct {
	Total     uint64 `json:"total"`
	Available uint64 `json:"available"`
}

type DiskInfo struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

type SysInfoResult struct {
	OS            string      `json:"os"`
	Arch          string      `json:"arch"`
	Hostname      string      `json:"hostname"`
	RunnerVersion string      `json:"runnerVersion"`
	CPU           CPUInfo     `json:"cpu"`
	Mem           MemInfo     `json:"mem"`
	Disk          DiskInfo    `json:"disk"`         // volume of the primary root
	Load          *[3]float64 `json:"load"`         // 1/5/15 min load average; null on Windows
	GitVersion    *string     `json:"gitVersion"`   // null when git is not installed
	DefaultShell  string      `json:"defaultShell"` // the user's login shell
	GitBash       *string     `json:"gitBash"`      // Windows only: path of Git Bash's bash.exe
}

type SysPingResult struct {
	Time int64 `json:"time"` // unix ms
}

type SysAddRootParams struct {
	Path string `json:"path"`
}

type SysAddRootResult struct {
	Roots []string `json:"roots"`
}

// CancelParams are the params of the $/cancel notification.
type CancelParams struct {
	ID json.RawMessage `json:"id"`
}

// ---------------------------------------------------------------- fs

type FsStatParams struct {
	Path string `json:"path"`
}

type FsStat struct {
	Path    string `json:"path"` // resolved absolute path
	Type    string `json:"type"` // file | dir | symlink | other
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
	Mode    uint32 `json:"mode"` // permission bits
}

type FsReadParams struct {
	Path     string `json:"path"`
	Offset   int64  `json:"offset"`   // utf8: lines to skip; base64: bytes to skip
	Limit    int64  `json:"limit"`    // utf8: max lines; base64: max bytes; 0 = to the end
	Encoding string `json:"encoding"` // utf8 (default) | base64
}

type FsReadResult struct {
	Content    string `json:"content"`
	Encoding   string `json:"encoding"`
	Sha256     string `json:"sha256"` // of the whole file
	Size       int64  `json:"size"`
	TotalLines int64  `json:"totalLines"`
	Truncated  bool   `json:"truncated"` // more content exists past offset+limit or the size cap
	Binary     bool   `json:"binary"`    // NUL byte in the first 8000 bytes; utf8 reads return no content
}

type FsWriteParams struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // utf8 (default) | base64
	// Optimistic concurrency: the file must currently hash to this value, or not exist when "".
	ExpectSha256 *string `json:"expectSha256"`
	Mkdirp       bool    `json:"mkdirp"`
}

type FsWriteResult struct {
	Sha256  string `json:"sha256"`
	Created bool   `json:"created"`
}

type FsListParams struct {
	Path             string `json:"path"`
	Depth            int    `json:"depth"` // 1 (default) = direct children
	RespectGitignore bool   `json:"respectGitignore"`
}

type FsEntry struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Type    string `json:"type"` // file | dir | symlink | other
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}

type FsListResult struct {
	Entries   []FsEntry `json:"entries"`
	Truncated bool      `json:"truncated"`
}

type FsMkdirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type FsRemoveParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type FsRenameParams struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite"`
}

type FsReadAncestorsParams struct {
	From  string   `json:"from"`
	Names []string `json:"names"` // subset of CLAUDE.md, AGENTS.md, ATELIER.md, CLAUDE.local.md, .claude/CLAUDE.md; empty = all
}

type FsAncestorFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type FsReadAncestorsResult struct {
	Files []FsAncestorFile `json:"files"` // outermost directory first
}

// ---------------------------------------------------------------- search

type FsGlobParams struct {
	Pattern string `json:"pattern"`
	Cwd     string `json:"cwd"`
	Limit   int    `json:"limit"` // default 100
}

type FsGlobResult struct {
	Files     []string `json:"files"` // absolute, newest first
	Truncated bool     `json:"truncated"`
}

type FsGrepParams struct {
	Pattern         string `json:"pattern"`
	Path            string `json:"path"`
	Glob            string `json:"glob"`
	Type            string `json:"type"`
	OutputMode      string `json:"outputMode"` // content | files (default) | count
	CaseInsensitive bool   `json:"caseInsensitive"`
	LineNumbers     bool   `json:"lineNumbers"`
	Before          int    `json:"before"`
	After           int    `json:"after"`
	Multiline       bool   `json:"multiline"`
	HeadLimit       int    `json:"headLimit"` // 0 = no limit
}

type FsGrepCount struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

type FsGrepResult struct {
	OutputMode string        `json:"outputMode"`
	Files      []string      `json:"files"`  // files mode: newest first
	Lines      []string      `json:"lines"`  // content mode: ripgrep-formatted lines
	Counts     []FsGrepCount `json:"counts"` // count mode
	NumFiles   int           `json:"numFiles"`
	NumMatches int           `json:"numMatches"` // matching lines
	Truncated  bool          `json:"truncated"`
}

// ---------------------------------------------------------------- watch

type FsWatchParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type FsWatchResult struct {
	WatchID string `json:"watchId"`
}

type FsUnwatchParams struct {
	WatchID string `json:"watchId"`
}

type FsChangeEvent struct {
	Path string `json:"path"`
	Op   string `json:"op"` // create | write | remove | rename
}

type FsChangedNotification struct {
	WatchID string          `json:"watchId"`
	Events  []FsChangeEvent `json:"events"`
}

// ---------------------------------------------------------------- shell

type ShellOpenParams struct {
	Cwd string            `json:"cwd"`
	Env map[string]string `json:"env"`
}

type ShellOpenResult struct {
	ShellID string `json:"shellId"`
	Cwd     string `json:"cwd"`
}

type ShellExecParams struct {
	ShellID    string `json:"shellId"`
	Command    string `json:"command"`
	TimeoutMs  int64  `json:"timeoutMs"` // foreground default 120000; background default none
	Background bool   `json:"background"`
	ExecID     string `json:"execId"` // optional client-chosen id, so output can be correlated before the result
}

type ShellExecResult struct {
	ExecID     string `json:"execId"`
	ExitCode   *int   `json:"exitCode"` // null for background execs
	Cwd        string `json:"cwd"`
	DurationMs int64  `json:"durationMs"`
	Output     string `json:"output"` // stdout+stderr interleaved; head and tail kept when truncated
	Truncated  bool   `json:"truncated"`
	TimedOut   bool   `json:"timedOut"`
}

type ShellOutputNotification struct {
	ExecID string `json:"execId"`
	Chunk  string `json:"chunk"`
}

type ShellReadParams struct {
	ExecID      string `json:"execId"`
	SinceOffset int64  `json:"sinceOffset"`
}

type ShellReadResult struct {
	Output    string `json:"output"`
	Offset    int64  `json:"offset"` // pass as sinceOffset next time
	Running   bool   `json:"running"`
	ExitCode  *int   `json:"exitCode"`
	Truncated bool   `json:"truncated"` // output between sinceOffset and the returned data was dropped
}

type ShellKillParams struct {
	ExecID string `json:"execId"`
}

type ShellKillResult struct {
	Killed bool `json:"killed"`
}

type ShellCloseParams struct {
	ShellID string `json:"shellId"`
}

// ---------------------------------------------------------------- proc

type ProcExecParams struct {
	Argv      []string          `json:"argv"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	Stdin     *string           `json:"stdin"`
	TimeoutMs int64             `json:"timeoutMs"` // 0 = none
}

type ProcExecResult struct {
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

// ---------------------------------------------------------------- pty

type PtyOpenParams struct {
	Cwd   string `json:"cwd"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	Shell string `json:"shell"` // default: the user's login shell
}

type PtyOpenResult struct {
	PtyID string `json:"ptyId"`
	Shell string `json:"shell"`
	Pid   int    `json:"pid"`
}

type PtyWriteParams struct {
	PtyID    string `json:"ptyId"`
	Data     string `json:"data"`
	Encoding string `json:"encoding"` // utf8 (default) | base64
}

type PtyResizeParams struct {
	PtyID string `json:"ptyId"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
}

type PtyCloseParams struct {
	PtyID string `json:"ptyId"`
}

type PtyDataNotification struct {
	PtyID string `json:"ptyId"`
	B64   string `json:"b64"`
}

type PtyExitNotification struct {
	PtyID string `json:"ptyId"`
	Code  int    `json:"code"`
}
