/**
 * Per-person usage limits on text models (ARCHITECTURE §8). Totals live in memory per person, seeded from
 * `usage_events` the first time the person is seen and kept current by `record`, so checking before every model request
 * costs no query. Days are UTC days, like the image limits; "30 days" is today and the 29 UTC days before it; the
 * request limit counts the last 60 minutes. Image rows are left out: images have limits of their own.
 */
import {
  effectiveLimits,
  formatLimitAmount,
  LIMIT_INFO,
  LIMIT_KEYS,
  LIMIT_REACHED,
  LIMIT_WARN_AT,
  limitPhrase,
  type LimitKey,
  type LimitsSettings,
  type LimitsStatus,
  type LimitStatusRow,
  type LimitWarning,
  type MessageError,
  type UserLimits,
} from '@atelier/protocol';
import type { Db } from '../store/db.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW_DAYS = 30;

/** What one UTC day added up to. */
interface Bucket {
  tokens: number;
  cost: number;
  requests: number;
  unpriced: number;
}

interface Counter {
  days: Map<number, Bucket>;
  /** Times of the requests in the last hour, oldest first. */
  recent: number[];
  /** Requests started and not yet recorded: they count toward the request limit, whose total they'd otherwise sneak past. */
  inflight: number;
  /** Limits already warned about: the UTC day for a daily limit, 0 for the others (until usage falls below the warning line). */
  warned: Map<LimitKey, number>;
}

export interface LimitsDeps {
  db: Db;
  settings(): { limits: LimitsSettings };
  /** The person's override; null when they have none. */
  person(userId: string): Promise<UserLimits | null>;
  /** Names of the people who can change limits, to say who to ask. */
  admins?(): Promise<string[]>;
  now?(): number;
}

export interface LimitHit {
  key: LimitKey;
  used: number;
  max: number;
  resetsAt: number | null;
}

export type Admission = { error: MessageError; hit: LimitHit } | { error?: undefined; release(): void };

const dayStart = (ts: number): number => Math.floor(ts / DAY) * DAY;

