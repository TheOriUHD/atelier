/**
 * Fetches the speech engine and its model into a folder of the backend's data (manifest.ts): each file streamed to a
 * `.part` file, checked against its hash, then renamed into place; the engine's npm package unpacked from its tarball.
 * A `ready.json` names what is installed, so a later start doesn't hash 680 MB again.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { gunzipSync } from 'node:zlib';
import { SPEECH_MODEL, SPEECH_RUNTIME, SPEECH_RUNTIME_VERSION } from './manifest.ts';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface InstallPaths {
  /** The folder with `sherpa-onnx.node` and its libraries. */
  runtime: string;
  /** The folder with the model's files. */
  model: string;
}

export const installPaths = (dir: string, platform: string): InstallPaths => ({
  runtime: join(dir, `runtime-${SPEECH_RUNTIME_VERSION}-${platform}`),
  model: join(dir, SPEECH_MODEL.id),
});

const MARKER = 'ready.json';

/** Whether both are in place as this version wants them (by the marker and the files' sizes). */
export async function installed(dir: string, platform: string): Promise<boolean> {
  const paths = installPaths(dir, platform);
  try {
    const marker = JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as { runtime?: string; model?: string };
    if (marker.runtime !== `${SPEECH_RUNTIME_VERSION}-${platform}` || marker.model !== SPEECH_MODEL.id) return false;
    await stat(join(paths.runtime, 'sherpa-onnx.node'));
    for (const f of SPEECH_MODEL.files) if ((await stat(join(paths.model, f.name))).size !== f.bytes) return false;
    return true;
  } catch {
    return false;
  }
}

/** Streams `url` to `file`, hashing on the way; rejects unless the hash (and size, when given) match. */
async function download(fetch: Fetch, url: string, file: string, check: { algorithm: 'sha256' | 'sha512'; digest: string; encoding: 'hex' | 'base64'; bytes?: number }, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${new URL(url).host} answered ${response.status} for ${url.split('/').at(-1)}.`);
  const hash = createHash(check.algorithm);
  const part = `${file}.part`;
  let size = 0;
  // A pipeline, so a full disk or a dropped connection rejects here (and cleans up) instead of throwing elsewhere.
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.byteLength;
      onBytes(chunk.byteLength);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), tap, createWriteStream(part), { signal });
  } catch (e) {
    await rm(part, { force: true });
    throw e instanceof Error && 'code' in e && e.code === 'ENOSPC' ? new Error('There is no room left on the disk for the speech model (about 715 MB).') : e;
  }
  const digest = hash.digest(check.encoding);
  if (digest !== check.digest || (check.bytes !== undefined && size !== check.bytes)) {
    await rm(part, { force: true });
    throw new Error(`${url.split('/').at(-1)} didn’t arrive intact (its checksum is wrong).`);
  }
  await rename(part, file);
}

/** The flat files of an npm package tarball (`package/<name>`), nothing outside it. */
export function untarPackage(tgz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from: number, length: number) => new TextDecoder().decode(header.subarray(from, from + length)).replace(/\0.*$/s, '');
    const name = `${text(345, 155) ? `${text(345, 155)}/` : ''}${text(0, 100)}`;
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1);
    const body = tar.subarray(at + 512, at + 512 + size);
    // Regular files directly in package/; pax headers, folders and anything with a path in it are skipped.
    if ((type === '0' || type === '') && /^package\/[A-Za-z0-9._-]+$/.test(name)) files.set(name.slice('package/'.length), body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export interface InstallProgress {
  received: number;
  total: number;
}

/** Fetches what is missing, reporting bytes as they come; a second call while one runs joins it. */
export async function install(options: { dir: string; platform: string; fetch: Fetch; onProgress(progress: InstallProgress): void; signal: AbortSignal }): Promise<InstallPaths> {
  const { dir, platform, fetch, signal } = options;
  const runtime = SPEECH_RUNTIME[platform];
  if (!runtime) throw new Error(`Atelier’s speech model doesn’t run on ${platform}.`);
  const paths = installPaths(dir, platform);
  await mkdir(paths.model, { recursive: true });
  const total = runtime.bytes + SPEECH_MODEL.files.reduce((n, f) => n + f.bytes, 0);
  let received = 0;
  const add = (n: number) => {
    received += n;
    options.onProgress({ received, total });
  };

  // The engine: an npm tarball, checked against npm's own integrity value, unpacked into a folder of its own that takes
  // the engine's place only once every file is in it (a crash halfway leaves no engine, so the next try fetches it).
  if (!(await stat(join(paths.runtime, 'sherpa-onnx.node')).then(() => true, () => false))) {
    const tgz = join(dir, `runtime-${platform}.tgz`);
    const [algorithm, digest] = runtime.integrity.split('-') as ['sha512', string];
    // The tarball is smaller than what it unpacks to: its bytes count up to the engine's share of the total.
    await download(fetch, runtime.url, tgz, { algorithm, digest, encoding: 'base64' }, (n) => add(Math.max(0, Math.min(n, runtime.bytes - received))), signal);
    const files = untarPackage(new Uint8Array(await readFile(tgz)));
    if (!files.has('sherpa-onnx.node')) throw new Error('The speech engine’s package has no sherpa-onnx.node.');
    const unpacking = `${paths.runtime}.part`;
    await rm(unpacking, { recursive: true, force: true });
    await mkdir(unpacking, { recursive: true });
    for (const [name, bytes] of files) await writeFile(join(unpacking, name), bytes, { mode: 0o755 });
    await rm(paths.runtime, { recursive: true, force: true });
    await rename(unpacking, paths.runtime);
    await rm(tgz, { force: true });
  }
  received = runtime.bytes;
  options.onProgress({ received, total });

  for (const f of SPEECH_MODEL.files) {
    const file = join(paths.model, f.name);
    if ((await stat(file).catch(() => null))?.size === f.bytes) {
      add(f.bytes);
      continue;
    }
    await download(fetch, SPEECH_MODEL.base + f.name, file, { algorithm: 'sha256', digest: f.sha256, encoding: 'hex', bytes: f.bytes }, add, signal);
  }
  await writeFile(join(dir, MARKER), JSON.stringify({ runtime: `${SPEECH_RUNTIME_VERSION}-${platform}`, model: SPEECH_MODEL.id, at: Date.now() }));
  return paths;
}

/** Forgets the engine and the marker (an engine that couldn't load), so the next try fetches it again. */
export async function forgetRuntime(dir: string, platform: string): Promise<void> {
  await rm(join(dir, MARKER), { force: true });
  await rm(installPaths(dir, platform).runtime, { recursive: true, force: true });
}
