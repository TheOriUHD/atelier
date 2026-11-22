/** The compose updater service: holds the Docker socket so the server never does, and can only pull and recreate atelier and sandbox. */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * What this updater can do beyond the first version's pull-and-restart in one go; `GET /status` lists it. `pull`:
 * download ahead and install later (0.10.6). `version`: install one exact version (`?version=0.10.7-beta.6`), which is
 * how a server on the beta channel gets betas: they have only their version's image tag, never `:latest` (0.10.7).
 */
export const FEATURES = ['pull', 'version'] as const;

/** A version the updater may be asked for: plain semver, the image tag being `v` and it. */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,32})?$/;

/** Atelier's own images by what they are: the server, the sandbox, and this updater. */
const OWN_IMAGES = { atelier: 'atelier', sandbox: 'atelier-sandbox', updater: 'atelier-updater' } as const;
type Own = keyof typeof OWN_IMAGES;

/** Whether `image` is Atelier's own image of that kind (by its name, wherever it is pulled from). */
export function isOwnImage(image: string, kind: Own): boolean {
  const name = image.split('@')[0]!;
  const slash = name.lastIndexOf('/');
  const colon = name.indexOf(':', slash + 1);
  return (colon < 0 ? name : name.slice(0, colon)).slice(slash + 1) === OWN_IMAGES[kind];
}

/**
 * `image` at the tag of `version` (`ghcr.io/theoriuhd/atelier:latest` → `…/atelier:v0.10.7-beta.6`), or null when it
 * isn't Atelier's own image under that name (a custom one is left as the compose file has it). A digest pin is replaced too.
 */
export function imageAt(image: string, kind: Own, version: string): string | null {
  if (!isOwnImage(image, kind)) return null;
  const name = image.split('@')[0]!;
  const slash = name.lastIndexOf('/');
  const colon = name.indexOf(':', slash + 1);
  return `${colon < 0 ? name : name.slice(0, colon)}:v${version}`;
}

/** The only services it ever touches. */
export const SERVICES = ['atelier', 'sandbox'] as const;

