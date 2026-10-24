/**
 * What the main process keeps in Electron's userData dir: the connection choice, the sign-in token
 * (encrypted with safeStorage), this machine's device id, the folders the person trusted here and the update
 * channel (Settings › System, a setting of this computer rather than of an account).
 */
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseConnection, type Connection } from './connection.ts';
import { readTrustedFolders } from './device-link.ts';

const file = (name: string) => join(app.getPath('userData'), name);

/** The saved choice, or null before the first one (or when the file no longer validates). */
export async function loadConnection(): Promise<Connection | null> {
  try {
    return parseConnection(JSON.parse(await readFile(file('connection.json'), 'utf8')));
  } catch {
    return null;
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  await writeFile(file('connection.json'), JSON.stringify(connection, null, 2));
}

/** "Sign out" / "Change setup…": the next start shows the first-run choice again. Local data stays where it is. */
export async function clearConnection(): Promise<void> {
  await rm(file('connection.json'), { force: true });
}

/** Where a token is valid: this computer's backend or the server URL. */
export const tokenTarget = (connection: Connection) => (connection.mode === 'server' ? connection.serverUrl : 'local');

const SavedToken = z.object({ target: z.string(), token: z.string() });

/** The token saved for this target. One issued by another target is never handed out. */
export async function loadToken(target: string): Promise<string | null> {
  try {
    const saved = SavedToken.parse(JSON.parse((await safeStorage.decryptStringAsync(await readFile(file('session.bin')))).result));
    return saved.target === target ? saved.token : null;
  } catch {
    return null;
  }
}

export async function saveToken(target: string, token: string): Promise<void> {
  await writeFile(file('session.bin'), await safeStorage.encryptStringAsync(JSON.stringify({ target, token })), { mode: 0o600 });
}

export async function clearToken(): Promise<void> {
  await rm(file('session.bin'), { force: true });
}

const UpdateSettings = z.object({ channel: z.enum(['stable', 'beta']).default('stable'), automatic: z.boolean().default(true) });
export type UpdateSettings = z.infer<typeof UpdateSettings>;

/** The update channel and whether the app checks by itself; a missing or unreadable file means stable and yes. */
export async function loadUpdateSettings(): Promise<UpdateSettings> {
  return readFile(file('updates.json'), 'utf8')
    .then((text) => UpdateSettings.parse(JSON.parse(text)))
    .catch(() => UpdateSettings.parse({}));
}

export async function saveUpdateSettings(change: Partial<UpdateSettings>): Promise<void> {
  await writeFile(file('updates.json'), JSON.stringify({ ...(await loadUpdateSettings()), ...change }, null, 2));
}

export interface Device {
  id: string;
  name: string;
  platform: 'macOS' | 'Windows' | 'Linux';
}

/** This machine as a device of its user (`devices.register`); the id is created once and kept. */
export async function loadDevice(): Promise<Device> {
  const path = file('device.json');
  let id = await readFile(path, 'utf8')
    .then((text) => z.object({ id: z.uuid() }).parse(JSON.parse(text)).id)
    .catch(() => null);
  if (!id) {
    id = randomUUID();
    await writeFile(path, JSON.stringify({ id }));
  }
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return { id, name: hostname().replace(/\.local$/i, ''), platform };
}

/**
 * Folders the person picked on this machine. A server may only start runners inside these (ARCHITECTURE
 * §21). That keeps its file tools to them, but commands it runs there can reach anything the person can.
 * Main passes the path to the server relay, which has no Electron `app` to ask.
 */
export const trustedFoldersFile = () => file('trusted-folders.json');

/** What this computer lets each server do here (`lending.ts`). */
export const lendingFile = () => file('lending.json');

/** ssh's askpass script and its logs, for SSH hosts reached from here for a server. */
export const sshDir = () => file('ssh');

/** A picked folder's workspace root: its git top level, or the folder itself (resolved). Trusts nothing. */
export async function workspaceRoot(picked: string): Promise<string> {
  const top = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: picked, timeout: 5000, windowsHide: true }).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  return normalize(await realpath(top || picked));
}

/** Trusts a folder at its workspace root (what the backend will use) and returns that root. */
export async function trustFolder(picked: string): Promise<string> {
  const root = await workspaceRoot(picked);
  const trusted = await readTrustedFolders(trustedFoldersFile());
  if (!trusted.includes(root)) await writeFile(trustedFoldersFile(), JSON.stringify([...trusted, root], null, 2));
  return root;
}
