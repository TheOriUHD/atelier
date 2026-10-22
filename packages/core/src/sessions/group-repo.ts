/** The person's own sidebar groups for Code and Cowork sessions. A group's sessions are not deleted with it. */
import { and, eq } from 'drizzle-orm';
import type { SessionGroup } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { sessionGroups, sessions } from '../store/schema.ts';
import { newId } from '../util/ids.ts';

type Row = typeof sessionGroups.$inferSelect;
const toGroup = (r: Row): SessionGroup => ({ id: r.id, name: r.name, collapsed: r.collapsed, createdAt: r.createdAt });

export class GroupRepo {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<SessionGroup[]> {
    const rows = await this.db.select().from(sessionGroups).where(eq(sessionGroups.userId, userId)).orderBy(sessionGroups.createdAt, sessionGroups.id).all();
    return rows.map(toGroup);
  }

  /** The group when it is this person's. */
  async get(userId: string, id: string): Promise<SessionGroup | undefined> {
    const row = await this.db.select().from(sessionGroups).where(and(eq(sessionGroups.id, id), eq(sessionGroups.userId, userId))).get();
    return row ? toGroup(row) : undefined;
  }

  async create(userId: string, name: string): Promise<SessionGroup> {
    const row = { id: newId(), userId, name, collapsed: false, createdAt: Date.now() };
    await this.db.insert(sessionGroups).values(row);
    return toGroup(row);
  }

  async update(userId: string, id: string, patch: { name?: string; collapsed?: boolean }): Promise<SessionGroup | undefined> {
    if (patch.name !== undefined || patch.collapsed !== undefined) {
      await this.db
        .update(sessionGroups)
        .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}) })
        .where(and(eq(sessionGroups.id, id), eq(sessionGroups.userId, userId)));
    }
    return this.get(userId, id);
  }

  /** Its sessions go back to being ungrouped (also by the foreign key; explicit so the order of events is plain). */
  async delete(userId: string, id: string): Promise<boolean> {
    if (!(await this.get(userId, id))) return false;
    await this.db.update(sessions).set({ groupId: null }).where(eq(sessions.groupId, id));
    await this.db.delete(sessionGroups).where(and(eq(sessionGroups.id, id), eq(sessionGroups.userId, userId)));
    return true;
  }
}
