/** The person's generated images, for the Images page. Temporary chats stay out of it. */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { imageId, modelRef, parseModelRef, type GeneratedImage } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { generatedImages, sessions } from '../store/schema.ts';

export interface LibraryQuery {
  before?: number;
  query?: string;
  ref?: string;
  limit: number;
}

/** `%` and `_` in what someone typed are literal. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function generatedImagesFor(db: Db, userId: string, { before, query, ref, limit }: LibraryQuery): { items: GeneratedImage[]; next: number | null; totalBytes: number } {
  const parsed = ref ? parseModelRef(ref) : null;
  const mine = and(eq(generatedImages.userId, userId), eq(generatedImages.hidden, false));
  const rows = db
    .select({ image: generatedImages, title: sessions.title })
    .from(generatedImages)
    .leftJoin(sessions, eq(sessions.id, generatedImages.sessionId))
    .where(
      and(
        mine,
        before !== undefined ? lt(generatedImages.createdAt, before) : undefined,
        query ? sql`${generatedImages.prompt} LIKE ${`%${escapeLike(query)}%`} ESCAPE '\\'` : undefined,
        parsed ? and(eq(generatedImages.providerId, parsed.providerId), eq(generatedImages.modelId, parsed.modelId)) : undefined,
      ),
    )
    .orderBy(desc(generatedImages.createdAt))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const total = db.select({ bytes: sql<number>`coalesce(sum(${generatedImages.size}), 0)` }).from(generatedImages).where(mine).get();
  return {
    items: page.map(({ image: g, title }) => ({
      id: imageId(g.blob),
      blob: g.blob,
      mime: g.mime,
      width: g.width,
      height: g.height,
      prompt: g.prompt,
      ref: modelRef(g.providerId, g.modelId),
      modelName: g.modelName,
      sessionId: g.sessionId,
      sessionTitle: title ?? null,
      createdAt: g.createdAt,
      ...(g.revisedPrompt ? { revisedPrompt: g.revisedPrompt } : {}),
      ...(g.negativePrompt ? { negativePrompt: g.negativePrompt } : {}),
      ...(g.seed !== null ? { seed: g.seed } : {}),
      ...(g.durationMs !== null ? { durationMs: g.durationMs } : {}),
      ...(g.costUsd !== null ? { costUsd: g.costUsd, costEstimated: g.costEstimated } : {}),
    })),
    next: rows.length > limit ? (page.at(-1)?.image.createdAt ?? null) : null,
    totalBytes: total?.bytes ?? 0,
  };
}
