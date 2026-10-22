import { describe, expect, it } from 'vitest';
import { imageSize } from './image-size.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

describe('imageSize', () => {
  it('reads a PNG', () => {
    const png = Uint8Array.from([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), ...be32(1440), ...be32(9000), 8, 6, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 1440, height: 9000 });
  });

  it('reads a GIF', () => {
    expect(imageSize(Uint8Array.from([...ascii('GIF89a'), ...le16(320), ...le16(200), 0, 0, 0]))).toEqual({ width: 320, height: 200 });
  });

  it('reads a JPEG past its other segments', () => {
    const app0 = [0xff, 0xe0, 0, 4, 0x4a, 0x46];
    const sof = [0xff, 0xc0, 0, 17, 8, 0x1f, 0x40, 0x03, 0xe8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(imageSize(Uint8Array.from([0xff, 0xd8, ...app0, ...sof]))).toEqual({ width: 1000, height: 8000 });
  });

  it('reads the three kinds of WebP', () => {
    const riff = (chunk: string, body: number[]) => Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0, ...body]);
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480), 0, 0]))).toEqual({ width: 640, height: 480 });
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, ...le24(1999), ...le24(8999), 0, 0, 0]))).toEqual({ width: 2000, height: 9000 });
    // VP8L packs both sizes, minus one, into 14 bits each after a signature byte.
    const w = 799;
    const h = 599;
    const packed = (w & 0x3fff) | ((h & 0x3fff) << 14);
    const lossless = riff('VP8L', [0x2f, packed & 255, (packed >> 8) & 255, (packed >> 16) & 255, (packed >> 24) & 255, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(lossless)).toEqual({ width: 800, height: 600 });
  });

  it('is null for something else', () => {
    expect(imageSize(Uint8Array.from(ascii('not an image at all, just text')))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });
});
