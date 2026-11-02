/**
 * A WebSocket through a person's desktop device (ARCHITECTURE §21, device services), for an image server's progress:
 * the socket opens there, to an address the device lent, and its messages come back over the link. A desktop too old
 * for this, one that refuses, or an address that doesn't answer rejects the call, so an adapter polls instead; nothing
 * is left waiting. The signal closes the socket on the device.
 */
import { DeviceSocketLine, type DeviceSocketSend } from '@atelier/protocol';
import type { ImageSocket } from '../images/types.ts';
import type { DeviceLinks } from './device-links.ts';

/** The device says how connecting went within this long, or it isn't going to. */
const OPEN_TIMEOUT_MS = 20_000;
/** Messages held for a reader that isn't reading: a device shouldn't be able to fill the server's memory. */
const MAX_QUEUED_BYTES = 256 * 1024 * 1024;

export type DeviceSocket = (url: string, signal: AbortSignal) => Promise<ImageSocket>;

/** Opens WebSockets from `deviceId` to the address it lent as `target`, with `headers` on each. */
export function deviceSocket(links: Pick<DeviceLinks, 'start'>, userId: string, deviceId: string, target: string, headers: Record<string, string> = {}): DeviceSocket {
  return async (url, signal) => {
    signal.throwIfAborted();
    const channel = await links.start(userId, deviceId, { kind: 'ws', target, url, headers });
    if (signal.aborted) {
      channel.kill();
      throw signal.reason;
    }
    return new Promise<ImageSocket>((resolve, reject) => {
      const queue: (string | Uint8Array)[] = [];
      let queued = 0;
      let opened = false;
      let ended = false;
      let failure: Error | null = null;
      let wake: (() => void) | null = null;
      const notify = () => {
        wake?.();
        wake = null;
      };
      const stop = (error?: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        failure = error ?? null;
        if (!opened) reject(error ?? new Error(`The connection to ${new URL(url).host} ended before it opened.`));
        notify();
      };
      const onAbort = () => {
        channel.kill();
        stop(opened ? undefined : (signal.reason as Error));
      };
      const timer = setTimeout(() => {
        channel.kill();
        stop(new Error(`The computer didn't connect to ${new URL(url).host} in time.`));
      }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      const push = (message: string | Uint8Array, bytes: number) => {
        queued += bytes;
        if (queued > MAX_QUEUED_BYTES) {
          channel.kill();
          return stop(new Error('Too much came over the connection at once.'));
        }
        queue.push(message);
        notify();
      };
      const socket: ImageSocket = {
        send: (text) => void (!ended && channel.send(JSON.stringify({ text } satisfies DeviceSocketSend))),
        close: () => {
          channel.kill();
          stop();
        },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) {
              const next = queue.shift()!;
              queued -= next.length;
              yield next;
              continue;
            }
            if (failure) throw failure;
            if (ended) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
      };
      channel.onLine((line) => {
        if (ended) return;
        const parsed = (() => {
          try {
            return DeviceSocketLine.safeParse(JSON.parse(line));
          } catch {
            return null;
          }
        })();
        if (!parsed?.success) return;
        const message = parsed.data;
        if ('open' in message) {
          if (opened) return;
          opened = true;
          clearTimeout(timer);
          resolve(socket);
        } else if (!opened) {
          if ('error' in message) stop(Object.assign(new Error(message.error), message.code ? { code: message.code } : {}));
          // Nothing but `error` may come before `open`: a socket isn't up until the device says so.
        } else if ('text' in message) push(message.text, message.text.length);
        else if ('binary' in message) {
          const bytes = Buffer.from(message.binary, 'base64');
          push(bytes, bytes.length);
        } else stop('error' in message ? Object.assign(new Error(message.error), message.code ? { code: message.code } : {}) : undefined);
      });
      void channel.closed.then(() => stop());
    });
  };
}
