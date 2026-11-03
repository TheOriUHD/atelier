/** The person's generated images, for the Images page. Temporary chats stay out of it. */
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { imageId, modelRef, videoId, parseModelRef, type GeneratedImage } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { generatedImages, sessions } from '../store/schema.ts';

export interface LibraryQuery {
  before?: number;
  query?: string;
  ref?: string;
  /** Only pictures or only clips. */
  kind?: 'image' | 'video';
  limit: number;
}

/** `%` and `_` in what someone typed are literal. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function generatedImagesFor(db: Db, userId: string, { before, query, ref, kind, limit }: LibraryQuery): { items: GeneratedImage[]; next: number | null; totalBytes: number } {
  const parsed = ref ? parseModelRef(ref) : null;
  const mine = and(eq(generatedImages.userId, userId), eq(generatedImages.hidden, false));
  const select = (at: SQL | undefined) =>
    db
      .select({ image: generatedImages, title: sessions.title, mode: sessions.mode })
      .from(generatedImages)
      .leftJoin(sessions, eq(sessions.id, generatedImages.sessionId))
      .where(
        and(
          mine,
          at,
          query ? sql`${generatedImages.prompt} LIKE ${`%${escapeLike(query)}%`} ESCAPE '\\'` : undefined,
          kind ? eq(generatedImages.kind, kind) : undefined,
          parsed ? and(eq(generatedImages.providerId, parsed.providerId), eq(generatedImages.modelId, parsed.modelId)) : undefined,
        ),
      )
      .orderBy(desc(generatedImages.createdAt));
  const rows = select(before !== undefined ? lt(generatedImages.createdAt, before) : undefined)
    .limit(limit + 1)
    .all();
  const first = rows.slice(0, limit);
  const edge = first.at(-1)?.image.createdAt;
  // The next page starts before `edge`, so the rest of a batch stored in the same millisecond has to come with this one.
  const split = rows.length > limit && rows[limit]!.image.createdAt === edge;
  const page = split ? [...first.filter((r) => r.image.createdAt !== edge), ...select(eq(generatedImages.createdAt, edge!)).all()] : first;
  const total = db.select({ bytes: sql<number>`coalesce(sum(${generatedImages.size}), 0)` }).from(generatedImages).where(mine).get();
  return {
    items: page.map(({ image: g, title, mode }) => ({
      id: g.kind === 'video' ? videoId(g.blob) : imageId(g.blob),
      ...(g.kind === 'video' ? { kind: 'video' as const, ...(g.mediaSeconds !== null ? { seconds: g.mediaSeconds } : {}), ...(g.fps !== null ? { fps: g.fps } : {}), ...(g.audio !== null ? { audio: g.audio } : {}) } : {}),
      blob: g.blob,
      mime: g.mime,
      width: g.width,
      height: g.height,
      prompt: g.prompt,
      ref: modelRef(g.providerId, g.modelId),
      modelName: g.modelName,
      sessionId: g.sessionId,
      sessionTitle: title ?? null,
      sessionMode: mode ?? null,
      createdAt: g.createdAt,
      ...(g.revisedPrompt ? { revisedPrompt: g.revisedPrompt } : {}),
      ...(g.negativePrompt ? { negativePrompt: g.negativePrompt } : {}),
      ...(g.seed !== null ? { seed: g.seed } : {}),
      ...(g.durationMs !== null ? { durationMs: g.durationMs } : {}),
      ...(g.costUsd !== null ? { costUsd: g.costUsd, costEstimated: g.costEstimated } : {}),
    })),
    next: rows.length > limit ? (edge ?? null) : null,
    totalBytes: total?.bytes ?? 0,
  };
}
