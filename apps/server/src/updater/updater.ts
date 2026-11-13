/** The compose updater service: holds the Docker socket so the server never does, and can only pull and recreate atelier and sandbox. */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative } from 'node:path';

/** The only services it ever touches. */
export const SERVICES = ['atelier', 'sandbox'] as const;

export interface Job {
  state: 'idle' | 'pulling' | 'restarting' | 'done' | 'failed';
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** While pulling: how much of the new images has come down, once the first layer's size is known. */
  progress: Progress | null;
}

/** Bytes downloaded of the bytes to download, and the share as a whole percent that never goes back. */
export interface Progress {
  done: number;
  total: number;
  percent: number;
  /** Everything is down and the layers are being unpacked. */
  unpacking: boolean;
}

interface Layer {
  current: number;
  total: number | null;
  stage: 'waiting' | 'downloading' | 'downloaded' | 'complete';
}

/**
 * Adds up what `docker compose --progress json pull` prints: one JSON object a line, per image and per layer, with the
 * bytes so far and the layer's size while it downloads. `sizes` (from the registry, by the short id compose names a layer
 * by) gives every layer's size from the start; a layer it lacks counts, until it starts, as big as the average known one.
 * The percent never goes back, and stays below 100 until the pull ends.
 */
export function pullProgress(sizes: ReadonlyMap<string, number> = new Map()) {
  const layers = new Map<string, Layer>();
  let shown = 0;
  return {
    line(text: string): void {
      let event: { id?: unknown; parent_id?: unknown; text?: unknown; current?: unknown; total?: unknown };
      try {
        event = JSON.parse(text) as typeof event;
      } catch {
        return;
      }
      if (typeof event.id !== 'string' || typeof event.parent_id !== 'string') return;
      const key = `${event.parent_id} ${event.id}`;
      const what = typeof event.text === 'string' ? event.text : '';
      if (what === 'Already exists') return void layers.delete(key);
      const layer = layers.get(key) ?? { current: 0, total: sizes.get(event.id) ?? null, stage: 'waiting' };
      if (what === 'Downloading') {
        if (typeof event.current === 'number') layer.current = event.current;
        if (typeof event.total === 'number' && event.total > 0) layer.total = event.total;
        layer.stage = 'downloading';
      } else if (what === 'Verifying Checksum' || what === 'Download complete' || what === 'Extracting') {
        if (layer.total !== null) layer.current = layer.total;
        if (layer.stage !== 'complete') layer.stage = 'downloaded';
      } else if (what === 'Pull complete') {
        if (layer.total !== null) layer.current = layer.total;
        layer.stage = 'complete';
      }
      layers.set(key, layer);
    },
    get(finished = false): Progress | null {
      const all = [...layers.values()];
      const sized = all.filter((l) => l.total !== null);
      if (!sized.length) return finished ? { done: 0, total: 0, percent: 100, unpacking: false } : null;
      const known = sized.reduce((sum, l) => sum + l.total!, 0);
      const waiting = all.filter((l) => l.total === null && l.stage === 'waiting').length;
      // A layer that finished without a size (one compose never reported, too small to) adds nothing either way.
      const total = known + Math.round((known / sized.length) * waiting);
      if (!total && !finished) return null;
      const done = sized.reduce((sum, l) => sum + Math.min(l.current, l.total!), 0);
      shown = finished ? 100 : Math.max(shown, Math.min(99, Math.floor((done / total) * 100)));
      return { done, total, percent: shown, unpacking: !finished && all.every((l) => l.stage === 'downloaded' || l.stage === 'complete') && all.some((l) => l.stage !== 'complete') };
    },
  };
}

export interface Service {
  image: string;
  /** Built on the host (no registry name, or never pulled): `docker compose pull` can't update it. */
  source: boolean;
}

/** Runs the docker CLI; resolves with its output, rejects with what it printed on failure. `onLine` gets each line as it comes. */
export type Docker = (args: string[], onLine?: (line: string) => void) => Promise<string>;

export interface UpdaterOptions {
  docker: Docker;
  /** This container's id (its hostname), whose compose labels name the project. */
  self: string;
  /** The secret the server made, read on every request so a new one applies at once. */
  secret(): Promise<string | null>;
  /** Where the compose project's folder is mounted, read-only. */
  projectMount?: string;
  /** Makes the host's project path lead to the mount, so compose resolves relative paths as on the host. */
  link?(hostPath: string, mount: string): Promise<void>;
  now?: () => number;
}

export interface Answer {
  status: number;
  body: unknown;
}

const LABEL = 'com.docker.compose';
/** How long the layers' sizes may take to read before the pull starts without them. */
const SIZES_MS = 20_000;

