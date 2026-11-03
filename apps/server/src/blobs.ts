/**
 * `/api/blobs/<hash>`: attachments, generated pictures and videos, avatars. Signed-in people only. Pictures and MP4/WebM videos
 * render inline, everything else downloads, and a video is served in ranges so it plays and seeks (protocol `blobResponse`,
 * which the desktop app's blob protocol uses too).
 */
import type { Context, Hono } from 'hono';
import { blobResponse, type BlobSource } from '@atelier/protocol';

export function blobRoutes(app: Hono, { userOf, blobSource }: { userOf(c: Context): Promise<string | null>; blobSource(userId: string, sha256: string): Promise<BlobSource | undefined> }): void {
  app.get('/api/blobs/:sha', async (c) => {
    const userId = await userOf(c);
    if (!userId) return c.json({ code: 'unauthenticated' }, 401);
    // Someone else's blob reads like one that doesn't exist: the hash is not a credential.
    const source = await blobSource(userId, c.req.param('sha'));
    if (!source) return c.notFound();
    return blobResponse(source, c.req.header('range'), { 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
}