export interface Job {
  state: 'idle' | 'pulling' | 'restarting' | 'done' | 'failed';
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** While pulling: how much of the new images has come down, once the first layer's size is known. */
  progress: Progress | null;
  /** When the new images finished coming down and wait for the install (a pull without a restart); null otherwise. */
  pulledAt: number | null;
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
  /** Writes the compose file that names a chosen version's images; returns its path (in this container's temp folder). */
  writeOverride?(content: string): Promise<string>;
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

export function createUpdater({ docker, self, secret, projectMount = '/project', link = linkProject, writeOverride = writeOverrideFile, now = Date.now }: UpdaterOptions) {
  let job: Job = { state: 'idle', message: null, startedAt: null, finishedAt: null, progress: null, pulledAt: null };
  let running: Promise<void> = Promise.resolve();

  const inspect = async <T>(...args: string[]): Promise<T[]> => JSON.parse(await docker(['inspect', ...args])) as T[];

  const project = async () => {
    const [me] = await inspect<{ Image?: string; Config: { Labels: Record<string, string> | null } }>(self);
    const labels = me?.Config.Labels ?? {};
    const name = labels[`${LABEL}.project`];
    const dir = labels[`${LABEL}.project.working_dir`];
    if (!name || !dir) throw new Error('The updater must run as a service of the Atelier compose project.');
    // Compose records every file it was given, the version files this updater and its helper wrote too: they aren't the
    // project's, and the next update writes its own again (or none, on the compose file's own tags).
    const files = (labels[`${LABEL}.project.config_files`] ?? '').split(',').filter((f) => f && f !== OVERRIDE_PATH);
    // This updater's own service in the project, and the image it runs (an id): an update brings it along.
    return { name, dir, files, service: labels[`${LABEL}.service`] ?? null, imageId: me?.Image ?? null };
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

  /**
   * `pull`: download the new images; `restart`: recreate the server and the sandbox from the images on this host.
   * `version`: those of that version (their `v<version>` tags) instead of the tags the compose file names.
   */
  const run = async ({ pull, restart, version }: { pull: boolean; restart: boolean; version: string | null }) => {
    try {
      const { name, dir, files, service: own, imageId } = await project();
      const present = await services(name);
      const names = SERVICES.filter((s) => present[s]);
      if (present.atelier?.source) throw new Error('This server was built from source; update it by rebuilding its image.');
      await link(dir, projectMount);
      // Only the files the project was started with; anything outside its folder isn't mounted here.
      const outside = files.find((f) => relative(dir, f).startsWith('..') || !isAbsolute(f));
      if (outside) throw new Error(`The compose file ${outside} is outside the project folder the updater can see.`);
      const base = ['compose', '--project-name', name, '--project-directory', dir, ...files.flatMap((f) => ['--file', f])];
      // The updater comes along when it runs Atelier's own image: downloaded with the rest, put in place after the install.
      const config = JSON.parse(await docker([...base, 'config', '--format', 'json'])) as { services?: Record<string, { image?: string }> };
      const mine = own && config.services?.[own]?.image && isOwnImage(config.services[own].image, 'updater') ? own : null;
      const override = version ? versionOverride(config, [...names, ...(mine ? [mine] : [])], version, mine) : null;
      const compose = override ? [...base, '--file', await writeOverride(JSON.stringify(override, null, 2))] : base;
      const pulls = [...names, ...(mine ? [mine] : [])];
      let progress: Progress | null = null;
      if (pull) {
        // The pull as JSON, a line an event, added up into the share downloaded so far against the layers' sizes.
        const pulled = pullProgress(await layerSizes(compose, pulls));
        await docker([...compose, '--progress', 'json', 'pull', ...pulls], (line) => {
          if (!line.trim()) return;
          pulled.line(line);
          job = { ...job, progress: pulled.get() };
        });
        progress = pulled.get(true);
      }
      if (!restart) {
        // Downloaded and waiting: the install is another request, and takes seconds because nothing is left to fetch.
        job = { state: 'idle', message: null, startedAt: job.startedAt, finishedAt: now(), progress, pulledAt: now() };
        return;
      }
      job = { ...job, state: 'restarting', message: null, progress, pulledAt: null };
      await docker([...compose, 'up', '--detach', '--no-deps', ...names], (line) => line.trim() && (job = { ...job, message: line.trim() }));
      job = { ...job, state: 'done', message: null, finishedAt: now() };
      // Last, this updater: a helper from the new image recreates it (it can't recreate itself, it would stop midway).
      if (mine) await replaceSelf({ name, dir, files, service: mine, imageId, image: override?.services[mine]?.image ?? config.services![mine]!.image! }).catch(() => undefined);
    } catch (e) {
      job = { ...job, state: 'failed', message: e instanceof Error ? e.message : String(e), finishedAt: now(), pulledAt: null };
    }
  };

  /**
   * One more compose file, on top of the project's, that names the images of `version` for Atelier's own services. The
   * project's files stay as they are: a later `docker compose up -d` by hand goes back to the tags they name.
   */
  const versionOverride = (config: { services?: Record<string, { image?: string }> }, names: readonly string[], version: string, mine: string | null) => {
    const services: Record<string, { image: string }> = {};
    for (const service of names) {
      const image = config.services?.[service]?.image;
      const kind: Own = service === mine ? 'updater' : (service as Own);
      const at = image ? imageAt(image, kind, version) : null;
      if (at) services[service] = { image: at };
    }
    if (!services.atelier) throw new Error(`The compose file's atelier service doesn't run Atelier's own image, so the updater can't choose its version.`);
    return { services };
  };

  /**
   * Starts a short-lived container of the updater's new image that recreates this updater's service from it, when the
   * image differs from the one this updater runs. It shares this container's volumes (the Docker socket, the project
   * folder, the secret) and needs no network.
   */
  const replaceSelf = async (target: { name: string; dir: string; files: string[]; service: string; imageId: string | null; image: string }) => {
    const id = (await docker(['image', 'inspect', '--format', '{{.Id}}', target.image]).catch(() => '')).trim();
    if (!id || id === target.imageId) return;
    const plan: ReplacePlan = { project: target.name, dir: target.dir, files: target.files, service: target.service, image: target.image };
    // At most five minutes: an image too old to know the helper's job would otherwise sit there listening for ever.
    await docker(['run', '--detach', '--rm', '--network', 'none', '--volumes-from', self, '--env', `${REPLACE_ENV}=${JSON.stringify(plan)}`, '--entrypoint', 'timeout', target.image, '300', 'node', '/app/updater.ts']);
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
    /** `target` is the request's path, with its query. */
    async handle(method: string, target: string, authorization: string | undefined): Promise<Answer> {
      if (!(await authorized(authorization))) return { status: 401, body: { error: 'Unauthorized.' } };
      const { pathname: path, searchParams } = new URL(target, 'http://updater');
      if (method === 'GET' && path === '/status') {
        try {
          const { name } = await project();
          return { status: 200, body: { project: name, services: await services(name), job, features: FEATURES } };
        } catch (e) {
          return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'POST' && (path === '/update' || path === '/pull')) {
        if (job.state === 'pulling' || job.state === 'restarting') return { status: 409, body: { error: 'An update is already running.', job } };
        // `/pull` only downloads. `/update` downloads and installs, or with `?pull=false` installs what a `/pull` fetched.
        const pull = path === '/pull' || searchParams.get('pull') !== 'false';
        const restart = path === '/update';
        // `?version=`: that version's images, not the compose file's tags (a beta has only its own version's tag).
        const version = searchParams.get('version');
        if (version !== null && !VERSION.test(version)) return { status: 400, body: { error: `"${version.slice(0, 40)}" isn't a version.` } };
        job = { state: pull ? 'pulling' : 'restarting', message: null, startedAt: now(), finishedAt: null, progress: null, pulledAt: pull ? null : job.pulledAt };
        // Answered before the work is done: recreating the server ends the connection that asked.
        running = run({ pull, restart, version });
        return { status: 202, body: { job } };
      }
      return { status: 404, body: { error: 'Not found.' } };
    },
  };
}

/** What the helper container is told: which service of which project to recreate, and from which image. */
export interface ReplacePlan {
  project: string;
  dir: string;
  files: string[];
  service: string;
  image: string;
}
/** The helper's one input; with it the container recreates the updater and exits instead of listening. */
export const REPLACE_ENV = 'ATELIER_UPDATER_REPLACE';

/**
 * The helper's work: recreate the updater's service from `image` (written over the compose file's own tag, which is how
 * a beta updater stays a beta's), leaving every other service alone.
 */
export async function replaceUpdater(plan: ReplacePlan, { docker, projectMount = '/project', link = linkProject, writeOverride = writeOverrideFile }: Pick<UpdaterOptions, 'docker' | 'projectMount' | 'link' | 'writeOverride'>): Promise<void> {
  if (!plan.project || !plan.dir || !plan.service || !plan.image || !Array.isArray(plan.files)) throw new Error('Nothing to replace.');
  await link(plan.dir, projectMount);
  const override = await writeOverride(JSON.stringify({ services: { [plan.service]: { image: plan.image } } }, null, 2));
  const compose = ['compose', '--project-name', plan.project, '--project-directory', plan.dir, ...plan.files.flatMap((f) => ['--file', f]), '--file', override];
  await docker([...compose, 'up', '--detach', '--no-deps', plan.service]);
}

/** The chosen version's compose file, in this container's own temp folder (the project folder is mounted read-only). */
const OVERRIDE_PATH = join(tmpdir(), 'atelier-version.compose.json');
async function writeOverrideFile(content: string): Promise<string> {
  await writeFile(OVERRIDE_PATH, content, { mode: 0o600 });
  return OVERRIDE_PATH;
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
  // The helper an update started: it puts the new updater in place, then exits.
  if (env[REPLACE_ENV]) {
    void replaceUpdater(JSON.parse(env[REPLACE_ENV]) as ReplacePlan, { docker: dockerCli }).then(
      () => console.log(JSON.stringify({ level: 'info', message: 'updater replaced' })),
      (e: unknown) => {
        console.error(JSON.stringify({ level: 'error', message: `replacing the updater failed: ${e instanceof Error ? e.message : String(e)}` }));
        process.exitCode = 1;
      },
    );
    return;
  }
  const secretFile = env.ATELIER_UPDATER_SECRET ?? '/updater/secret';
  const updater = createUpdater({
    docker: dockerCli,
    self: env.HOSTNAME ?? hostname(),
    secret: () => readFile(secretFile, 'utf8').then((s) => s.trim() || null, () => null),
  });
  const port = Number(env.ATELIER_UPDATER_PORT ?? 7341);
  createServer((req, res) => {
    req.resume();
    void updater.handle(req.method ?? 'GET', req.url ?? '/', req.headers.authorization).then(({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  }).listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'updater listening', port })));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
