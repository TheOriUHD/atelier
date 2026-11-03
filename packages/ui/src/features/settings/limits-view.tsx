import { LIMIT_INFO, type LimitsStatus, type LimitStatusRow } from '@atelier/protocol';
import { ProgressBar } from '../../components/ui/index.ts';
import { formatTokens, formatUsd } from './usage-data.ts';

/** "420K of 1M tokens", "$2.40 of $5.00", "12 of 30 requests". */
export function limitAmounts(row: Pick<LimitStatusRow, 'key' | 'used' | 'max'>): string {
  const { unit } = LIMIT_INFO[row.key];
  if (unit === 'usd') return `${formatUsd(row.used)} of ${formatUsd(row.max)}`;
  if (unit === 'tokens') return `${formatTokens(row.used)} of ${formatTokens(row.max)} tokens`;
  return `${row.used.toLocaleString('en-US')} of ${row.max.toLocaleString('en-US')} ${row.max === 1 ? 'request' : 'requests'}`;
}

export const limitTone = (row: Pick<LimitStatusRow, 'reached' | 'near'>) => (row.reached ? 'danger' : row.near ? 'warning' : 'default');

/** The row closest to its limit, for a table cell that has room for one. */
export function closestLimit(status: LimitsStatus): LimitStatusRow | null {
  return [...status.rows].sort((a, b) => b.used / b.max - a.used / a.max)[0] ?? null;
}

/** "today at 2:00 AM" / "Nov 9, 2:00 AM", in the viewer's time zone. The limits themselves reset at 00:00 UTC. */
export function resetText(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at - now < 24 * 3_600_000) return `at ${time}`;
  return `on ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

/** One limit as a labelled bar: amounts used, and when it resets once that matters. */
export function LimitMeter({ row }: { row: LimitStatusRow }) {
  const label = LIMIT_INFO[row.key].label;
  const share = Math.min(100, Math.round((row.used / row.max) * 100));
  const daily = LIMIT_INFO[row.key].period === 'day';
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline justify-between gap-4 text-body">
        <span className="text-fg">{label}</span>
        <span className="text-fg-secondary tabular-nums">{limitAmounts(row)}</span>
      </div>
      <ProgressBar value={row.used / row.max} tone={limitTone(row)} aria-label={`${label}: ${share}% used`} />
      <p className="text-footnote text-fg-muted">
        {row.reached
          ? `Limit reached. ${row.resetsAt === null ? 'It lifts when your running requests finish.' : `It lifts ${resetText(row.resetsAt)}.`}`
          : row.near
            ? `${share}% used.${row.resetsAt === null ? '' : ` Resets ${resetText(row.resetsAt)}.`}`
            : daily && row.resetsAt !== null
              ? `Resets ${resetText(row.resetsAt)} (00:00 UTC).`
              : LIMIT_INFO[row.key].period === 'hour'
                ? 'Counts the last 60 minutes.'
                : 'Counts today and the 29 days before it.'}
      </p>
    </div>
  );
}

/** Says that cost limits skip requests without a price, when the person has such requests and a cost limit. */
export function unpricedNote(status: LimitsStatus): string | null {
  const costLimited = status.rows.some((r) => LIMIT_INFO[r.key].unit === 'usd');
  if (!costLimited || status.unpriced === 0) return null;
  return `${status.unpriced.toLocaleString('en-US')} ${status.unpriced === 1 ? 'request' : 'requests'} in the last 30 days had no price (models without one, such as local models). A cost limit doesn't count them; a token limit does.`;
}
