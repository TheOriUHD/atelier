/**
 * Runner protocol v1 (ARCHITECTURE.md §5): JSON-RPC 2.0 between core and the Go runner, one JSON
 * object per line over stdio. Mirrored by hand in runner/internal/rpc/types.go; keep both in sync.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

/** JSON-RPC error codes the runner returns. Application errors also carry a stable `data.code` string. */
export const RunnerErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  NotInitialized: -32002,
  /** Filesystem failure; `data.code` is the errno name: ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY, EACCES, EPERM, EIO, … */
  IO: -32000,
  PathOutsideWorkspace: -32010,
  /** `fs.write` with a stale `expectSha256`; `data.actualSha256` is the current hash or null. */
  Conflict: -32011,
  /** Unknown shell, exec or pty id, e.g. after the runner restarted. */
  ShellRestarted: -32012,
  /** `data.runnerProtocolVersion` and `data.runnerVersion` describe the runner. */
  VersionMismatch: -32020,
  Cancelled: -32800,
} as const;

export type Encoding = 'utf8' | 'base64';
export type FileType = 'file' | 'dir' | 'symlink' | 'other';

// ---------------------------------------------------------------- sys

export interface InitializeParams {
  protocolVersion: number;
  client: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: number;
  runnerVersion: string;
  os: string;
  arch: string;
  roots: string[];
  home: string;
  /** The user's login shell. */
  shell: string;
  pathSep: '/' | '\\';
  capabilities: {
    /** Every request method the runner answers. */
    methods: string[];
    /** What `shell.exec` runs commands with. */
    execShell: 'bash' | 'sh' | 'powershell';
  };
}

export interface SysInfoResult {
  os: string;
  arch: string;
  hostname: string;
  runnerVersion: string;
  cpu: { count: number; model: string };
  /** Bytes. */
  mem: { total: number; available: number };
  /** Volume of the primary root, in bytes. */
  disk: { path: string; total: number; free: number };
  /** 1/5/15 minute load average; null on Windows. */
  load: [number, number, number] | null;
  /** e.g. "2.50.1 (Apple Git-155)"; null when git is not installed. */
  gitVersion: string | null;
  defaultShell: string;
  /** Windows only: Git Bash's bash.exe. */
  gitBash: string | null;
}

export interface SysPingResult {
  /** Unix ms. */
  time: number;
}

export interface SysAddRootParams {
  path: string;
}

export interface SysAddRootResult {
  roots: string[];
}

// ---------------------------------------------------------------- fs

export interface FsStatParams {
  path: string;
}

export interface FsStat {
  /** Resolved absolute path. */
  path: string;
  type: FileType;
  size: number;
  mtimeMs: number;
  /** Permission bits. */
  mode: number;
}

export interface FsReadParams {
  path: string;
  /** utf8: lines to skip; base64: bytes to skip. */
  offset?: number;
  /** utf8: max lines; base64: max bytes. Omitted or 0 reads to the end (capped at 16 MiB). */
  limit?: number;
  encoding?: Encoding;
}

export interface FsReadResult {
  content: string;
  encoding: Encoding;
  /** Hash of the whole file, for `fs.write`'s `expectSha256`. */
  sha256: string;
  size: number;
  totalLines: number;
  /** More content exists past offset+limit or the size cap. */
  truncated: boolean;
  /** A NUL byte in the first 8000 bytes. utf8 reads of binary files return no content. */
  binary: boolean;
}

export interface FsWriteParams {
  path: string;
  content: string;
  encoding?: Encoding;
  /** The file must currently hash to this value, or not exist when "". Mismatch → Conflict. */
  expectSha256?: string;
  /** Create missing parent directories. */
  mkdirp?: boolean;
}

export interface FsWriteResult {
  sha256: string;
  created: boolean;
}

export interface FsListParams {
  path: string;
  /** 1 (default) lists direct children. */
  depth?: number;
  respectGitignore?: boolean;
}

export interface FsEntry {
  path: string;
  name: string;
  type: FileType;
  size: number;
  mtimeMs: number;
}

export interface FsListResult {
  /** Sorted by path. Symlinks are listed, never followed. */
  entries: FsEntry[];
  truncated: boolean;
}

