/**
 * Where the terminal app keeps its things (ARCHITECTURE §25). `~/.atelier/cli/` by default, `ATELIER_CLI_DIR` moves it.
 * Separate from the desktop app's `~/.atelier` data (its secrets are sealed by Electron and its backend owns that
 * database), but the person's skills, commands, agents and instructions in `~/.atelier` and `~/.claude` are found by
 * home discovery as on the desktop.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * The daemon's socket. A Unix socket path is limited to about 104 bytes (macOS) or 108 (Linux), so a long home folder
 * falls back to a folder of its own under the temp dir; Windows uses a named pipe named after the folder.
 */
export function socketPath(dir: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.() ?? 0): string {
  if (platform === 'win32') return `\\\\.\\pipe\\atelier-cli-${hashOf(dir)}`;
  const preferred = join(dir, 'run', 'daemon.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : join(tmpdir(), `atelier-${uid}`, `${hashOf(dir)}.sock`);
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
