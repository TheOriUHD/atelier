/**
 * The fetch every image adapter gets. A service, hosted or someone's own, decides what comes back, so: a redirect stays on
 * its host (following one to another would take the key along, or reach this server's own network), and no answer can
 * fill the backend's memory. A finished image's URL on another host goes through `download.ts` instead.
 */
import type { ProviderFetch } from '../providers/types.ts';

/** Far above any image: previews in a stream and a batch of four large images in base64 fit easily. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Statuses that can't have a body: `new Response` refuses one. */
const EMPTY = new Set([101, 204, 205, 304]);

function capped(res: Response, max: number): Response {
  if (!res.body || EMPTY.has(res.status)) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('The answer is too large.'));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function guardedImageFetch(inner: ProviderFetch, max = MAX_RESPONSE_BYTES): ProviderFetch {
  return async (input, init) => {
    let url = input;
    let next = init;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await inner(url, { ...next, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return capped(res, max);
      const target = new URL(location, url);
      if (target.origin !== new URL(url).origin) throw new Error(`${new URL(url).host} redirected to another host, which isn't followed.`);
      url = target.href;
      // As fetch does: 303, and 301 or 302 after a POST, go on as a GET without the body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && next.method === 'POST')) next = { ...next, method: 'GET', body: null };
    }
    throw new Error('Too many redirects.');
  };
}
