/**
 * Fetches a finished image from where a hosted service left it. The page can't load remote images (the CSP refuses
 * them), and a signed URL expires, so the backend takes the bytes at once. The URL comes from a remote service, so
 * it gets what WebFetch's URLs get: no private addresses, redirects checked one by one, no credentials, a size limit.
 */
import { sniffMime, type ImageMime } from '../providers/images.ts';
import { resolvePublicHost, type Lookup, type PinnedInit } from '../tools/address-guard.ts';
import { readCapped } from '../tools/web-fetch.ts';
import type { AudioMime } from '@atelier/protocol';
import { checkAudio, MAX_AUDIO_BYTES } from './audio.ts';
import { checkVideo, MAX_VIDEO_BYTES, type VideoMime } from './video.ts';

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

/** What each kind of result is called in a message, and how large it may be. */
const KINDS = {
  image: { noun: 'an image', max: MAX_IMAGE_BYTES, limit: 'The image is larger than 64 MB.' },
  video: { noun: 'a video', max: MAX_VIDEO_BYTES, limit: `The video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB.` },
  sound: { noun: 'a sound', max: MAX_AUDIO_BYTES, limit: `The sound is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB.` },
} as const;

/** The one guarded fetch behind both downloads: a public host, no credentials, redirects checked one by one, a size cap. */
async function fetchGuarded(deps: DownloadDeps, url: string, signal: AbortSignal, kind: keyof typeof KINDS): Promise<Uint8Array> {
  const { noun, max, limit } = KINDS[kind];
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new Error(`Can't fetch ${noun} from ${current.protocol}`);
    if (current.username || current.password) throw new Error("A URL with credentials isn't allowed.");
    const pin = await resolvePublicHost(current.hostname, deps.allowPrivate ?? false, deps.lookup);
    const res = await deps.fetch(current.href, { redirect: 'manual', pin, signal });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('A redirect went nowhere.');
      current = new URL(next, current);
      continue;
    }
    if (!res.ok) throw new Error(`Fetching the ${kind} failed (${res.status}).`);
    const bytes = await readCapped(res, max);
    if (!bytes) throw new Error(limit);
    return bytes;
  }
  throw new Error(`Too many redirects fetching the ${kind}.`);
}

export async function downloadImage(deps: DownloadDeps, url: string, signal: AbortSignal): Promise<DownloadedImage> {
  const bytes = await fetchGuarded(deps, url, signal, 'image');
  return { bytes, mime: checkImage(bytes) };
}

export interface DownloadedVideo {
  bytes: Uint8Array;
  mime: VideoMime;
}

/** A finished clip from where a hosted service left it, held to the same rules as an image, with a larger size limit. */
export async function downloadVideo(deps: DownloadDeps, url: string, signal: AbortSignal): Promise<DownloadedVideo> {
  const bytes = await fetchGuarded(deps, url, signal, 'video');
  return { bytes, mime: checkVideo(bytes) };
}

export interface DownloadedAudio {
  bytes: Uint8Array;
  mime: AudioMime;
}

/** A finished sound from where a hosted service left it, held to the same rules as an image. */
export async function downloadAudio(deps: DownloadDeps, url: string, signal: AbortSignal): Promise<DownloadedAudio> {
  const bytes = await fetchGuarded(deps, url, signal, 'sound');
  return { bytes, mime: checkAudio(bytes) };
}
