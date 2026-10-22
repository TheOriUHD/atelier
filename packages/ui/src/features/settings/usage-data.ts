/** Settings › Usage: totals, days and models from `usage.summary` rows (one per day, model and mode). */
import type { UsageRow } from '@atelier/protocol';

export const MODES = ['chat', 'work', 'code', 'other'] as const;
export type ModeKey = (typeof MODES)[number];
export const MODE_LABELS: Record<ModeKey, string> = { chat: 'Chat', work: 'Cowork', code: 'Code', other: 'Other' };

const modeOf = (row: UsageRow): ModeKey => (MODES as readonly string[]).includes(row.mode) ? (row.mode as ModeKey) : 'other';

/** Every token a request processed: its whole prompt (`input` excludes cache reads and writes) and its output. */
export const tokensOf = (r: Pick<UsageRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => r.input + r.cacheRead + r.cacheWrite + r.output;

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** Of the priced requests. */
  cost: number;
  unpriced: number;
}

export function totals(rows: readonly UsageRow[]): UsageTotals {
  const t: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, unpriced: 0 };
  for (const r of rows) {
    t.requests += r.requests;
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.tokens += tokensOf(r);
    t.cost += r.costUsd ?? 0;
    t.unpriced += r.unpriced;
  }
  return t;
}

/** Totals of the last `days` days (1: today), in local time, from the rows of a period at least that long. */
export function totalsSince(rows: readonly UsageRow[], days: number, now = new Date()): UsageTotals {
  const first = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
  return totals(rows.filter((r) => r.day >= first));
}

export type DayTokens = { day: string } & Record<ModeKey, number>;

/** `YYYY-MM-DD` in local time, as `usage.summary` names days. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Tokens per mode for each of the last `days` days, oldest first, with the quiet days at zero. */
export function tokensByDay(rows: readonly UsageRow[], days: number, now = new Date()): DayTokens[] {
  const list: DayTokens[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    list.push({ day: localDay(date), chat: 0, work: 0, code: 0, other: 0 });
  }
  const byDay = new Map(list.map((d) => [d.day, d]));
  for (const r of rows) {
    const day = byDay.get(r.day);
    if (day) day[modeOf(r)] += tokensOf(r);
  }
  return list;
}

/** Each mode's share of the tokens, for the modes that were used, largest first. */
export function modeShares(rows: readonly UsageRow[]): { mode: ModeKey; share: number }[] {
  const sums = new Map<ModeKey, number>();
  for (const r of rows) sums.set(modeOf(r), (sums.get(modeOf(r)) ?? 0) + tokensOf(r));
  const all = [...sums.values()].reduce((a, b) => a + b, 0);
  return MODES.filter((m) => sums.get(m)).map((mode) => ({ mode, share: sums.get(mode)! / all })).sort((a, b) => b.share - a.share);
}

export interface ModelUsage {
  ref: string;
  providerId: string;
  modelId: string;
  requests: number;
  tokens: number;
  /** Null when none of its requests had a price. */
  cost: number | null;
  unpriced: number;
  /** Output speed averaged over requests, when the provider reported it. */
  tokensPerSecond: number | null;
}

/** One entry per model, most tokens first. */
export function byModel(rows: readonly UsageRow[]): ModelUsage[] {
  const models = new Map<string, ModelUsage>();
  // Requests behind each model's average speed so far.
  const timed = new Map<string, number>();
  for (const r of rows) {
    const ref = `${r.providerId}/${r.modelId}`;
    const m = models.get(ref) ?? { ref, providerId: r.providerId, modelId: r.modelId, requests: 0, tokens: 0, cost: null, unpriced: 0, tokensPerSecond: null };
    m.requests += r.requests;
    m.tokens += tokensOf(r);
    m.unpriced += r.unpriced;
    if (r.costUsd !== null) m.cost = (m.cost ?? 0) + r.costUsd;
    if (r.tokensPerSecond !== null) {
      const before = timed.get(ref) ?? 0;
      m.tokensPerSecond = ((m.tokensPerSecond ?? 0) * before + r.tokensPerSecond * r.timed) / (before + r.timed);
      timed.set(ref, before + r.timed);
    }
    models.set(ref, m);
  }
  return [...models.values()].sort((a, b) => b.tokens - a.tokens);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');

/** "980", "12.4K", "3.1M". */
export const formatTokens = (n: number) => (n < 1000 ? whole.format(n) : compact.format(n));

/** "$0.42", "$1,280.00"; amounts under a cent read "<$0.01". */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return '<$0.01';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
