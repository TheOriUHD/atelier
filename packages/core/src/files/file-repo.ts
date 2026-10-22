import { and, eq } from 'drizzle-orm';
import type { FileRef } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { files } from '../store/schema.ts';
import type { BlobStore } from '../store/blobs.ts';
import { newId } from '../util/ids.ts';
import { canExtractText, estimateTokens, extractText } from './text-extract.ts';

type FileRow = typeof files.$inferSelect;

export function toFileRef(r: FileRow): FileRef {
  return { id: r.id, name: r.name, mime: r.mime, size: r.size, blob: r.blob, kind: r.kind, tokens: r.tokens, createdAt: r.createdAt };
}

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export class FileRepo {
  constructor(
    private readonly db: Db,
    private readonly blobs: BlobStore,
  ) {}

  async upload(input: { name: string; mime: string; bytes: Uint8Array; kind: FileRef['kind']; userId?: string | null; sessionId?: string | null; projectId?: string | null }): Promise<FileRef> {
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('File is larger than 32 MB');
    const blob = await this.blobs.put(input.bytes, input.mime);
    let tokens: number | null = null;
    if (canExtractText(input.mime)) {
      try {
        tokens = estimateTokens((await extractText(input.bytes, input.mime)).text);
      } catch {
        tokens = null;
      }
    }
    const row: typeof files.$inferInsert = {
      id: newId(),
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      blob: blob.sha256,
      name: input.name.slice(0, 255),
      mime: input.mime,
      size: input.bytes.byteLength,
      tokens,
      kind: input.kind,
      createdAt: Date.now(),
    };
    await this.db.insert(files).values(row);
    return toFileRef((await this.get(row.id!))!);
  }

  async get(id: string): Promise<FileRow | undefined> {
    return this.db.select().from(files).where(eq(files.id, id)).get();
  }

  async forProject(projectId: string): Promise<FileRef[]> {
    const rows = await this.db.select().from(files).where(eq(files.projectId, projectId)).orderBy(files.createdAt).all();
    return rows.map(toFileRef);
  }

  /** Copies an uploaded file into a project's knowledge (same blob, new row). */
  async attachToProject(fileId: string, projectId: string): Promise<FileRef> {
    const src = await this.get(fileId);
    if (!src) throw new Error('File not found');
    const row = { ...src, id: newId(), projectId, sessionId: null, kind: 'project' as const, createdAt: Date.now() };
    await this.db.insert(files).values(row);
    return toFileRef(row);
  }

  async removeFromProject(projectId: string, fileId: string): Promise<void> {
    await this.db.delete(files).where(and(eq(files.id, fileId), eq(files.projectId, projectId)));
  }

  async text(fileRow: Pick<FileRow, 'blob' | 'mime'>, maxChars?: number): Promise<{ text: string; truncated: boolean }> {
    return extractText(await this.blobs.read(fileRow.blob), fileRow.mime, maxChars);
  }
}
