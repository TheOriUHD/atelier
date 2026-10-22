/**
 * Sessions and their message trees. Edits and retries create siblings; `headMessageId` is the leaf of
 * the active branch. Compaction never deletes: a summary node starts the model-visible history.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { messageText, type Message, type Mode, type Part, type SessionSummary, type TemporaryMode } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { messages, sessions } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { NOT_TEMPORARY_SQL, notTemporary } from './temporary.ts';

export type SessionRow = typeof sessions.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export function toSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    mode: r.mode,
    workspaceId: r.workspaceId,
    permissionMode: (r.permissionMode as SessionSummary['permissionMode']) ?? null,
    title: r.title,
    projectId: r.projectId,
    model: r.model,
    effort: (r.effort as SessionSummary['effort']) ?? null,
    thinking: r.overrides.thinking !== false,
    remoteControl: r.overrides.remoteControl !== false,
    connectorsOff: connectorsOff(r),
    research: r.overrides.research === true,
    status: r.status,
    finishedUnseen: r.finishedUnseenAt !== null,
    groupId: r.groupId,
    archivedAt: r.archivedAt,
    temporary: r.temporary,
    pinnedAt: r.pinnedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The connectors a session has switched off (kept in its overrides). */
export function connectorsOff(r: Pick<SessionRow, 'overrides'>): string[] {
  const off = r.overrides.connectorsOff;
  return Array.isArray(off) ? off.filter((n): n is string => typeof n === 'string') : [];
}

export function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    sessionId: r.sessionId,
    parentId: r.parentId,
    role: r.role,
    parts: r.parts as Part[],
    model: r.model,
    usage: (r.usage as Message['usage']) ?? null,
    stopReason: (r.stopReason as Message['stopReason']) ?? null,
    error: r.error ?? null,
    kind: r.kind,
    summarizesThroughId: r.summarizesThroughId,
    createdAt: r.createdAt,
  };
}

