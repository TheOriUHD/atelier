/**
 * Servers this computer already knows, offered first when choosing one: the server the Atelier desktop app on this
 * computer is connected to (its `connection.json`, a plain address), and the one this terminal used before.
 */
import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { CliConfig } from '../config.ts';

export interface KnownServer {
  url: string;
  /** Why it is offered: "your Atelier app uses it", "used before". */
  why: string;
}

/** The desktop app's userData folder (Electron's, named after the app). */
export function desktopDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Atelier');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Atelier');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Atelier');
}

export async function knownServers(config: CliConfig, dir = desktopDataDir()): Promise<KnownServer[]> {
  const out: KnownServer[] = [];
  const desktop = await readFile(join(dir, 'connection.json'), 'utf8')
    .then((t) => JSON.parse(t) as { mode?: string; serverUrl?: string })
    .catch(() => null);
  if (desktop?.mode === 'server' && typeof desktop.serverUrl === 'string' && /^https?:\/\//.test(desktop.serverUrl)) out.push({ url: desktop.serverUrl.replace(/\/+$/, ''), why: 'your Atelier app uses it' });
  const before = config.connection?.mode === 'server' ? config.connection.serverUrl.replace(/\/+$/, '') : null;
  if (before && !out.some((k) => k.url === before)) out.push({ url: before, why: 'used before' });
  return out;
}

/** The app macOS asks about local network access for: the terminal this runs in. */
export function terminalApp(env: NodeJS.ProcessEnv = process.env): string {
  const program = env.TERM_PROGRAM ?? '';
  return (
    { 'iTerm.app': 'iTerm', Apple_Terminal: 'Terminal', ghostty: 'Ghostty', WezTerm: 'WezTerm', vscode: env.CURSOR_TRACE_ID ? 'Cursor' : 'Visual Studio Code', Hyper: 'Hyper', Tabby: 'Tabby', rio: 'Rio' } as Record<string, string>
  )[program] ?? (/kitty/.test(env.TERM ?? '') ? 'kitty' : 'your terminal app');
}

export const LOCAL_NETWORK_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork';

export function openLocalNetworkSettings(): void {
  if (process.platform !== 'darwin') return;
  const child = spawn('open', [LOCAL_NETWORK_PANE], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Whether macOS refuses this terminal the local network: a connection to the network's first address (usually the
 * router) fails at once with "no route to host" when it does, where a real network answers or times out. macOS only.
 */
export function localNetworkBlocked(interfaces = networkInterfaces()): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const mine = Object.entries(interfaces)
    .filter(([name]) => /^en\d/.test(name))
    .flatMap(([, list]) => list ?? [])
    .find((a) => a.family === 'IPv4' && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address));
  if (!mine) return Promise.resolve(false);
  const host = mine.address.split('.').slice(0, 3).concat('1').join('.');
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port: 80, timeout: 1500 });
    const done = (blocked: boolean) => (socket.destroy(), resolve(blocked));
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(false));
    socket.once('error', (e: NodeJS.ErrnoException) => done((e.code === 'EHOSTUNREACH' || e.code === 'EPERM' || e.code === 'EACCES') && Date.now() - started < 300));
  });
}