/** A name without a registry or namespace (`atelier`, `atelier:local`) can only have been built on this host. */
export function looksLocal(image: string): boolean {
  const name = image.split('@')[0]!;
  const slash = name.lastIndexOf('/');
  const tag = name.slice(slash + 1).split(':')[1];
  return slash < 0 || tag === 'local';
}

interface Manifest {
  layers?: { digest?: string; size?: number }[];
}
interface ManifestEntry {
  Descriptor?: { platform?: { os?: string; architecture?: string } };
  OCIManifest?: Manifest;
  SchemaV2Manifest?: Manifest;
  Raw?: string;
}

/** The layers of one `docker manifest inspect --verbose` answer for this platform: short id (12 hex) to size in bytes. */
export function manifestSizes(answer: unknown, platform: string): Map<string, number> {
  const [os, architecture] = platform.split('/');
  const entries = (Array.isArray(answer) ? answer : [answer]) as ManifestEntry[];
  const entry = entries.length === 1 ? entries[0] : entries.find((e) => e.Descriptor?.platform?.os === os && e.Descriptor?.platform?.architecture === architecture);
  let manifest = entry?.OCIManifest ?? entry?.SchemaV2Manifest;
  if (!manifest && entry?.Raw) {
    try {
      manifest = JSON.parse(Buffer.from(entry.Raw, 'base64').toString('utf8')) as Manifest;
    } catch {
      manifest = undefined;
    }
  }
  const sizes = new Map<string, number>();
  for (const layer of manifest?.layers ?? []) {
    const hex = layer.digest?.split(':')[1];
    if (hex && typeof layer.size === 'number') sizes.set(hex.slice(0, 12), layer.size);
  }
  return sizes;
}

