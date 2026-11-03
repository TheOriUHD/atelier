import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlobSource } from '@atelier/protocol';
import { blobRoutes } from './blobs.ts';

// Files on disk, read in slices the way the blob store reads them in production (its own range reads are tested in core).
let dir: string;
let app: Hono;
let signedIn = true;
let clip: Uint8Array;
const sha = 'a'.repeat(64);
const html = 'b'.repeat(64);

const fileSource = (path: string, mime: string): BlobSource => ({
  mime,
  size: statSync(path).size,
  whole: () => Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>,
  slice: async (start, end) => {
    const file = await open(path, 'r');
    try {
      const out = new Uint8Array(end - start + 1);
      await file.read(out, 0, out.length, start);
      return out;
    } finally {
      await file.close();
    }
  },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-blobs-'));
  clip = new Uint8Array(100_000).map((_, i) => i % 251);
  await writeFile(join(dir, sha), clip);
  await writeFile(join(dir, html), '<script>alert(1)</script>');
  signedIn = true;
  app = new Hono();
  blobRoutes(app, {
    userOf: async () => (signedIn ? 'u1' : null),
    blobSource: async (_user, hash) => {
      const mime = hash === sha ? 'video/mp4' : hash === html ? 'text/html' : undefined;
      return mime ? fileSource(join(dir, hash), mime) : undefined;
    },
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const get = (hash: string, range?: string) => app.request(`/api/blobs/${hash}`, range ? { headers: { range } } : {});
const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('/api/blobs', () => {
  it('needs a sign-in', async () => {
    signedIn = false;
    expect((await get(sha)).status).toBe(401);
  });

  it('serves a stored video whole, inline, with the safe headers', async () => {
    const res = await get(sha);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'video/mp4',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-length': '100000',
      'cache-control': 'private, max-age=31536000, immutable',
    });
    expect(await bytes(res)).toEqual(clip);
  });

  it('answers the range a player asks for, from the middle of the file, so seeking works', async () => {
    const res = await get(sha, 'bytes=50000-50099');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 50000-50099/100000');
    expect(await bytes(res)).toEqual(clip.slice(50000, 50100));
  });

  it('answers bytes=0- and the last bytes of the file, which players use to find the index of an MP4', async () => {
    const start = await get(sha, 'bytes=0-');
    expect(start.status).toBe(206);
    expect(start.headers.get('content-range')).toBe('bytes 0-99999/100000');
    const tail = await get(sha, 'bytes=-1000');
    expect(tail.headers.get('content-range')).toBe('bytes 99000-99999/100000');
    expect(await bytes(tail)).toEqual(clip.slice(99000));
  });

  it('refuses a range past the end', async () => {
    const res = await get(sha, 'bytes=200000-');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100000');
  });

  it('keeps anything but a picture or a video a download, so a stored page never renders', async () => {
    const res = await get(html);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('is not found for a file that is not there, or a name that is not a hash', async () => {
    expect((await get('0'.repeat(64))).status).toBe(404);
    expect((await get('..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });
});
