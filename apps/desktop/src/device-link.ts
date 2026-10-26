/**
 * The desktop end of the device link (ARCHITECTURE §21): while signed in to a server, this machine lends
 * its runner for folders the person trusted here. The server asks for a runner at a root; the root must be
 * one of the trusted folders (or inside one), otherwise the request is refused. Runner lines are piped
 * as they are: the server is the runner's client. The root limits only file tools; the runner's commands
 * run as this machine's user, so a trusted folder lets the server run commands here.
 *
 * Version 2 also lends what `services` provides (scratch folders, SSH hosts reached from here), each only as far as the
 * person allowed it on this computer, and says so in its first frame (`hello`).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { DEVICE_HEADERS, DEVICE_LINK_PATH, DEVICE_LINK_PING_MS, ServerToDevice, type DeviceInfo, type DeviceRequest, type DeviceStart, type DeviceToServer } from '@atelier/protocol';
import type { DeviceServices } from './device-services.ts';
import { backoff } from './relay.ts';

type OpenSocket = (url: string, headers: Record<string, string>) => WebSocket;
/** Node's WebSocket (undici) accepts request headers; the DOM typings don't know that. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

type RunnerProcess = ChildProcessByStdio<Writable, Readable, null>;

/** Something lent over a channel: a runner process here, or a runner on an SSH host reached from here. */
interface Lent {
  write(line: string): void;
  kill(): void;
}

const MAX_RUNNERS = 32;
/** Channels started at once: SSH hosts' runners (each an ssh process), connectors' programs, requests in flight. */
const MAX_STARTED = 48;
/** The server rejected the sign-in (see apps/server): wait for a new token instead of retrying. */
const SIGNED_OUT = 4401;
const MISSED_PINGS = 2;

export interface DeviceLinkOptions {
  serverUrl: string;
  device: DeviceInfo;
  /** The runner build for this machine, or null when there is none (then every request is refused). */
  runnerBinary: string | null;
  trustedFolders(): Promise<string[]>;
  /** What else this computer lends (version 2); without it, only runners for trusted folders. */
  services?: Pick<DeviceServices, 'hello' | 'request' | 'start' | 'scratchEnv'> & Partial<Pick<DeviceServices, 'watchHome'>>;
  openSocket?: OpenSocket;
  spawnRunner?: (binary: string, root: string, env?: Record<string, string>) => RunnerProcess;
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
  const spawnRunner =
    options.spawnRunner ??
    ((binary, root, env) => spawn(binary, ['--stdio', '--root', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...(env ? { env: { ...process.env, ...env } } : {}) }));
  const url = `${options.serverUrl.replace(/^http/, 'ws')}${DEVICE_LINK_PATH}`;
  let token: string | null = null;
  let socket: WebSocket | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  /** The server turned the token down (4401), so the link stopped trying until it is given one again. */
  let refused = false;
  const runners = new Map<string, Lent>();
  /** How many of those are SSH hosts' runners. */
  let started = 0;
  /** Channels whose root is being checked, or whose service is starting. */
  const opening = new Set<string>();
  let stopWatch: (() => void) | undefined;

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
    // One of this computer's scratch folders (when the person allows them for this server) is lent too.
    const scratch = real && !insideTrusted(real, trusted) ? await options.services?.scratchEnv(real) : undefined;
    if (!opening.delete(channel)) return; // Closed, or the link dropped, while we checked.
    if (!real || (!insideTrusted(real, trusted) && !scratch)) return refuse(`${root} isn't a folder you opened in ${options.device.name}'s desktop app.`);
    const child = spawnRunner(options.runnerBinary, real, scratch ?? undefined);
    const lent: Lent = { write: (line) => child.stdin.write(`${line}\n`), kill: () => child.kill() };
    runners.set(channel, lent);
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => send({ t: 'line', channel, line }));
    child.once('error', () => child.kill());
    child.once('close', () => {
      if (runners.get(channel) !== lent) return;
      runners.delete(channel);
      send({ t: 'closed', channel, reason: 'The runner stopped.' });
    });
    send({ t: 'opened', channel });
  };

  /** Starts a service's channel (an SSH host's runner); the person must have allowed it here (the service checks). */
  const start = async (channel: string, service: DeviceStart) => {
    const refuse = (reason: string) => send({ t: 'closed', channel, reason: reason.slice(0, 500) });
    if (!options.services) return refuse(`${options.device.name}'s desktop app doesn't lend that.`);
    if (started >= MAX_STARTED) return refuse(`${options.device.name} is already running ${MAX_STARTED} SSH workspaces, connectors and requests for the server.`);
    opening.add(channel);
    started++;
    let lent: Awaited<ReturnType<NonNullable<DeviceLinkOptions['services']>['start']>>;
    try {
      lent = await options.services.start(service, (line) => send({ t: 'log', channel, line: line.slice(0, 8192) }));
    } catch (e) {
      started--;
      opening.delete(channel);
      return refuse(e instanceof Error ? e.message : String(e));
    }
    if (!opening.delete(channel)) {
      started--;
      return lent.kill(); // Closed, or the link dropped, while it started.
    }
    const entry: Lent = { write: (line) => lent.send(line), kill: () => lent.kill() };
    runners.set(channel, entry);
    lent.onLine((line) => send({ t: 'line', channel, line }));
    void lent.closed.then(() => {
      started--;
      if (runners.get(channel) !== entry) return;
      runners.delete(channel);
      send({ t: 'closed', channel, reason: 'The connection ended.' });
    });
    send({ t: 'opened', channel });
  };

  /** Answers a request: its value, or why not. */
  const answer = async (id: number, request: DeviceRequest) => {
    if (!options.services) return send({ t: 'res', id, ok: false, code: 'unsupported', error: `${options.device.name}'s desktop app doesn't lend that.` });
    try {
      send({ t: 'res', id, ok: true, value: await options.services.request(request) });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      send({ t: 'res', id, ok: false, code: code === 'refused' || code === 'unsupported' ? code : 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 2000) });
    }
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
    else if (frame.t === 'start') void start(frame.channel, frame.service);
    else if (frame.t === 'req') void answer(frame.id, frame.request);
    else if (frame.t === 'line') runners.get(frame.channel)?.write(frame.line);
    else {
      opening.delete(frame.channel);
      runners.get(frame.channel)?.kill();
      runners.delete(frame.channel);
    }
  };

  const connect = () => {
    if (!token) return;
    refused = false;
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
      if (code === SIGNED_OUT) {
        refused = true;
        return;
      }
      timer = setTimeout(connect, backoff(++failures));
    };
    ws.onopen = () => {
      failures = 0;
      // The person's config here changing (a skill added, CLAUDE.md edited) makes the server read it again.
      stopWatch ??= options.services?.watchHome?.(() => send({ t: 'event', event: 'home.changed' }));
      // Says what it lends first; the server waits a moment for it before taking this for an older desktop.
      void options.services
        ?.hello()
        .then((hello) => socket === ws && send({ t: 'hello', hello }))
        .catch(() => undefined);
    };
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
    /**
     * Signs the link in (or out with null); a changed token reconnects, and so does the same one the server turned down
     * before (an account that had to change its password first keeps its token).
     */
    setToken(next: string | null): void {
      if (next === token && !(next && refused)) return;
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
      stopWatch?.();
      stopWatch = undefined;
    },
    /** The person changed what this computer lends the server: tell it. */
    lendingChanged(): void {
      void options.services
        ?.hello()
        .then((hello) => send({ t: 'event', event: 'lending.changed', lending: hello.lending }))
        .catch(() => undefined);
    },
  };
}
