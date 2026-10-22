/**
 * Images on their way to a model provider (docs/ARCHITECTURE.md §7). Providers refuse what is too big, and a refusal
 * of one image used to fail every later request too, since the image stayed in the conversation. So each request's
 * images are fitted to the provider's own limits first: reduced to the largest side and byte size it takes, the oldest
 * left out (with a note to the model) when there are more than it holds, and the type taken from the bytes, not the name.
 *
 * Decoding and encoding are pure JavaScript (PNG and JPEG), so this runs the same on the desktop and the server.
 */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { ProviderType } from '@atelier/protocol';
import { imageSize } from './image-size.ts';

const MB = 1024 * 1024;

export interface ImagePolicy {
  /** Longest side in pixels; null when the provider names no limit. */
  maxSide: number | null;
  /** Bytes of one image. */
  maxBytes: number;
  /** Images in one request; the oldest beyond it are left out. */
  maxCount: number | null;
  /** Past this many images in a request each must also fit `side` (Anthropic: more than 20 → 2000 pixels). */
  many: { above: number; side: number } | null;
  /** Bytes of all images together (the request's own size limit); the oldest are left out to fit. */
  totalBytes: number | null;
}

/**
 * What each provider takes. Anthropic: 8000 pixels and 5 MB an image, 100 images and 32 MB a request, and 2000 pixels
 * each past 20 images. OpenAI: 20 MB an image, 500 images and 50 MB a request, resized on its side. An OpenAI-compatible
 * endpoint can be anything (OpenRouter fronts Anthropic's models), so it gets the stricter of the two. Local servers
 * (Ollama, llama.cpp) have no limit but memory and their vision encoder's own resizing: 4096 pixels is more than any
 * of them uses.
 */
export const IMAGE_POLICIES: Record<ProviderType, ImagePolicy> = {
  anthropic: { maxSide: 8000, maxBytes: 5 * MB, maxCount: 100, many: { above: 20, side: 2000 }, totalBytes: 24 * MB },
  openai: { maxSide: null, maxBytes: 20 * MB, maxCount: 500, many: null, totalBytes: 40 * MB },
  // ChatGPT's own page: up to 10 files in a message and 20 MB each (the adapter enforces the rest).
  'chatgpt-chat': { maxSide: null, maxBytes: 20 * MB, maxCount: 10, many: null, totalBytes: null },
  chatgpt: { maxSide: null, maxBytes: 20 * MB, maxCount: 500, many: null, totalBytes: 40 * MB },
  // Copilot fronts Anthropic's models as well as OpenAI's: the stricter of the two.
  copilot: { maxSide: 8000, maxBytes: 5 * MB, maxCount: 100, many: { above: 20, side: 2000 }, totalBytes: 24 * MB },
  'openai-compatible': { maxSide: 8000, maxBytes: 5 * MB, maxCount: 100, many: { above: 20, side: 2000 }, totalBytes: 24 * MB },
  ollama: { maxSide: 4096, maxBytes: 25 * MB, maxCount: null, many: null, totalBytes: null },
  llamacpp: { maxSide: 4096, maxBytes: 25 * MB, maxCount: null, many: null, totalBytes: null },
};

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The type of an image from its first bytes: a `.png` that holds a JPEG is rejected by providers that check. */
export function sniffMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

interface Raster {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

/** More than this many pixels is too much to decode in memory (RGBA is four bytes each). */
const MAX_PIXELS = 100_000_000;

function decode(bytes: Uint8Array, mime: ImageMime): Raster | null {
  try {
    if (mime === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: png.data };
    }
    if (mime === 'image/jpeg') {
      const out = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
      return { width: out.width, height: out.height, data: out.data };
    }
  } catch {
    return null;
  }
  return null;
}

