/**
 * The admin activity log (ARCHITECTURE §21): writes, reads, exports and prunes `audit_events`.
 *
 * Writing is the part that must not get in anyone's way. `record` never throws and never waits for the database: it
 * hands the rows to a queue that inserts them one batch after another, and a failure there is logged (at most once a
 * minute) and forgotten. The handler that caused the event has already answered by then.
 */
import { and, asc, desc, eq, getTableColumns, lt, or, sql, type SQL } from 'drizzle-orm';
import { AUDIT_EXPORT_MAX, RETENTION_DAYS, type AuditDetail, type AuditEvent, type AuditExport, type AuditFilter, type AuditKind, type AuditPage } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { auditEvents } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { oneLine, scrubText } from './audit-redact.ts';

/** What a rule says happened. */
export interface AuditDraft {
  kind: AuditKind;
  target?: string | null;
  summary: string;
  detail?: Record<string, string | number | boolean | null | undefined> | null;
}

/** Who did it, as the server saw it. */
export interface AuditWho {
  actorId?: string | null;
  /** The username (for a failed sign-in, the one that was tried). */
  actor?: string | null;
  ip?: string | null;
}

/**
 * A safety net against a flood (many failed sign-ins from many addresses): beyond this many rows the oldest go, so the
 * table can't fill a disk before the retention period would have removed anything.
 */
export const AUDIT_MAX_ROWS = 500_000;

export const DEFAULT_PAGE = 50;

type Row = typeof auditEvents.$inferSelect;
/** The order rows were written in. Events of the same millisecond sort by it, so a burst reads back in the order it happened. */
const seq = sql<number>`rowid`;
const withSeq = { ...getTableColumns(auditEvents), seq };

export class AuditLog {
  private tail: Promise<void> = Promise.resolve();
  private lastFailureLogged = 0;

  constructor(
    private readonly db: Db,
    private readonly options: {
      /** The log is for shared servers: a desktop app on its own backend has one person and writes nothing. */
      enabled(): boolean;
      onError(message: string, error: unknown): void;
      now?(): number;
    },
  ) {}

  /** Queues events for writing and returns at once. Never throws. */
  record(who: AuditWho, drafts: AuditDraft | readonly AuditDraft[]): void {
    try {
      if (!this.options.enabled()) return;
      const at = (this.options.now ?? Date.now)();
      const rows = (Array.isArray(drafts) ? (drafts as readonly AuditDraft[]) : [drafts as AuditDraft]).map((d) => toRow(who, d, at));
      if (!rows.length) return;
      this.tail = this.tail.then(() => this.insert(rows));
    } catch (e) {
      this.failed(e);
    }
  }

  /** Resolves once everything queued so far is written (tests, shutdown). */
  idle(): Promise<void> {
    return this.tail;
  }

