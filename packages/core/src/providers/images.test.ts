import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { BlobOverlay, fitImage, IMAGE_POLICIES, sniffMime } from './images.ts';
import { imageSize } from './image-size.ts';

const png = (width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array => {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      image.data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return PNG.sync.write(image);
};
const gradient = (x: number, y: number): [number, number, number, number] => [x % 256, y % 256, (x + y) % 256, 255];
const noise = (): [number, number, number, number] => [Math.random() * 256, Math.random() * 256, Math.random() * 256, 255];
const jpegOf = (width: number, height: number): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([i % 251, (i >> 3) % 241, 90, 255], i);
  return jpeg.encode({ width, height, data }, 90).data;
};

describe('IMAGE_POLICIES', () => {
  it('let every provider take at least one image of a sensible size', () => {
    for (const [type, policy] of Object.entries(IMAGE_POLICIES)) {
      expect(policy.maxBytes, `${type} maxBytes`).toBeGreaterThan(0);
      expect(policy.maxCount === null || policy.maxCount > 0, `${type} maxCount`).toBe(true);
      expect(policy.totalBytes === null || policy.totalBytes >= policy.maxBytes, `${type} totalBytes`).toBe(true);
    }
  });
});

describe('sniffMime', () => {
  it('reads the type from the bytes', () => {
    expect(sniffMime(png(2, 2, gradient))).toBe('image/png');
    expect(sniffMime(jpegOf(8, 8))).toBe('image/jpeg');
    expect(sniffMime(Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)), (x) => x))).toBe('image/gif');
    expect(sniffMime(Uint8Array.from([...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0))))).toBe('image/webp');
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('fitImage', () => {
  it('returns what already fits untouched', () => {
    const bytes = png(40, 30, gradient);
    const result = fitImage(bytes, 'image/png', 100, 1_000_000);
    expect(result).toMatchObject({ ok: true, image: { changed: false, width: 40, height: 30 } });
    expect(result.ok && result.image.bytes).toBe(bytes);
  });

  it('reduces a PNG to the side limit and keeps it a PNG', () => {
    const result = fitImage(png(300, 200, gradient), 'image/png', 100, 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image).toMatchObject({ mime: 'image/png', changed: true, width: 100, height: 67 });
    expect(imageSize(result.image.bytes)).toEqual({ width: 100, height: 67 });
  });

  it('averages the pixels it merges, and keeps transparency', () => {
    // Left half red, right half transparent: reduced 2x each half keeps its colour and alpha.
    const bytes = png(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const result = fitImage(bytes, 'image/png', 4, 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = PNG.sync.read(Buffer.from(result.image.bytes));
    expect([out.width, out.height]).toEqual([4, 2]);
    expect([...out.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(out.data[(0 * 4 + 3) * 4 + 3]).toBe(0);
  });

  it('reduces a JPEG and keeps it a JPEG', () => {
    const result = fitImage(jpegOf(400, 300), 'image/jpeg', 100, 1_000_000);
    expect(result).toMatchObject({ ok: true, image: { mime: 'image/jpeg', width: 100, height: 75, changed: true } });
  });

  it('turns a PNG that is too many bytes into a JPEG that fits', () => {
    const photo = png(220, 220, noise);
    expect(photo.length).toBeGreaterThan(60_000);
    const result = fitImage(photo, 'image/png', null, 30_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mime).toBe('image/jpeg');
    expect(result.image.bytes.length).toBeLessThanOrEqual(30_000);
    expect(result.image.changed).toBe(true);
  });

  it('takes the type from the bytes when the name is wrong', () => {
    const result = fitImage(jpegOf(20, 20), 'image/png', 100, 1_000_000);
    expect(result).toMatchObject({ ok: true, image: { mime: 'image/jpeg', changed: false } });
  });

  it('says why an image it cannot reduce is left out', () => {
    const webp = Uint8Array.from([...'RIFF\0\0\0\0WEBPVP8X\0\0\0\0'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0, 0x0f, 0x27, 0, 0x0f, 0x27, 0, 0, 0, 0, 0, 0, 0]));
    expect(imageSize(webp)).toMatchObject({ width: 10000 });
    const result = fitImage(webp, 'image/webp', 8000, 5_000_000);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('only PNG and JPEG') });
  });
});

describe('BlobOverlay', () => {
  it('reads its own bytes by name, and everything else from the store', async () => {
    const overlay = new BlobOverlay(async (sha) => new Uint8Array([sha.length]));
    const name = overlay.add(new Uint8Array([9, 9, 9]));
    expect(name).toMatch(/^fit:[0-9a-f]{64}$/);
    expect(await overlay.read(name)).toEqual(new Uint8Array([9, 9, 9]));
    expect(await overlay.read('abc')).toEqual(new Uint8Array([3]));
    expect(overlay.add(new Uint8Array([9, 9, 9]))).toBe(name);
  });

  it('lets the oldest go past its cap', async () => {
    const overlay = new BlobOverlay(async () => new Uint8Array([0]), 10);
    const a = overlay.add(new Uint8Array(6).fill(1));
    const b = overlay.add(new Uint8Array(6).fill(2));
    expect(await overlay.read(b)).toEqual(new Uint8Array(6).fill(2));
    expect(await overlay.read(a)).toEqual(new Uint8Array([0]));
  });
});
