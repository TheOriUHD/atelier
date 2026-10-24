/**
 * What this desktop lends a server beyond runners for trusted folders (ARCHITECTURE §21): a folder for each session
 * started without one, and SSH hosts reached with this computer's ssh, keys, known hosts and runner builds. Each needs
 * the person's say-so on this computer (`lending.json`), so a server can't make it do more than they allowed here.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { APP, DEVICE_LINK_PROTOCOL, type DeviceHello, type DeviceLending, type DeviceRequest, type DeviceStart } from '@atelier/protocol';
import { bootstrapRunner, probeSsh, remoteRunnerChannel, runOnce, sshConfigHosts, throughShell, writeAskpass, type RunnerChannel } from '@atelier/core/device';

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
}

/** A runner of an SSH host that failed this soon after it started was probably gone from there: look for it again next time. */
const EARLY_EXIT_MS = 10_000;

export type DeviceServices = ReturnType<typeof deviceServices>;

export function deviceServices(o: DeviceServicesOptions) {
  let script: Promise<string | null> | null = null;
  const askpass = () => (script ??= writeAskpass(o.sshDir));
  /** Where each SSH host keeps this app's runner, found (or uploaded) once while it keeps working. */
  const runners = new Map<string, Promise<{ runner: string; home: string }>>();

  const allowSsh = async (host: string) => {
    if (!(await o.lending()).ssh.includes(host)) throw new Refusal('refused', `${host} isn't an SSH host you use from ${o.deviceName}: choose it in the desktop app there first.`);
  };

  return {
    services: ['runner', 'scratch', 'ssh'],

    async hello(): Promise<DeviceHello> {
      return { protocol: DEVICE_LINK_PROTOCOL, app: APP.version, services: this.services, lending: await o.lending(), home: homedir(), sep, os: process.platform, arch: process.arch };
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
      }
    },

    /** Starts what the server asked for; `log` gets what it writes to stderr. */
    async start(service: DeviceStart, log: (line: string) => void): Promise<RunnerChannel> {
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
  };
}
