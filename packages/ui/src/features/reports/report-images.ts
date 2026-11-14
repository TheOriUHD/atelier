/**
 * Pictures for a report, made small before they go (ARCHITECTURE §26): scaled to at most `REPORT_LIMITS.screenshotSide`
 * on the longest side and compressed (WebP where the browser can write it, JPEG elsewhere), stepping quality and size
 * down until the picture fits the collector's limit. A screenshot of Atelier stays sharp; a phone photo shrinks a lot.
 */
import { REPORT_LIMITS } from '@atelier/protocol';

export interface Shot {
  id: string;
  mime: 'image/webp' | 'image/jpeg' | 'image/png';
  dataBase64: string;
  width: number;
  height: number;
  bytes: number;
  /** An object URL for the thumbnail; revoked when the picture goes. */
  url: string;
  /** `window`: taken by the report shortcut; `added`: pasted, dropped or chosen. */
  source: 'window' | 'added';
}

/** Quality and an extra scale, tried in order until the picture fits. */
const STEPS: [number, number][] = [
  [0.86, 1],
  [0.78, 1],
  [0.72, 0.75],
  [0.65, 0.5],
];

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture.'));
    reader.readAsDataURL(blob);
  });

export class PictureError extends Error {}

export async function compressPicture(source: Blob, from: Shot['source']): Promise<Shot> {
  if (!source.type.startsWith('image/') || source.type === 'image/svg+xml') throw new PictureError('Only pictures can be attached (PNG, JPEG, WebP, GIF, HEIC where the browser reads it).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new PictureError('That picture could not be read. Try a PNG or JPEG.');
  }
  try {
    const fit = Math.min(1, REPORT_LIMITS.screenshotSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    for (const [quality, scale] of STEPS) {
      canvas.width = Math.max(1, Math.round(bitmap.width * fit * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * fit * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob = await toBlob(canvas, 'image/webp', quality);
      // Safari writes PNG when asked for WebP: JPEG is the smaller answer there.
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
      if (!blob) break;
      if (blob.size <= REPORT_LIMITS.screenshotBytes) {
        return {
          id: crypto.randomUUID(),
          mime: blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
          dataBase64: await base64(blob),
          width: canvas.width,
          height: canvas.height,
          bytes: blob.size,
          url: URL.createObjectURL(blob),
          source: from,
        };
      }
    }
    throw new PictureError('That picture is too large, even made smaller. Crop it and try again.');
  } finally {
    bitmap.close();
  }
}

/** The PNG the desktop took of the window, as a picture to attach. */
export async function windowShot(png: { dataBase64: string }): Promise<Shot> {
  const bytes = Uint8Array.from(atob(png.dataBase64), (c) => c.charCodeAt(0));
  return compressPicture(new Blob([bytes], { type: 'image/png' }), 'window');
}
