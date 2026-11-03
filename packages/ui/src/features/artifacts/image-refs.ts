/**
 * Generated images inside the sandbox (ARCHITECTURE §23). An artifact or inline visual can't load `/api/blobs/…`: its
 * frame has an opaque origin and a CSP of `img-src data: blob:`, `connect-src 'none'`. So the model writes
 * `atelier-image:img_ab12cd34` where the picture goes, and this module, in the app and not in the frame, swaps each such
 * reference for a `data:` URL of that image before the content is posted in. Only ids of the conversation's own images
 * (the table in `images/session-images.tsx`) resolve; any other id becomes a placeholder, so a guessed id shows nothing.
 * The frame never gets a way to ask for more, and still can't make a request.
 */
import type { ImageIndex, SessionImage } from '../images/session-images.tsx';

/** What the model writes: the scheme and the id. */
export const IMAGE_REF = /atelier-image:(img_[0-9a-f]{8})(?![0-9a-zA-Z_])/g;

/** More references than this in one piece of content aren't resolved: the rest become the placeholder. */
export const MAX_REFERENCED = 12;
/** One image's data URL, in characters (about 1.5 MB of picture). Larger images are shrunk first. */
export const MAX_IMAGE_CHARS = 2_000_000;
/** All the data URLs in one piece of content. */
export const MAX_TOTAL_CHARS = 8_000_000;

/** The ids a piece of content refers to, once each, in order of appearance. */
export function referencedImages(content: string): string[] {
  return [...new Set([...content.matchAll(IMAGE_REF)].map((m) => m[1]!))];
}

const svg = (text: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#8882"/><text x="160" y="104" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#888">${text}</text></svg>`)}`;

/** Shown where an image can't be: an id from nowhere in this conversation, or more than fits. */
export const PLACEHOLDERS = {
  unknown: svg('Image not available'),
  tooLarge: svg('Image too large to show here'),
};

/** One image not yet loaded: invisible, so the layout holds while it comes. */
export const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The data URLs images were loaded into, by blob: loading is by content, so a hit is always right. */
const loaded = new Map<string, string | null>();
const LOADED_CAP = 48;

export const cachedDataUrl = (blob: string): string | null | undefined => loaded.get(blob);

function remember(blob: string, url: string | null) {
  loaded.delete(blob);
  loaded.set(blob, url);
  while (loaded.size > LOADED_CAP) loaded.delete(loaded.keys().next().value as string);
}

export type LoadDataUrl = (image: SessionImage) => Promise<string | null>;

/** The referenced images of this conversation that aren't loaded yet. */
export function pendingImages(content: string, index: ImageIndex): SessionImage[] {
  return referencedImages(content)
    .slice(0, MAX_REFERENCED)
    .flatMap((id) => {
      const image = index.get(id);
      return image && !loaded.has(image.blob) ? [image] : [];
    });
}

/** Loads what `pendingImages` lists, one at a time; a failure is remembered as "no picture" so it isn't retried on every keystroke of a stream. */
export async function loadImages(images: readonly SessionImage[], load: LoadDataUrl): Promise<void> {
  for (const image of images) {
    if (loaded.has(image.blob)) continue;
    remember(image.blob, await load(image).catch(() => null));
  }
}

/**
 * The content with each reference swapped for its data URL. An id that isn't this conversation's, an image that
 * can't be shown, one past the per-image or total cap or past the twelfth reference becomes a placeholder; an image
 * still loading is blank (`pending` says so).
 */
export function inlineImages(content: string, index: ImageIndex): { content: string; pending: boolean } {
  let pending = false;
  let used = 0;
  const order = new Map(referencedImages(content).map((id, i) => [id, i]));
  const text = content.replace(IMAGE_REF, (_match, id: string) => {
    if ((order.get(id) ?? 0) >= MAX_REFERENCED) return PLACEHOLDERS.tooLarge;
    const image = index.get(id);
    if (!image) return PLACEHOLDERS.unknown;
    const url = loaded.get(image.blob);
    if (url === undefined) {
      pending = true;
      return BLANK;
    }
    if (url === null) return PLACEHOLDERS.unknown;
    if (url.length > MAX_IMAGE_CHARS || used + url.length > MAX_TOTAL_CHARS) return PLACEHOLDERS.tooLarge;
    used += url.length;
    return url;
  });
  return { content: text, pending };
}

const ALLOWED = /^image\/(png|jpe?g|webp|gif)$/;
const SHRINK_SIDES = [1600, 1200, 900, 640];

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/** Loads an image from the app's own blob address as a data URL, shrunk until it fits `MAX_IMAGE_CHARS`. */
export async function loadDataUrl(image: SessionImage, address: (blob: string) => string): Promise<string | null> {
  const response = await fetch(address(image.blob));
  if (!response.ok) return null;
  const blob = await response.blob();
  const type = blob.type || image.mime;
  if (ALLOWED.test(type)) {
    const direct = await readDataUrl(blob.type ? blob : new Blob([blob], { type }));
    if (direct.length <= MAX_IMAGE_CHARS) return direct;
  }
  // Too big, or in a type the sandbox may not draw: redrawn smaller as WebP, then JPEG.
  const bitmap = await createImageBitmap(blob);
  try {
    for (const side of SHRINK_SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const mime of ['image/webp', 'image/jpeg']) {
        const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.85));
        if (out?.type === mime) {
          const url = await readDataUrl(out);
          if (url.length <= MAX_IMAGE_CHARS) return url;
        }
      }
    }
  } finally {
    bitmap.close();
  }
  return null;
}
