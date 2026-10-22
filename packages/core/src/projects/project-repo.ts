import { desc, eq, sql } from 'drizzle-orm';
import type { Project } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { projects } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { NOT_TEMPORARY_SQL } from '../sessions/temporary.ts';

type ProjectRow = typeof projects.$inferSelect;
const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  pinnedAt: r.pinnedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  async list(userId?: string): Promise<(Project & { fileCount: number; sessionCount: number })[]> {
    const rows = await this.db.select().from(projects).where(userId ? eq(projects.userId, userId) : undefined).orderBy(desc(projects.updatedAt)).all();
    const counts = (table: string, column: string, where = '1') =>
      new Map(
        (this.db.$client.prepare(`SELECT ${column} AS id, COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${where} GROUP BY ${column}`).all() as { id: string; n: number }[]).map((r) => [r.id, r.n]),
      );
    const fileCounts = counts('files', 'project_id');
    const sessionCounts = counts('sessions', 'project_id', NOT_TEMPORARY_SQL);
    return rows.map((r) => ({ ...toProject(r), fileCount: fileCounts.get(r.id) ?? 0, sessionCount: sessionCounts.get(r.id) ?? 0 }));
  }

  async get(id: string): Promise<Project | undefined> {
    const row = await this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? toProject(row) : undefined;
  }

  async ownerOf(id: string): Promise<string | null | undefined> {
    return (await this.db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, id)).get())?.userId;
  }

  async create(input: { name: string; description: string; userId?: string | null }): Promise<Project> {
    const now = Date.now();
    const id = newId();
    await this.db.insert(projects).values({ id, userId: input.userId ?? null, name: input.name, description: input.description, createdAt: now, updatedAt: now });
    return (await this.get(id))!;
  }

  /** Pinning doesn't count as an update: "Recently updated" keeps its order. */
  async update(id: string, { pinned, ...patch }: Partial<Pick<Project, 'name' | 'description' | 'instructions'>> & { pinned?: boolean }): Promise<Project> {
    const values = { ...patch, ...(pinned === undefined ? {} : { pinnedAt: pinned ? Date.now() : null }), ...(Object.keys(patch).length ? { updatedAt: Date.now() } : {}) };
    if (Object.keys(values).length) await this.db.update(projects).set(values).where(eq(projects.id, id));
    const p = await this.get(id);
    if (!p) throw new Error('Project not found');
    return p;
  }

  async touch(id: string): Promise<void> {
    await this.db.update(projects).set({ updatedAt: sql`${Date.now()}` }).where(eq(projects.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(projects).where(eq(projects.id, id));
  }
}
