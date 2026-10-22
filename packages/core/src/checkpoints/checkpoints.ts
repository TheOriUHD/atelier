/**
 * Checkpoints and Rewind (ARCHITECTURE §8). Before a turn first writes a file, its content is kept as a blob;
 * rewinding to one of the person's messages restores every file the turns since then changed. Changes made
 * by Bash are not tracked.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { SessionRepo } from '../sessions/session-repo.ts';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { checkpoints } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import type { Workspace } from '../workspaces/workspace.ts';

/** Files above the runner's read cap aren't checkpointed (Rewind leaves them alone). */
const MAX_BYTES = 16 * 1024 * 1024;

export class Checkpoints {
  constructor(private readonly deps: { db: Db; blobs: BlobStore; repo: SessionRepo }) {}

  /** Keeps `path`'s current content unless this turn already did. Sub-agent sessions count toward their root. */
  async capture(ws: Workspace, sessionId: string, path: string): Promise<void> {
    const root = await this.root(sessionId);
    const turn = await this.deps.repo.currentTurn(root);
    if (!turn) return;
    const key = and(eq(checkpoints.sessionId, root), eq(checkpoints.messageId, turn), eq(checkpoints.path, path));
    if (await this.deps.db.select({ id: checkpoints.id }).from(checkpoints).where(key).get()) return;

    const stat = await ws.runner.call('fs.stat', { path }).catch(() => null);
    let beforeBlob: string | null = null;
    if (stat) {
      if (stat.type !== 'file' || stat.size > MAX_BYTES) return;
      const file = await ws.runner.call('fs.read', { path, encoding: 'base64' });
      beforeBlob = (await this.deps.blobs.put(Buffer.from(file.content, 'base64'), 'application/octet-stream')).sha256;
    }
    await this.deps.db
      .insert(checkpoints)
      .values({ id: newId(), sessionId: root, messageId: turn, path, beforeBlob, createdAt: Date.now() })
      .onConflictDoNothing();
  }

  /**
   * Restores the files changed from `messageId` (one of the person's messages on the active branch) onward to
   * how they were before it, and returns their paths.
   */
  async rewind(ws: Workspace, sessionId: string, messageId: string): Promise<string[]> {
    const { messages } = await this.deps.repo.branch(sessionId);
    const from = messages.findIndex((m) => m.id === messageId);
    if (from < 0) throw new Error('That message is not in this conversation.');
    const turns = messages.slice(from).filter((m) => m.role === 'user' && m.kind === 'normal').map((m) => m.id);
    const rows = await this.deps.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.sessionId, sessionId), inArray(checkpoints.messageId, turns)))
      .orderBy(desc(checkpoints.createdAt))
      .all();
    // Newest first, so a file changed in several turns ends up as it was before the earliest.
    for (const row of rows) {
      if (row.beforeBlob) {
        const content = Buffer.from(await this.deps.blobs.read(row.beforeBlob)).toString('base64');
        await ws.runner.call('fs.write', { path: row.path, content, encoding: 'base64', mkdirp: true });
      } else {
        await ws.runner.call('fs.remove', { path: row.path }).catch(() => undefined);
      }
    }
    return [...new Set(rows.map((r) => r.path))];
  }

  /** Turns of a conversation that changed files, oldest first. */
  async list(sessionId: string): Promise<{ messageId: string; paths: string[] }[]> {
    const rows = await this.deps.db.select().from(checkpoints).where(eq(checkpoints.sessionId, sessionId)).orderBy(checkpoints.createdAt).all();
    const turns = new Map<string, string[]>();
    for (const r of rows) turns.set(r.messageId, [...(turns.get(r.messageId) ?? []), r.path]);
    return [...turns].map(([messageId, paths]) => ({ messageId, paths }));
  }

  /**
   * Every file the conversation's turns changed, in the order they were first changed, with how it was before that
   * (null: it didn't exist): the Diff pane's "this session" compare.
   */
  async firstVersions(sessionId: string): Promise<{ path: string; before(): Promise<string | null> }[]> {
    // Insertion order breaks ties between checkpoints of the same millisecond.
    const rows = await this.deps.db.select().from(checkpoints).where(eq(checkpoints.sessionId, sessionId)).orderBy(checkpoints.createdAt, sql`rowid`).all();
    const first = new Map<string, string | null>();
    for (const r of rows) if (!first.has(r.path)) first.set(r.path, r.beforeBlob);
    return [...first].map(([path, blob]) => ({
      path,
      before: async () => (blob ? Buffer.from(await this.deps.blobs.read(blob)).toString('utf8') : null),
    }));
  }

  /** Drops checkpoints older than the retention period. */
  async prune(retentionDays: number): Promise<void> {
    await this.deps.db.delete(checkpoints).where(lt(checkpoints.createdAt, Date.now() - retentionDays * 86_400_000));
  }

  private async root(sessionId: string): Promise<string> {
    let row = await this.deps.repo.getRow(sessionId);
    while (row?.parentSessionId) row = await this.deps.repo.getRow(row.parentSessionId);
    return row?.id ?? sessionId;
  }
}
