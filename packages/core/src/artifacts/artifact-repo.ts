import { and, desc, eq, lt, max, or, sql } from 'drizzle-orm';
import type { ArtifactListItem, ArtifactSummary, ArtifactType, ArtifactVersion } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { artifacts, artifactVersions, sessions } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { notTemporary } from '../sessions/temporary.ts';

type ArtifactRow = typeof artifacts.$inferSelect;

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  private async summarize(row: ArtifactRow): Promise<ArtifactSummary> {
    const latest = await this.db
      .select({ v: max(artifactVersions.version) })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, row.id))
      .get();
    const v = latest?.v ?? 1;
    return { id: row.id, sessionId: row.sessionId, identifier: row.identifier, type: row.type, title: row.title, language: row.language, version: v, versions: v, updatedAt: row.updatedAt };
  }

  async findByIdentifier(sessionId: string, identifier: string): Promise<ArtifactRow | undefined> {
    return this.db.select().from(artifacts).where(and(eq(artifacts.sessionId, sessionId), eq(artifacts.identifier, identifier))).get();
  }

  async create(input: { sessionId: string; identifier: string; type: ArtifactType; title: string; language: string | null; content: string; messageId: string | null }): Promise<ArtifactSummary> {
    const now = Date.now();
    const id = newId();
    await this.db.insert(artifacts).values({ id, sessionId: input.sessionId, identifier: input.identifier, type: input.type, title: input.title, language: input.language, createdAt: now, updatedAt: now });
    await this.db.insert(artifactVersions).values({ artifactId: id, version: 1, content: input.content, messageId: input.messageId, createdAt: now });
    return this.summarize((await this.db.select().from(artifacts).where(eq(artifacts.id, id)).get())!);
  }

  async addVersion(row: ArtifactRow, content: string, messageId: string | null, patch: { title?: string; type?: ArtifactType; language?: string | null } = {}): Promise<ArtifactSummary> {
    const now = Date.now();
    const current = await this.latest(row.id);
    await this.db.insert(artifactVersions).values({ artifactId: row.id, version: current.version + 1, content, messageId, createdAt: now });
    await this.db.update(artifacts).set({ ...patch, updatedAt: now }).where(eq(artifacts.id, row.id));
    return this.summarize((await this.db.select().from(artifacts).where(eq(artifacts.id, row.id)).get())!);
  }

  async latest(artifactId: string): Promise<ArtifactVersion> {
    const row = await this.db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifactId)).orderBy(desc(artifactVersions.version)).get();
    if (!row) throw new Error('Artifact has no versions');
    return row;
  }

  async list(sessionId: string): Promise<ArtifactSummary[]> {
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId)).orderBy(artifacts.createdAt).all();
    return Promise.all(rows.map((r) => this.summarize(r)));
  }

  /**
   * A person's artifacts across their sessions, most recently updated first, a page at a time. The cursor is the
   * last item's `updatedAt:id`, so new or updated artifacts don't shift the pages already read.
   */
  async listForUser(userId: string, page: { limit: number; cursor?: string; type?: ArtifactType }): Promise<{ items: ArtifactListItem[]; nextCursor: string | null }> {
    const conditions = [eq(sessions.userId, userId), notTemporary()];
    if (page.type) conditions.push(eq(artifacts.type, page.type));
    if (page.cursor) {
      const at = page.cursor.indexOf(':');
      const updatedAt = Number(page.cursor.slice(0, at));
      const id = page.cursor.slice(at + 1);
      conditions.push(or(lt(artifacts.updatedAt, updatedAt), and(eq(artifacts.updatedAt, updatedAt), lt(artifacts.id, id)))!);
    }
    const rows = await this.db
      .select({
        artifact: artifacts,
        sessionTitle: sessions.title,
        versions: sql<number | null>`(SELECT MAX(v.version) FROM artifact_versions v WHERE v.artifact_id = "artifacts"."id")`,
      })
      .from(artifacts)
      .innerJoin(sessions, eq(sessions.id, artifacts.sessionId))
      .where(and(...conditions))
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(page.limit + 1)
      .all();
    const items = rows.slice(0, page.limit).map(({ artifact: r, sessionTitle, versions }) => ({
      id: r.id,
      sessionId: r.sessionId,
      identifier: r.identifier,
      type: r.type,
      title: r.title,
      language: r.language,
      version: versions ?? 1,
      versions: versions ?? 1,
      updatedAt: r.updatedAt,
      sessionTitle,
    }));
    const last = items.at(-1);
    return { items, nextCursor: rows.length > page.limit && last ? `${last.updatedAt}:${last.id}` : null };
  }

  async get(id: string, version?: number): Promise<{ summary: ArtifactSummary; content: ArtifactVersion } | undefined> {
    const row = await this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    if (!row) return undefined;
    const content = version
      ? await this.db.select().from(artifactVersions).where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, version))).get()
      : await this.latest(id);
    if (!content) return undefined;
    return { summary: { ...(await this.summarize(row)), version: content.version }, content };
  }
}
