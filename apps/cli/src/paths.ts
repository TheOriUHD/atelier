/**
 * Where the terminal app keeps its things (ARCHITECTURE §25). `~/.atelier/cli/` by default, `ATELIER_CLI_DIR` moves it.
 * Separate from the desktop app's `~/.atelier` data (its secrets are sealed by Electron and its backend owns that
 * database), but the person's skills, commands, agents and instructions in `~/.atelier` and `~/.claude` are found by
 * home discovery as on the desktop.
 */
import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function cliDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATELIER_CLI_DIR || join(homedir(), '.atelier', 'cli');
}

export const paths = (dir = cliDir()) => ({
  dir,
  config: join(dir, 'config.json'),
  credentials: join(dir, 'credentials.json'),
  device: join(dir, 'device.json'),
  trusted: join(dir, 'trusted-folders.json'),
  lending: join(dir, 'lending.json'),
  history: join(dir, 'history.jsonl'),
  logs: join(dir, 'logs'),
  run: join(dir, 'run'),
  /** The standalone backend: its settings.json and prompts beside this, its database and blobs in `data/`. */
  backendConfig: dir,
  backendData: join(dir, 'data'),
  scratch: join(dir, 'data', 'scratch-workspaces'),
  ssh: join(dir, 'ssh'),
  updates: join(dir, 'updates'),
});

export type CliPaths = ReturnType<typeof paths>;

/**
 * The daemon's Unix socket. Its path is limited to about 104 bytes (macOS) or 108 (Linux), so a long home folder falls
 * back to a folder of its own under the temp dir, which must then be this user's alone (`checkPlace`).
 */
export function socketPath(dir: string, uid = process.getuid?.() ?? 0): string {
  const preferred = join(dir, 'run', 'daemon.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : join(tmpdir(), `atelier-${uid}`, `${hashOf(dir)}.sock`);
}

/**
 * On Windows the daemon listens on a named pipe with a random name, kept in `run/daemon.pipe` (in the user's profile,
 * which only they can read): a pipe named after the folder alone could be taken first by another user of the computer,
 * who would then get the token a terminal sends.
 */
export const pipeFile = (dir: string) => join(dir, 'run', 'daemon.pipe');
export const newPipeName = (dir: string) => `\\\\.\\pipe\\atelier-cli-${hashOf(dir)}-${randomBytes(12).toString('hex')}`;

/** Where the running service listens: the socket, or the pipe named in `daemon.pipe`; null when there is none. */
export async function servicePath(dir: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== 'win32') return socketPath(dir);
  const name = (await readFile(pipeFile(dir), 'utf8').catch(() => '')).trim();
  return /^\\\\\.\\pipe\\atelier-cli-[0-9a-f]+-[0-9a-f]{24}$/.test(name) ? name : null;
}

/**
 * Whether a Unix socket's folder (and the socket, once it exists) are this user's alone: owned by them, not a link, and
 * not open to others. Anyone else's would let them put their own socket there and read the token a terminal sends.
 * Returns what is wrong, or null.
 */
export async function checkPlace(socket: string, uid = process.getuid?.()): Promise<string | null> {
  if (uid === undefined) return null;
  const dir = await lstat(dirname(socket)).catch(() => null);
  if (!dir) return null;
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o022) !== 0) return `${dirname(socket)} isn't yours alone (owner, a link, or writable by others).`;
  const file = await lstat(socket).catch(() => null);
  if (file && (file.uid !== uid || file.isSymbolicLink())) return `${socket} isn't yours.`;
  return null;
}

/** A short stable name for a folder (FNV-1a, hex). */
export function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
