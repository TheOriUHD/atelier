/**
 * Fetches a finished image from where a hosted service left it. The page can't load remote images (the CSP refuses
 * them), and a signed URL expires, so the backend takes the bytes at once. The URL comes from a remote service, so
 * it gets what WebFetch's URLs get: no private addresses, redirects checked one by one, no credentials, a size limit.
 */
import { sniffMime, type ImageMime } from '../providers/images.ts';
import { resolvePublicHost, type Lookup, type PinnedInit } from '../tools/address-guard.ts';
import { readCapped } from '../tools/web-fetch.ts';

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface DownloadDeps {
  /** Gets `init.pin` (the addresses that were checked) as the only addresses to connect to; see address-guard.ts. */
  fetch: (url: string, init: PinnedInit) => Promise<Response>;
  lookup?: Lookup;
  /** Tests point images at a local fake server. */
  allowPrivate?: boolean;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  mime: ImageMime;
}

/** What an image's bytes are, refusing anything else: a service's error page must not be stored as a picture. */
export function checkImage(bytes: Uint8Array): ImageMime {
  if (bytes.byteLength === 0) throw new Error('The image came back empty.');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The image is larger than 64 MB.');
  const mime = sniffMime(bytes);
  if (!mime) throw new Error("What came back isn't an image Atelier can show.");
  return mime;
}

export async function downloadImage(deps: DownloadDeps, url: string, signal: AbortSignal): Promise<DownloadedImage> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new Error(`Can't fetch an image from ${current.protocol}`);
    if (current.username || current.password) throw new Error("A URL with credentials isn't allowed.");
    const pin = await resolvePublicHost(current.hostname, deps.allowPrivate ?? false, deps.lookup);
    const res = await deps.fetch(current.href, { redirect: 'manual', pin, signal });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('A redirect went nowhere.');
      current = new URL(next, current);
      continue;
    }
    if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    if (!bytes) throw new Error('The image is larger than 64 MB.');
    return { bytes, mime: checkImage(bytes) };
  }
  throw new Error('Too many redirects fetching the image.');
}