export interface FsMkdirParams {
  path: string;
  recursive?: boolean;
}

export interface FsRemoveParams {
  path: string;
  recursive?: boolean;
}

export interface FsRenameParams {
  from: string;
  to: string;
  overwrite?: boolean;
}

export type InstructionFileName = 'CLAUDE.md' | 'AGENTS.md' | 'ATELIER.md' | 'CLAUDE.local.md' | '.claude/CLAUDE.md';

export interface FsReadAncestorsParams {
  /** A path inside a root; the walk covers it and every directory above it. */
  from: string;
  /** Defaults to all instruction file names. */
  names?: InstructionFileName[];
}

export interface FsReadAncestorsResult {
  /** Outermost directory first; within a directory, in `names` order. */
  files: { path: string; content: string }[];
}

// ---------------------------------------------------------------- search

export interface FsGlobParams {
  /** doublestar pattern, relative to `cwd` or absolute. */
  pattern: string;
  /** Defaults to the primary root. */
  cwd?: string;
  /** Default 100. */
  limit?: number;
}

export interface FsGlobResult {
  /** Absolute paths, newest first. */
  files: string[];
  truncated: boolean;
}

export type GrepOutputMode = 'content' | 'files' | 'count';

export interface FsGrepParams {
  /** RE2 syntax. */
  pattern: string;
  /** File or directory; defaults to the primary root. */
  path?: string;
  /** ripgrep --glob: space-separated, `!` negates. */
  glob?: string;
  /** ripgrep --type, e.g. ts, js, py, go, rust, md, json. */
  type?: string;
  /** Default 'files'. */
  outputMode?: GrepOutputMode;
  caseInsensitive?: boolean;
  lineNumbers?: boolean;
  before?: number;
  after?: number;
  /** Patterns may span lines and `.` matches newlines (rg -U --multiline-dotall). */
  multiline?: boolean;
  /** Caps entries (files/count) or output lines (content). 0 or omitted: no limit. */
  headLimit?: number;
}

export interface FsGrepResult {
  outputMode: GrepOutputMode;
  /** files mode: newest first. */
  files: string[];
  /** content mode: ripgrep's format, "path:12:text" / context "path-11-text" / "--" between groups. */
  lines: string[];
  /** count mode: matching lines per file. */
  counts: { path: string; count: number }[];
  numFiles: number;
  /** Matching lines across all files. */
  numMatches: number;
  truncated: boolean;
}

// ---------------------------------------------------------------- watch

export interface FsWatchParams {
  path: string;
  recursive?: boolean;
}

export interface FsWatchResult {
  watchId: string;
}

export interface FsUnwatchParams {
  watchId: string;
}

export interface FsChangeEvent {
  path: string;
  op: 'create' | 'write' | 'remove' | 'rename';
}

export interface FsChangedNotification {
  watchId: string;
  events: FsChangeEvent[];
}

// ---------------------------------------------------------------- shell

export interface ShellOpenParams {
  /** Defaults to the primary root. */
  cwd?: string;
  /** Overrides on top of the login-shell environment snapshot. */
  env?: Record<string, string>;
}

export interface ShellOpenResult {
  shellId: string;
  cwd: string;
}

export interface ShellExecParams {
  shellId: string;
  command: string;
  /** Foreground default 120000; background default none. */
  timeoutMs?: number;
  /** Return immediately; read output with shell.read. */
  background?: boolean;
  /** Optional client-chosen id, so `shell.output` can be matched to this call before it returns. */
  execId?: string;
}

