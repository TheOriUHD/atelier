/**
 * Talking to the background service: connect to its socket with the token, start it when nobody answers, and swap it
 * for a fresh one when it serves another connection or an older version and has nothing running.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { RpcMessage } from '@atelier/protocol';
import type { ReconnectingTransport } from '@atelier/client';
import { checkPlace, servicePath, type CliPaths } from '../paths.ts';
import { selfCommand, VERSION } from '../runtime.ts';
import { newer } from '../update/update.ts';
import { onFrames, sameWant, sendFrame, ServiceFrame, type ClientFrame, type ServiceStatus, type Want } from './wire.ts';

export class ServiceError extends Error {}

export interface ServiceLink {
  socket: Socket;
  status: ServiceStatus;
  send(frame: ClientFrame): void;
  /** Frames after the welcome. */
  onFrame(handler: (frame: ServiceFrame) => void): () => void;
  close(): void;
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect(path);
    s.once('connect', () => (s.removeListener('error', reject), resolve(s)));
    s.once('error', reject);
  });
}

/** Connects and says hello; null when no service answers at all. */
async function hello(p: CliPaths, want: Want): Promise<ServiceLink | null> {
  const where = await servicePath(p.dir);
  if (!where) return null;
  // Only a socket in a place that is this user's alone gets the token.
  const wrong = await checkPlace(where);
  if (wrong) throw new ServiceError(`The background service's socket can't be trusted: ${wrong}`);
  let socket: Socket;
  try {
    socket = await open(where);
  } catch {
    return null;
  }
  const token = (await readFile(join(p.run, 'daemon.token'), 'utf8').catch(() => '')).trim();
  const handlers = new Set<(f: ServiceFrame) => void>();
  return new Promise((resolve, reject) => {
    let status: ServiceStatus | null = null;
    const timer = setTimeout(() => (socket.destroy(), resolve(null)), 5000);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timer);
      if (!status) resolve(null);
    });
    onFrames(socket, ServiceFrame, (frame) => {
      if (!status) {
        clearTimeout(timer);
        if (frame.t === 'refused') return reject(new ServiceError(frame.reason));
        if (frame.t !== 'welcome') return;
        status = frame.status;
        resolve({
          socket,
          status,
          send: (f) => sendFrame(socket, f),
          onFrame: (h) => (handlers.add(h), () => void handlers.delete(h)),
          close: () => socket.end(),
        });
        return;
      }
      for (const h of handlers) h(frame);
    });
    sendFrame(socket, { t: 'hello', token, version: VERSION, want });
  });
}

/** Starts a service in the background, on its own (it outlives this terminal). */
export function startService(want: Want, env: NodeJS.ProcessEnv = process.env): void {
  const { command, args } = selfCommand();
  const child = spawn(command, [...args, 'daemon', 'run', ...(want.mode === 'server' ? ['--server', want.serverUrl] : ['--local'])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, ATELIER_DAEMON: '1' },
  });
  // A program security software keeps from starting: told by the wait below, not a crash here.
  child.on('error', () => undefined);
  child.unref();
}

/** Why the service that was started didn't (`daemon run` writes it), when it says so after `since`. */
async function startError(p: CliPaths, since: number): Promise<string | null> {
  const file = join(p.run, 'daemon.error');
  const changed = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
  if (changed < since - 1000) return null;
  return (await readFile(file, 'utf8').catch(() => '')).trim() || null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks a service to stop and waits until it is gone; false when it is busy (replies running) and `force` isn't set. */
export async function stopService(link: ServiceLink, force = false): Promise<boolean> {
  return new Promise((resolve) => {
    const off = link.onFrame((f) => {
      if (f.t === 'busy') {
        off();
        resolve(false);
      }
    });
    link.socket.once('close', () => (off(), resolve(true)));
    link.send({ t: 'stop', force });
  });
}

/**
 * A service for `want`, started if needed. One serving another connection or an older version is replaced when it has
 * nothing running; a busy one serving another connection is an error (the person finishes or stops it first).
 */
export async function connectService(p: CliPaths, want: Want, options: { start?: boolean; timeoutMs?: number } = {}): Promise<ServiceLink> {
  // A first start on Windows (security software looking at a new program, PowerShell unsealing the key) can take long.
  const since = Date.now();
  const deadline = since + (options.timeoutMs ?? (process.platform === 'win32' ? 60_000 : 30_000));
  let started = false;
  for (;;) {
    const link = await hello(p, want);
    if (link) {
      const other = !sameWant(link.status.want, want);
      // Only an older one is replaced: a terminal still on the old version would otherwise stop the new service, and the
      // new terminal the old one again, each time ending the calls in flight.
      const older = newer(VERSION, link.status.version);
      if (!other && !older) return link;
      if (await stopService(link, false)) {
        await sleep(300);
        continue;
      }
      if (!other) return link; // An older one with replies running: use it for now.
      link.close();
      throw new ServiceError(
        `The background service is running ${link.status.busy === 1 ? 'a reply' : `${link.status.busy} replies`} for ${link.status.want.mode === 'server' ? link.status.want.serverUrl : 'this computer'}. Let ${link.status.busy === 1 ? 'it' : 'them'} finish, or stop ${link.status.busy === 1 ? 'it' : 'them'} with \`atelier daemon stop --force\`.`,
      );
    }
    if (options.start === false) throw new ServiceError('The background service isn’t running.');
    if (!started) {
      startService(want);
      started = true;
    }
    if (started) {
      const why = await startError(p, since);
      if (why) throw new ServiceError(`The background service couldn’t start: ${why}`);
    }
    if (Date.now() > deadline) throw new ServiceError(`The background service didn’t start in time. Its log is in ${join(p.logs, 'daemon.log')}.`);
    await sleep(150);
  }
}

/**
 * A JSON-RPC transport through the service (standalone): if the service goes away (restarted, crashed), it connects
 * again, starting a new one, and tells the client to load what it shows anew.
 */
export function serviceTransport(p: CliPaths, first: ServiceLink, want: Want): ReconnectingTransport {
  const messageHandlers = new Set<(m: RpcMessage) => void>();
  const closeHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const statusHandlers = new Set<(c: boolean) => void>();
  const add = <T>(set: Set<T>, h: T) => (set.add(h), () => void set.delete(h));
  let link: ServiceLink | null = null;
  let ended = false;
  const queue: RpcMessage[] = [];

  const attach = (next: ServiceLink, again: boolean) => {
    link = next;
    next.onFrame((f) => {
      if (f.t === 'rpc') messageHandlers.forEach((h) => h(f.m as RpcMessage));
    });
    next.socket.once('close', () => {
      if (link !== next) return;
      link = null;
      closeHandlers.forEach((h) => h());
      statusHandlers.forEach((h) => h(false));
      if (!ended) void retry();
    });
    for (const m of queue.splice(0)) next.send({ t: 'rpc', m });
    statusHandlers.forEach((h) => h(true));
    if (again) reconnectHandlers.forEach((h) => h());
  };
  const retry = async () => {
    for (let attempt = 0; !ended; attempt++) {
      try {
        attach(await connectService(p, want), true);
        return;
      } catch {
        await sleep(Math.min(5000, 250 * 2 ** attempt));
      }
    }
  };
  attach(first, false);

  return {
    send: (m) => (link ? link.send({ t: 'rpc', m }) : void queue.push(m)),
    onMessage: (h) => add(messageHandlers, h),
    onClose: (h) => add(closeHandlers, h),
    onReconnect: (h) => add(reconnectHandlers, h),
    onStatus: (h) => add(statusHandlers, h),
    close: () => {
      ended = true;
      link?.close();
    },
  };
}
