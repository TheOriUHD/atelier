/**
 * Tokens per day, stacked by mode (Recharts, loaded with the Usage page only). Series colors come from the
 * `--series-<mode>` variables the page sets, so the legend and the bars share them.
 */
import { Bar, BarChart, BarStack, CartesianGrid, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { MODE_LABELS, formatTokens, type DayTokens, type ModeKey } from './usage-data.ts';

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T00:00:00`));

const TICK = { fill: 'var(--at-color-text-muted)', fontSize: 12 };

export default function UsageChart({ data, modes }: { data: DayTokens[]; modes: ModeKey[] }) {
  return (
    <BarChart responsive data={data} style={{ width: '100%', height: 200 }} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--at-color-border-subtle)" />
      <XAxis dataKey="day" tickFormatter={dayLabel} tickLine={false} axisLine={{ stroke: 'var(--at-color-border)' }} tick={TICK} minTickGap={24} />
      <YAxis tickFormatter={formatTokens} tickLine={false} axisLine={false} tick={TICK} width={44} allowDecimals={false} />
      <Tooltip cursor={{ fill: 'var(--at-color-fill-ghost-hover)' }} content={(props) => <DayTooltip {...props} modes={modes} />} isAnimationActive={false} />
      {/* Rounds the top of each day's stack; a 2px surface stroke separates the modes in it. */}
      <BarStack radius={[4, 4, 0, 0]}>
        {modes.map((m) => (
          <Bar key={m} dataKey={m} name={MODE_LABELS[m]} fill={`var(--series-${m})`} stroke="var(--at-color-surface)" strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
        ))}
      </BarStack>
    </BarChart>
  );
}

function DayTooltip({ active, payload, modes }: Pick<TooltipContentProps, 'active' | 'payload'> & { modes: ModeKey[] }) {
  const day = payload[0]?.payload as DayTokens | undefined;
  if (!active || !day) return null;
  const used = modes.filter((m) => day[m] > 0).reverse();
  return (
    <div className="flex min-w-36 flex-col gap-1 rounded-lg bg-popover px-3 py-2 text-footnote text-fg shadow-popover">
      <span className="text-fg-secondary">{dayLabel(day.day)}</span>
      {used.length === 0 && <span className="text-fg-muted">No usage</span>}
      {used.map((m) => (
        <span key={m} className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full" style={{ background: `var(--series-${m})` }} />
          {MODE_LABELS[m]}
          <span className="ml-auto pl-3 tabular-nums">{formatTokens(day[m])}</span>
        </span>
      ))}
    </div>
  );
}
