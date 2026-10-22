/**
 * What the Code view shows of a workspace: one directory level of the file tree, a file's text, and git's
 * view of the working tree. Paths are relative to the workspace root with `/` separators; the runner
 * resolves them and refuses anything outside the workspace.
 */
import type { DiffCompare, GitFileStatus, GitStatus, WorkspaceEntry, WorkspaceFile } from '@atelier/protocol';
import { unifiedDiff } from './line-diff.ts';
import type { Workspace } from './workspace.ts';

const MAX_FILE_LINES = 5000;
const MAX_INDEXED_FILES = 20_000;
const INDEX_TTL_MS = 10_000;
const MAX_DIFF_CHARS = 2_000_000;
const MAX_UNTRACKED_DIFFS = 50;
/** Git's empty tree: diffs against it when the repository has no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function listDir(ws: Workspace, dir: string): Promise<WorkspaceEntry[]> {
  const { entries } = await ws.runner.call('fs.list', { path: dir || '.', depth: 1, respectGitignore: true });
  return entries
    .filter((e) => e.name !== '.git')
    .map((e) => ({ name: e.name, path: relative(ws, e.path), kind: e.type === 'dir' ? 'dir' : e.type === 'symlink' ? 'symlink' : 'file', size: e.size }) satisfies WorkspaceEntry)
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
}

export async function readFile(ws: Workspace, path: string): Promise<WorkspaceFile> {
  const r = await ws.runner.call('fs.read', { path, limit: MAX_FILE_LINES });
  return { path, content: r.binary ? null : r.content, truncated: r.truncated, size: r.size };
}

const indexes = new WeakMap<Workspace, { at: number; files: Promise<string[]> }>();

/**
 * Files matching what the person typed after `@`, best first: name starts with it, then name contains it,
 * then path contains it (case-insensitive). The file list is cached for a few seconds per workspace.
 */
export async function findFiles(ws: Workspace, query: string, limit = 50): Promise<string[]> {
  let index = indexes.get(ws);
  if (!index || Date.now() - index.at > INDEX_TTL_MS) {
    index = { at: Date.now(), files: ws.runner.call('fs.glob', { pattern: '**/*', limit: MAX_INDEXED_FILES }).then((r) => r.files.map((f) => relative(ws, f))) };
    indexes.set(ws, index);
    index.files.catch(() => indexes.delete(ws));
  }
  const files = await index.files;
  const q = query.toLowerCase();
  const rank = (path: string) => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : 3;
  };
  return files
    .map((path) => ({ path, rank: rank(path) }))
    .filter((f) => f.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((f) => f.path);
}

/** null outside a git repository (or without git). */
export async function gitStatus(ws: Workspace): Promise<GitStatus> {
  const r = await git(ws, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  return r && r.exitCode === 0 ? parseStatus(r.stdout) : null;
}

/** What `gitDiff` compares the working tree with; `session` is `sessionDiff`'s. */
export type GitCompare = Exclude<DiffCompare, 'session'>;

/**
 * A unified diff of the working tree; one file when `path` is given. `head`: against HEAD, untracked files included.
 * `staged`: what is staged, against HEAD. `base`: against where the branch left the default branch, untracked files
 * included. `base` in the result names what the diff starts from.
 */
export async function gitDiff(ws: Workspace, path?: string, compare: GitCompare = 'head'): Promise<{ diff: string; truncated: boolean; base: string | null }> {
  const head = await git(ws, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head) return { diff: '', truncated: false, base: null };
  let base: string | null = head.exitCode === 0 ? 'HEAD' : null;
  let from = base ?? EMPTY_TREE;
  if (compare === 'base') {
    const main = await defaultBranch(ws);
    const fork = main ? await git(ws, ['merge-base', main.ref, 'HEAD']) : null;
    if (!main || fork?.exitCode !== 0) return { diff: '', truncated: false, base: null };
    base = main.name;
    from = fork.stdout.trim();
  }
  const only = path ? ['--', path] : [];
  const tracked = await git(ws, ['diff', ...(compare === 'staged' ? ['--cached'] : []), from, '--no-color', '--no-ext-diff', ...only]);
  let diff = tracked?.exitCode === 0 ? tracked.stdout : '';
  if (compare !== 'staged') {
    const status = await gitStatus(ws);
    const untracked = (status?.files ?? []).filter((f) => f.status === 'untracked' && (!path || f.path === path)).slice(0, MAX_UNTRACKED_DIFFS);
    for (const file of untracked) {
      if (diff.length >= MAX_DIFF_CHARS) break;
      // --no-index exits 1 when the files differ, which they always do here.
      const r = await git(ws, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file.path]);
      if (r) diff += r.stdout;
    }
  }
  return { ...clipDiff(diff), base };
}

