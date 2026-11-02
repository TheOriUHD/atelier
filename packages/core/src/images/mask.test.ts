import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { blackChanges, coverage, looksLikeMask, MaskError, normaliseMask, readMask, resizeMask, transparentChanges, whiteChanges } from './mask.ts';
import type { ImageInput } from './types.ts';

/** A real PNG, pixel by pixel. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.data.set(pixel(x, y), (y * width + x) * 4);
  }
  return PNG.sync.write(image);
}

const decoded = (bytes: Uint8Array) => PNG.sync.read(Buffer.from(bytes));
const at = (bytes: Uint8Array, x: number, y: number): number[] => {
  const image = decoded(bytes);
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
};
const input = (bytes: Uint8Array): ImageInput => ({ bytes, mime: 'image/png', name: 'in.png' });

/** White on the left half of a picture, as a brush across the left would leave it. */
const leftHalf = (w: number, h: number) => png(w, h, (x) => (x < w / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

describe('masks', () => {
  it('reads how much each pixel changes from its brightness, seen over black', () => {
    const pixels: [number, number, number, number][] = [[255, 255, 255, 255], [0, 0, 0, 255], [255, 255, 255, 0]];
    const mask = readMask(png(3, 1, (x) => pixels[x]!));
    expect([...mask.change]).toEqual([255, 0, 0]);
  });

  it('reads a JPEG mask, as JPEG smears its edges', () => {
    const raw = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < raw.length; i += 4) raw.set((i / 4) % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255], i);
    const jpg = jpeg.encode({ width: 16, height: 16, data: raw }, 95).data;
    const mask = readMask(jpg);
    expect(mask.change[0]).toBeGreaterThan(240);
    expect(mask.change[15]).toBeLessThan(15);
  });

  it('refuses what is not an image, or not one it can read as a mask', () => {
    expect(() => readMask(new TextEncoder().encode('SECRET=1'))).toThrow(MaskError);
    expect(() => readMask(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]))).toThrow('PNG or JPEG');
  });

  it('shrinks and grows a mask without moving its edge', () => {
    const big = readMask(leftHalf(400, 200));
    const small = resizeMask(big, 100, 50);
    expect(small.change[0]).toBe(255);
    expect(small.change[99]).toBe(0);
    expect(small.change[49]).toBe(255);
    expect(small.change[50]).toBe(0);
    const grown = resizeMask(small, 400, 200);
    expect(grown.change[199]).toBe(255);
    expect(grown.change[200]).toBe(0);
    expect(resizeMask(big, 400, 200)).toBe(big);
  });

  it('counts the share that changes', () => {
    expect(coverage(readMask(leftHalf(10, 10)))).toBe(0.5);
  });

  it('tells a mask from a photo', () => {
    expect(looksLikeMask(readMask(leftHalf(10, 10)))).toBe(true);
    expect(looksLikeMask(readMask(png(10, 10, (x, y) => [x * 25, y * 25, 120, 255])))).toBe(false);
  });

  describe("the internal convention: white changes, opaque, the reference input's size", () => {
    it('resizes to the input image and writes pure black and white, however soft the brush edge was', () => {
      // A soft edge, one column of 200 and one of 60 between the two: they count as white and black.
      const soft = png(40, 40, (x) => (x < 19 ? [255, 255, 255, 255] : x === 19 ? [200, 200, 200, 255] : x === 20 ? [60, 60, 60, 255] : [0, 0, 0, 255]));
      const reference = input(png(10, 10, () => [9, 9, 9, 255]));
      const out = normaliseMask(soft, reference);
      expect(out.mime).toBe('image/png');
      expect(decoded(out.bytes)).toMatchObject({ width: 10, height: 10 });
      expect(at(out.bytes, 0, 5)).toEqual([255, 255, 255, 255]);
      expect(at(out.bytes, 9, 5)).toEqual([0, 0, 0, 255]);
    });

    it('refuses a photo, an empty mask and a full one with a reason the model can act on', () => {
      const reference = input(png(8, 8, () => [1, 2, 3, 255]));
      expect(() => normaliseMask(png(8, 8, (x, y) => [x * 30, y * 30, 99, 255]), reference)).toThrow('is a picture, not a mask');
      expect(() => normaliseMask(png(8, 8, () => [0, 0, 0, 255]), reference)).toThrow('marks nothing');
      expect(() => normaliseMask(png(8, 8, () => [255, 255, 255, 255]), reference)).toThrow('Leave the mask out');
    });
  });

  describe("the dialects' conventions, from real PNG bytes", () => {
    // 2×1: the left pixel changes.
    const internal = whiteChanges(readMask(png(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]))));

    it('Stability, A1111, SwarmUI, ComfyUI: white changes, as it is', () => {
      expect([at(internal.bytes, 0, 0), at(internal.bytes, 1, 0)]).toEqual([[255, 255, 255, 255], [0, 0, 0, 255]]);
    });

    it('Ideogram: black changes, white stays', () => {
      const out = blackChanges(internal);
      expect([at(out.bytes, 0, 0), at(out.bytes, 1, 0)]).toEqual([[0, 0, 0, 255], [255, 255, 255, 255]]);
    });

    it('OpenAI: the area to change is fully transparent, the rest opaque, and the file still has an alpha channel', () => {
      const out = transparentChanges(internal);
      expect(decoded(out.bytes).alpha).toBe(true);
      expect([at(out.bytes, 0, 0)[3], at(out.bytes, 1, 0)[3]]).toEqual([0, 255]);
    });

    it('converts back and forth without losing the shape', () => {
      const twice = blackChanges(blackChanges(internal));
      expect(Buffer.from(twice.bytes).equals(Buffer.from(internal.bytes))).toBe(true);
    });
  });
});
