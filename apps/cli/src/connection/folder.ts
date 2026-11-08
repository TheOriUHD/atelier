/**
 * The folder a terminal works in: the git repository around the current directory (or the directory itself), as one of
 * the person's folders on the backend. A folder seen for the first time is trusted after the person says so, as Claude
 * Code asks; for a server that means its sessions may run commands as them in that folder.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorkspaceSummary } from '@atelier/protocol';
import { readJson, writePrivate } from '../config.ts';
import type { CliPaths } from '../paths.ts';
import type { Connected } from './connect.ts';

const run = promisify(execFile);

/** The repository's top level around `dir`, or `dir`; resolved through symlinks, as the device link compares. */
export async function folderRoot(dir: string): Promise<string> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 5000 }).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  return realpath(top || dir).catch(() => top || dir);
}

const samePath = (a: string, b: string) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b) || a.replace(/\\/g, '/') === b.replace(/\\/g, '/');

/** The person's folder at `root` on this computer, if the backend knows it. */
export async function knownFolder(c: Connected, root: string): Promise<WorkspaceSummary | null> {
  const list = await c.rpc.call('workspaces.list', {});
  return list.find((w) => w.kind === 'local' && !w.scratch && samePath(w.root, root) && (c.mode === 'local' || w.deviceId === c.device?.id)) ?? null;
}

/** Whether this terminal's trust list has the folder (server mode: what the device link lends). */
export async function trustedHere(p: CliPaths, root: string): Promise<boolean> {
  const list = await readJson(p.trusted, z.array(z.string()), []);
  return list.some((t) => samePath(t, root));
}

/** Trusts the folder (server mode: on this computer first, so the device link lends it) and adds it as the person's folder. */
export async function trustFolder(c: Connected, p: CliPaths, root: string): Promise<WorkspaceSummary> {
  if (c.mode === 'server') {
    const list = await readJson(p.trusted, z.array(z.string()), []);
    if (!list.some((t) => samePath(t, root))) await writePrivate(p.trusted, `${JSON.stringify([...list, root], null, 2)}\n`);
  }
  const added = await c.rpc.call('workspaces.addLocal', { path: root });
  return added.trusted === false ? c.rpc.call('workspaces.trust', { id: added.id }) : added;
}
