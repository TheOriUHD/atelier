/**
 * Co-op parallel tracks (ARCHITECTURE §24): git worktrees of the session's folder, one per track, where an agent works for
 * one person beside the conversation. The host merges a finished track's branch into the folder, or closes it. The git
 * here runs on the folder's machine through its runner, like the Code view's git bar (workspaces/git.ts).
 */
import type { Workspace } from '../workspaces/workspace.ts';

export class TrackError extends Error {}

/** What a track's session keeps of it (its `overrides.coopTrack`). */
export interface TrackRecord {
  participantId: string;
  branch: string;
  path: string;
  workspaceId: string;
  /** The commit it started from. */
  base: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: number;
}

const TIMEOUT_MS = 120_000;
/** At most this much of a track's diff is shown. */
const MAX_DIFF = 400_000;

async function git(ws: Workspace, argv: string[], cwd = ws.root): Promise<string> {
  const r = await ws.runner.call('proc.exec', { argv: ['git', ...argv], cwd, timeoutMs: TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } }).catch((e: unknown) => {
    throw new TrackError(e instanceof Error ? e.message : String(e));
  });
  if (r.timedOut) throw new TrackError(`git ${argv[0]} took too long.`);
  if (r.exitCode !== 0) throw new TrackError((r.stderr || r.stdout).trim() || `git ${argv[0]} failed (exit ${r.exitCode}).`);
  return r.stdout;
}

/** A branch name for a track: `atelier/track-<who>-<id>`, only characters git and shells take as they are. */
export function trackBranch(who: string, id: string): string {
  const name = who.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'guest';
  return `atelier/track-${name}-${id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
}

/** A worktree of `main`'s repository at `path`, on a new `branch` from its HEAD; returns the commit it starts from. */
export async function addTrack(main: Workspace, branch: string, path: string): Promise<string> {
  const base = (await git(main, ['rev-parse', 'HEAD']).catch(() => {
    throw new TrackError('Parallel tracks need a git repository with at least one commit.');
  })).trim();
  await git(main, ['worktree', 'add', '-b', branch, '--', path, base]);
  return base;
}

/** Everything a track's worktree holds: its commits since `base` and what it hasn't committed, new files included. */
export async function trackDiff(track: Workspace, base: string): Promise<{ diff: string; truncated: boolean; base: string }> {
  await git(track, ['add', '-A']);
  const diff = await git(track, ['diff', '--cached', base]);
  return diff.length > MAX_DIFF ? { diff: diff.slice(0, MAX_DIFF), truncated: true, base } : { diff, truncated: false, base };
}

/**
 * Commits what the track left uncommitted, then merges its branch into the main folder. A merge that doesn't go cleanly
 * is undone and refused with git's own words, so the folder is as it was.
 */
export async function mergeTrack(main: Workspace, track: Workspace, branch: string, message: string, author: { name: string; email: string }): Promise<void> {
  const identity = [...(author.name ? ['-c', `user.name=${author.name}`] : []), ...(author.email ? ['-c', `user.email=${author.email}`] : [])];
  await git(track, ['add', '-A']);
  const staged = await track.runner.call('proc.exec', { argv: ['git', 'diff', '--cached', '--quiet'], cwd: track.root, timeoutMs: TIMEOUT_MS, env: {} });
  if (staged.exitCode === 1) await git(track, [...identity, 'commit', '-q', '-m', message]);
  try {
    await git(main, [...identity, 'merge', '--no-ff', '--no-edit', branch]);
  } catch (error) {
    await git(main, ['merge', '--abort']).catch(() => undefined);
    throw new TrackError(`It doesn’t merge cleanly, so nothing changed: ${error instanceof Error ? error.message.split('\n').slice(0, 6).join(' ') : String(error)}`);
  }
}

/** The track's worktree and branch go. */
export async function removeTrack(main: Workspace, branch: string, path: string): Promise<void> {
  await git(main, ['worktree', 'remove', '--force', '--', path]).catch(() => git(main, ['worktree', 'prune']));
  await git(main, ['branch', '-D', '--', branch]).catch(() => undefined);
}
