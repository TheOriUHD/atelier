import { describe, expect, it } from 'vitest';
import { blobResponse, INLINE_BLOB_TYPES, parseByteRange, RANGE_CHUNK_BYTES, type BlobSource } from './blob-http.ts';

const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251));
const source = (data: Uint8Array<ArrayBuffer>, mime = 'video/mp4'): BlobSource => ({ mime, size: data.byteLength, whole: () => data, slice: (start, end) => data.slice(start, end + 1) });
const body = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('parseByteRange', () => {
  it('resolves a closed, an open and a suffix range against the size', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=10-5000', 1000)).toEqual({ start: 10, end: 999 });
  });

  it('never gives more than one chunk, so an open range of a huge file is a piece of it', () => {
    expect(parseByteRange('bytes=0-', 500 * 1024 * 1024)).toEqual({ start: 0, end: RANGE_CHUNK_BYTES - 1 });
  });

  it('calls a start past the end unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=50-10', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('ignores what it does not understand, which sends the whole file', () => {
    for (const header of [null, undefined, '', 'bytes=', 'bytes=-', 'items=0-5', 'bytes=0-5,10-20', 'bytes=a-b', ' bytes=1-2 x']) expect(parseByteRange(header, 1000)).toBeNull();
  });
});

describe('blobResponse', () => {
  const clip = bytes(1000);

  it('sends a video inline with the safe headers and says it takes ranges', async () => {
    const res = await blobResponse(source(clip), null, { 'Cache-Control': 'private, max-age=31536000, immutable' });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'video/mp4',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-length': '1000',
      'cache-control': 'private, max-age=31536000, immutable',
    });
    expect(await body(res)).toEqual(clip);
  });

  it('answers a range with 206, its place in the file and exactly those bytes', async () => {
    const res = await blobResponse(source(clip), 'bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(await body(res)).toEqual(clip.slice(100, 200));
  });

  it('answers the first request of a player, bytes=0-, with the start and the size to seek by', async () => {
    const res = await blobResponse(source(clip), 'bytes=0-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-999/1000');
  });

  it('answers a range past the end with 416 and the size', async () => {
    const res = await blobResponse(source(clip), 'bytes=2000-3000');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('keeps nosniff and the sandbox on a range too', async () => {
    const res = await blobResponse(source(clip), 'bytes=0-9');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves anything that is not a picture or a clip as a download, whatever its type says', async () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/javascript', 'video/x-matroska', 'video/ogg']) {
      const res = await blobResponse(source(clip, mime), null);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe('attachment');
    }
  });

  it('serves an empty file whole', async () => {
    const res = await blobResponse(source(new Uint8Array(0)), 'bytes=0-');
    expect(res.status).toBe(416);
    expect((await blobResponse(source(new Uint8Array(0)), null)).status).toBe(200);
  });
});

describe('INLINE_BLOB_TYPES', () => {
  it('lists the pictures and the two video containers, and nothing else', () => {
    for (const ok of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm']) expect(INLINE_BLOB_TYPES.test(ok)).toBe(true);
    for (const bad of ['image/svg+xml', 'video/quicktime', 'video/mp4; codecs=avc1', 'video/', 'text/html', 'audio/mp4']) expect(INLINE_BLOB_TYPES.test(bad)).toBe(false);
  });
});
