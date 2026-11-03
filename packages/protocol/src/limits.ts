/**
 * Usage limits for text models on a shared server (ARCHITECTURE §8, §21). Admins set them for everyone in
 * `settings.limits` and can raise, lower or lift them for one person on the user record. All of them are off until set.
 * Days are UTC days (like the image limits); "30 days" is today and the 29 UTC days before it.
 */
import { z } from 'zod';

export const LIMIT_KEYS = ['tokensPerDay', 'tokensPer30Days', 'costUsdPerDay', 'costUsdPer30Days', 'requestsPerHour'] as const;
export const LimitKey = z.enum(LIMIT_KEYS);
export type LimitKey = z.infer<typeof LimitKey>;

export interface LimitInfo {
  unit: 'tokens' | 'usd' | 'requests';
  period: 'day' | '30 days' | 'hour';
  /** The admin's label for it, and the person's name for it in sentences ("your limit of 200,000 tokens per day"). */
  label: string;
}

export const LIMIT_INFO: Record<LimitKey, LimitInfo> = {
  tokensPerDay: { unit: 'tokens', period: 'day', label: 'Tokens per day' },
  tokensPer30Days: { unit: 'tokens', period: '30 days', label: 'Tokens per 30 days' },
  costUsdPerDay: { unit: 'usd', period: 'day', label: 'Cost per day' },
  costUsdPer30Days: { unit: 'usd', period: '30 days', label: 'Cost per 30 days' },
  requestsPerHour: { unit: 'requests', period: 'hour', label: 'Requests per hour' },
};

/** What each person may use, absent meaning no limit. Tokens are input, output and cache together, as on the Usage page. */
export const LimitsSettings = z.object({
  tokensPerDay: z.number().int().positive().optional(),
  tokensPer30Days: z.number().int().positive().optional(),
  /** Only requests with a price count (a local model has none). */
  costUsdPerDay: z.number().positive().optional(),
  costUsdPer30Days: z.number().positive().optional(),
  requestsPerHour: z.number().int().positive().optional(),
});
export type LimitsSettings = z.infer<typeof LimitsSettings>;

/**
 * An admin's override for one person. A number replaces the system limit for them, `null` lifts that limit, absent
 * follows the system. `exempt` lifts them all.
 */
export const UserLimits = z.object({
  exempt: z.boolean().optional(),
  tokensPerDay: z.number().int().positive().nullable().optional(),
  tokensPer30Days: z.number().int().positive().nullable().optional(),
  costUsdPerDay: z.number().positive().nullable().optional(),
  costUsdPer30Days: z.number().positive().nullable().optional(),
  requestsPerHour: z.number().int().positive().nullable().optional(),
});
export type UserLimits = z.infer<typeof UserLimits>;

/** The limits that apply to one person: the system's, changed by their override. */
export function effectiveLimits(system: LimitsSettings, person: UserLimits | null | undefined): { exempt: boolean; values: LimitsSettings } {
  if (person?.exempt) return { exempt: true, values: {} };
  const values: LimitsSettings = {};
  for (const key of LIMIT_KEYS) {
    const own = person?.[key];
    const value = own === undefined ? system[key] : own;
    if (value !== null && value !== undefined) values[key] = value;
  }
  return { exempt: false, values };
}

/** A person is warned when they pass this share of a limit. */
export const LIMIT_WARN_AT = 0.8;

export const LimitStatusRow = z.object({
  key: LimitKey,
  used: z.number(),
  max: z.number(),
  /** When enough has aged out for the limit to let requests through again; null when it can't be said (requests under way). */
  resetsAt: z.number().nullable(),
  /** At or over the limit: requests are refused. */
  reached: z.boolean(),
  /** At or over {@link LIMIT_WARN_AT} of it. */
  near: z.boolean(),
  /** The person's own limit differs from the system's (an override). */
  overridden: z.boolean().optional(),
});
export type LimitStatusRow = z.infer<typeof LimitStatusRow>;

/** One person's usage against the limits that apply to them. */
export const LimitsStatus = z.object({
  exempt: z.boolean(),
  rows: z.array(LimitStatusRow),
  /** Requests in the last 30 days with no price: cost limits don't count them. */
  unpriced: z.number().int().nonnegative(),
});
export type LimitsStatus = z.infer<typeof LimitsStatus>;

/** An admin's row for one person on the Limits page. */
export const PersonLimits = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  disabled: z.boolean(),
  status: LimitsStatus,
  /** Their override as stored. */
  own: UserLimits,
});
export type PersonLimits = z.infer<typeof PersonLimits>;

/** Shown above the message box once per limit and period, when the person passes 80% of it. */
export const LimitWarning = z.object({
  key: LimitKey,
  used: z.number(),
  max: z.number(),
  resetsAt: z.number().nullable(),
  message: z.string(),
});
export type LimitWarning = z.infer<typeof LimitWarning>;

/** `limit_reached` is the MessageError code of a turn a limit stopped. */
export const LIMIT_REACHED = 'limit_reached';

/** "200,000 tokens", "$5.00", "30 requests". */
export function formatLimitAmount(key: LimitKey, n: number): string {
  const { unit } = LIMIT_INFO[key];
  if (unit === 'usd') return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const count = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return unit === 'tokens' ? `${count} tokens` : `${count} ${n === 1 ? 'request' : 'requests'}`;
}

/** "tokens per day": the limit named in a sentence. */
export function limitPhrase(key: LimitKey): string {
  const { unit, period } = LIMIT_INFO[key];
  const what = unit === 'tokens' ? 'tokens' : unit === 'usd' ? 'cost' : 'requests';
  return `${what} per ${period}`;
}