export function createUpdater({ docker, self, secret, projectMount = '/project', link = linkProject, now = Date.now }: UpdaterOptions) {
  let job: Job = { state: 'idle', message: null, startedAt: null, finishedAt: null, progress: null };
  let running: Promise<void> = Promise.resolve();

  const inspect = async <T>(...args: string[]): Promise<T[]> => JSON.parse(await docker(['inspect', ...args])) as T[];

  const project = async () => {
    const [me] = await inspect<{ Config: { Labels: Record<string, string> | null } }>(self);
    const labels = me?.Config.Labels ?? {};
    const name = labels[`${LABEL}.project`];
    const dir = labels[`${LABEL}.project.working_dir`];
    if (!name || !dir) throw new Error('The updater must run as a service of the Atelier compose project.');
    const files = (labels[`${LABEL}.project.config_files`] ?? '').split(',').filter(Boolean);
    return { name, dir, files };
  };

  const services = async (name: string): Promise<Partial<Record<(typeof SERVICES)[number], Service>>> => {
    const found: Partial<Record<(typeof SERVICES)[number], Service>> = {};
    for (const service of SERVICES) {
      const ids = (await docker(['ps', '-a', '-q', '--filter', `label=${LABEL}.project=${name}`, '--filter', `label=${LABEL}.service=${service}`]))
        .split('\n')
        .filter(Boolean);
      if (!ids[0]) continue;
      const [container] = await inspect<{ Image: string; Config: { Image: string } }>(ids[0]);
      if (!container) continue;
      const [image] = await inspect<{ RepoDigests: string[] | null }>('--type', 'image', container.Image);
      found[service] = { image: container.Config.Image, source: looksLocal(container.Config.Image) || !image?.RepoDigests?.length };
    }
    return found;
  };

  const run = async () => {
    try {
      const { name, dir, files } = await project();
      const present = await services(name);
      const names = SERVICES.filter((s) => present[s]);
      if (present.atelier?.source) throw new Error('This server was built from source; update it by rebuilding its image.');
      await link(dir, projectMount);
      // Only the files the project was started with; anything outside its folder isn't mounted here.
      const outside = files.find((f) => relative(dir, f).startsWith('..') || !isAbsolute(f));
      if (outside) throw new Error(`The compose file ${outside} is outside the project folder the updater can see.`);
      const compose = ['compose', '--project-name', name, '--project-directory', dir, ...files.flatMap((f) => ['--file', f])];
      // The pull as JSON, a line an event, added up into the share downloaded so far against the layers' sizes.
      const pulled = pullProgress(await layerSizes(compose, names));
      await docker([...compose, '--progress', 'json', 'pull', ...names], (line) => {
        if (!line.trim()) return;
        pulled.line(line);
        job = { ...job, progress: pulled.get() };
      });
      job = { ...job, state: 'restarting', message: null, progress: pulled.get(true) };
      await docker([...compose, 'up', '--detach', '--no-deps', ...names], (line) => line.trim() && (job = { ...job, message: line.trim() }));
      job = { ...job, state: 'done', message: null, finishedAt: now() };
    } catch (e) {
      job = { ...job, state: 'failed', message: e instanceof Error ? e.message : String(e), finishedAt: now() };
    }
  };

  /** Every layer's size from the registry, so the share is right from the start; empty when that can't be read in time. */
  const layerSizes = (compose: string[], names: readonly string[]): Promise<Map<string, number>> => {
    const sizes = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Map<string, number>>((resolve) => (timer = setTimeout(() => resolve(new Map()), SIZES_MS)));
    return Promise.race([read(compose, names, sizes), late]).finally(() => clearTimeout(timer));
  };
  const read = async (compose: string[], names: readonly string[], sizes: Map<string, number>): Promise<Map<string, number>> => {
    try {
      const platform = (await docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).trim();
      const config = JSON.parse(await docker([...compose, 'config', '--format', 'json'])) as { services?: Record<string, { image?: string }> };
      for (const name of names) {
        const image = config.services?.[name]?.image;
        if (!image) continue;
        const answer: unknown = JSON.parse(await docker(['manifest', 'inspect', '--verbose', image]));
        for (const [id, size] of manifestSizes(answer, platform)) sizes.set(id, size);
      }
    } catch {
      // Without them the pull counts the layers it hasn't started as big as the average.
    }
    return sizes;
  };

  const authorized = async (header: string | undefined) => {
    const expected = await secret();
    if (!expected || !header?.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const wanted = Buffer.from(expected);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  return {
    job: () => job,
    /** Resolves when the current update has finished (tests). */
    settled: () => running,
    async handle(method: string, path: string, authorization: string | undefined): Promise<Answer> {
      if (!(await authorized(authorization))) return { status: 401, body: { error: 'Unauthorized.' } };
      if (method === 'GET' && path === '/status') {
        try {
          const { name } = await project();
          return { status: 200, body: { project: name, services: await services(name), job } };
        } catch (e) {
          return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'POST' && path === '/update') {
        if (job.state === 'pulling' || job.state === 'restarting') return { status: 409, body: { error: 'An update is already running.', job } };
        job = { state: 'pulling', message: null, startedAt: now(), finishedAt: null, progress: null };
        // Answered before the work is done: recreating the server ends the connection that asked.
        running = run();
        return { status: 202, body: { job } };
      }
      return { status: 404, body: { error: 'Not found.' } };
    },
  };
}

/** The host's project folder (from the compose labels) as a link to the read-only mount, so `.env` and relative paths resolve. */
async function linkProject(hostPath: string, mount: string): Promise<void> {
  if (hostPath === mount || existsSync(hostPath)) return;
  await mkdir(dirname(hostPath), { recursive: true });
  await symlink(mount, hostPath);
}

/** Why a docker command failed, from what it printed: compose's JSON error when it printed JSON, else the last lines. */
export function failureText(printed: string, code: number | null): string {
  const lines = printed.trim().split('\n').filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const event = JSON.parse(line) as { error?: unknown; message?: unknown };
      if (event.error === true && typeof event.message === 'string' && event.message.trim()) return event.message.trim().split('\n')[0]!;
    } catch {
      // Not JSON: plain output.
    }
  }
  return lines.slice(-3).join('\n') || `docker exited with ${code}`;
}

export const dockerCli: Docker = (args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // Whole lines only: a line cut between two reads waits for its end.
    const reader = () => {
      let rest = '';
      return {
        read(chunk: Buffer) {
          const parts = (rest + chunk.toString()).split(/\r?\n|\r/);
          rest = parts.pop() ?? '';
          if (onLine) parts.forEach(onLine);
        },
        end: () => rest && onLine?.(rest),
      };
    };
    const stdout = reader();
    const stderr = reader();
    child.stdout.on('data', (chunk: Buffer) => ((out += chunk), stdout.read(chunk)));
    child.stderr.on('data', (chunk: Buffer) => ((err += chunk), stderr.read(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      stdout.end();
      stderr.end();
      if (code === 0) resolve(out);
      else reject(new Error(failureText(err, code)));
    });
  });

/** Starts the HTTP listener (the container's command). */
export function main(env: Record<string, string | undefined> = process.env): void {
  const secretFile = env.ATELIER_UPDATER_SECRET ?? '/updater/secret';
  const updater = createUpdater({
    docker: dockerCli,
    self: env.HOSTNAME ?? hostname(),
    secret: () => readFile(secretFile, 'utf8').then((s) => s.trim() || null, () => null),
  });
  const port = Number(env.ATELIER_UPDATER_PORT ?? 7341);
  createServer((req, res) => {
    req.resume();
    const path = new URL(req.url ?? '/', 'http://updater').pathname;
    void updater.handle(req.method ?? 'GET', path, req.headers.authorization).then(({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  }).listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'updater listening', port })));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