const clipDiff = (diff: string) => (diff.length > MAX_DIFF_CHARS ? { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true } : { diff, truncated: false });

/**
 * The repository's main line: origin's HEAD, else a local `main`, `master` or `trunk`. `ref` is what git resolves
 * (`origin/main`), `name` what people call it (`main`). Null when there is none, or outside a repository.
 */
export async function defaultBranch(ws: Workspace): Promise<{ name: string; ref: string } | null> {
  const origin = await git(ws, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const remote = origin?.exitCode === 0 ? origin.stdout.trim() : '';
  if (remote) return { name: remote.replace(/^origin\//, ''), ref: remote };
  for (const name of ['main', 'master', 'trunk']) {
    const local = await git(ws, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (local?.exitCode === 0) return { name, ref: name };
  }
  return null;
}

/**
 * The files a session's Write and Edit calls changed, from how each was before the session first changed it (null:
 * it didn't exist) to how it is now. Works outside git repositories too; changes made by Bash aren't tracked.
 */
export async function sessionDiff(
  ws: Workspace,
  files: { path: string; before(): Promise<string | null> }[],
  path?: string,
): Promise<{ diff: string; truncated: boolean; base: null }> {
  let diff = '';
  for (const file of files) {
    if (diff.length >= MAX_DIFF_CHARS) break;
    const rel = relative(ws, file.path);
    if (path && rel !== path) continue;
    const now = await ws.runner.call('fs.read', { path: file.path, encoding: 'base64' }).then(
      (r) => Buffer.from(r.content, 'base64').toString('utf8'),
      () => null,
    );
    diff += unifiedDiff(rel, await file.before(), now);
  }
  return { ...clipDiff(diff), base: null };
}

const GREP_LIMIT = 300;

/**
 * The Files pane's content search: lines containing `query` as typed (not a pattern), ignoring case unless it has
 * capitals. Paths relative to the root; at most 300 lines.
 */
export async function grepFiles(ws: Workspace, query: string): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
  const pattern = query.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  const r = await ws.runner.call('fs.grep', { pattern, outputMode: 'content', lineNumbers: true, caseInsensitive: query === query.toLowerCase(), headLimit: GREP_LIMIT });
  const matches = r.lines.flatMap((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    return m ? [{ path: relative(ws, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, 500) }] : [];
  });
  return { matches, truncated: r.truncated || r.lines.length >= GREP_LIMIT };
}

/** Paths come out as they are (`café.txt`, not `"caf\303\251.txt"`), as the Diff tab and `git status -z` expect. */
function git(ws: Workspace, args: string[]) {
  return ws.runner.call('proc.exec', { argv: ['git', '-c', 'core.quotePath=false', ...args], cwd: ws.root, timeoutMs: 15_000 }).catch(() => null);
}

function relative(ws: Workspace, absolute: string): string {
  const rel = absolute.startsWith(ws.root) ? absolute.slice(ws.root.length).replace(/^[\\/]+/, '') : absolute;
  return ws.pathSep === '\\' ? rel.replaceAll('\\', '/') : rel;
}

/** `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): NonNullable<GitStatus> {
  const records = out.split('\0');
  let branch: string | null = null;
  let upstream: NonNullable<GitStatus>['upstream'] = null;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.startsWith('# branch.head ')) {
      const name = r.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
    } else if (r.startsWith('# branch.ab ')) {
      const [ahead, behind] = r.slice('# branch.ab '.length).split(' ').map((n) => Math.abs(Number(n)));
      upstream = { ahead: ahead ?? 0, behind: behind ?? 0 };
    } else if (r.startsWith('1 ') || r.startsWith('2 ')) {
      const fields = r.split(' ');
      const xy = fields[1]!;
      // Ordinary entries have 8 fields before the path, renames 9 (plus the original path in the next record).
      const path = fields.slice(r.startsWith('1 ') ? 8 : 9).join(' ');
      if (r.startsWith('2 ')) i++;
      files.push({ path, status: r.startsWith('2 ') ? 'renamed' : codeStatus(xy), staged: xy[0] !== '.' });
    } else if (r.startsWith('u ')) {
      files.push({ path: r.split(' ').slice(10).join(' '), status: 'conflicted', staged: false });
    } else if (r.startsWith('? ')) {
      files.push({ path: r.slice(2), status: 'untracked', staged: false });
    }
  }
  return { branch, upstream, files };
}

function codeStatus(xy: string): GitFileStatus['status'] {
  const code = xy[1] !== '.' ? xy[1] : xy[0];
  return code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
}