  async list(filter: AuditFilter, page: { cursor?: string | undefined; limit?: number | undefined }, retentionDays: number): Promise<AuditPage> {
    const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE, 1), 200);
    const where = [filterSql(filter)];
    const cursor = parseCursor(page.cursor);
    if (cursor) where.push(or(lt(auditEvents.at, cursor.at), and(eq(auditEvents.at, cursor.at), sql`rowid < ${cursor.seq}`))!);
    const rows = await this.db
      .select(withSeq)
      .from(auditEvents)
      .where(and(...where.filter((w): w is SQL => !!w)))
      .orderBy(desc(auditEvents.at), desc(seq))
      .limit(limit + 1)
      .all();
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return { events: shown.map(toEvent), next: more && last ? `${last.at}:${last.seq}` : null, retentionDays };
  }

  async export(filter: AuditFilter, retentionDays: number): Promise<AuditExport> {
    const where = filterSql(filter);
    const rows = await this.db
      .select(withSeq)
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.at), desc(seq))
      .limit(AUDIT_EXPORT_MAX + 1)
      .all();
    return { exportedAt: (this.options.now ?? Date.now)(), retentionDays, truncated: rows.length > AUDIT_EXPORT_MAX, events: rows.slice(0, AUDIT_EXPORT_MAX).map(toEvent) };
  }

  /** Deletes events older than the retention period, then the oldest beyond `AUDIT_MAX_ROWS`. Returns how many went. */
  async prune(retentionDays: number): Promise<number> {
    const days = Math.min(Math.max(Math.round(retentionDays), RETENTION_DAYS.min), RETENTION_DAYS.max);
    const before = ((this.options.now ?? Date.now)()) - days * 24 * 3600_000;
    let removed = (await this.db.delete(auditEvents).where(lt(auditEvents.at, before)).returning({ id: auditEvents.id }).all()).length;
    const count = (await this.db.select({ n: sql<number>`count(*)` }).from(auditEvents).get())?.n ?? 0;
    if (count > AUDIT_MAX_ROWS) {
      const oldest = await this.db.select({ id: auditEvents.id }).from(auditEvents).orderBy(asc(auditEvents.at)).limit(count - AUDIT_MAX_ROWS).all();
      for (let i = 0; i < oldest.length; i += 500) {
        const ids = oldest.slice(i, i + 500).map((r) => r.id);
        removed += (await this.db.delete(auditEvents).where(sql`${auditEvents.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).returning({ id: auditEvents.id }).all()).length;
      }
    }
    return removed;
  }

  private async insert(rows: Row[]): Promise<void> {
    try {
      await this.db.insert(auditEvents).values(rows);
    } catch (e) {
      this.failed(e);
    }
  }

  private failed(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLogged < 60_000) return;
    this.lastFailureLogged = now;
    try {
      this.options.onError('the activity log could not be written', error);
    } catch {
      // A logger that throws is no reason to fail anything either.
    }
  }
}

/** Bounded, single-line, scrubbed: even a rule that passes something it shouldn't can't put a credential into the log. */
function toRow(who: AuditWho, d: AuditDraft, at: number): Row {
  const detail: AuditDetail = {};
  for (const [key, value] of Object.entries(d.detail ?? {}).slice(0, 12)) {
    if (value === undefined) continue;
    detail[oneLine(key, 40)] = typeof value === 'string' ? scrubText(oneLine(value, 200)) : value;
  }
  return {
    id: newId(),
    at,
    kind: d.kind,
    actorId: who.actorId ?? null,
    actor: who.actor ? oneLine(who.actor, 80).toLowerCase() : null,
    target: d.target ? scrubText(oneLine(d.target, 200)) : null,
    summary: scrubText(oneLine(d.summary, 300)),
    detail: Object.keys(detail).length ? detail : null,
    ip: who.ip ? oneLine(who.ip, 64) : null,
  };
}

function toEvent(r: Row & { seq?: number }): AuditEvent {
  return { id: r.id, at: r.at, kind: r.kind, actorId: r.actorId, actor: r.actor, target: r.target, summary: r.summary, detail: r.detail, ip: r.ip };
}

/** Kinds and categories are lowercase words and dots; anything else matches nothing instead of reaching the query. */
const KIND = /^[a-z_]+(\.[a-z_]+)?$/;

function filterSql(filter: AuditFilter): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (filter.kind) {
    parts.push(KIND.test(filter.kind) ? (filter.kind.includes('.') ? eq(auditEvents.kind, filter.kind) : sql`${auditEvents.kind} like ${`${filter.kind}.%`}`) : sql`0`);
  }
  if (filter.user) {
    const user = filter.user.trim().toLowerCase();
    parts.push(or(eq(auditEvents.actor, user), eq(sql`lower(${auditEvents.target})`, user)));
  }
  if (filter.from !== undefined) parts.push(sql`${auditEvents.at} >= ${filter.from}`);
  if (filter.to !== undefined) parts.push(sql`${auditEvents.at} <= ${filter.to}`);
  const present = parts.filter((p): p is SQL => !!p);
  return present.length ? and(...present) : undefined;
}

function parseCursor(cursor: string | undefined): { at: number; seq: number } | null {
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(cursor ?? '');
  return match ? { at: Number(match[1]), seq: Number(match[2]) } : null;
}
