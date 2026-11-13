/**
 * The background service (ARCHITECTURE §25), `atelier daemon run`: one per person and connection, started by the first
 * terminal that needs it and gone 10 minutes after the last one closed with nothing running.
 *   standalone   it runs the backend (`createBackend`, the desktop's own kind) over `~/.atelier/cli/data`, so every
 *                terminal shares one database and a reply keeps going when its terminal closes
 *   server mode  it holds the device link, lending this computer's trusted folders (and what lending.json allows) to
 *                the server, so its sessions' tools run here; terminals talk to the server themselves
 * A client proves it may connect with the token in `run/daemon.token` (this user only) before anything else: the
 * backend's `auth.localSignIn` needs no secret, so the token is what keeps other users' processes out.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { connect as netConnect, createServer, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { contract, createMemoryTransportPair, createRpcClient, DeviceInfo, runnerBinaryName, type RpcMessage, type Transport } from '@atelier/protocol';
import { AesGcmCipher, createBackend, type Backend } from '@atelier/core';
import { createDeviceLink, deviceServices, readLending, readTrustedFolders, type DeviceLinkState } from '@atelier/core/device';
import { readConfig, readJson, writePrivate } from '../config.ts';
import { credentialStore, LOCAL_KEY, tokenName, type CredentialStore } from '../keychain.ts';
import { checkPlace, newPipeName, paths as cliPaths, pipeFile, servicePath, socketPath, type CliPaths } from '../paths.ts';
import { runnerDir, USER_AGENT, VERSION } from '../runtime.ts';
import { ClientFrame, onFrames, sameWant, sendFrame, type ServiceStatus, type Want } from './wire.ts';

/** How long the service stays after the last terminal closed, with nothing running. */
export const IDLE_EXIT_MS = 10 * 60_000;

export interface DaemonOptions {
  want: Want;
  paths?: CliPaths;
  /** For tests: a shorter idle time. */
  idleMs?: number;
}

/** This computer as a device of the server: its id kept in device.json, named after the host. */
export async function cliDevice(p: CliPaths): Promise<DeviceInfo> {
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const stored = await readJson(p.device, DeviceInfo.partial(), {});
  const device: DeviceInfo = { id: stored.id ?? randomUUID(), name: stored.name ?? `${hostname().replace(/\.local$/, '')} · terminal`, platform };
  if (stored.id !== device.id || stored.name !== device.name || stored.platform !== platform) await writePrivate(p.device, `${JSON.stringify(device, null, 2)}\n`);
  return device;
}

/** What tells the key apart without being it: kept beside the backend's data, so a lost or changed key is noticed. */
const keyCheck = (key: Buffer) => createHash('sha256').update('atelier-cli-local-key\0').update(key).digest('hex').slice(0, 32);

/**
 * The standalone backend's key for its secrets: in the system's store, made the first time. A new key is made only when
 * none was ever made here (no `checkFile`): writing one over a key that can't be read now loses every API key saved with
 * it, which is how a slow PowerShell on Windows ended in "Unsupported state or unable to authenticate data".
 */
export async function localKey(store: CredentialStore, checkFile: string): Promise<Buffer> {
  const stored = await store.get(LOCAL_KEY);
  const check = await readFile(checkFile, 'utf8').then((t: string) => t.trim(), () => null);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    const key = Buffer.from(stored, 'hex');
    if (check && check !== keyCheck(key)) throw new Error(`The key for your saved API keys changed (${store.kind}), so they can't be read. Add your providers' keys again with /provider, or run \`atelier reset-keys\` to start the key store over.`);
    if (!check) await writePrivate(checkFile, `${keyCheck(key)}\n`);
    return key;
  }
  if (check) throw new Error(`The key for your saved API keys is missing from ${store.kind === 'dpapi' ? 'Windows' : store.kind === 'keychain' ? 'the keychain' : store.kind === 'secret-service' ? 'the keyring' : 'credentials.json'}, so they can't be read. If you moved or reset that store, run \`atelier reset-keys\` and add your providers' keys again.`);
  const key = randomBytes(32);
  await store.set(LOCAL_KEY, key.toString('hex'));
  await writePrivate(checkFile, `${keyCheck(key)}\n`);
  return key;
}

function logTo(file: string) {
  const out = createWriteStream(file, { flags: 'a', mode: 0o600 });
  const line = (level: string, message: string, extra?: unknown) => {
    const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra !== undefined ? ` ${JSON.stringify(extra)}` : '';
    out.write(`${new Date().toISOString()} ${level} ${message}${detail}\n`);
  };
  return { info: (m: string, d?: Record<string, unknown>) => line('info', m, d), error: (m: string, e?: unknown) => line('error', m, e), end: () => out.end() };
}

