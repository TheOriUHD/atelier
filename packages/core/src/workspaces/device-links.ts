/**
 * Live device links (ARCHITECTURE §21): which desktop devices are lending their runner right now, and runner
 * channels over them. A link belongs to the account that signed the device in and is kept under that account
 * and the device id: only that account's workspaces use it, and another account using the same id can't replace it.
 */
import { DEVICE_LINK_PING_MS, DeviceToServer, type ServerToDevice } from '@atelier/protocol';
import { newId } from '../util/ids.ts';
import type { RunnerChannel, RunnerExit } from './runner-client.ts';

export interface LinkSocket {
  /** Must not throw once the socket is closed. */
  send(frame: ServerToDevice): void;
  close(): void;
}

interface Channel {
  line(line: string): void;
  opened(): void;
  finish(reason: string): void;
}

interface Link {
  socket: LinkSocket;
  channels: Map<string, Channel>;
  /** Pings sent since the device last sent anything. */
  unanswered: number;
}

const OPEN_TIMEOUT_MS = 15_000;
const MISSED_PINGS = 2;
const linkKey = (userId: string, deviceId: string) => JSON.stringify([userId, deviceId]);

export class DeviceLinks {
  private links = new Map<string, Link>();

  /** `onChange` hears when one of the user's devices comes or goes. */
  constructor(private readonly onChange: (userId: string) => void) {}

  /** A device connected. Replaces this account's older link of the device; returns where its frames and close go. */
  attach(userId: string, deviceId: string, socket: LinkSocket): { receive(text: string): void; closed(): void } {
    const key = linkKey(userId, deviceId);
    this.links.get(key)?.socket.close();
    const link: Link = { socket, channels: new Map(), unanswered: 0 };
    this.links.set(key, link);
    this.onChange(userId);
    const closed = () => {
      clearInterval(heartbeat);
      for (const channel of link.channels.values()) channel.finish('The device disconnected.');
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
    return { receive: (text) => this.receive(link, text), closed };
  }

  online(userId: string, deviceId: string): boolean {
    return this.links.has(linkKey(userId, deviceId));
  }

  /** Asks the device to start a runner at `root`; rejects with the device's reason when it refuses. */
  open(userId: string, deviceId: string, root: string): Promise<RunnerChannel> {
    const link = this.links.get(linkKey(userId, deviceId));
    if (!link) return Promise.reject(new Error('The device is not connected.'));
    const id = newId();
    return new Promise((resolve, reject) => {
      let onLine: ((line: string) => void) | undefined;
      let isOpen = false;
      let ended = false;
      let resolveClosed!: (exit: RunnerExit) => void;
      const closed = new Promise<RunnerExit>((r) => (resolveClosed = r));
      const finish = (reason: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        link.channels.delete(id);
        if (!isOpen) reject(new Error(reason));
        resolveClosed({ code: null, signal: null });
      };
      const timer = setTimeout(() => finish('The device did not answer.'), OPEN_TIMEOUT_MS);
      const channel: RunnerChannel = {
        send: (line) => !ended && link.socket.send({ t: 'line', channel: id, line }),
        onLine: (handler) => void (onLine = handler),
        closed,
        kill: () => {
          if (!ended) link.socket.send({ t: 'close', channel: id });
          finish('Closed.');
        },
      };
      link.channels.set(id, {
        line: (line) => onLine?.(line),
        opened: () => {
          isOpen = true;
          clearTimeout(timer);
          resolve(channel);
        },
        finish,
      });
      link.socket.send({ t: 'open', channel: id, root });
    });
  }

  closeAll(): void {
    for (const link of this.links.values()) link.socket.close();
  }

  private receive(link: Link, text: string): void {
    let frame: DeviceToServer;
    try {
      frame = DeviceToServer.parse(JSON.parse(text));
    } catch {
      return; // A malformed frame from a device is dropped.
    }
    link.unanswered = 0;
    if (frame.t === 'pong') return;
    const channel = link.channels.get(frame.channel);
    if (!channel) return;
    if (frame.t === 'opened') channel.opened();
    else if (frame.t === 'line') channel.line(frame.line);
    else channel.finish(frame.reason);
  }
}
