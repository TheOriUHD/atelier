/**
 * Updates as the desktop app does them: an installed copy looks for a newer version when it starts (at most every six
 * hours), downloads, checks and unpacks it in the background and points `atelier` at it. The running session goes on
 * unchanged; the next start is the new version, and its background service replaces the old one once it is idle.
 * `/update` and `atelier update` do the same at once. A server that mirrors releases is asked first, with this
 * terminal's sign-in; the public feed otherwise.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { updateConfig, type CliConfig } from '../config.ts';
import { credentialStore, tokenName } from '../keychain.ts';
import type { CliPaths } from '../paths.ts';
import { activate, install, installRoot, latest, newer, publicFeed, selfInstalled, serverFeed, VERSION, type Feed } from './update.ts';

const EVERY_MS = 6 * 3600_000;
/** Another start downloading the same version holds this long before it counts as abandoned. */
const LOCK_MS = 15 * 60_000;

export type UpdateResult =
  | { kind: 'installed'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'newest'; version: string }
  | { kind: 'not-installed'; version: string };

/** The feed to ask: the server's mirror when this terminal is signed in to one that has it, else the public one. */
async function feedFor(p: CliPaths, config: CliConfig, channel: string): Promise<Feed> {
  if (config.connection?.mode === 'server') {
    const token = await (await credentialStore(p.credentials)).get(tokenName(config.connection.serverUrl)).catch(() => null);
    if (token) {
      const mirrored = serverFeed(config.connection.serverUrl, token, channel);
      if (await latest(mirrored).then(() => true, () => false)) return mirrored;
    }
  }
  return publicFeed(channel);
}

/** One download of a version at a time, across terminals started together. */
async function locked<T>(p: CliPaths, version: string, work: () => Promise<T>): Promise<T | null> {
  await mkdir(p.updates, { recursive: true });
  const lock = join(p.updates, `${version}.lock`);
  const held = await stat(lock).then((s) => Date.now() - s.mtimeMs < LOCK_MS, () => false);
  if (held) return null;
  await rm(lock, { force: true });
  const handle = await open(lock, 'wx').catch(() => null);
  if (!handle) return null;
  try {
    return await work();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

/** Looks for a newer version and, when allowed, installs it; never throws for a feed that can't be reached. */
export async function updateNow(p: CliPaths, config: CliConfig, options: { channel?: string; install: boolean; onProgress?: (text: string) => void; timeoutMs?: number }): Promise<UpdateResult> {
  const channel = options.channel ?? config.channel;
  const feed = await feedFor(p, config, channel);
  const manifest = await latest(feed, options.timeoutMs ?? 15_000);
  await updateConfig(p.config, (c) => ({ ...c, checkedForUpdatesAt: Date.now() }));
  if (!newer(manifest.version, VERSION)) return { kind: 'newest', version: VERSION };
  if (!selfInstalled()) return { kind: 'not-installed', version: manifest.version };
  if (!options.install) return { kind: 'available', version: manifest.version };
  const ready = join(installRoot().versions, manifest.version);
  const done = await locked(p, manifest.version, async () => {
    // Downloaded before (a start that was closed before it pointed `atelier` at it): only the pointing is left.
    const target = existsSync(join(ready, 'bin')) ? ready : await install(feed, manifest, p.updates, options.onProgress);
    await activate(target);
    return true;
  });
  return done ? { kind: 'installed', version: manifest.version } : { kind: 'available', version: manifest.version };
}

/** The check a start makes in the background: a line for the session, or nothing. */
export async function autoUpdate(p: CliPaths, config: CliConfig, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.ATELIER_NO_UPDATE_CHECK || !selfInstalled() || Date.now() - (config.checkedForUpdatesAt ?? 0) < EVERY_MS) return null;
  const result = await updateNow(p, config, { install: config.autoUpdate, timeoutMs: 5000 }).catch(() => null);
  if (result?.kind === 'installed') return `Atelier CLI ${result.version} is downloaded: it starts next time (atelier -c carries on with this session).`;
  if (result?.kind === 'available') return `Atelier CLI ${result.version} is out: /update gets it.`;
  return null;
}

/** What an update did, in a line. */
export function updateWords(result: UpdateResult, beta = false): string {
  switch (result.kind) {
    case 'newest':
      return `Atelier CLI ${result.version} is the newest${beta ? ' (beta)' : ''}.`;
    case 'not-installed':
      return `Atelier CLI ${result.version} is out. This copy wasn’t installed with the installer; update it the way you installed it, or run: curl -fsSL https://updates.atelierhq.dev/cli | sh`;
    case 'available':
      return `Atelier CLI ${result.version} is being downloaded by another terminal; it starts next time.`;
    case 'installed':
      return `✓ Updated to Atelier CLI ${result.version}. It starts next time; the background service follows once it is idle.`;
  }
}