/** Keeps the computer from sleeping while replies run here (standalone): macOS `caffeinate`, Linux `systemd-inhibit`. */
function keepAwake() {
  let child: ChildProcess | null = null;
  return (on: boolean) => {
    if (on && !child) {
      const [command, args] =
        process.platform === 'darwin' ? ['caffeinate', ['-i', '-w', String(process.pid)]] : process.platform === 'linux' ? ['systemd-inhibit', ['--what=idle:sleep', '--who=Atelier', '--why=A reply is running', 'sleep', 'infinity']] : [null, []];
      if (!command) return;
      child = spawn(command, args as string[], { stdio: 'ignore' });
      child.on('error', () => (child = null));
      child.unref();
    } else if (!on && child) {
      child.kill();
      child = null;
    }
  };
}

/** Whether a service already answers on the socket (another one started first). */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect(path);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

/**
 * Takes the start lock, or says another start holds it: a lock whose process is gone (or older than two minutes) is
 * taken over.
 */
async function startLock(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await open(file, 'wx').catch(() => null);
    if (handle) {
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    }
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    const age = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? 0);
    const alive = pid > 0 && pid !== process.pid && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive && age < 120_000) return false;
    await unlink(file).catch(() => undefined);
  }
  return false;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const p = options.paths ?? cliPaths();
  const idleMs = options.idleMs ?? IDLE_EXIT_MS;
  await mkdir(p.run, { recursive: true, mode: 0o700 });
  await mkdir(p.logs, { recursive: true, mode: 0o700 });
  const logFile = join(p.logs, 'daemon.log');
  if (((await stat(logFile).catch(() => null))?.size ?? 0) > 5 * 1024 * 1024) await rename(logFile, `${logFile}.1`).catch(() => undefined);
  const log = logTo(logFile);
  const windows = process.platform === 'win32';

  // Another service may have started a moment earlier (two terminals opened together): leave it to that one.
  const running = await servicePath(p.dir);
  if (running && (await answers(running))) {
    log.info('another service is running; leaving');
    log.end();
    return;
  }
  // One start at a time: two at once each made a token, a key and a pipe, and a terminal could pair one's pipe with the
  // other's token ("Not this user's service") or end up with the other's key.
  if (!(await startLock(join(p.run, 'daemon.lock')))) {
    log.info('another service is starting; leaving');
    log.end();
    return;
  }
  const where = windows ? newPipeName(p.dir) : socketPath(p.dir);
  if (!windows) {
    await mkdir(dirname(where), { recursive: true, mode: 0o700 });
    const wrong = await checkPlace(where);
    if (wrong) {
      log.error(`not starting: ${wrong}`);
      log.end();
      throw new Error(wrong);
    }
    if (existsSync(where)) await unlink(where).catch(() => undefined);
  }

  const token = randomBytes(32).toString('hex');
  await writePrivate(join(p.run, 'daemon.token'), token);
  const store = await credentialStore(p.credentials);
  const config = await readConfig(p.config);
  const startedAt = Date.now();
  const clients = new Set<Socket>();
  const awake = keepAwake();
  let busy = 0;
  let link: DeviceLinkState | undefined;
  let backend: Backend | null = null;
  let deviceLink: ReturnType<typeof createDeviceLink> | null = null;
  let ownerToken: string | null = null;
  let stopping = false;
  let lastClientAt = Date.now();
  /** Standalone: connects a terminal's socket to the backend, signed in as this computer's owner once there is one. */
  let connectClient: ((socket: Socket, send: (m: RpcMessage) => void, onMessage: Set<(m: RpcMessage) => void>, onClose: Set<() => void>) => Promise<void>) | null = null;

  const status = (): ServiceStatus => ({ version: VERSION, pid: process.pid, want: options.want, startedAt, clients: clients.size, busy, keepAvailable: config.keepAvailable, ...(link ? { link } : {}) });

  if (options.want.mode === 'local') {
    const key = await localKey(store, join(p.backendData, 'local-key.check'));
    const dir = runnerDir();
    backend = await createBackend({
      surface: 'desktop',
      configDir: p.backendConfig,
      dataDir: p.backendData,
      cipher: new AesGcmCipher(key),
      ...(dir ? { runnerDir: dir } : {}),
      env: process.env,
      logger: log,
    });
    // The service's own connection: it signs the person's terminals in, and sees whether replies are running.
    const [mine, theirs] = createMemoryTransportPair();
    backend.connect(theirs, { client: { clientKind: 'cli', ip: '127.0.0.1', userAgent: `${USER_AGENT} service` } });
    const self = createRpcClient(contract, mine);
    const owner = async (): Promise<string | null> => {
      if (ownerToken) return ownerToken;
      const st = await self.call('auth.status', {});
      if (st.setupRequired) return null;
      ownerToken = (await self.call('auth.localSignIn', { clientKind: 'cli' })).token;
      return ownerToken;
    };
    const countBusy = async () => {
      if (!(await owner().catch(() => null))) return;
      const list = await self.call('sessions.list', { archived: 'all', limit: 500 }).catch(() => []);
      const next = list.filter((s) => s.status === 'running' || s.status === 'waiting').length;
      if (next !== busy) {
        busy = next;
        awake(busy > 0);
      }
    };
    self.on('sessions.changed', () => void countBusy());
    setInterval(() => void countBusy(), 30_000).unref();
    connectClient = async (socket, send, onMessage, onClose) => {
      const transport: Transport = { send, onMessage: (h) => (onMessage.add(h), () => onMessage.delete(h)), onClose: (h) => (onClose.add(h), () => onClose.delete(h)) };
      const signedIn = await owner().catch(() => null);
      const disconnect = backend!.connect(transport, { ...(signedIn ? { token: signedIn } : {}), client: { clientKind: 'cli', ip: '127.0.0.1', userAgent: USER_AGENT } });
      socket.once('close', disconnect);
    };
  } else {
    const serverUrl = options.want.serverUrl;
    const device = await cliDevice(p);
    const dir = runnerDir();
    const binary = dir ? join(dir, runnerBinaryName(process.platform, process.arch)) : null;
    const trustedFolders = () => readTrustedFolders(p.trusted);
    const services = deviceServices({
      deviceName: device.name,
      lending: () => readLending(p.lending, serverUrl),
      scratchDir: p.scratch,
      runnerDir: dir && existsSync(join(dir, 'checksums.json')) ? dir : null,
      ssh: process.env.ATELIER_SSH ?? 'ssh',
      sshDir: p.ssh,
      trustedFolders,
    });
    deviceLink = createDeviceLink({
      serverUrl,
      device,
      runnerBinary: binary && existsSync(binary) ? binary : null,
      trustedFolders,
      services,
      onState: (state) => {
        link = state;
        log.info(`device link ${state}`);
      },
    });
    deviceLink.setToken(process.env.ATELIER_TOKEN || (await store.get(tokenName(serverUrl))));
  }

  const server = createServer((socket) => {
    let welcomed = false;
    const handlers = new Set<(m: RpcMessage) => void>();
    const closers = new Set<() => void>();
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(timer);
      clients.delete(socket);
      lastClientAt = Date.now();
      for (const h of closers) h();
    });
    onFrames(socket, ClientFrame, (frame) => {
      if (!welcomed) {
        if (frame.t !== 'hello' || frame.token.length !== token.length || !timingSafeEqual(Buffer.from(frame.token), Buffer.from(token))) {
          sendFrame(socket, { t: 'refused', reason: 'Not this user’s service.' });
          return void socket.end();
        }
        clearTimeout(timer);
        welcomed = true;
        clients.add(socket);
        sendFrame(socket, { t: 'welcome', status: status() });
        // A client that wants another connection or is newer asks the service to stop; it stays for the others meanwhile.
        if (sameWant(frame.want, options.want) && connectClient) void connectClient(socket, (m) => sendFrame(socket, { t: 'rpc', m }), handlers, closers);
        return;
      }
      if (frame.t === 'rpc') for (const h of handlers) h(frame.m as RpcMessage);
      else if (frame.t === 'status') sendFrame(socket, { t: 'status', status: status() });
      else if (frame.t === 'token' && deviceLink) void store.get(tokenName((options.want as { serverUrl: string }).serverUrl)).then((t) => deviceLink!.setToken(t));
      else if (frame.t === 'lending' && deviceLink) deviceLink.lendingChanged();
      else if (frame.t === 'stop') {
        if (busy > 0 && !frame.force) return sendFrame(socket, { t: 'busy', busy });
        sendFrame(socket, { t: 'stopping' });
        void stop('asked to stop');
      }
    });
  });

  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping: ${why}`);
    server.close();
    for (const c of clients) c.destroy();
    awake(false);
    deviceLink?.close({ exiting: true });
    await backend?.dispose().catch((e: unknown) => log.error('dispose failed', e));
    // Only its own socket: a newer service may already listen at the same path (after an update), and removing that
    // left terminals waiting for a service that was there.
    if (!windows && (await stat(where).catch(() => null))?.ino === socketInode) await unlink(where).catch(() => undefined);
    log.end();
    setTimeout(() => process.exit(0), 200).unref();
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(where, () => resolve());
  });
  if (!windows) await chmod(where, 0o600).catch(() => undefined);
  else await writePrivate(pipeFile(p.dir), where);
  const socketInode = windows ? null : ((await stat(where).catch(() => null))?.ino ?? null);
  await unlink(join(p.run, 'daemon.lock')).catch(() => undefined);
  await unlink(join(p.run, 'daemon.error')).catch(() => undefined);
  log.info(`listening (${options.want.mode}${options.want.mode === 'server' ? ` ${options.want.serverUrl}` : ''}), version ${VERSION}`);

  setInterval(() => {
    if (clients.size > 0 || busy > 0 || config.keepAvailable) return;
    if (Date.now() - lastClientAt >= idleMs) void stop('idle');
  }, Math.min(30_000, idleMs)).unref();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void stop(signal));
  // A failure in one client's handling is logged, not the end of the service for every terminal.
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  process.on('uncaughtException', (e) => log.error('uncaught exception', e));
}
