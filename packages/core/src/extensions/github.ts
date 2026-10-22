/** Downloads a GitHub repository at a commit, for installing skills and plugins (no git needed). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract } from 'tar';

/** An install that can't go ahead; `code` and `data` reach the UI with the message. */
export class InstallError extends Error {
  constructor(
    message: string,
    readonly code = 'install_failed',
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** More than any skill or plugin needs; stops a hostile archive from filling the disk. */
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit; the default branch when absent. */
  ref?: string;
  /** A folder inside the repository ('' for its root). */
  path: string;
}

/** The repository at `ref` in a temporary folder, with the commit it resolved to. Call `cleanup` when done. */
export async function downloadRepo(src: Pick<RepoRef, 'owner' | 'repo' | 'ref'>, fetch: Fetch): Promise<{ dir: string; sha: string; cleanup: () => Promise<void> }> {
  const api = (path: string) =>
    fetch(`https://api.github.com/repos/${src.owner}/${src.repo}${path}`, { headers: { accept: 'application/vnd.github+json' } }).then(async (r) => {
      if (!r.ok) throw new InstallError(r.status === 404 ? `${src.owner}/${src.repo} wasn't found (or is private).` : `GitHub answered ${r.status}.`);
      return r.json() as Promise<Record<string, unknown>>;
    });
  const ref = src.ref ?? String((await api('')).default_branch);
  const sha = String((await api(`/commits/${encodeURIComponent(ref)}`)).sha);
  const dir = await mkdtemp(join(tmpdir(), 'atelier-download-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const tarball = await fetch(`https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${sha}`, {});
    if (!tarball.ok || !tarball.body) throw new InstallError(`Downloading ${src.owner}/${src.repo} failed (${tarball.status}).`);
    // The archive's top folder is `<repo>-<sha>`; entries escaping the folder are refused by tar. Links are
    // dropped, since copying an install would follow them to wherever they point on this machine.
    let unpacked = 0;
    const filter = (_path: string, entry: { type?: string; size?: number }) => {
      if (!['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(entry.type ?? '')) return false;
      unpacked += entry.size ?? 0;
      return unpacked <= MAX_UNPACKED_BYTES;
    };
    await pipeline(Readable.fromWeb(tarball.body as never), extract({ cwd: dir, strip: 1, filter }));
    if (unpacked > MAX_UNPACKED_BYTES) throw new InstallError(`${src.owner}/${src.repo} is larger than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB unpacked.`);
    return { dir, sha, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
