/**
 * Whether this computer shows a 12-hour or a 24-hour clock, for the times the page shows. The page's own locale is the
 * app's language, which says nothing of the clock: English with region Germany is "en-US" there, and would get
 * "2:25 PM" where the menu bar says 14:25.
 */
export type HourCycle = 'h12' | 'h23';

/** The clock a locale tag uses ("de-DE" → h23, "en-US" → h12); null for a tag Intl doesn't take. */
export function localeHourCycle(tag: string): HourCycle | null {
  try {
    const cycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h11' || cycle === 'h12' ? 'h12' : cycle ? 'h23' : null;
  } catch {
    return null;
  }
}

/** Windows' short time pattern ("HH:mm", "h:mm tt"): H is the 24-hour clock, h the 12-hour one. */
export function shortTimeHourCycle(pattern: string): HourCycle | null {
  return pattern.includes('H') ? 'h23' : pattern.includes('h') ? 'h12' : null;
}

/** A POSIX locale ("de_DE.UTF-8", "en_US@euro") as a tag; null for C and POSIX, which name no clock. */
export function posixLocaleTag(locale: string | undefined): string | null {
  const tag = locale?.split(/[.@]/)[0]?.replace('_', '-');
  return tag && tag !== 'C' && tag !== 'POSIX' ? tag : null;
}

export interface ClockSources {
  platform: NodeJS.Platform;
  /** macOS: System Settings › Date & Time › 24-hour time, when it was turned on or off ("AppleICUForce24HourTime"). */
  force24(): boolean;
  force12(): boolean;
  /** `app.getSystemLocale()` ("en-US@rg=dezzzz") and `app.getLocaleCountryCode()` ("DE"). */
  systemLocale(): string;
  country(): string;
  /** Windows: HKCU\Control Panel\International's sShortTime, null when it can't be read. */
  shortTime(): Promise<string | null>;
  env: NodeJS.ProcessEnv;
}

/** This computer's clock; null when it can't tell, and the page keeps its locale's. */
export async function systemHourCycle(s: ClockSources): Promise<HourCycle | null> {
  if (s.platform === 'darwin') {
    if (s.force24()) return 'h23';
    if (s.force12()) return 'h12';
    // Otherwise the region decides: English in Germany shows 14:25.
    const language = s.systemLocale().split(/[-_@]/)[0];
    return language && s.country() ? localeHourCycle(`${language}-${s.country()}`) : null;
  }
  if (s.platform === 'win32') {
    const pattern = await s.shortTime().catch(() => null);
    return pattern ? shortTimeHourCycle(pattern) : null;
  }
  const tag = posixLocaleTag(s.env.LC_ALL || s.env.LC_TIME || s.env.LANG);
  return tag ? localeHourCycle(tag) : null;
}

/** sShortTime from `reg query`'s output ("    sShortTime    REG_SZ    HH:mm"). */
export function parseShortTime(output: string): string | null {
  return /sShortTime\s+REG_SZ\s+(.+)/.exec(output)?.[1]?.trim() || null;
}
