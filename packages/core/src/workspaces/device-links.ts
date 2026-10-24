/**
 * Live device links (ARCHITECTURE §21): which desktop devices are connected right now, what they lend, and the channels
 * and requests over them. A link belongs to the account that signed the device in and is kept under that account and
 * the device id: only that account's workspaces use it, and another account using the same id can't replace it.
 *
 * A device says what it lends in its first frame (`hello`). One that says nothing within HELLO_WAIT_MS is an older
 * desktop: it lends runners for trusted folders and nothing else.
 */
import {
  DEVICE_LINK_PING_MS,
  DeviceToServer,
  NO_LENDING,
  REQUEST_SERVICE,
  type DeviceHello,
  type DeviceLending,
  type DeviceRequest,
  type DeviceService,
  type DeviceStart,
  type ServerToDevice,
} from '@atelier/protocol';
import { newId } from '../util/ids.ts';
import type { RunnerChannel, RunnerExit } from './runner-client.ts';

export interface LinkSocket {
  /** Must not throw once the socket is closed. */
  send(frame: ServerToDevice): void;
  close(): void;
}

interface Channel {
  line(line: string): void;
  log(line: string): void;
  opened(): void;
  finish(reason: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Link {
  socket: LinkSocket;
  channels: Map<string, Channel>;
  /** Pings sent since the device last sent anything. */
  unanswered: number;
  hello: DeviceHello | null;
  /** Settles once the device said what it lends, or HELLO_WAIT_MS passed without it. */
  ready: Promise<void>;
  requests: Map<number, Pending>;
  nextRequest: number;
}

/** What a connected device lends and allows, and where its home folder is. */
export interface DeviceLinkInfo {
  services: readonly string[];
  lending: DeviceLending;
  /** Null for an older desktop, which doesn't say. */
  home: string | null;
  sep: '/' | '\\';
  os: string | null;
  app: string | null;
}

/** Why the device didn't do something: not connected, too old for it, not allowed there, or it failed. */
export class DeviceLinkError extends Error {
  constructor(
    readonly code: 'offline' | 'unsupported' | 'refused' | 'failed' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

const OPEN_TIMEOUT_MS = 15_000;
/**
 * How long a start may take: reaching an SSH host can include uploading the runner there (up to two minutes); an HTTP
 * request waits for its response's head (a local model server loading a model can take minutes); a program, for npx's
 * first download.
 */
const START_TIMEOUT_MS: Record<DeviceStart['kind'], number> = { ssh: 150_000, http: 15 * 60_000, mcp: 120_000 };
const REQUEST_TIMEOUT_MS = 30_000;
const HELLO_WAIT_MS = 3_000;
const MISSED_PINGS = 2;
const LEGACY: DeviceLinkInfo = { services: ['runner'], lending: NO_LENDING, home: null, sep: '/', os: null, app: null };
const START_SERVICE: Record<DeviceStart['kind'], DeviceService> = { ssh: 'ssh', http: 'http', mcp: 'mcp' };
const linkKey = (userId: string, deviceId: string) => JSON.stringify([userId, deviceId]);

export class DeviceLinks {
  private links = new Map<string, Link>();

  /**
   * `onChange` hears when one of the user's devices comes or goes, or changes what it lends; `onHomeChanged` when the
   * person's config in a device's home folder changed.
   */
  constructor(
    private readonly onChange: (userId: string) => void,
    private readonly onHomeChanged: (userId: string, deviceId: string) => void = () => {},
  ) {}

  /** A device connected. Replaces this account's older link of the device; returns where its frames and close go. */
  attach(userId: string, deviceId: string, socket: LinkSocket): { receive(text: string): void; closed(): void } {
    const key = linkKey(userId, deviceId);
    this.links.get(key)?.socket.close();
    let markReady!: () => void;
    const link: Link = { socket, channels: new Map(), unanswered: 0, hello: null, ready: new Promise((r) => (markReady = r)), requests: new Map(), nextRequest: 1 };
    const helloWait = setTimeout(markReady, HELLO_WAIT_MS);
    helloWait.unref?.();
    this.links.set(key, link);
    this.onChange(userId);
    const closed = () => {
      clearInterval(heartbeat);
      clearTimeout(helloWait);
      markReady();
      for (const channel of link.channels.values()) channel.finish('The device disconnected.');
      for (const pending of link.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new DeviceLinkError('offline', 'The device disconnected.'));
      }
      link.requests.clear();
      if (this.links.get(key) !== link) return;
      this.links.delete(key);
      this.onChange(userId);
    };
    // A device that stops answering (asleep, off the network) is dropped as if it had disconnected, before
    // its socket notices: its workspaces show as unavailable and calls waiting on its runners fail.
    const heartbeat = setInterval(() => {
      if (link.unanswered >= MISSED_PINGS) {
        socket.close();
        return closed();
      }
      link.unanswered++;
      socket.send({ t: 'ping' });
    }, DEVICE_LINK_PING_MS);
    heartbeat.unref?.();
    const hello = (said: DeviceHello) => {
      link.hello = said;
      clearTimeout(helloWait);
      markReady();
      this.onChange(userId);
    };
    const lendingChanged = (lending: DeviceLending) => {
      if (!link.hello) return;
      link.hello = { ...link.hello, lending };
      this.onChange(userId);
    };
    const homeChanged = () => this.links.get(key) === link && this.onHomeChanged(userId, deviceId);
    return { receive: (text) => this.receive(link, text, hello, lendingChanged, homeChanged), closed };
  }

  online(userId: string, deviceId: string): boolean {
    return this.links.has(linkKey(userId, deviceId));
  }

  /** The user's devices connected now, longest connected first. */
  devices(userId: string): string[] {
    return [...this.links.keys()].map((key) => JSON.parse(key) as [string, string]).flatMap(([u, d]) => (u === userId ? [d] : []));
  }

  /** What the connected device lends and allows; null while it isn't connected. Doesn't wait for its `hello`. */
  info(userId: string, deviceId: string): DeviceLinkInfo | null {
    const link = this.links.get(linkKey(userId, deviceId));
    if (!link) return null;
    const hello = link.hello;
    if (!hello) return LEGACY;
    return { services: hello.services, lending: hello.lending, home: hello.home, sep: hello.sep, os: hello.os, app: hello.app };
  }

  /** Like `info`, once the device had its chance to say what it lends. */
  async ready(userId: string, deviceId: string): Promise<DeviceLinkInfo | null> {
    const link = this.links.get(linkKey(userId, deviceId));
    if (!link) return null;
    await link.ready;
    return this.info(userId, deviceId);
  }

  /** Asks the device to start a runner at `root`; rejects with the device's reason when it refuses. */
  open(userId: string, deviceId: string, root: string): Promise<RunnerChannel> {
    const link = this.links.get(linkKey(userId, deviceId));
    if (!link) return Promise.reject(new DeviceLinkError('offline', 'The device is not connected.'));
    return this.channel(link, (channel) => ({ t: 'open', channel, root }), OPEN_TIMEOUT_MS);
  }

  /** Starts another kind of channel (a runner on an SSH host through the device); what it writes to stderr goes to `onLog`. */
  async start(userId: string, deviceId: string, service: DeviceStart, onLog?: (line: string) => void): Promise<RunnerChannel> {
    const link = await this.lending(userId, deviceId, START_SERVICE[service.kind]);
    return this.channel(link, (channel) => ({ t: 'start', channel, service }), START_TIMEOUT_MS[service.kind], onLog);
  }

  /** Asks the device something; rejects with a `DeviceLinkError` saying why when it can't or won't. */
  async request(userId: string, deviceId: string, request: DeviceRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const link = await this.lending(userId, deviceId, REQUEST_SERVICE[request.op]);
    const id = link.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.requests.delete(id);
        reject(new DeviceLinkError('timeout', 'The device did not answer.'));
      }, timeoutMs);
      timer.unref?.();
      link.requests.set(id, { resolve, reject, timer });
      link.socket.send({ t: 'req', id, request });
    });
  }

  closeAll(): void {
    for (const link of this.links.values()) link.socket.close();
  }

  /** The device's link once it said what it lends, if it lends `service`. */
  private async lending(userId: string, deviceId: string, service: DeviceService): Promise<Link> {
    const link = this.links.get(linkKey(userId, deviceId));
    if (!link) throw new DeviceLinkError('offline', 'The device is not connected.');
    await link.ready;
    if (this.links.get(linkKey(userId, deviceId)) !== link) throw new DeviceLinkError('offline', 'The device disconnected.');
    if (!(link.hello?.services ?? LEGACY.services).includes(service)) {
      throw new DeviceLinkError('unsupported', 'The desktop app on that computer is too old for this: update it, then try again.');
    }
    return link;
  }

  private channel(link: Link, frame: (channel: string) => ServerToDevice, timeoutMs: number, onLog?: (line: string) => void): Promise<RunnerChannel> {
    const id = newId();
    return new Promise((resolve, reject) => {
      let onLine: ((line: string) => void) | undefined;
      // Lines that come before anyone listens (a quick answer right after `opened`) wait for the listener.
      const early: string[] = [];
      let isOpen = false;
      let ended = false;
      let resolveClosed!: (exit: RunnerExit) => void;
      const closed = new Promise<RunnerExit>((r) => (resolveClosed = r));
      const finish = (reason: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        link.channels.delete(id);
        if (!isOpen) reject(new DeviceLinkError('refused', reason));
        resolveClosed({ code: null, signal: null });
      };
      const timer = setTimeout(() => finish('The device did not answer.'), timeoutMs);
      const channel: RunnerChannel = {
        send: (line) => !ended && link.socket.send({ t: 'line', channel: id, line }),
        onLine: (handler) => {
          onLine = handler;
          for (const line of early.splice(0)) handler(line);
        },
        closed,
        kill: () => {
          if (!ended) link.socket.send({ t: 'close', channel: id });
          finish('Closed.');
        },
      };
      link.channels.set(id, {
        line: (line) => (onLine ? onLine(line) : early.push(line)),
        log: (line) => onLog?.(line),
        opened: () => {
          isOpen = true;
          clearTimeout(timer);
          resolve(channel);
        },
        finish,
      });
      link.socket.send(frame(id));
    });
  }

  private receive(link: Link, text: string, hello: (said: DeviceHello) => void, lendingChanged: (lending: DeviceLending) => void, homeChanged: () => void): void {
    let frame: DeviceToServer;
    try {
      frame = DeviceToServer.parse(JSON.parse(text));
    } catch {
      return; // A malformed frame from a device is dropped.
    }
    link.unanswered = 0;
    switch (frame.t) {
      case 'pong':
        return;
      case 'hello':
        return hello(frame.hello);
      case 'event':
        return frame.event === 'home.changed' ? void homeChanged() : lendingChanged(frame.lending);
      case 'res': {
        const pending = link.requests.get(frame.id);
        if (!pending) return;
        link.requests.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(new DeviceLinkError(frame.code ?? 'failed', frame.error ?? 'The device could not do that.'));
        return;
      }
      default: {
        const channel = link.channels.get(frame.channel);
        if (!channel) return;
        if (frame.t === 'opened') channel.opened();
        else if (frame.t === 'line') channel.line(frame.line);
        else if (frame.t === 'log') channel.log(frame.line);
        else channel.finish(frame.reason);
      }
    }
  }
}
