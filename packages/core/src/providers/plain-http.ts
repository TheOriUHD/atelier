/**
 * `fetch` for model servers reached over plain HTTP (Ollama, llama.cpp, LM Studio on this computer or the local
 * network), without the 300-second header and body timeouts of Node's built-in fetch. Those servers send nothing while
 * a model writes a tool call: on Ollama 0.33 a 24B model writing a long call for five minutes ended as "Cannot reach"
 * when undici gave up, and the generation was lost. Instead a request ends when the server ends it, its signal aborts
 * (the stop button, the queue's limits), or nothing at all arrives for `idleMs` (15 minutes unless set), which reads as
 * a retryable "no response". HTTPS goes to the fallback, whose servers stream or ping.
 */
import { request, type IncomingMessage } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ProviderFetch } from './types.ts';

export const DEFAULT_IDLE_MS = 15 * 60_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The server sent nothing (no headers, no bytes) for the idle limit; asking again may work. */
export class NoResponseError extends Error {
  constructor(readonly idleMs: number) {
    super(`No response for ${Math.round(idleMs / 60_000)} minutes`);
    this.name = 'NoResponseError';
  }
}

export interface PlainHttpOptions {
  /** How long a request may receive nothing before it ends with `NoResponseError`. */
  idleMs?: number;
}

type Init = Parameters<ProviderFetch>[1];

export function plainHttpFetch(fallback: ProviderFetch, options: PlainHttpOptions = {}): ProviderFetch {
  const idleMs = options.idleMs && options.idleMs > 0 ? options.idleMs : DEFAULT_IDLE_MS;

  const send = (url: string, init: Init, redirects: number): Promise<Response> => {
    const target = URL.parse(url);
    if (target?.protocol !== 'http:') return fallback(url, init);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<Response>((resolve, reject) => {
      let idle: NoResponseError | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const req = request(
        target,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(signal ? { signal } : {}),
        },
        (res) => {
          watch();
          const status = res.statusCode ?? 502;
          const location = res.headers.location;
          if (REDIRECTS.has(status) && location && init.redirect !== 'manual') {
            stop();
            res.resume();
            if (redirects >= MAX_REDIRECTS)
              return reject(new TypeError('fetch failed', { cause: new Error('redirect count exceeded') }));
            // As fetch does: 303, and 301/302 after a POST, continue as a GET without the body.
            const asGet = status === 303 || ((status === 301 || status === 302) && init.method === 'POST');
            const next: Init = asGet ? { ...init, method: 'GET', body: null } : init;
            resolve(send(new URL(location, target).href, next, redirects + 1));
            return;
          }
          resolve(respond(res, status));
        },
      );
      /** Restarts the idle limit; called when the request goes out and whenever bytes arrive. */
      const watch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          idle = new NoResponseError(idleMs);
          req.destroy(idle);
        }, idleMs);
        timer.unref?.();
      };
      const stop = () => clearTimeout(timer);
      // Network failures look like fetch's (a TypeError), so they read as "Cannot reach"; aborts stay aborts.
      req.on('error', (error) => {
        stop();
        reject(
          signal?.aborted
            ? abortError(signal)
            : (idle ?? (error.name === 'AbortError' ? error : new TypeError('fetch failed', { cause: error }))),
        );
      });

      const respond = (res: IncomingMessage, status: number): Response => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }
        const encoding = (res.headers['content-encoding'] ?? '').toLowerCase();
        const decoded =
          encoding === 'gzip'
            ? res.pipe(createGunzip())
            : encoding === 'deflate'
              ? res.pipe(createInflate())
              : encoding === 'br'
                ? res.pipe(createBrotliDecompress())
                : res;
        if (decoded !== res) {
          res.on('error', (e) => decoded.destroy(e));
          headers.delete('content-encoding');
          headers.delete('content-length');
        }
        const empty = status === 204 || status === 304 || init.method === 'HEAD';
        if (empty) {
          stop();
          res.resume();
          return new Response(null, { status, statusText: res.statusMessage ?? '', headers });
        }
        // The body as fetch's would end: an abort as an AbortError (not a connection reset), a dropped connection as
        // TypeError "terminated" (retryable), silence past the limit as NoResponseError.
        const body = new PassThrough();
        decoded.on('data', watch);
        decoded.on('end', stop);
        decoded.on('error', (error) => {
          stop();
          body.destroy(signal?.aborted ? abortError(signal) : (idle ?? new TypeError('terminated', { cause: error })));
        });
        decoded.pipe(body);
        const onAbort = () => {
          stop();
          body.destroy(abortError(signal!));
          decoded.destroy();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        body.once('close', () => {
          stop();
          signal?.removeEventListener('abort', onAbort);
        });
        return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
          status,
          statusText: res.statusMessage ?? '',
          headers,
        });
      };

      watch();
      const payload = init.body;
      if (typeof payload === 'string' || payload instanceof Uint8Array) req.end(payload);
      else req.end();
    });
  };

  return (url, init) => send(url, init, 0);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === 'AbortError'
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