/** "at 00:00 UTC (in about 6 hours)", for a time the person can plan around. */
export function describeReset(at: number | null, now: number): string {
  if (at === null) return 'when your running requests finish';
  const date = new Date(at);
  // The date only when it isn't about today and tonight: "at 00:00 UTC (in about 14 hours)" says it better.
  const sameDay = at - now < DAY;
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  const day = sameDay ? '' : `on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} `;
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  const left =
    minutes < 90 ? `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
    : minutes < 36 * 60 ? `in about ${Math.round(minutes / 60)} hours`
    : `in about ${Math.round(minutes / 1440)} days`;
  return `${day}at ${time} UTC (${left})`;
}

export class UsageLimits {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly deps: LimitsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The person's totals, read from the usage events the first time and kept by `record` after. */
  private counter(userId: string): Counter {
    let counter = this.counters.get(userId);
    if (counter) return counter;
    const now = this.now();
    const sql = this.deps.db.$client;
    const days = new Map<number, Bucket>();
    // `ts / DAY` is an integer division in SQLite: the UTC day number.
    const rows = sql
      .prepare(
        `SELECT ts / ${DAY} AS day, SUM(input + output + cache_read + cache_write) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS requests, COUNT(*) - COUNT(cost_usd) AS unpriced
         FROM usage_events WHERE user_id = ? AND ts >= ? AND images = 0 AND videos = 0 AND audios = 0 GROUP BY day`,
      )
      .all(userId, dayStart(now) - (WINDOW_DAYS - 1) * DAY) as { day: number; tokens: number; cost: number; requests: number; unpriced: number }[];
    for (const r of rows) days.set(r.day * DAY, { tokens: r.tokens, cost: r.cost, requests: r.requests, unpriced: r.unpriced });
    const recent = (sql.prepare('SELECT ts FROM usage_events WHERE user_id = ? AND ts >= ? AND images = 0 AND videos = 0 AND audios = 0 ORDER BY ts').all(userId, now - HOUR) as { ts: number }[]).map((r) => r.ts);
    counter = { days, recent, inflight: 0, warned: new Map() };
    this.counters.set(userId, counter);
    return counter;
  }

  /** Drops what has aged out of the 30 days and the hour. */
  private prune(counter: Counter, now: number): void {
    const oldest = dayStart(now) - (WINDOW_DAYS - 1) * DAY;
    for (const day of counter.days.keys()) if (day < oldest) counter.days.delete(day);
    let aged = 0;
    while (aged < counter.recent.length && counter.recent[aged]! <= now - HOUR) aged++;
    if (aged) counter.recent.splice(0, aged);
  }

  /**
   * A model request finished (or its tokens are known): add it to the person's totals. Call it before the usage row is
   * inserted, so a person seen for the first time is seeded without it.
   */
  record(userId: string | null, entry: { ts?: number; tokens: number; costUsd: number | null }): void {
    if (!userId) return;
    const ts = entry.ts ?? this.now();
    const counter = this.counter(userId);
    const day = dayStart(ts);
    const bucket = counter.days.get(day) ?? { tokens: 0, cost: 0, requests: 0, unpriced: 0 };
    bucket.tokens += entry.tokens;
    bucket.requests += 1;
    if (entry.costUsd === null) bucket.unpriced += 1;
    else bucket.cost += entry.costUsd;
    counter.days.set(day, bucket);
    // Requests are recorded roughly in order; keep the list sorted for the reset time.
    const at = counter.recent.findLastIndex((t) => t <= ts) + 1;
    counter.recent.splice(at, 0, ts);
    this.prune(counter, this.now());
  }

  /** The rows for the limits in `values`, as they stand now. */
  private rows(counter: Counter, values: LimitsSettings, system: LimitsSettings, now: number): LimitStatusRow[] {
    this.prune(counter, now);
    const today = dayStart(now);
    const window = [...counter.days.entries()].filter(([day]) => day >= today - (WINDOW_DAYS - 1) * DAY).sort(([a], [b]) => a - b);
    const sum = (pick: (b: Bucket) => number, days: [number, Bucket][]) => days.reduce((n, [, b]) => n + pick(b), 0);
    const rows: LimitStatusRow[] = [];
    for (const key of LIMIT_KEYS) {
      const max = values[key];
      if (max === undefined) continue;
      const { unit, period } = LIMIT_INFO[key];
      const pick = unit === 'tokens' ? (b: Bucket) => b.tokens : (b: Bucket) => b.cost;
      let used: number;
      let resetsAt: number | null;
      if (period === 'hour') {
        used = counter.recent.length + counter.inflight;
        // The request that must age out for the count to drop below the limit; none when requests under way account for it.
        const nth = used - max;
        resetsAt = used >= max ? (nth < counter.recent.length ? counter.recent[nth]! + HOUR : null) : null;
      } else if (period === 'day') {
        used = counter.days.get(today) ? pick(counter.days.get(today)!) : 0;
        resetsAt = today + DAY;
      } else {
        used = sum(pick, window);
        resetsAt = null;
        if (used >= max) {
          // Days leave the window oldest first; it lets requests through once enough of them have.
          let left = used;
          for (const [day, bucket] of window) {
            left -= pick(bucket);
            if (left < max) {
              resetsAt = day + WINDOW_DAYS * DAY;
              break;
            }
          }
        }
      }
      const reached = used >= max;
      rows.push({ key, used, max, resetsAt, reached, near: used >= max * LIMIT_WARN_AT, ...(max !== system[key] ? { overridden: true } : {}) });
    }
    return rows;
  }

  private async limitsOf(userId: string): Promise<{ exempt: boolean; values: LimitsSettings; system: LimitsSettings }> {
    const system = this.deps.settings().limits;
    const own = await this.deps.person(userId).catch(() => null);
    return { ...effectiveLimits(system, own), system };
  }

  /** The person's usage against the limits that apply to them. */
  async status(userId: string): Promise<LimitsStatus> {
    const { exempt, values, system } = await this.limitsOf(userId);
    const counter = this.counter(userId);
    const now = this.now();
    const rows = this.rows(counter, values, system, now);
    const today = dayStart(now);
    const unpriced = [...counter.days.entries()].reduce((n, [day, b]) => (day >= today - (WINDOW_DAYS - 1) * DAY ? n + b.unpriced : n), 0);
    return { exempt, rows, unpriced };
  }

  /** Where the person stands against the limits that apply to them: the limit that blocks them (the one that lifts last), if any. Nothing awaits in here. */
  private evaluate(userId: string, { values, system }: { values: LimitsSettings; system: LimitsSettings }): { counter: Counter; hit: LimitHit | null } {
    const counter = this.counter(userId);
    const reached = this.rows(counter, values, system, this.now()).filter((r) => r.reached);
    if (!reached.length) return { counter, hit: null };
    // Everything that blocks must lift before requests go through, so the person is told the last of them.
    const worst = reached.reduce((a, b) => (b.resetsAt === null ? a : a.resetsAt === null || b.resetsAt > a.resetsAt ? b : a));
    return { counter, hit: { key: worst.key, used: worst.used, max: worst.max, resetsAt: worst.resetsAt } };
  }

  /**
   * Asks to start a model request for `userId`. Refused when a limit is reached, with the error that ends the turn;
   * otherwise the request is counted as under way until `release`, so runs started together can't all slip under a
   * request limit: the check and the count happen in one step, with nothing awaited between them.
   */
  async admit(userId: string | null): Promise<Admission> {
    if (!userId) return { release: () => {} };
    const { counter, hit } = this.evaluate(userId, await this.limitsOf(userId));
    if (hit) return { hit, error: await this.error(hit) };
    counter.inflight++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        counter.inflight = Math.max(0, counter.inflight - 1);
      },
    };
  }

  /**
   * Whether a request the person didn't ask for (a title, a suggestion, a memory update) may go ahead. It is not counted
   * as under way: it must never be what makes the person's own turn wait. Once recorded it counts like any other.
   */
  async check(userId: string | null): Promise<MessageError | null> {
    if (!userId) return null;
    const { hit } = this.evaluate(userId, await this.limitsOf(userId));
    return hit ? this.error(hit) : null;
  }

  /** The text of a refused turn: which limit, when it resets, who to ask. */
  async error(hit: LimitHit): Promise<MessageError> {
    const names = (await this.deps.admins?.().catch(() => [])) ?? [];
    const ask = names.length ? `an admin (${names.slice(0, 3).join(', ')})` : 'an admin';
    const priced = LIMIT_INFO[hit.key].unit === 'usd' ? ' Only requests to models with a price count toward a cost limit.' : '';
    const message =
      `You’ve reached your limit of ${formatLimitAmount(hit.key, hit.max)} (${limitPhrase(hit.key)}). ` +
      `It lets requests through again ${describeReset(hit.resetsAt, this.now())}.${priced} Ask ${ask} if you need more before then.`;
    return { code: LIMIT_REACHED, message, retryable: false };
  }

  /**
   * Limits the person has newly passed 80% of, once per limit and period: a daily limit once a day, the others until
   * usage falls back under the line. Reaching the limit itself isn't a warning; the next request says so.
   */
  async warnings(userId: string): Promise<LimitWarning[]> {
    const { values, system } = await this.limitsOf(userId);
    const counter = this.counter(userId);
    const now = this.now();
    const today = dayStart(now);
    const warnings: LimitWarning[] = [];
    for (const row of this.rows(counter, values, system, now)) {
      if (!row.near) {
        counter.warned.delete(row.key);
        continue;
      }
      if (row.reached) continue;
      const period = LIMIT_INFO[row.key].period === 'day' ? today : 0;
      if (counter.warned.get(row.key) === period) continue;
      counter.warned.set(row.key, period);
      const share = Math.round((row.used / row.max) * 100);
      warnings.push({
        key: row.key,
        used: row.used,
        max: row.max,
        resetsAt: row.resetsAt,
        message: `You’ve used ${share}% of your limit of ${formatLimitAmount(row.key, row.max)} (${limitPhrase(row.key)}).${row.resetsAt !== null ? ` It resets ${describeReset(row.resetsAt, now)}.` : ''}`,
      });
    }
    return warnings;
  }
}
