/**
 * The stats card under the Code and Cowork greetings (design/components.md › Code home): totals for a period, an
 * activity heatmap of the last 26 weeks and tokens per model. Only shown once the person has a session in the mode.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { parseModelRef, type StatsSummary } from '@atelier/protocol';
import { SegmentedControl, cn } from '../../components/ui/index.ts';
import { useModels } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';

type Period = 'all' | '30' | '7';
const PERIODS = [
  { value: 'all', label: 'All' },
  { value: '30', label: '30d' },
  { value: '7', label: '7d' },
] as const;
const VIEWS = [
  { value: 'overview', label: 'Overview' },
  { value: 'models', label: 'Models' },
] as const;

const WEEKS = 26;
/** Empty days, then four steps of the interactive blue by messages relative to the busiest day. */
const LEVELS = ['bg-fill-ghost-hover', 'bg-interactive/30', 'bg-interactive/55', 'bg-interactive/80', 'bg-interactive'];

/** Rough token counts (about 4 tokens for 3 words) of books people know, shortest first. */
const BOOKS = [
  { title: 'The Little Prince', tokens: 23_000 },
  { title: 'The Hobbit', tokens: 127_000 },
  { title: 'War and Peace', tokens: 780_000 },
  { title: 'the whole Harry Potter series', tokens: 1_450_000 },
  { title: 'the Encyclopædia Britannica', tokens: 53_000_000 },
];

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** A playful sense of scale: the longest of the books that `tokens` outgrows, or a share of the shortest. */
export function bookComparison(tokens: number): string | null {
  if (tokens <= 0) return null;
  const book = BOOKS.findLast((b) => b.tokens <= tokens);
  if (!book) return `You’ve used about ${Math.max(1, Math.round((tokens / BOOKS[0]!.tokens) * 100))}% of ${BOOKS[0]!.title} in tokens.`;
  const times = tokens / book.tokens;
  if (times < 1.5) return `You’ve used about as many tokens as ${book.title}.`;
  return `You’ve used ~${times < 10 ? +times.toFixed(1) : Math.round(times).toLocaleString()}× more tokens than ${book.title}.`;
}

function useStats(mode: 'code' | 'work', period: Period) {
  const days = period === 'all' ? null : (Number(period) as 7 | 30);
  return useQuery({
    queryKey: ['stats', mode, days],
    queryFn: () => rpc().call('stats.summary', { mode, days, timezoneOffset: new Date().getTimezoneOffset() }),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function StatsCard({ mode, className }: { mode: 'code' | 'work'; className?: string }) {
  const [view, setView] = useState<(typeof VIEWS)[number]['value']>('overview');
  const [period, setPeriod] = useState<Period>('all');
  const { data: stats } = useStats(mode, period);
  // Shown from the first visit: zeros and an empty heatmap until there are sessions.
  if (!stats) return null;
  return (
    <section aria-label={mode === 'code' ? 'Your Code stats' : 'Your Cowork stats'} className={cn('w-full max-w-[480px] rounded-2xl bg-raised p-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl size="xs" aria-label="Stats view" items={VIEWS} value={view} onValueChange={setView} />
        <SegmentedControl size="xs" aria-label="Period" items={PERIODS} value={period} onValueChange={setPeriod} />
      </div>
      {view === 'overview' ? <Overview stats={stats} /> : <Models stats={stats} />}
    </section>
  );
}

function useModelName(): (ref: string) => string {
  const { data: models } = useModels();
  return (ref) => models?.find((m) => m.ref === ref)?.displayName ?? parseModelRef(ref)?.modelId ?? ref;
}

function Overview({ stats }: { stats: StatsSummary }) {
  const modelName = useModelName();
  const tiles: [string, string][] = [
    ['Sessions', stats.sessions.toLocaleString()],
    ['Messages', stats.messages.toLocaleString()],
    ['Total tokens', compact.format(stats.tokens)],
    ['Active days', stats.activeDays.toLocaleString()],
    ['Peak hour', stats.peakHour === null ? '—' : new Date(2000, 0, 1, stats.peakHour).toLocaleTimeString(undefined, { hour: 'numeric' })],
    ['Favorite model', stats.favoriteModel ? modelName(stats.favoriteModel) : '—'],
  ];
  const caption = bookComparison(stats.tokens);
  return (
    <>
      <dl className="mt-3 grid grid-cols-3 gap-1">
        {tiles.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-lg bg-fill-ghost-hover px-2 py-1.5">
            <dt className="truncate text-caption text-fg-muted">{label}</dt>
            <dd title={value} className="truncate text-body font-semibold text-fg">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Heatmap days={stats.days} />
      {caption && <p className="mt-2.5 text-caption text-fg-muted">{caption}</p>}
    </>
  );
}

/** `YYYY-MM-DD` of a local date, as `stats.summary` names days. */
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** A column per week (Sunday on top), the current week last and cut at today. */
function Heatmap({ days }: { days: StatsSummary['days'] }) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells = Array.from({ length: (WEEKS - 1) * 7 + today.getDay() + 1 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const busiest = Math.max(1, ...cells.map((date) => byDay.get(dayKey(date))?.messages ?? 0));
  return (
    <div role="group" aria-label={`Activity in the last ${WEEKS} weeks`} className="mt-3 grid grid-flow-col grid-rows-7 auto-cols-fr gap-[3px]">
      {cells.map((date) => {
        const day = byDay.get(dayKey(date));
        const when = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const text = day ? `${plural(day.sessions, 'session')}, ${plural(day.messages, 'message')} on ${when}` : `No sessions on ${when}`;
        return <span key={date.getTime()} role="img" aria-label={text} title={text} className={cn('aspect-square rounded-[3px]', LEVELS[day ? Math.ceil((day.messages / busiest) * 4) : 0])} />;
      })}
    </div>
  );
}

function Models({ stats }: { stats: StatsSummary }) {
  const modelName = useModelName();
  if (!stats.models.length) return <p className="mt-3 text-body text-fg-muted">No tokens used in this period.</p>;
  return (
    <ul aria-label="Tokens by model" className="mt-3 flex flex-col gap-2">
      {stats.models.map((m) => {
        const share = m.tokens / Math.max(1, stats.tokens);
        return (
          <li key={m.ref} className="flex items-center gap-3 text-body">
            <span className="w-36 truncate text-fg">{modelName(m.ref)}</span>
            <span aria-hidden className="h-1 min-w-0 flex-1 rounded-full bg-fill-ghost-hover">
              <span className="block h-full rounded-full bg-interactive" style={{ width: `${share * 100}%` }} />
            </span>
            <span className="text-footnote text-fg-secondary tabular-nums">{compact.format(m.tokens)}</span>
            <span className="w-9 text-right text-footnote text-fg-muted tabular-nums">{Math.round(share * 100)}%</span>
          </li>
        );
      })}
    </ul>
  );
}
