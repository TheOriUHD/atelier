/**
 * The Code view's git bar (ARCHITECTURE §8): branches, staging, commits, push and pull requests, run with
 * `git` (and `gh` for pull requests) on the workspace's machine, so its credentials and config apply.
 */
import type { Workspace } from './workspace.ts';
import { defaultBranch } from './workspace-view.ts';

export class GitError extends Error {}

const TIMEOUT_MS = 60_000;
/** Push and PR creation talk to the network. */
const NETWORK_TIMEOUT_MS = 120_000;

async function run(ws: Workspace, argv: string[], timeoutMs = TIMEOUT_MS, stdin?: string): Promise<string> {
  const r = await ws.runner.call('proc.exec', { argv, cwd: ws.root, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' }, ...(stdin !== undefined ? { stdin } : {}) }).catch((e: unknown) => {
    throw new GitError(e instanceof Error ? e.message : String(e));
  });
  if (r.timedOut) throw new GitError(`${argv.slice(0, 2).join(' ')} took too long.`);
  if (r.exitCode !== 0) throw new GitError((r.stderr || r.stdout).trim() || `${argv.slice(0, 2).join(' ')} failed (exit ${r.exitCode}).`);
  return r.stdout;
}

export async function branches(ws: Workspace): Promise<{ current: string | null; branches: string[]; lastCommit: string | null; defaultBranch: string | null }> {
  const out = await run(ws, ['git', 'branch', '--format=%(HEAD)%(refname:short)']);
  const lines = out.split('\n').filter(Boolean);
  const current = lines.find((l) => l.startsWith('*'))?.slice(1) ?? null;
  // A repository without commits has no subject to offer.
  const lastCommit = (await run(ws, ['git', 'log', '-1', '--format=%s']).catch(() => '')).trim() || null;
  return {
    current: current === '' || current?.startsWith('(') ? null : current,
    branches: lines.map((l) => l.slice(1)).filter((b) => !b.startsWith('(')),
    lastCommit,
    defaultBranch: (await defaultBranch(ws))?.name ?? null,
  };
}

export async function checkout(ws: Workspace, branch: string, create: boolean): Promise<void> {
  if (branch.startsWith('-')) throw new GitError('Branch names cannot start with "-".');
  await run(ws, create ? ['git', 'switch', '-c', branch] : ['git', 'switch', branch]);
}

export async function stage(ws: Workspace, paths: string[], staged: boolean): Promise<void> {
  if (!paths.length) return;
  // `reset` unstages in a repository without commits too, where `restore --staged` can't resolve HEAD.
  await run(ws, staged ? ['git', 'add', '--', ...paths] : ['git', 'reset', '-q', '--', ...paths]);
}

/** Commits what is staged; returns the new commit's short hash. */
export async function commit(ws: Workspace, message: string, author: { name: string; email: string }): Promise<string> {
  if (!message.trim()) throw new GitError('Write a commit message first.');
  const identity = [...(author.name ? ['-c', `user.name=${author.name}`] : []), ...(author.email ? ['-c', `user.email=${author.email}`] : [])];
  await run(ws, ['git', ...identity, 'commit', '-m', message]);
  return (await run(ws, ['git', 'rev-parse', '--short', 'HEAD'])).trim();
}

/**
 * Rejects one hunk of the Diff pane: reverse-applies a single-file patch (the file's header lines from
 * `workspaces.diff` plus the hunk). A staged hunk leaves the index too; when the file's staged and working
 * versions differ, only the working tree changes.
 */
export async function revertPatch(ws: Workspace, patch: string): Promise<void> {
  if ((patch.match(/^diff --git /gm) ?? []).length !== 1 || !/^@@ /m.test(patch)) throw new GitError('Send one file header and its hunk.');
  const input = patch.endsWith('\n') ? patch : `${patch}\n`;
  const apply = (index: boolean) => run(ws, ['git', 'apply', '--reverse', ...(index ? ['--index'] : []), '--whitespace=nowarn', '-'], TIMEOUT_MS, input);
  await apply(true).catch(() => apply(false));
}

/** Pushes the current branch, setting its upstream on `origin` the first time. */
export async function push(ws: Workspace): Promise<void> {
  const { current } = await branches(ws);
  if (!current) throw new GitError('Check out a branch before pushing.');
  await run(ws, ['git', 'push', '--set-upstream', 'origin', current], NETWORK_TIMEOUT_MS);
}

/** Opens a pull request for the current branch with the GitHub CLI; returns its URL. */
export async function createPullRequest(ws: Workspace, input: { title: string; body: string; base?: string }): Promise<string> {
  const argv = ['gh', 'pr', 'create', '--title', input.title, '--body', input.body, ...(input.base ? ['--base', input.base] : [])];
  const out = await run(ws, argv, NETWORK_TIMEOUT_MS).catch((e: unknown) => {
    if (e instanceof GitError && /executable file not found|no such file|not found/i.test(e.message)) {
      throw new GitError('Opening a pull request needs the GitHub CLI (gh) on the machine with this workspace, signed in with `gh auth login`.');
    }
    throw e;
  });
  return out.trim().split('\n').at(-1) ?? '';
}

const SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * The repository at the start of a Code session, for its first context note: branch, default branch, changed files and
 * the last five commit subjects. Null when the folder isn't a repository or git doesn't answer quickly. Repository-set
 * fsmonitor hooks don't run.
 */
export async function repositorySnapshot(ws: Workspace): Promise<{ branch: string; defaultBranch: string; changed: number; subjects: string[] } | null> {
  const git = (...args: string[]) => run(ws, ['git', '--no-pager', '-c', 'core.fsmonitor=false', ...args], SNAPSHOT_TIMEOUT_MS);
  try {
    const [branch, status, log, origin] = await Promise.all([
      git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('status', '--porcelain'),
      git('log', '-5', '--format=%s').catch(() => ''),
      git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => ''),
    ]);
    return {
      branch: branch.trim(),
      defaultBranch: origin.trim().replace(/^origin\//, '') || 'unknown',
      changed: status.split('\n').filter(Boolean).length,
      subjects: log.split('\n').filter(Boolean),
    };
  } catch {
    return null;
  }
}
