/**
 * The collector's limits and the small pieces both it and the admin Worker (deploy/admin) need: what a day is, how hard
 * the proof of work is, the statuses a report can have. Plain functions, no Worker APIs.
 */

export const POLICY = {
  /** How long a challenge can be answered. */
  challengeTtlMs: 10 * 60_000,
  /** Reports kept per address and day (D1 `report_quota`). */
  perAddressPerDay: 20,
  /** Reports kept per day, from everyone: past it the collector answers 503 until midnight UTC. */
  perDay: 1500,
  /** What R2 may hold in all; past it the collector answers 503 "The collector is full". */
  storageBytes: 8_000_000_000,
  /** The rate limiting bindings in wrangler.toml, per address and minute (approximate, per Cloudflare location). */
  rate: { reports: { limit: 4, period: 60 }, challenges: { limit: 12, period: 60 } },
  /** Kept this long, then deleted by the admin Worker's cron with their files. */
  retentionDays: 365,
  /** Quota rows are deleted when they are older than this many days. */
  quotaDays: 2,
};

/**
 * The proof of work's difficulty, from how many reports came in today: about 0.3 s of one core at 18 bits, 1 s at
 * 20 and 5 s at 22 (each bit doubles it). A flood makes every later report cost more.
 */
export const BITS_STEPS = [
  { below: 200, bits: 18 },
  { below: 800, bits: 20 },
  { below: Infinity, bits: 22 },
];
export const bitsFor = (reportsToday) => BITS_STEPS.find((s) => reportsToday < s.below).bits;

/** The UTC day of a moment, `YYYY-MM-DD`. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Seconds until the next UTC midnight: when the daily limits start over. */
export function secondsToMidnight(ms) {
  const next = new Date(ms);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - ms) / 1000));
}

/** What a report can be marked as, per kind; every report starts as `new`. */
export const STATUSES = {
  issue: ['new', 'triaged', 'in-progress', 'fixed', 'wont-fix', 'duplicate'],
  feature: ['new', 'planned', 'in-progress', 'done', 'declined', 'duplicate'],
};
/** The statuses that close a report: the inbox's "Open" filter leaves them out. */
export const CLOSED_STATUSES = ['fixed', 'wont-fix', 'duplicate', 'done', 'declined'];

/** The key in D1 `collector_state` that holds the bytes stored in R2. */
export const STORED_BYTES = 'stored_bytes';

/** Where a report's files are in R2. */
export const reportPrefix = (id) => `reports/${id}/`;

/** The file a screenshot is stored as, by its type. */
export const SHOT_EXTENSIONS = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
