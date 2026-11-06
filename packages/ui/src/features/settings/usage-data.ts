/** Settings › Usage: totals, days and models from `usage.summary` rows (one per day, model and mode). */
import type { UsageRow } from '@atelier/protocol';

export const MODES = ['chat', 'work', 'code', 'other'] as const;
export type ModeKey = (typeof MODES)[number];
export const MODE_LABELS: Record<ModeKey, string> = { chat: 'Chat', work: 'Cowork', code: 'Code', other: 'Other' };

const modeOf = (row: UsageRow): ModeKey => (MODES as readonly string[]).includes(row.mode) ? (row.mode as ModeKey) : 'other';

/** Every token a request processed: its whole prompt (`input` excludes cache reads and writes) and its output. */
export const tokensOf = (r: Pick<UsageRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => r.input + r.cacheRead + r.cacheWrite + r.output;

/** Image rows count images and dollars: they have no tokens, and a local image with no price isn't a request missing one. */
export const isImageRow = (r: Pick<UsageRow, 'images'>) => (r.images ?? 0) > 0;
export const isVideoRow = (r: Pick<UsageRow, 'videos'>) => (r.videos ?? 0) > 0;
export const isAudioRow = (r: Pick<UsageRow, 'audios'>) => (r.audios ?? 0) > 0;
/** Pictures, clips and sounds have no tokens: none is a request to a text model. */
export const isMediaRow = (r: Pick<UsageRow, 'images' | 'videos' | 'audios'>) => isImageRow(r) || isVideoRow(r) || isAudioRow(r);

export interface UsageTotals {
  /** Requests to text models; images are counted apart. */
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  images: number;
  videos: number;
  /** Seconds of video in all. */
  videoSeconds: number;
  /** Sounds, and their seconds in all. */
  audios: number;
  audioSeconds: number;
  /** Of the priced requests, images and videos. */
  cost: number;
  /** How much of `cost` comes from a price list rather than from the service. */
  estimated: number;
  /** Requests and image rows with a price. */
  priced: number;
  unpriced: number;
}

export function totals(rows: readonly UsageRow[]): UsageTotals {
  const t: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, images: 0, videos: 0, videoSeconds: 0, audios: 0, audioSeconds: 0, cost: 0, estimated: 0, priced: 0, unpriced: 0 };
  for (const r of rows) {
    t.cost += r.costUsd ?? 0;
    t.estimated += r.estimatedUsd ?? 0;
    if (isMediaRow(r)) {
      t.images += r.images ?? 0;
      t.videos += r.videos ?? 0;
      t.videoSeconds += r.videoSeconds ?? 0;
      t.audios += r.audios ?? 0;
      t.audioSeconds += r.audioSeconds ?? 0;
      t.priced += r.requests - r.unpriced;
      continue;
    }
    t.requests += r.requests;
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.tokens += tokensOf(r);
    t.priced += r.requests - r.unpriced;
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

/** One entry per text model, most tokens first. */
export function byModel(rows: readonly UsageRow[]): ModelUsage[] {
  const models = new Map<string, ModelUsage>();
  // Requests behind each model's average speed so far.
  const timed = new Map<string, number>();
  for (const r of rows) {
    if (isMediaRow(r)) continue;
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

export interface ImageModelUsage {
  ref: string;
  providerId: string;
  modelId: string;
  images: number;
  /** Null when none of its images had a price, as on a local server. */
  cost: number | null;
  /** How much of `cost` comes from a price list. */
  estimated: number;
}

/** One entry per image model, most images first. */
export function byImageModel(rows: readonly UsageRow[]): ImageModelUsage[] {
  const models = new Map<string, ImageModelUsage>();
  for (const r of rows) {
    if (!isImageRow(r)) continue;
    const ref = `${r.providerId}/${r.modelId}`;
    const m = models.get(ref) ?? { ref, providerId: r.providerId, modelId: r.modelId, images: 0, cost: null, estimated: 0 };
    m.images += r.images!;
    m.estimated += r.estimatedUsd ?? 0;
    if (r.costUsd !== null) m.cost = (m.cost ?? 0) + r.costUsd;
    models.set(ref, m);
  }
  return [...models.values()].sort((a, b) => b.images - a.images);
}

export interface VideoModelUsage {
  ref: string;
  providerId: string;
  modelId: string;
  videos: number;
  seconds: number;
  cost: number | null;
  estimated: number;
}

/** One entry per video model, most videos first. */
export function byVideoModel(rows: readonly UsageRow[]): VideoModelUsage[] {
  const models = new Map<string, VideoModelUsage>();
  for (const r of rows) {
    if (!isVideoRow(r)) continue;
    const ref = `${r.providerId}/${r.modelId}`;
    const m = models.get(ref) ?? { ref, providerId: r.providerId, modelId: r.modelId, videos: 0, seconds: 0, cost: null, estimated: 0 };
    m.videos += r.videos!;
    m.seconds += r.videoSeconds ?? 0;
    m.estimated += r.estimatedUsd ?? 0;
    if (r.costUsd !== null) m.cost = (m.cost ?? 0) + r.costUsd;
    models.set(ref, m);
  }
  return [...models.values()].sort((a, b) => b.videos - a.videos);
}

export interface AudioModelUsage {
  ref: string;
  providerId: string;
  modelId: string;
  sounds: number;
  seconds: number;
  /** Characters read out, for speech. */
  chars: number;
  cost: number | null;
  estimated: number;
}

/** One entry per sound model, most sounds first. */
export function byAudioModel(rows: readonly UsageRow[]): AudioModelUsage[] {
  const models = new Map<string, AudioModelUsage>();
  for (const r of rows) {
    if (!isAudioRow(r)) continue;
    const ref = `${r.providerId}/${r.modelId}`;
    const m = models.get(ref) ?? { ref, providerId: r.providerId, modelId: r.modelId, sounds: 0, seconds: 0, chars: 0, cost: null, estimated: 0 };
    m.sounds += r.audios!;
    m.seconds += r.audioSeconds ?? 0;
    m.chars += r.audioChars ?? 0;
    m.estimated += r.estimatedUsd ?? 0;
    if (r.costUsd !== null) m.cost = (m.cost ?? 0) + r.costUsd;
    models.set(ref, m);
  }
  return [...models.values()].sort((a, b) => b.sounds - a.sounds);
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
