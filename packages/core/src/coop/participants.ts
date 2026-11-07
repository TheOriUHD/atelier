/**
 * Who takes part in a co-op session besides its host (ARCHITECTURE §24), as the `session_participants` table keeps
 * them. The host is the session's own person (`sessions.user_id`) and has no row here. A participant who left keeps
 * their row with `left_at`, so their messages still name them.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { ModelsChoice, ParticipantRole } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { sessionParticipants } from '../store/schema.ts';

export type ParticipantRow = typeof sessionParticipants.$inferSelect;

export interface NewParticipant {
  sessionId: string;
  id: string;
  kind: 'account' | 'peer';
  userId?: string | null;
  peerKey?: string | null;
  name: string;
  avatar?: string | null;
  role: Exclude<ParticipantRole, 'host'>;
  models: ModelsChoice;
  model?: string | null;
}

export type ParticipantPatch = Partial<Pick<ParticipantRow, 'name' | 'avatar' | 'role' | 'models' | 'model' | 'trusted' | 'title' | 'pinnedAt' | 'groupId' | 'archivedAt' | 'finishedUnseenAt'>>;

export class ParticipantRepo {
  constructor(private readonly db: Db) {}

  /** Everyone in the session now (not those who left), in the order they joined. */
  async list(sessionId: string): Promise<ParticipantRow[]> {
    const rows = await this.db
      .select()
      .from(sessionParticipants)
      .where(and(eq(sessionParticipants.sessionId, sessionId), isNull(sessionParticipants.leftAt)));
    return rows.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** One participant, also one who left (their messages still carry their name). */
  async get(sessionId: string, id: string): Promise<ParticipantRow | null> {
    const [row] = await this.db
      .select()
      .from(sessionParticipants)
      .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.id, id)));
    return row ?? null;
  }

  /** The role an account has in a session it doesn't own, or null when it isn't in it (or left). */
  async roleOf(sessionId: string, userId: string): Promise<Exclude<ParticipantRole, 'host'> | null> {
    const [row] = await this.db
      .select({ role: sessionParticipants.role })
      .from(sessionParticipants)
      .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId), isNull(sessionParticipants.leftAt)));
    return row?.role ?? null;
  }

  /** The sessions an account takes part in without owning them, with its own per-viewer state. */
  async ofUser(userId: string): Promise<ParticipantRow[]> {
    return this.db
      .select()
      .from(sessionParticipants)
      .where(and(eq(sessionParticipants.userId, userId), isNull(sessionParticipants.leftAt)));
  }

  /** Adds a participant, or brings back one who left (same id), with what they bring now. */
  async add(p: NewParticipant, now = Date.now()): Promise<ParticipantRow> {
    const values = {
      sessionId: p.sessionId,
      id: p.id,
      kind: p.kind,
      userId: p.userId ?? null,
      peerKey: p.peerKey ?? null,
      name: p.name,
      avatar: p.avatar ?? null,
      role: p.role,
      models: p.models,
      model: p.model ?? null,
      trusted: false,
      joinedAt: now,
      leftAt: null,
    };
    await this.db
      .insert(sessionParticipants)
      .values(values)
      .onConflictDoUpdate({ target: [sessionParticipants.sessionId, sessionParticipants.id], set: { ...values, trusted: false } });
    return (await this.get(p.sessionId, p.id))!;
  }

  async update(sessionId: string, id: string, patch: ParticipantPatch): Promise<ParticipantRow | null> {
    if (Object.keys(patch).length === 0) return this.get(sessionId, id);
    await this.db
      .update(sessionParticipants)
      .set(patch)
      .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.id, id)));
    return this.get(sessionId, id);
  }

  /** They leave (or are removed): their row stays, so their messages keep their name, but they have no access. */
  async remove(sessionId: string, id: string, now = Date.now()): Promise<void> {
    await this.db
      .update(sessionParticipants)
      .set({ leftAt: now, trusted: false })
      .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.id, id)));
  }

  /** Co-op ended: everyone leaves. */
  async removeAll(sessionId: string, now = Date.now()): Promise<void> {
    await this.db
      .update(sessionParticipants)
      .set({ leftAt: now, trusted: false })
      .where(and(eq(sessionParticipants.sessionId, sessionId), isNull(sessionParticipants.leftAt)));
  }
}
