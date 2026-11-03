/** Content-addressed blob store: files live at <dir>/<aa>/<bb>/<sha256>, metadata in the `blobs` table. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { blobs } from './schema.ts';

export interface BlobInfo {
  sha256: string;
  size: number;
  mime: string;
}

/**
 * Moves a written temp file to its content-addressed name. Windows refuses a rename onto a file that another
 * writer of the same content is placing at that moment (EPERM, EACCES or EBUSY): the name is its content, so
 * once the file is there it is the blob and this copy is dropped.
 */
async function place(tmp: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const raced = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST';
      const there = raced && (await stat(path).then(() => true, () => false));
      if (there || !raced || attempt >= 8) {
        await rm(tmp, { force: true });
        if (there) return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

export class BlobStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  private pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid blob id');
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(bytes: Uint8Array, mime: string): Promise<BlobInfo> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = this.pathFor(sha256);
    const existing = await this.db.select().from(blobs).where(eq(blobs.sha256, sha256)).get();
    if (!existing) {
      await mkdir(join(path, '..'), { recursive: true });
      // A name of its own: parallel writes of the same content (sub-agents' identical prompts) must not share one.
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await place(tmp, path);
      await this.db.insert(blobs).values({ sha256, size: bytes.byteLength, mime, createdAt: Date.now() }).onConflictDoNothing();
    }
    return { sha256, size: bytes.byteLength, mime: existing?.mime ?? mime };
  }

  /**
   * Stores what `source` yields without holding it in memory (the export of a person's data): written to a temporary file
   * while it is hashed, then named by its hash like any blob.
   */
  async putStream(source: AsyncIterable<Uint8Array>, mime: string): Promise<BlobInfo> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        async function* () {
          for await (const chunk of source) {
            hash.update(chunk);
            size += chunk.byteLength;
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
      const sha256 = hash.digest('hex');
      const path = this.pathFor(sha256);
      const existing = await this.db.select().from(blobs).where(eq(blobs.sha256, sha256)).get();
      if (existing) {
        await rm(tmp, { force: true });
        return { sha256, size, mime: existing.mime };
      }
      await mkdir(join(path, '..'), { recursive: true });
      await place(tmp, path);
      await this.db.insert(blobs).values({ sha256, size, mime, createdAt: Date.now() }).onConflictDoNothing();
      return { sha256, size, mime };
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /** The blob's bytes in chunks, for copying it somewhere without reading it whole. */
  stream(sha256: string): AsyncIterable<Uint8Array> {
    return createReadStream(this.pathFor(sha256));
  }

  async putText(text: string, mime = 'text/plain'): Promise<BlobInfo> {
    return this.put(new TextEncoder().encode(text), mime);
  }

  async read(sha256: string): Promise<Uint8Array<ArrayBuffer>> {
    return readFile(this.pathFor(sha256));
  }

  /** Bytes `start` to `end` (inclusive) of a file, read from disk without reading the rest: a video is served in pieces. */
  async readRange(sha256: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    const file = await open(this.pathFor(sha256), 'r');
    try {
      const length = Math.max(0, end - start + 1);
      const out = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(out, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === length ? out : out.slice(0, read);
    } finally {
      await file.close();
    }
  }

  /** The whole file as a stream, so a large download never sits in memory. */
  stream(sha256: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(this.pathFor(sha256))) as unknown as ReadableStream<Uint8Array>;
  }

  async readText(sha256: string): Promise<string> {
    return new TextDecoder().decode(await this.read(sha256));
  }

  async info(sha256: string): Promise<BlobInfo | undefined> {
    const row = await this.db.select().from(blobs).where(eq(blobs.sha256, sha256)).get();
    return row ? { sha256: row.sha256, size: row.size, mime: row.mime } : undefined;
  }

  /** Deletes blobs not referenced by `keep` (computed by the caller from all referencing tables). */
  async collectGarbage(keep: ReadonlySet<string>): Promise<number> {
    const all = await this.db.select({ sha256: blobs.sha256 }).from(blobs).all();
    let removed = 0;
    for (const { sha256 } of all) {
      if (keep.has(sha256)) continue;
      await rm(this.pathFor(sha256), { force: true });
      await this.db.delete(blobs).where(eq(blobs.sha256, sha256));
      removed++;
    }
    return removed;
  }

  /** Total bytes on disk, for Settings › System. */
  async diskUsage(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else total += (await stat(p)).size;
      }
    };
    await walk(this.dir);
    return total;
  }
}
