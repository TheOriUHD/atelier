/**
 * Settings › Usage (ARCHITECTURE §17, M4): tokens, cost and speed per day, provider, model and mode, from the
 * usage events each reply records; and the Code and Cowork homes' stats. Days follow the asking person's time zone.
 */
import type { Mode, SessionUsage, StatsSummary, UsageRow } from '@atelier/protocol';
import type { Db } from '../store/db.ts';

const DAY = 86_400_000;
/** The stats card's heatmap: 26 weeks, enough for its first column to start on any weekday. */
const HEATMAP_DAYS = 26 * 7;

/** Local midnight `days - 1` days before `now`, so "7 days" is today and the six before it. `timezoneOffset` as `Date#getTimezoneOffset()`. */
function since(now: number, days: number, timezoneOffset: number): number {
  const offsetMs = timezoneOffset * 60_000;
  return Math.floor((now - offsetMs) / DAY) * DAY + offsetMs - (days - 1) * DAY;
}

export function usageSummary(db: Db, opts: { userId: string | null; days: number; timezoneOffset: number; now?: number }): UsageRow[] {
  return db.$client
    .prepare(
      `SELECT date((ts - ?) / 1000, 'unixepoch') AS day, provider_id AS providerId, model_id AS modelId, COALESCE(mode, 'chat') AS mode,
              COUNT(*) AS requests, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
              SUM(reasoning) AS reasoning, SUM(cost_usd) AS costUsd, COUNT(*) - COUNT(cost_usd) AS unpriced, AVG(tokens_per_second) AS tokensPerSecond, COUNT(tokens_per_second) AS timed
       FROM usage_events WHERE ts >= ? AND (? IS NULL OR user_id = ?)
       GROUP BY day, provider_id, model_id, mode ORDER BY day, provider_id, model_id, mode`,
    )
    .all(opts.timezoneOffset * 60_000, since(opts.now ?? Date.now(), opts.days, opts.timezoneOffset), opts.userId, opts.userId) as unknown as UsageRow[];
}

/** The person's and the model's messages in the person's root sessions of a mode; tool results and summaries aside. */
const MESSAGES = `FROM messages m JOIN sessions s ON s.id = m.session_id
  WHERE s.user_id = ? AND s.mode = ? AND s.parent_session_id IS NULL AND m.role IN ('user', 'assistant') AND m.kind = 'normal' AND m.created_at >= ?`;
const LOCAL_DAY = `date((m.created_at - ?) / 1000, 'unixepoch')`;

/** The stats card for `mode` over the last `days` days, or all time. A sub-agent's tokens count for its parent session. */
export function statsSummary(db: Db, opts: { userId: string; mode: Mode; days: number | null; timezoneOffset: number; now?: number }): StatsSummary {
  const now = opts.now ?? Date.now();
  const offsetMs = opts.timezoneOffset * 60_000;
  const from = opts.days ? since(now, opts.days, opts.timezoneOffset) : 0;
  const scope = [opts.userId, opts.mode];
  const sql = db.$client;
  const totals = sql
    .prepare(`SELECT COUNT(DISTINCT m.session_id) AS sessions, COUNT(*) AS messages, COUNT(DISTINCT ${LOCAL_DAY}) AS activeDays ${MESSAGES}`)
    .get(offsetMs, ...scope, from) as { sessions: number; messages: number; activeDays: number };
  const peak = sql
    .prepare(`SELECT CAST(strftime('%H', (m.created_at - ?) / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n ${MESSAGES} GROUP BY hour ORDER BY n DESC, hour LIMIT 1`)
    .get(offsetMs, ...scope, from) as { hour: number } | undefined;
  const days = sql
    .prepare(`SELECT ${LOCAL_DAY} AS day, COUNT(DISTINCT m.session_id) AS sessions, COUNT(*) AS messages ${MESSAGES} GROUP BY day ORDER BY day`)
    .all(offsetMs, ...scope, since(now, HEATMAP_DAYS, opts.timezoneOffset)) as StatsSummary['days'];
  const models = sql
    .prepare(
      `SELECT e.provider_id || '/' || e.model_id AS ref, SUM(e.input + e.cache_read + e.cache_write + e.output) AS tokens, COUNT(*) AS requests
       FROM usage_events e JOIN sessions s ON s.id = e.session_id JOIN sessions r ON r.id = COALESCE(s.parent_session_id, s.id)
       WHERE r.user_id = ? AND r.mode = ? AND e.ts >= ? GROUP BY ref ORDER BY tokens DESC, ref`,
    )
    .all(...scope, from) as StatsSummary['models'];
  return {
    ...totals,
    tokens: models.reduce((n, m) => n + m.tokens, 0),
    peakHour: peak?.hour ?? null,
    favoriteModel: models[0]?.ref ?? null,
    days,
    models,
  };
}

/**
 * Tokens a session and its sub-agents used, for the context popover. The speed is the last reply's: the provider's
 * generation speed, or else output over the whole request's time.
 */
export function sessionUsage(db: Db, sessionId: string): SessionUsage {
  const scope = `FROM usage_events WHERE session_id = ? OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?)`;
  const totals = db.$client
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cacheRead,
              COALESCE(SUM(cache_write), 0) AS cacheWrite, SUM(cost_usd) AS costUsd ${scope}`,
    )
    .get(sessionId, sessionId) as Omit<SessionUsage, 'tokensPerSecond'>;
  const speed = db.$client
    .prepare(`SELECT COALESCE(tokens_per_second, output * 1000.0 / duration_ms) AS tps FROM (SELECT * ${scope}) WHERE output > 0 AND (tokens_per_second IS NOT NULL OR duration_ms > 0) ORDER BY ts DESC LIMIT 1`)
    .get(sessionId, sessionId) as { tps: number } | undefined;
  return { ...totals, tokensPerSecond: speed?.tps ?? null };
}
