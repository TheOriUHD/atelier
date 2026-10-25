/**
 * `fetch` through a person's desktop device (ARCHITECTURE §21, device services): requests to an address the device lent
 * (a model server or connector on that computer or its network) go out from there. The response's head arrives first,
 * then its body as it streams; the request's signal cancels it on the device. A device that can't be reached, or won't
 * send the request, fails it the way an unreachable server does (`TypeError: fetch failed`).
 */
import { z } from 'zod';
import type { DeviceLinks } from './device-links.ts';

/**
 * What the device sends in an `http` channel: the head, then body chunks; `error` when the request failed there, with
 * the network error's `code` (`ECONNREFUSED` …) when there was one.
 */
const Message = z.union([
  z.object({ head: z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()) }) }),
  z.object({ chunk: z.string() }),
  z.object({ error: z.string(), code: z.string().max(64).optional() }),
]);

/** Statuses whose responses have no body (the Response constructor refuses one). */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

const failed = (cause: unknown) => new TypeError('fetch failed', { cause: cause instanceof Error ? cause : new Error(String(cause)) });

export type DeviceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `fetch` from `deviceId` to the address it lent as `target`. */
export function deviceFetch(links: Pick<DeviceLinks, 'start'>, userId: string, deviceId: string, target: string): DeviceFetch {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase() as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer()).toString('base64');
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const channel = await links.start(userId, deviceId, { kind: 'http', target, method, url, headers, ...(body ? { body } : {}) }).catch((e: unknown) => Promise.reject(failed(e)));
    return new Promise<Response>((resolve, reject) => {
      let headed = false;
      let done = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (controller = c),
        cancel: () => channel.kill(),
      });
      const end = (error?: unknown) => {
        if (done) return;
        done = true;
        if (!headed) return reject(error ?? failed('The device closed the request.'));
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // The body was cancelled already.
        }
      };
      channel.onLine((line) => {
        let message: z.infer<typeof Message>;
        try {
          message = Message.parse(JSON.parse(line));
        } catch {
          return;
        }
        if ('head' in message) {
          if (headed) return;
          headed = true;
          const empty = method === 'HEAD' || NO_BODY.has(message.head.status);
          resolve(new Response(empty ? null : stream, { status: message.head.status, headers: message.head.headers }));
        } else if ('chunk' in message) {
          if (headed && !done) controller.enqueue(Buffer.from(message.chunk, 'base64'));
        } else end(failed(Object.assign(new Error(message.error), message.code ? { code: message.code } : {})));
      });
      void channel.closed.then(() => end());
      signal?.addEventListener(
        'abort',
        () => {
          channel.kill();
          end(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  };
}
