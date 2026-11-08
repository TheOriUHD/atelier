/**
 * Keeping the terminal app up to date (ARCHITECTURE §25). A release has `atelier-cli.json` (the version, and per
 * platform its package's name, size and sha512) and the packages, each with an Ed25519 `.sig` made by the release's
 * key, checked against the key this build carries (`APP.updatePublicKey`) as desktop updates are. It comes from the
 * public feed (updates.atelierhq.dev/<channel>/), or, signed in to a server that mirrors releases, from that server.
 * An update unpacks into `versions/<version>` beside the running one and moves the `atelier` link to it.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { APP } from '@atelier/protocol';
import { VERSION } from '../runtime.ts';

export const CliManifest = z.object({
  version: z.string(),
  files: z.record(z.string(), z.object({ file: z.string(), sha512: z.string(), size: z.number() })),
});
export type CliManifest = z.infer<typeof CliManifest>;

export const MANIFEST = 'atelier-cli.json';
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'x64' : arch}`;
export const packageName = (version: string, key: string) => `atelier-cli-${version}-${key}.${key.startsWith('windows') ? 'zip' : 'tar.gz'}`;

/** Where installs live: `~/.local/share/atelier` (Windows: `%LOCALAPPDATA%\Atelier\cli`), with the link in `~/.local/bin`. */
export function installRoot(env: NodeJS.ProcessEnv = process.env): { versions: string; bin: string } {
  if (process.platform === 'win32') {
    const base = join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Atelier', 'cli');
    return { versions: join(base, 'versions'), bin: join(base, 'bin') };
  }
  return { versions: join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'atelier', 'versions'), bin: join(homedir(), '.local', 'bin') };
}

/** a > b for dotted versions with an optional `-beta.N`. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-');
    return { nums: main!.split('.').map(Number), pre: pre ? Number(pre.replace(/\D/g, '')) : Infinity };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  return x.pre > y.pre;
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function isSigned(file: string, sha512: string, signature: string, publicKey = APP.updatePublicKey): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`atelier-update:v1\n${file}\n${sha512}`, 'utf8'), key, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}

export interface Feed {
  base: string;
  headers: Record<string, string>;
}

/** The public feed, or the server's mirror (`<server>/updates`) with this terminal's token. */
export const publicFeed = (channel: string): Feed => ({ base: `${APP.updateFeed}/${channel}`, headers: {} });
export const serverFeed = (serverUrl: string, token: string, channel: string): Feed => ({ base: `${serverUrl}/updates/${channel}`, headers: { Authorization: `Bearer ${token}` } });

export async function latest(feed: Feed, timeoutMs = 4000): Promise<CliManifest> {
  const res = await fetch(`${feed.base}/${MANIFEST}`, { headers: feed.headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`The update feed answered ${res.status}.`);
  return CliManifest.parse(await res.json());
}

const sha512File = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha512');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject);
  });

/** Downloads, checks and unpacks a version; returns its folder. */
export async function install(feed: Feed, manifest: CliManifest, work: string, onProgress?: (text: string) => void): Promise<string> {
  const key = platformKey();
  const entry = manifest.files[key];
  if (!entry) throw new Error(`Atelier CLI ${manifest.version} has no build for ${key}.`);
  const sig = await fetch(`${feed.base}/${entry.file}.sig`, { headers: feed.headers, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.text() : ''));
  if (!sig || !isSigned(entry.file, entry.sha512, sig)) throw new Error(`${entry.file} isn’t signed by Atelier’s release key. Nothing was changed.`);
  await mkdir(work, { recursive: true });
  const archive = join(work, entry.file);
  onProgress?.(`Downloading ${entry.file} (${(entry.size / 1048576).toFixed(0)} MB)…`);
  const res = await fetch(`${feed.base}/${entry.file}`, { headers: feed.headers });
  if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}.`);
  await writeFile(archive, Buffer.from(await res.arrayBuffer()));
  if ((await sha512File(archive)) !== entry.sha512) throw new Error(`${entry.file} came down damaged (its checksum differs). Nothing was changed.`);
  const { versions } = installRoot();
  const target = join(versions, manifest.version);
  const unpacking = `${target}.part`;
  await rm(unpacking, { recursive: true, force: true });
  await mkdir(unpacking, { recursive: true });
  onProgress?.('Unpacking…');
  if (archive.endsWith('.zip')) {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${unpacking}' -Force`], (e) => (e ? reject(e) : resolve())));
  } else {
    const tar = await import('tar');
    await tar.x({ file: archive, cwd: unpacking, strip: 1 });
  }
  await rm(target, { recursive: true, force: true });
  await rename(unpacking, target);
  await rm(archive, { force: true });
  return target;
}

/** Points `atelier` at a version; older ones beyond the newest three are removed. */
export async function activate(target: string): Promise<string> {
  const { versions, bin } = installRoot();
  await mkdir(bin, { recursive: true });
  if (process.platform === 'win32') {
    const shim = join(bin, 'atelier.cmd');
    await writeFile(shim, `@echo off\r\n"${join(target, 'bin', 'atelier.cmd')}" %*\r\n`);
    return shim;
  }
  const link = join(bin, 'atelier');
  const temp = `${link}.${process.pid}`;
  await symlink(join(target, 'bin', 'atelier'), temp);
  await rename(temp, link);
  await chmod(join(target, 'bin', 'atelier'), 0o755).catch(() => undefined);
  const all = (await readdir(versions).catch(() => [] as string[])).filter((v) => /^\d/.test(v) && !v.endsWith('.part')).sort((a, b) => (newer(a, b) ? -1 : 1));
  for (const old of all.slice(3)) await rm(join(versions, old), { recursive: true, force: true });
  return link;
}

/** Whether this copy runs from an install made by the installer (and can update itself). */
export function selfInstalled(): boolean {
  const { versions } = installRoot();
  return (process.argv[1] ?? '').startsWith(versions);
}

export async function currentLink(): Promise<string | null> {
  const { bin } = installRoot();
  return readlink(join(bin, 'atelier')).catch(() => null);
}

export { VERSION, existsSync, dirname, unlink };