/** Area-averaged reduction: every output pixel is the mean of the source pixels it covers. */
function reduce(src: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          // Weighted by alpha, so a transparent pixel's colour doesn't bleed into its neighbours.
          const alpha = src.data[i + 3]!;
          r += src.data[i]! * alpha;
          g += src.data[i + 1]! * alpha;
          b += src.data[i + 2]! * alpha;
          a += alpha;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

const encodePng = (r: Raster): Uint8Array => {
  const png = new PNG({ width: r.width, height: r.height });
  png.data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
};

/** JPEG has no alpha: transparency is flattened onto white. */
const encodeJpeg = (r: Raster, quality: number): Uint8Array => {
  const flat = new Uint8Array(r.data.length);
  for (let i = 0; i < r.data.length; i += 4) {
    const a = r.data[i + 3]! / 255;
    flat[i] = Math.round(r.data[i]! * a + 255 * (1 - a));
    flat[i + 1] = Math.round(r.data[i + 1]! * a + 255 * (1 - a));
    flat[i + 2] = Math.round(r.data[i + 2]! * a + 255 * (1 - a));
    flat[i + 3] = 255;
  }
  return jpeg.encode({ width: r.width, height: r.height, data: flat }, quality).data;
};

export interface Fitted {
  bytes: Uint8Array;
  mime: ImageMime;
  width: number;
  height: number;
  /** Whether it was reduced or re-encoded (false: the original bytes). */
  changed: boolean;
}

export type FitResult = { ok: true; image: Fitted } | { ok: false; reason: string };

/**
 * `bytes` as an image within `side` pixels (null: no limit) and `maxBytes`. PNG stays PNG while it fits (screenshots
 * and diagrams stay sharp), otherwise it and every JPEG become a JPEG at the best quality that fits, then smaller.
 */
export function fitImage(bytes: Uint8Array, declared: string, side: number | null, maxBytes: number): FitResult {
  const mime = sniffMime(bytes) ?? (declared as ImageMime);
  const size = imageSize(bytes);
  if (size && (side === null || Math.max(size.width, size.height) <= side) && bytes.length <= maxBytes) {
    return { ok: true, image: { bytes, mime, width: size.width, height: size.height, changed: false } };
  }
  if (!size) return bytes.length <= maxBytes ? { ok: true, image: { bytes, mime, width: 0, height: 0, changed: false } } : { ok: false, reason: `is ${(bytes.length / MB).toFixed(1)} MB and can't be reduced` };
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    return { ok: false, reason: `(${size.width}×${size.height} ${mime.replace('image/', '').toUpperCase()}) is too large for this provider and can't be reduced; only PNG and JPEG can be` };
  }
  if (size.width * size.height > MAX_PIXELS) return { ok: false, reason: `(${size.width}×${size.height}) has too many pixels to reduce` };
  const source = decode(bytes, mime);
  if (!source) return { ok: false, reason: `(${size.width}×${size.height}) could not be read to be reduced` };

  const scale = side === null ? 1 : Math.min(1, side / Math.max(source.width, source.height));
  let raster = scale < 1 ? reduce(source, Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale))) : source;
  const done = (out: Uint8Array, as: ImageMime): FitResult => ({ ok: true, image: { bytes: out, mime: as, width: raster.width, height: raster.height, changed: true } });

  if (mime === 'image/png') {
    const png = encodePng(raster);
    if (png.length <= maxBytes) return done(png, 'image/png');
  }
  // A JPEG at the best quality that fits; if none does, a quarter fewer pixels, a few times.
  for (let round = 0; round < 5; round++) {
    for (const quality of [90, 80, 70, 60]) {
      const out = encodeJpeg(raster, quality);
      if (out.length <= maxBytes) return done(out, 'image/jpeg');
    }
    raster = reduce(raster, Math.max(1, Math.round(raster.width * 0.75)), Math.max(1, Math.round(raster.height * 0.75)));
  }
  return { ok: false, reason: 'could not be reduced to the size this provider takes' };
}

/** Fitted images by what they were fitted from and to; the same input always gives the same bytes (prompt caches rely on it). */
const FITTED_CAP = 16;
const fitted = new Map<string, FitResult>();

export function fitImageCached(sha: string, bytes: Uint8Array, declared: string, side: number | null, maxBytes: number): FitResult {
  const key = `${sha}|${side ?? '-'}|${maxBytes}`;
  const hit = fitted.get(key);
  if (hit) {
    fitted.delete(key);
    fitted.set(key, hit);
    return hit;
  }
  const result = fitImage(bytes, declared, side, maxBytes);
  fitted.set(key, result);
  while (fitted.size > FITTED_CAP) fitted.delete(fitted.keys().next().value as string);
  return result;
}

/** Bytes by a name that stands for them: what a fitted image is read from after it replaced the original in a request. */
export class BlobOverlay {
  private readonly blobs = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(
    private readonly base: (sha256: string) => Promise<Uint8Array>,
    private readonly cap = 128 * MB,
  ) {}

  read = async (sha256: string): Promise<Uint8Array> => {
    const own = this.blobs.get(sha256);
    return own ?? this.base(sha256);
  };

  /** Stores `bytes` and returns the name to read them by (content-addressed, so equal images share one). */
  add(bytes: Uint8Array): string {
    const name = `fit:${createHash('sha256').update(bytes).digest('hex')}`;
    if (!this.blobs.has(name)) {
      this.blobs.set(name, bytes);
      this.bytes += bytes.length;
      while (this.bytes > this.cap && this.blobs.size > 1) {
        const oldest = this.blobs.keys().next().value as string;
        this.bytes -= this.blobs.get(oldest)!.length;
        this.blobs.delete(oldest);
      }
    }
    return name;
  }
}