export interface ShellExecResult {
  execId: string;
  /** null for background execs. Killed by a signal: 128 + signal. */
  exitCode: number | null;
  /** The shell's cwd after the command. */
  cwd: string;
  durationMs: number;
  /** stdout and stderr interleaved; when truncated, the head and tail with a marker between. */
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Live output of a foreground `shell.exec`. */
export interface ShellOutputNotification {
  execId: string;
  chunk: string;
}

export interface ShellReadParams {
  execId: string;
  sinceOffset?: number;
}

export interface ShellReadResult {
  output: string;
  /** Pass as `sinceOffset` next time. */
  offset: number;
  running: boolean;
  exitCode: number | null;
  /** Output between `sinceOffset` and the returned data was dropped. */
  truncated: boolean;
}

export interface ShellKillParams {
  execId: string;
}

export interface ShellKillResult {
  /** false if the command had already exited. */
  killed: boolean;
}

export interface ShellCloseParams {
  shellId: string;
}

// ---------------------------------------------------------------- proc

export interface ProcExecParams {
  /** Executed directly, never through a shell. */
  argv: string[];
  /** Defaults to the primary root. */
  cwd?: string;
  /** Overrides on top of the runner's environment. */
  env?: Record<string, string>;
  stdin?: string;
  /** 0 or omitted: no timeout. */
  timeoutMs?: number;
}

export interface ProcExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout or stderr exceeded 16 MiB. */
  truncated: boolean;
}

// ---------------------------------------------------------------- pty

export interface PtyOpenParams {
  /** Defaults to the primary root. */
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Defaults to the user's login shell. */
  shell?: string;
}

export interface PtyOpenResult {
  ptyId: string;
  shell: string;
  pid: number;
}

export interface PtyWriteParams {
  ptyId: string;
  data: string;
  encoding?: Encoding;
}

export interface PtyResizeParams {
  ptyId: string;
  cols: number;
  rows: number;
}

export interface PtyCloseParams {
  ptyId: string;
}

export interface PtyDataNotification {
  ptyId: string;
  b64: string;
}

export interface PtyExitNotification {
  ptyId: string;
  code: number;
}

// ---------------------------------------------------------------- method and notification maps

type Empty = Record<string, never>;

export interface RunnerMethods {
  initialize: { params: InitializeParams; result: InitializeResult };
  shutdown: { params: Empty; result: null };
  'sys.info': { params: Empty; result: SysInfoResult };
  'sys.ping': { params: Empty; result: SysPingResult };
  'sys.addRoot': { params: SysAddRootParams; result: SysAddRootResult };
  'fs.stat': { params: FsStatParams; result: FsStat };
  'fs.read': { params: FsReadParams; result: FsReadResult };
  'fs.write': { params: FsWriteParams; result: FsWriteResult };
  'fs.list': { params: FsListParams; result: FsListResult };
  'fs.mkdir': { params: FsMkdirParams; result: null };
  'fs.remove': { params: FsRemoveParams; result: null };
  'fs.rename': { params: FsRenameParams; result: null };
  'fs.readAncestors': { params: FsReadAncestorsParams; result: FsReadAncestorsResult };
  'fs.glob': { params: FsGlobParams; result: FsGlobResult };
  'fs.grep': { params: FsGrepParams; result: FsGrepResult };
  'fs.watch': { params: FsWatchParams; result: FsWatchResult };
  'fs.unwatch': { params: FsUnwatchParams; result: null };
  'shell.open': { params: ShellOpenParams; result: ShellOpenResult };
  'shell.exec': { params: ShellExecParams; result: ShellExecResult };
  'shell.read': { params: ShellReadParams; result: ShellReadResult };
  'shell.kill': { params: ShellKillParams; result: ShellKillResult };
  'shell.close': { params: ShellCloseParams; result: null };
  'proc.exec': { params: ProcExecParams; result: ProcExecResult };
  'pty.open': { params: PtyOpenParams; result: PtyOpenResult };
  'pty.write': { params: PtyWriteParams; result: null };
  'pty.resize': { params: PtyResizeParams; result: null };
  'pty.close': { params: PtyCloseParams; result: null };
}

export interface RunnerNotifications {
  'fs.changed': FsChangedNotification;
  'shell.output': ShellOutputNotification;
  'pty.data': PtyDataNotification;
  'pty.exit': PtyExitNotification;
}

export type RunnerMethod = keyof RunnerMethods;
export type RunnerNotification = keyof RunnerNotifications;

/** File name of the runner build for a Node platform/arch, as produced by `pnpm runner:build`. */
export function runnerBinaryName(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const goarch = arch === 'x64' ? 'amd64' : arch;
  return `atelier-runner-${os}-${goarch}${platform === 'win32' ? '.exe' : ''}`;
}
