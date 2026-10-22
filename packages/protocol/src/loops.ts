/**
 * `/loop [interval] <prompt>` (Code and Cowork): sends the prompt now and again every interval, each time once the
 * session is idle, until it is stopped, its session is deleted or it reaches its limits. The composer reads the command
 * with these rules; the backend keeps the loops and applies the shortest interval.
 */

/** Without an interval, a loop repeats every ten minutes. */
export const LOOP_DEFAULT_INTERVAL_MS = 10 * 60_000;
/** The shortest interval: shorter ones are rounded up to it. */
export const LOOP_MIN_INTERVAL_MS = 60_000;
/** The longest interval: a day. */
export const LOOP_MAX_INTERVAL_MS = 24 * 3_600_000;
/** A loop ends after this many runs… */
export const LOOP_MAX_RUNS = 500;
/** …or this long after it started, whichever comes first. */
export const LOOP_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Loops one session may have running at once… */
export const LOOP_MAX_PER_SESSION = 5;
/** …and one person, across their sessions. */
export const LOOP_MAX_PER_USER = 20;

export type LoopCommand =
  /** `/loop`: show the session's loops. */
  | { action: 'list' }
  /** `/loop stop [n|id]`: stop all of the session's loops, or one (its number in the list, or its id). */
  | { action: 'stop'; target: string | null }
  | { action: 'start'; intervalMs: number; prompt: string }
  | { action: 'error'; message: string };

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;

/** `30s`, `5m`, `2h`, `1d`, or a combination in that order (`1h30m`); null when `text` isn't one. */
export function parseInterval(text: string): number | null {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(text);
  if (!m || !text) return null;
  const [, d = '0', h = '0', min = '0', s = '0'] = m;
  return Number(d) * UNIT_MS.d + Number(h) * UNIT_MS.h + Number(min) * UNIT_MS.m + Number(s) * UNIT_MS.s;
}

/** "45s", "5m", "2h", "1h 30m", "1d". */
export function formatInterval(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) parts.push(`${n}${unit}`);
  }
  return parts.join(' ') || '0s';
}

/** What the text after `/loop` asks for. */
export function parseLoopCommand(args: string): LoopCommand {
  const text = args.trim();
  if (!text || /^list$/i.test(text)) return { action: 'list' };
  const stop = /^stop(?:\s+(\S+))?$/i.exec(text);
  if (stop) return { action: 'stop', target: stop[1] ?? null };
  const [first = '', ...rest] = text.split(/\s+/);
  const interval = parseInterval(first);
  if (interval === null) return { action: 'start', intervalMs: LOOP_DEFAULT_INTERVAL_MS, prompt: text };
  const prompt = text.slice(first.length).trim();
  if (!rest.length || !prompt) return { action: 'error', message: `Add what to send every ${formatInterval(interval)}, like “/loop ${first} check the deploy”.` };
  if (interval <= 0) return { action: 'error', message: 'The interval has to be longer than zero.' };
  if (interval > LOOP_MAX_INTERVAL_MS) return { action: 'error', message: `The longest interval is ${formatInterval(LOOP_MAX_INTERVAL_MS)}.` };
  return { action: 'start', intervalMs: interval, prompt };
}
