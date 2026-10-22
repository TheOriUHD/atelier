/**
 * The desktop end of the device link (ARCHITECTURE §21): while signed in to a server, this machine lends
 * its runner for folders the person trusted here. The server asks for a runner at a root; the root must be
 * one of the trusted folders (or inside one), otherwise the request is refused. Runner lines are piped
 * as they are: the server is the runner's client. The root limits only file tools; the runner's commands
 * run as this machine's user, so a trusted folder lets the server run commands here.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { DEVICE_HEADERS, DEVICE_LINK_PATH, DEVICE_LINK_PING_MS, ServerToDevice, type DeviceInfo, type DeviceToServer } from '@atelier/protocol';
import { backoff } from './relay.ts';

type OpenSocket = (url: string, headers: Record<string, string>) => WebSocket;
/** Node's WebSocket (undici) accepts request headers; the DOM typings don't know that. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

type RunnerProcess = ChildProcessByStdio<Writable, Readable, null>;

const MAX_RUNNERS = 32;
/** The server rejected the sign-in (see apps/server): wait for a new token instead of retrying. */
const SIGNED_OUT = 4401;
const MISSED_PINGS = 2;

export interface DeviceLinkOptions {
  serverUrl: string;
  device: DeviceInfo;
  /** The runner build for this machine, or null when there is none (then every request is refused). */
  runnerBinary: string | null;
  trustedFolders(): Promise<string[]>;
  openSocket?: OpenSocket;
  spawnRunner?: (binary: string, root: string) => RunnerProcess;
}

/** The folders the person trusted on this machine (`trusted-folders.json`, written by main's folder picker). */
export function readTrustedFolders(path: string): Promise<string[]> {
  return readFile(path, 'utf8')
    .then((text) => z.array(z.string()).parse(JSON.parse(text)))
    .catch(() => []);
}

/** Compares paths as written: both must already be resolved through symlinks (`realpath`). */
export function insideTrusted(root: string, trusted: string[]): boolean {
  const target = normalize(root);
  return trusted.some((folder) => {
    const rel = relative(normalize(folder), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** An existing path the renderer asked about (Work's "Show in Finder"), resolved through symlinks; null unless it lies in a trusted folder. */
export async function trustedPath(input: unknown, trusted: string[]): Promise<string | null> {
  const path = z.string().min(1).max(4096).safeParse(input);
  if (!path.success || !isAbsolute(path.data)) return null;
  const real = await realpath(path.data).catch(() => null);
  return real && insideTrusted(real, trusted) ? real : null;
}

export function createDeviceLink(options: DeviceLinkOptions) {
  const openSocket = options.openSocket ?? ((url, headers) => new NodeWebSocket(url, { headers }));
  const spawnRunner = options.spawnRunner ?? ((binary, root) => spawn(binary, ['--stdio', '--root', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }));
  const url = `${options.serverUrl.replace(/^http/, 'ws')}${DEVICE_LINK_PATH}`;
  let token: string | null = null;
  let socket: WebSocket | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const runners = new Map<string, RunnerProcess>();
  /** Channels whose root is being checked. */
  const opening = new Set<string>();

  const send = (frame: DeviceToServer) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const stopRunners = () => {
    for (const child of runners.values()) child.kill();
    runners.clear();
    opening.clear();
  };

  const open = async (channel: string, root: string) => {
    const refuse = (reason: string) => send({ t: 'closed', channel, reason });
    if (!options.runnerBinary) return refuse(`${options.device.name} has no runner build for this platform.`);
    if (runners.size >= MAX_RUNNERS) return refuse(`${options.device.name} is already running ${MAX_RUNNERS} workspaces.`);
    opening.add(channel);
    // Trusted folders are stored resolved; resolving the root too means a symlink inside one can't lead out of it.
    const real = await realpath(root).catch(() => null);
    const trusted = await options.trustedFolders();
    if (!opening.delete(channel)) return; // Closed, or the link dropped, while we checked.
    if (!real || !insideTrusted(real, trusted)) return refuse(`${root} isn't a folder you opened in ${options.device.name}'s desktop app.`);
    const child = spawnRunner(options.runnerBinary, real);
    runners.set(channel, child);
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => send({ t: 'line', channel, line }));
    child.once('error', () => child.kill());
    child.once('close', () => {
      if (runners.get(channel) !== child) return;
      runners.delete(channel);
      send({ t: 'closed', channel, reason: 'The runner stopped.' });
    });
    send({ t: 'opened', channel });
  };

  const receive = (text: string) => {
    let frame: ServerToDevice;
    try {
      frame = ServerToDevice.parse(JSON.parse(text));
    } catch {
      return; // Malformed frames from the server are dropped.
    }
    if (frame.t === 'ping') send({ t: 'pong' });
    else if (frame.t === 'open') void open(frame.channel, frame.root);
    else if (frame.t === 'line') runners.get(frame.channel)?.stdin.write(`${frame.line}\n`);
    else {
      opening.delete(frame.channel);
      runners.get(frame.channel)?.kill();
      runners.delete(frame.channel);
    }
  };

  const connect = () => {
    if (!token) return;
    const ws = (socket = openSocket(url, {
      Authorization: `Bearer ${token}`,
      [DEVICE_HEADERS.id]: options.device.id,
      [DEVICE_HEADERS.name]: options.device.name,
      [DEVICE_HEADERS.platform]: options.device.platform,
    }));
    let quiet = 0;
    const gone = (code: number) => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(watchdog);
      stopRunners();
      if (code === SIGNED_OUT) return;
      timer = setTimeout(connect, backoff(++failures));
    };
    ws.onopen = () => void (failures = 0);
    ws.onmessage = (event: MessageEvent) => {
      quiet = 0;
      if (typeof event.data === 'string') receive(event.data);
    };
    ws.onclose = (event: CloseEvent) => gone(event.code);
    // The server pings every DEVICE_LINK_PING_MS. Without them the link is dead even if the socket hasn't
    // noticed (this machine slept, the network changed): drop it and connect again.
    watchdog = setInterval(() => {
      if (++quiet <= MISSED_PINGS) return;
      gone(1006);
      ws.close();
    }, DEVICE_LINK_PING_MS);
  };

  return {
    /** Signs the link in (or out with null); a changed token reconnects. */
    setToken(next: string | null): void {
      if (next === token) return;
      token = next;
      clearTimeout(timer);
      clearInterval(watchdog);
      const old = socket;
      socket = null;
      old?.close();
      stopRunners();
      failures = 0;
      connect();
    },
    close(): void {
      this.setToken(null);
    },
  };
}
