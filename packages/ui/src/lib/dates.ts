const DAY = 86_400_000;
const dayOfMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * The sidebar's recents group for a time, by calendar day: "Today", "Yesterday", the date ("Oct 11") within the
 * past week, then "Previous 30 days" and "Older". Newest-first lists meet the groups in that order.
 */
export function recentGroup(timestamp: number, now = Date.now()): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfToday - DAY) return 'Yesterday';
  if (timestamp >= startOfToday - 6 * DAY) return dayOfMonth.format(timestamp);
  if (timestamp >= startOfToday - 30 * DAY) return 'Previous 30 days';
  return 'Older';
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < DAY / 1000) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * (DAY / 1000)) return relative.format(Math.round(seconds / (DAY / 1000)), 'day');
  if (abs < 365 * (DAY / 1000)) return relative.format(Math.round(seconds / (30 * (DAY / 1000))), 'month');
  return relative.format(Math.round(seconds / (365 * (DAY / 1000))), 'year');
}

/** The new-chat greeting: "Morning, Ada" by the time of day, and something playful in the small hours. */
export function greeting(name: string | undefined, date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Hello, night owl';
  const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  return name ? `${part}, ${name}` : `Good ${part.toLowerCase()}`;
}

const mediumDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "Oct 13, 2026" in the user's locale. */
export function shortDate(timestamp: number): string {
  return mediumDate.format(timestamp);
}
