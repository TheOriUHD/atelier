/**
 * What this desktop lends a server beyond runners for trusted folders (ARCHITECTURE §21): a folder for each session
 * started without one, SSH hosts reached with this computer's ssh, keys, known hosts and runner builds, requests to
 * addresses on this computer or its network (personal model servers and connectors), the person's own connectors that
 * run a program here, their config in its home folder, and the app's ChatGPT window. Each needs the person's say-so on
 * this computer (`lending.json`), so a server can't make it do more than they allowed here.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { APP, DEVICE_LINK_PROTOCOL, UNSAFE_CONNECTOR_ENV, type DeviceHello, type DeviceLending, type DeviceRequest, type DeviceStart } from '@atelier/protocol';
import {
  bootstrapRunner,
  detectLocalServers,
  homeFs,
  importClaudeCode,
  interpolate,
  plainHttpFetch,
  probeSsh,
  programChannel,
  remoteRunnerChannel,
  runOnce,
  scanHome,
  sshConfigHosts,
  throughShell,
  watchHome,
  writeAskpass,
  type RunnerChannel,
} from '@atelier/core/device';
import { connectorFingerprint } from './lending.ts';

/** Why this computer didn't do what the server asked: the person didn't allow it here, or it can't. */
export class Refusal extends Error {
  constructor(
    readonly code: 'refused' | 'unsupported' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceServicesOptions {
  /** This computer's name, for what the person reads. */
  deviceName: string;
  /** What the person allowed the server to do here, read again for every request. */
  lending(): Promise<DeviceLending>;
  /** Where scratch folders go (`<data folder>/scratch-workspaces`), a folder per account inside. */
  scratchDir: string;
  /** The runner builds and their checksums, for SSH hosts; null when there are none. */
  runnerDir: string | null;
  /** The `ssh` command. */
  ssh: string;
  /** A private folder for ssh's askpass script and its logs. */
  sshDir: string;
  /** One call to the app's ChatGPT window (main's ChatGptChatBrowser); absent where there is none. */
  chatgptChat?: (operation: Extract<DeviceRequest, { op: 'chatgptChat' }>['operation'], value: string) => Promise<string>;
  /** The folders trusted here, whose `.mcp.json` an import from Claude Code reads. */
  trustedFolders?(): Promise<string[]>;
  /** This computer's home folder (the person's config, and where connectors' programs run). */
  home?: string;
}

/** How long after the person opened the import here a server may read Claude Code's connectors (with their keys). */
const IMPORT_WINDOW_MS = 2 * 60_000;

/** A runner of an SSH host that failed this soon after it started was probably gone from there: look for it again next time. */
const EARLY_EXIT_MS = 10_000;

/** Whether `url` is at or below `base`: the same origin, and the base's path or one under it. */
export function withinAddress(url: string, base: string): boolean {
  const u = URL.parse(url);
  const b = URL.parse(base);
  if (!u || !b || u.origin !== b.origin || u.username || u.password) return false;
  const root = b.pathname.replace(/\/+$/, '');
  return u.pathname === root || u.pathname.startsWith(`${root}/`) || root === '';
}

/** A channel whose lines this computer writes (an HTTP response): buffered until the link listens. */
function lineChannel(onKill: () => void) {
  const pending: string[] = [];
  let listener: ((line: string) => void) | null = null;
  let finish!: () => void;
  const closed = new Promise<{ code: null; signal: null }>((r) => (finish = () => r({ code: null, signal: null })));
  let ended = false;
  const channel: RunnerChannel = {
    send: () => {},
    onLine: (handler) => {
      listener = handler;
      for (const line of pending.splice(0)) handler(line);
    },
    closed,
    kill: () => {
      onKill();
      end();
    },
  };
  const emit = (value: object) => {
    const line = JSON.stringify(value);
    if (listener) listener(line);
    else pending.push(line);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    finish();
  };
  return { channel, emit, end };
}

export type DeviceServices = ReturnType<typeof deviceServices>;

export function deviceServices(o: DeviceServicesOptions) {
  let script: Promise<string | null> | null = null;
  const askpass = () => (script ??= writeAskpass(o.sshDir));
  /** Where each SSH host keeps this app's runner, found (or uploaded) once while it keeps working. */
  const runners = new Map<string, Promise<{ runner: string; home: string }>>();

  const allowSsh = async (host: string) => {
    if (!(await o.lending()).ssh.includes(host)) throw new Refusal('refused', `${host} isn't an SSH host you use from ${o.deviceName}: choose it in the desktop app there first.`);
  };
  const home = o.home ?? homedir();
  const allowHome = async () => {
    if (!(await o.lending()).home) throw new Refusal('refused', `${o.deviceName} doesn't share the config in its home folder: allow it in the desktop app there.`);
  };
  /** Until when the person's import here lets the server read Claude Code's connectors. */
  let importUntil = 0;

  return {
    services: ['runner', 'scratch', 'ssh', 'http', 'mcp', 'home', ...(o.chatgptChat ? ['chatgptChat'] : [])],

    async hello(): Promise<DeviceHello> {
      return { protocol: DEVICE_LINK_PROTOCOL, app: APP.version, services: this.services, lending: await o.lending(), home, sep, os: process.platform, arch: process.arch };
    },

    /** The person opened "Import from Claude Code" in a window here: the server may read its connectors for a while. */
    allowImport(): void {
      importUntil = Date.now() + IMPORT_WINDOW_MS;
    },

    /** Tells `onChange` when the person's config in the home folder changes, so a server reads it again. */
    watchHome(onChange: () => void): () => void {
      return watchHome(home, onChange);
    },

    /**
     * For a runner the server asks for at `real` (resolved through symlinks): its environment when it is exactly one of
     * this computer's scratch folders (`<scratch>/<account>/<name>`) and they are allowed; null otherwise. Git never looks
     * above a scratch folder.
     */
    async scratchEnv(real: string): Promise<Record<string, string> | null> {
      if (!(await o.lending()).scratch) return null;
      const base = await realpath(o.scratchDir).catch(() => null);
      if (!base) return null;
      const rel = relative(base, real);
      const parts = rel.split(sep);
      if (isAbsolute(rel) || parts.length !== 2 || parts.some((p) => !p || p === '..')) return null;
      return { GIT_CEILING_DIRECTORIES: dirname(real) };
    },

    async request(request: DeviceRequest): Promise<unknown> {
      switch (request.op) {
        case 'scratch.create': {
          if (!(await o.lending()).scratch) throw new Refusal('refused', `Sessions without a folder aren't allowed on ${o.deviceName}: allow them in the desktop app there.`);
          const parent = join(o.scratchDir, request.user);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          const dir = join(parent, request.name);
          await mkdir(dir, { mode: 0o700 });
          return { root: await realpath(dir) };
        }
        case 'ssh.hosts':
          return sshConfigHosts();
        case 'ssh.probe':
          await allowSsh(request.connection.host);
          return probeSsh({ ssh: o.ssh, dir: o.sshDir }, await askpass(), request.connection, request.answers);
        case 'ssh.test': {
          await allowSsh(request.connection.host);
          const shell = throughShell(o.ssh, o.sshDir, await askpass(), request.connection, request.answers);
          return (await runOnce(shell, 'uname -sm')).stdout;
        }
        case 'providers.detect':
          return detectLocalServers(fetchHere);
        case 'chatgptChat':
          if (!o.chatgptChat) throw new Refusal('unsupported', `${o.deviceName}'s desktop app has no ChatGPT window.`);
          if (!(await o.lending()).chatgptChat) throw new Refusal('refused', `ChatGPT Chat isn't allowed on ${o.deviceName}: add it in the desktop app there.`);
          return o.chatgptChat(request.operation, request.value ?? '');
        case 'home.scan':
          await allowHome();
          return scanHome(home);
        case 'home.read':
          await allowHome();
          return homeFs(home).read(request.path);
        case 'mcp.import':
          // Claude Code's connectors carry their keys: only right after the person asked for them here.
          if (Date.now() > importUntil) throw new Refusal('refused', `Open "Import from Claude Code" in the desktop app on ${o.deviceName} to import from there.`);
          return importClaudeCode(home, (await o.trustedFolders?.()) ?? []);
      }
    },

    /** Starts what the server asked for; `log` gets what it writes to stderr. */
    async start(service: DeviceStart, log: (line: string) => void): Promise<RunnerChannel> {
      if (service.kind === 'http') return this.http(service);
      if (service.kind === 'mcp') return this.mcp(service, log);
      await allowSsh(service.connection.host);
      if (!o.runnerDir) throw new Refusal('unsupported', `${o.deviceName} has no runner builds to put on SSH hosts.`);
      const shell = throughShell(o.ssh, o.sshDir, await askpass(), service.connection, service.answers);
      const key = JSON.stringify([service.connection.host, service.connection.port, service.connection.keyPath]);
      let found = runners.get(key);
      if (!found) {
        found = bootstrapRunner(shell, o.runnerDir);
        runners.set(key, found);
        found.catch(() => runners.get(key) === found && runners.delete(key));
      }
      const { runner } = await found;
      const startedAt = Date.now();
      const env: Record<string, string> = service.env.GIT_CEILING_DIRECTORIES ? { GIT_CEILING_DIRECTORIES: service.env.GIT_CEILING_DIRECTORIES } : {};
      const channel = remoteRunnerChannel(shell, runner, [service.root], log, env);
      void channel.closed.then(() => {
        if (Date.now() - startedAt < EARLY_EXIT_MS && runners.get(key) === found) runners.delete(key);
      });
      return channel;
    },

    /**
     * A personal connector's program, allowed here by exactly what runs (its fingerprint): never with an environment
     * variable that changes which code runs, `${VAR}` filled in from this computer's environment, run in the home folder.
     * Its stdout and stdin are the channel's lines, its stderr goes to `log`.
     */
    async mcp(service: Extract<DeviceStart, { kind: 'mcp' }>, log: (line: string) => void): Promise<RunnerChannel> {
      const keys = Object.keys(service.env);
      const lent = (await o.lending()).connectors.find((c) => c.id === service.connectorId);
      if (!lent || lent.fingerprint !== connectorFingerprint(service.command, service.args, keys)) {
        throw new Refusal('refused', `${o.deviceName} doesn't run that connector: allow it in Customize › Connectors in the desktop app there.`);
      }
      const unsafe = keys.find((k) => UNSAFE_CONNECTOR_ENV.test(k));
      if (unsafe) throw new Refusal('refused', `${o.deviceName} doesn't let a connector set ${unsafe}.`);
      const missing: string[] = [];
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(service.env)) {
        const filled = await interpolate(value, { secret: async () => undefined, env: (name) => process.env[name] });
        missing.push(...filled.missing);
        env[key] = filled.value;
      }
      if (missing.length) throw new Refusal('failed', `${o.deviceName} has no ${missing.join(', ')} in its environment.`);
      try {
        return await programChannel({ command: service.command, args: service.args, env, cwd: home }, log);
      } catch (e) {
        throw new Refusal('failed', `${service.command} didn't start on ${o.deviceName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /**
     * One request to an address the person lent here (a model server or connector on this computer or its network), at
     * or below its base URL: no redirects followed, no cookies passed back. The response streams back as it arrives.
     */
    async http(service: Extract<DeviceStart, { kind: 'http' }>): Promise<RunnerChannel> {
      const address = (await o.lending()).http.find((a) => a.id === service.target);
      if (!address || !withinAddress(service.url, address.baseUrl)) throw new Refusal('refused', `${o.deviceName} doesn't lend that address.`);
      const abort = new AbortController();
      const { channel, emit, end } = lineChannel(() => abort.abort());
      void (async () => {
        try {
          const response = await fetchHere(service.url, {
            method: service.method,
            headers: service.headers,
            ...(service.body ? { body: Buffer.from(service.body, 'base64') } : {}),
            signal: abort.signal,
            redirect: 'manual',
          });
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            if (name !== 'set-cookie') headers[name] = value;
          });
          emit({ head: { status: response.status, headers } });
          if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) emit({ chunk: Buffer.from(chunk).toString('base64') });
        } catch (e) {
          if (!abort.signal.aborted) emit({ error: e instanceof Error ? e.message : String(e) });
        } finally {
          end();
        }
      })();
      return channel;
    },
  };
}

/** Plain HTTP without Node's 300-second timeouts (a local model server can say nothing for minutes); HTTPS as usual. */
const fetchHere = plainHttpFetch((url, init) => fetch(url, init));
