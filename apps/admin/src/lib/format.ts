/** Numbers, sizes and times the way the panel shows them: decimal units (GB, not GiB), English, compact. */

export const num = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('en');

/** 1,234 → 1.2K; for axes and tight tiles. */
export function compact(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString('en');
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Bytes in decimal units: 950 B, 12 kB, 3.4 MB, 48 GB. */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return `${v.toLocaleString('en', { maximumFractionDigits: digits })} ${units[i]}`;
}

export const mhz = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) || n <= 0 ? '–' : `${Math.round(n).toLocaleString('en')} MHz`;

export const pct = (x: number | null | undefined, digits = 0): string =>
  x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(digits)}%`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function relative(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return date(ms, now);
}

/** "Nov 3", or "Nov 3, 2025" in another year. */
export function date(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Nov 14, 2026, 10:32". */
export const dateTime = (ms: number): string =>
  new Date(ms).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** A `YYYY-MM-DD` day (UTC) as "Nov 3". */
export const dayLabel = (day: string, withYear = false): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {}),
  });

/** "3 d 4 h", "5 h 12 min", "42 s". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '–';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

const OS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  none: 'Unknown',
};
export const osLabel = (platform: string | null | undefined): string =>
  platform ? (OS[platform] ?? platform) : 'Unknown';

/** "in-progress" → "In progress", "wont-fix" → "Won't fix". */
export function statusLabel(status: string): string {
  if (status === 'wont-fix') return 'Won’t fix';
  const s = status.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The days from `from` to `to` (inclusive), `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Positive when `a` is newer than `b` (`1.2.3-beta.4`; releases above their prereleases). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [core = '', pre = ''] = v.split('-');
    return [...core.split('.').map(Number), pre ? 0 : 1, pre] as (number | string)[];
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (typeof x[i] === 'number' && typeof y[i] === 'number') return (x[i] as number) - (y[i] as number) || 0;
    return String(x[i] ?? '') < String(y[i] ?? '') ? -1 : 1;
  }
  return 0;
}
