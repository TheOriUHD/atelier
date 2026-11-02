/**
 * Masks for "change this area" (ARCHITECTURE §23). Every service wants its own dialect of the same idea, and sending
 * one person's brush strokes as they came would be right for one of them and silently wrong for the rest:
 *
 *  - A1111/Forge, SwarmUI, ComfyUI (`LoadImageMask` red channel), Stability and Bedrock's Stability inpaint: white changes.
 *  - Ideogram: black changes ("Black marks the region to repaint", v2 inpaint/precise-edit).
 *  - OpenAI's `gpt-image` edits: an alpha channel, and fully transparent changes.
 *
 * So there is ONE internal convention, white = change, opaque, black and white only, exactly the size of the first
 * input image the adapter receives. `ImageService` builds it (`normaliseMask`), and a dialect that wants another
 * convention converts with `blackChanges` / `transparentChanges` here, never by its own pixel loop.
 *
 * Pure JavaScript (pngjs), so it runs the same on the desktop and the server.
 */
import { PNG } from 'pngjs';
import { imageSize } from '../providers/image-size.ts';
import { decode, sniffMime } from '../providers/images.ts';
import type { ImageInput } from './types.ts';

/** One value per pixel: 255 changes, 0 stays. */
export interface Mask {
  width: number;
  height: number;
  change: Uint8Array;
}

/** More pixels than this isn't decoded for a mask: an input image is at most 2048 on a side already. */
const MAX_MASK_PIXELS = 36_000_000;
/** A pixel at or above this changes. */
const HALF = 128;
/** A real mask is black and white; a photo passed by mistake has mostly in-between greys. */
const EXTREME = 40;
const MIN_EXTREME_SHARE = 0.9;

export class MaskError extends Error {}

const toPng = (width: number, height: number, fill: (data: Buffer) => void, colorType: 2 | 6): Uint8Array => {
  const png = new PNG({ width, height });
  fill(png.data);
  return PNG.sync.write(png, { colorType, inputColorType: 6, inputHasAlpha: true });
};

/**
 * Reads any image as a mask. How much a pixel changes is its brightness, seen over black: a transparent pixel
 * therefore stays, and so does black. Throws `MaskError` with what the model should hear.
 */
export function readMask(bytes: Uint8Array): Mask {
  const mime = sniffMime(bytes);
  const size = imageSize(bytes);
  if (!mime || !size) throw new MaskError("isn't an image.");
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new MaskError('must be a PNG or JPEG.');
  if (size.width * size.height > MAX_MASK_PIXELS) throw new MaskError('is too large to be a mask.');
  const raster = decode(bytes, mime);
  if (!raster) throw new MaskError("can't be read.");
  const change = new Uint8Array(raster.width * raster.height);
  for (let i = 0, p = 0; p < change.length; p++, i += 4) {
    const luma = 0.299 * raster.data[i]! + 0.587 * raster.data[i + 1]! + 0.114 * raster.data[i + 2]!;
    change[p] = Math.round((luma * raster.data[i + 3]!) / 255);
  }
  return { width: raster.width, height: raster.height, change };
}

/** `mask` at another size, each new pixel the mean of the old ones it covers. */
export function resizeMask(mask: Mask, width: number, height: number): Mask {
  if (mask.width === width && mask.height === height) return mask;
  const change = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(mask.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(mask.width, Math.floor((x + 1) * sx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += mask.change[yy * mask.width + xx]!;
      change[y * width + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { width, height, change };
}

/** The share of the picture that changes (0 to 1), counting pixels at least half white. */
export function coverage(mask: Mask): number {
  let n = 0;
  for (const v of mask.change) if (v >= HALF) n++;
  return n / mask.change.length;
}

/** Whether nearly every pixel is clearly black or clearly white, as a brushed mask is. */
export function looksLikeMask(mask: Mask): boolean {
  let extreme = 0;
  for (const v of mask.change) if (v <= EXTREME || v >= 255 - EXTREME) extreme++;
  return extreme / mask.change.length >= MIN_EXTREME_SHARE;
}

const asInput = (bytes: Uint8Array, name: string): ImageInput => ({ bytes, mime: 'image/png', name });

/** The internal convention: opaque RGB, pure white where it changes, pure black elsewhere. */
export function whiteChanges(mask: Mask, name = 'mask.png'): ImageInput {
  return asInput(
    toPng(mask.width, mask.height, (data) => {
      for (let p = 0, i = 0; p < mask.change.length; p++, i += 4) {
        const v = mask.change[p]! >= HALF ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }, 2),
    name,
  );
}

/** Reads a mask in the internal convention (what `whiteChanges` made), for a dialect to convert. */
export const readInternal = (input: ImageInput): Mask => readMask(input.bytes);

/** Ideogram's: black changes, white stays. */
export function blackChanges(input: ImageInput): ImageInput {
  const mask = readInternal(input);
  return asInput(
    toPng(mask.width, mask.height, (data) => {
      for (let p = 0, i = 0; p < mask.change.length; p++, i += 4) {
        const v = mask.change[p]! >= HALF ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }, 2),
    input.name,
  );
}

/** OpenAI's: RGBA, fully transparent where it changes, opaque (black) where it stays. */
export function transparentChanges(input: ImageInput): ImageInput {
  const mask = readInternal(input);
  return asInput(
    toPng(mask.width, mask.height, (data) => {
      for (let p = 0, i = 0; p < mask.change.length; p++, i += 4) {
        data[i] = data[i + 1] = data[i + 2] = 0;
        data[i + 3] = mask.change[p]! >= HALF ? 0 : 255;
      }
    }, 6),
    input.name,
  );
}

/**
 * The mask a model passed, made ready for an adapter: in the internal convention and the size of `reference`, the
 * input image as the adapter receives it. Throws `MaskError` when it can't be a mask, or marks nothing, or everything.
 */
export function normaliseMask(raw: Uint8Array, reference: ImageInput): ImageInput {
  const size = imageSize(reference.bytes);
  if (!size) throw new MaskError("the image it belongs to can't be measured.");
  const read = readMask(raw);
  if (!looksLikeMask(read)) throw new MaskError('is a picture, not a mask: a mask is only black and white.');
  const mask = resizeMask(read, size.width, size.height);
  const share = coverage(mask);
  if (share === 0) throw new MaskError('marks nothing to change.');
  if (share === 1) throw new MaskError('marks the whole image. Leave the mask out to change all of it.');
  return whiteChanges(mask);
}