/** Text indexed for search: visible text plus tool-call names; never thinking or hidden context. */
function searchTextOf(parts: readonly Part[]): string {
  const text = messageText(parts);
  const tools = parts.filter((p) => p.type === 'tool_call').map((p) => (p.type === 'tool_call' ? p.name : ''));
  return [text, ...tools].join(' ').slice(0, 20_000);
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    mode: Mode;
    userId?: string | null;
    projectId?: string | null;
    model?: string | null;
    effort?: string | null;
    workspaceId?: string | null;
    permissionMode?: string | null;
    parentSessionId?: string;
    groupId?: string | null;
    title?: string;
    overrides?: Record<string, unknown>;
    temporary?: TemporaryMode | null;
  }): Promise<SessionSummary> {
    const now = Date.now();
    // A temporary chat's sub-agents and side chats are as temporary as it is.
    const temporary = input.temporary !== undefined ? input.temporary : input.parentSessionId ? ((await this.getRow(input.parentSessionId))?.temporary ?? null) : null;
    const row: typeof sessions.$inferInsert = {
      id: newId(),
      userId: input.userId ?? null,
      mode: input.mode,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      workspaceId: input.workspaceId ?? null,
      permissionMode: input.permissionMode ?? null,
      parentSessionId: input.parentSessionId ?? null,
      groupId: input.groupId ?? null,
      temporary,
      ...(input.title ? { title: input.title } : {}),
      ...(input.overrides ? { overrides: input.overrides } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(sessions).values(row);
    return toSummary((await this.getRow(row.id!))!);
  }

  async getRow(id: string): Promise<SessionRow | undefined> {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    const row = await this.getRow(id);
    return row ? toSummary(row) : undefined;
  }

  /**
   * Top-level sessions only (subagent children are hidden), pinned first, then most recent, each with whether it
   * produced something: an artifact, or in Cowork a file written or edited (a Write or Edit call in a reply).
   * Temporary chats are history nobody keeps: left out unless `withTemporary` (housekeeping, never a person's list).
   */
  async list(filter: { userId?: string; mode?: Mode; projectId?: string; query?: string; archived?: 'active' | 'archived' | 'all'; limit: number; withTemporary?: boolean }): Promise<SessionSummary[]> {
    const conditions = [isNull(sessions.parentSessionId)];
    if (!filter.withTemporary) conditions.push(notTemporary());
    if (filter.archived !== 'all') conditions.push(filter.archived === 'archived' ? isNotNull(sessions.archivedAt) : isNull(sessions.archivedAt));
    if (filter.userId) conditions.push(eq(sessions.userId, filter.userId));
    if (filter.mode) conditions.push(eq(sessions.mode, filter.mode));
    if (filter.projectId) conditions.push(eq(sessions.projectId, filter.projectId));
    if (filter.query?.trim()) {
      const ids = this.searchSessionIds(filter.query);
      if (ids.length === 0) return [];
      conditions.push(inArray(sessions.id, ids));
    }
    const produced = sql<number>`(EXISTS (SELECT 1 FROM artifacts a WHERE a.session_id = "sessions"."id") OR ("sessions"."mode" = 'work' AND EXISTS (
      SELECT 1 FROM messages m WHERE m.session_id = "sessions"."id" AND m.role = 'assistant' AND (m.parts LIKE '%"name":"Write"%' OR m.parts LIKE '%"name":"Edit"%'))))`;
    const rows = await this.db
      .select({ session: sessions, produced })
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sql`${sessions.pinnedAt} IS NULL`, desc(sessions.pinnedAt), desc(sessions.updatedAt))
      .limit(filter.limit)
      .all();
    return rows.map((r) => ({ ...toSummary(r.session), produced: !!r.produced }));
  }

  /** Sessions whose title or any message matches the FTS query (prefix match per term). */
  private searchSessionIds(query: string): string[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["*^():]/g, ''))
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!terms) return [];
    const hits = this.db.$client
      .prepare(
        `SELECT DISTINCT m.session_id AS id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN sessions s ON s.id = m.session_id WHERE messages_fts MATCH ? AND s.${NOT_TEMPORARY_SQL} LIMIT 500`,
      )
      .all(terms) as { id: string }[];
    const titleHits = this.db.$client
      .prepare(`SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\' AND ${NOT_TEMPORARY_SQL} LIMIT 500`)
      .all(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { id: string }[];
    return [...new Set([...hits, ...titleHits].map((r) => r.id))];
  }

  async update(
    id: string,
    patch: Partial<Pick<SessionRow, 'title' | 'model' | 'effort' | 'projectId' | 'status' | 'pinnedAt' | 'headMessageId' | 'pending' | 'seq' | 'systemSnapshot' | 'toolsSnapshot' | 'overrides' | 'permissionMode' | 'todos' | 'workspaceId'>>,
  ): Promise<SessionSummary> {
    await this.db.update(sessions).set({ ...patch, updatedAt: Date.now() }).where(eq(sessions.id, id));
    const row = await this.getRow(id);
    if (!row) throw new Error(`Session ${id} not found`);
    return toSummary(row);
  }

  /** Updates fields without touching updatedAt (status bookkeeping must not reorder Recents). */
  async patchQuietly(id: string, patch: Partial<Pick<SessionRow, 'status' | 'pending' | 'seq' | 'finishedUnseenAt' | 'groupId' | 'archivedAt' | 'overrides'>>): Promise<void> {
    await this.db.update(sessions).set(patch).where(eq(sessions.id, id));
  }

  /**
   * A copy of the conversation on the session's active branch, as a new session with the same folder, model and
   * settings (its artifacts and checkpoints stay with the original). `into` continues it in another mode (a chat taken
   * over to Cowork): same title, and the new mode builds its own system prompt.
   */
  async fork(id: string, into?: Mode): Promise<SessionSummary> {
    const row = await this.getRow(id);
    if (!row) throw new Error(`Session ${id} not found`);
    const path = await this.path(row.headMessageId);
    const moved = into !== undefined && into !== row.mode;
    const copy = await this.create({
      mode: into ?? row.mode,
      userId: row.userId,
      projectId: row.projectId,
      model: row.model,
      effort: row.effort,
      workspaceId: row.workspaceId,
      permissionMode: row.permissionMode,
      overrides: row.overrides,
      temporary: row.temporary,
      title: moved ? row.title : row.title ? `Fork of ${row.title}` : '',
    });
    const ids = new Map(path.map((m) => [m.id, newId()]));
    for (const m of path) {
      await this.insertMessage(
        {
          ...m,
          id: ids.get(m.id)!,
          sessionId: copy.id,
          parentId: m.parentId ? (ids.get(m.parentId) ?? null) : null,
          summarizesThroughId: m.summarizesThroughId ? (ids.get(m.summarizesThroughId) ?? null) : null,
        },
        { setHead: false },
      );
    }
    await this.db
      .update(sessions)
      .set({
        headMessageId: path.length ? ids.get(path[path.length - 1]!.id)! : null,
        todos: row.todos,
        groupId: row.groupId,
        systemSnapshot: moved ? null : row.systemSnapshot,
        toolsSnapshot: moved ? null : row.toolsSnapshot,
      })
      .where(eq(sessions.id, copy.id));
    return (await this.get(copy.id))!;
  }

  /** Clears the "finished while you were away" mark; the updated summary when there was one, otherwise null. */
  async markSeen(id: string): Promise<SessionSummary | null> {
    const row = await this.getRow(id);
    if (!row || row.finishedUnseenAt === null) return null;
    await this.patchQuietly(id, { finishedUnseenAt: null });
    return toSummary({ ...row, finishedUnseenAt: null });
  }

  /** A session's child sessions (sub-agents, side chats), oldest first. */
  async children(parentId: string): Promise<SessionRow[]> {
    return this.db.select().from(sessions).where(eq(sessions.parentSessionId, parentId)).orderBy(sessions.createdAt).all();
  }

  /** Temporary chats (top-level) last active before `before`: the sweep's candidates. */
  async temporaryIdleSince(before: number): Promise<SessionRow[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(isNotNull(sessions.temporary), isNull(sessions.parentSessionId), lt(sessions.updatedAt, before)))
      .all();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.parentSessionId, id));
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  /** After a restart: runs that were going (or waiting for an answer nobody can deliver now) are interrupted. */
  async markRunningAsInterrupted(): Promise<string[]> {
    const active = inArray(sessions.status, ['running', 'waiting']);
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(active).all();
    if (rows.length) await this.db.update(sessions).set({ status: 'interrupted', pending: null }).where(active);
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------- messages

  async insertMessage(m: Omit<Message, 'createdAt'> & { createdAt?: number }, opts: { setHead?: boolean } = {}): Promise<Message> {
    const createdAt = m.createdAt ?? Date.now();
    await this.db.insert(messages).values({
      id: m.id,
      sessionId: m.sessionId,
      parentId: m.parentId,
      role: m.role,
      parts: m.parts,
      model: m.model,
      usage: m.usage,
      stopReason: m.stopReason,
      error: m.error,
      kind: m.kind,
      summarizesThroughId: m.summarizesThroughId,
      searchText: searchTextOf(m.parts),
      createdAt,
    });
    if (opts.setHead !== false) await this.update(m.sessionId, { headMessageId: m.id });
    return { ...m, createdAt };
  }

  async updateMessage(id: string, patch: Partial<Pick<Message, 'parts' | 'usage' | 'stopReason' | 'error' | 'model'>>): Promise<void> {
    await this.db
      .update(messages)
      .set({ ...patch, ...(patch.parts ? { searchText: searchTextOf(patch.parts) } : {}) })
      .where(eq(messages.id, id));
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? toMessage(row) : undefined;
  }

  private async allMessages(sessionId: string): Promise<Message[]> {
    const rows = await this.db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(messages.createdAt).all();
    return rows.map(toMessage);
  }

  /**
   * Root → head along parent links, walked in SQL so only the branch is loaded. With `fromSummary` the walk
   * stops at the nearest compaction summary (the model never sees what it summarizes).
   */
  private async path(headId: string | null, fromSummary = false): Promise<Message[]> {
    if (!headId) return [];
    const ids = (
      this.db.$client
        .prepare(
          `WITH RECURSIVE path(id, parent_id, kind, depth) AS (
             SELECT id, parent_id, kind, 0 FROM messages WHERE id = ?
             UNION ALL
             SELECT m.id, m.parent_id, m.kind, p.depth + 1 FROM messages m JOIN path p ON m.id = p.parent_id
             WHERE NOT (? AND p.kind = 'compaction_summary')
           )
           SELECT id FROM path ORDER BY depth DESC`,
        )
        .all(headId, fromSummary ? 1 : 0) as { id: string }[]
    ).map((r) => r.id);
    const rows = await this.db.select().from(messages).where(inArray(messages.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, toMessage(r)]));
    return ids.map((id) => byId.get(id)!);
  }

  /** Active branch root → head, plus sibling lists for ‹ n/m › navigation. */
  async branch(sessionId: string): Promise<{ messages: Message[]; siblings: Record<string, string[]> }> {
    const session = await this.getRow(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const path = await this.path(session.headMessageId);
    // Sibling groups only need ids, not message bodies.
    const links = this.db.$client
      .prepare('SELECT id, parent_id AS parentId FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
      .all(sessionId) as { id: string; parentId: string | null }[];
    const children = new Map<string | null, string[]>();
    for (const m of links) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m.id]);
    const siblings: Record<string, string[]> = {};
    for (const m of path) {
      const group = children.get(m.parentId) ?? [m.id];
      if (group.length > 1) siblings[m.id] = group;
    }
    return { messages: path, siblings };
  }

  /** Model-visible history: the active branch starting at the nearest compaction summary. */
  async history(sessionId: string): Promise<Message[]> {
    const session = await this.getRow(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.path(session.headMessageId, true);
  }

  /** The person's message that started the current turn: the nearest user message above the head. */
  async currentTurn(sessionId: string): Promise<string | null> {
    const row = this.db.$client
      .prepare(
        `WITH RECURSIVE up(id, parent_id, role, kind) AS (
           SELECT m.id, m.parent_id, m.role, m.kind FROM messages m JOIN sessions s ON m.id = s.head_message_id WHERE s.id = ?
           UNION ALL
           SELECT m.id, m.parent_id, m.role, m.kind FROM messages m JOIN up ON m.id = up.parent_id WHERE NOT (up.role = 'user' AND up.kind = 'normal')
         )
         SELECT id FROM up WHERE role = 'user' AND kind = 'normal' LIMIT 1`,
      )
      .get(sessionId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Moves a message under another parent (compaction slots a summary in before an unanswered request). */
  async reparent(id: string, parentId: string | null): Promise<void> {
    await this.db.update(messages).set({ parentId }).where(eq(messages.id, id));
  }

  /** Makes `messageId`'s branch active, following the most recent child down to a leaf. */
  async switchBranch(sessionId: string, messageId: string): Promise<void> {
    const all = await this.allMessages(sessionId);
    if (!all.some((m) => m.id === messageId)) throw new Error('Message not in session');
    let leaf = messageId;
    for (;;) {
      const kids = all.filter((m) => m.parentId === leaf);
      if (kids.length === 0) break;
      leaf = kids[kids.length - 1]!.id;
    }
    await this.update(sessionId, { headMessageId: leaf });
  }

  async messageCount(sessionId: string): Promise<number> {
    const row = this.db.$client.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number };
    return row.n;
  }
}
