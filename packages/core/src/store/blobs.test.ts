import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from './blobs.ts';
import { openDatabase, type Db } from './db.ts';

let dir: string;
let db: Db;
let blobs: BlobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-blobs-'));
  db = openDatabase(join(dir, 'atelier.db'));
  blobs = new BlobStore(db, join(dir, 'blobs'));
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const data = new Uint8Array(300_000).map((_, i) => (i * 7) % 253);

describe('BlobStore ranges', () => {
  it('reads a slice from the middle without the rest', async () => {
    const { sha256 } = await blobs.put(data, 'video/mp4');
    expect(await blobs.readRange(sha256, 150_000, 150_099)).toEqual(data.slice(150_000, 150_100));
  });

  it('reads the first and the last byte, and a range that ends past the file as far as it goes', async () => {
    const { sha256 } = await blobs.put(data, 'video/mp4');
    expect(await blobs.readRange(sha256, 0, 0)).toEqual(data.slice(0, 1));
    expect(await blobs.readRange(sha256, data.length - 1, data.length - 1)).toEqual(data.slice(-1));
    expect(await blobs.readRange(sha256, data.length - 10, data.length + 100)).toEqual(data.slice(-10));
  });

  it('streams the whole file', async () => {
    const { sha256 } = await blobs.put(data, 'video/mp4');
    const body = new Uint8Array(await new Response(blobs.stream(sha256)).arrayBuffer());
    expect(body).toEqual(data);
  });

  it('refuses a name that is not a hash, so a path can never be read', async () => {
    await expect(blobs.readRange('../../etc/passwd', 0, 10)).rejects.toThrow('Invalid blob id');
    expect(() => blobs.stream('../../etc/passwd')).toThrow('Invalid blob id');
  });
});
