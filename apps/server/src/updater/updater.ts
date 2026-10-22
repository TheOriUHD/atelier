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

/** A name without a registry or namespace (`atelier`, `atelier:local`) can only have been built on this host. */
export function looksLocal(image: string): boolean {
  const name = image.split('@')[0]!;
  const slash = name.lastIndexOf('/');
  const tag = name.slice(slash + 1).split(':')[1];
  return slash < 0 || tag === 'local';
}

export function createUpdater({ docker, self, secret, projectMount = '/project', link = linkProject, now = Date.now }: UpdaterOptions) {
  let job: Job = { state: 'idle', message: null, startedAt: null, finishedAt: null };
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
      const progress = (line: string) => line.trim() && (job = { ...job, message: line.trim() });
      await docker([...compose, 'pull', ...names], progress);
      job = { ...job, state: 'restarting', message: null };
      await docker([...compose, 'up', '--detach', '--no-deps', ...names], progress);
      job = { ...job, state: 'done', message: null, finishedAt: now() };
    } catch (e) {
      job = { ...job, state: 'failed', message: e instanceof Error ? e.message : String(e), finishedAt: now() };
    }
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
        job = { state: 'pulling', message: null, startedAt: now(), finishedAt: null };
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

const dockerCli: Docker = (args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const lines = (chunk: Buffer) => onLine && chunk.toString().split(/\r?\n|\r/).forEach(onLine);
    child.stdout.on('data', (chunk: Buffer) => ((out += chunk), lines(chunk)));
    child.stderr.on('data', (chunk: Buffer) => ((err += chunk), lines(chunk)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `docker exited with ${code}`))));
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
