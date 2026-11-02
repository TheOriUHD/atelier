/**
 * Settings › Admin › Activity: the admin activity log of a shared server (ARCHITECTURE §21). A filterable list of who
 * changed what, newest first, that loads more as it is scrolled, and an export of what the filters match as JSON.
 * Narrow screens get cards instead of a table; nothing here needs sideways scrolling.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, Download, RefreshCw } from 'lucide-react';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, auditCategory, type AuditEvent, type AuditFilter } from '@atelier/protocol';
import { Badge, Button, Icon, Select, TextField, cn, toast, type BadgeTone, type SelectOption } from '../../components/ui/index.ts';
import { useNarrow } from '../../lib/narrow.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { downloadText } from '../artifacts/artifact-files.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { settingEntry } from './search-index.ts';
import { useSetting } from './use-setting.ts';

const ALL = 'all';
const PAGE = 50;
/** The retention choices; the stored value may be any whole number from 7 to 365, and shows as itself when it isn't one of these. */
const RETENTION_CHOICES = [7, 14, 30, 60, 90, 180, 365];

const CATEGORY_OPTIONS: SelectOption[] = [{ value: ALL, label: 'All activity' }, ...AUDIT_CATEGORIES.map((c) => ({ value: c, label: AUDIT_CATEGORY_LABELS[c] ?? c }))];

export function ActivityPage() {
  // One set of filters for the list and the export under it.
  const filters = useFilters();
  return (
    <>
      <LogSection filters={filters} />
      <KeepSection filter={filters.filter} />
    </>
  );
}

/** Midnight at the start of a `YYYY-MM-DD` day in the viewer's time zone, or the last millisecond of it. */
export function dayBounds(day: string, end: boolean): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const at = end ? new Date(year, month, date, 23, 59, 59, 999) : new Date(year, month, date);
  // 2026-13-45 would roll over into a real day; it isn't one.
  return at.getFullYear() === year && at.getMonth() === month && at.getDate() === date ? at.getTime() : undefined;
}

function useFilters() {
  const [category, setCategory] = useState<string>(ALL);
  const [person, setPerson] = useState('');
  const [typed, setTyped] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // The person field asks once typing stops, not at every key.
  useEffect(() => {
    const timer = setTimeout(() => setPerson(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const start = dayBounds(from, false);
  const finish = dayBounds(to, true);
  const filter: AuditFilter = {
    ...(category !== ALL ? { kind: category } : {}),
    ...(person ? { user: person } : {}),
    ...(start !== undefined ? { from: start } : {}),
    ...(finish !== undefined ? { to: finish } : {}),
  };
  const active = Object.keys(filter).length > 0 || typed !== '';
  return { filter, active, category, setCategory, typed, setTyped, from, setFrom, to, setTo, clear: () => (setCategory(ALL), setTyped(''), setPerson(''), setFrom(''), setTo('')) };
}

function LogSection({ filters }: { filters: ReturnType<typeof useFilters> }) {
  const entry = settingEntry('activity.log');
  const narrow = useNarrow();
  const query = useInfiniteQuery({
    queryKey: ['audit', 'events', filters.filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => rpc().call('audit.list', { ...filters.filter, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 0,
  });
  const events = query.data?.pages.flatMap((p) => p.events) ?? [];
  const [open, setOpen] = useState<string | null>(null);

  // Loads the next page when the end of the list scrolls into view; the button below does the same where that can't happen.
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const node = end.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const watcher = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && !isFetchingNextPage && void fetchNextPage(), { rootMargin: '240px' });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, events.length]);

  return (
    <SettingsSection
      id="activity.log"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" variant="ghost" leadingIcon={RefreshCw} loading={query.isRefetching && !isFetchingNextPage} onClick={() => void query.refetch()}>
          Refresh
        </Button>
      }
    >
      <Filters {...filters} />
      {query.isError ? (
        <p role="alert" className="py-3 text-body text-danger-text">
          {describeError(query.error).message}
        </p>
      ) : query.isPending ? (
        <p className="py-3 text-body text-fg-muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="py-3 text-body text-fg-muted">{filters.active ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}</p>
      ) : narrow ? (
        <ul aria-label="Activity" className="flex flex-col">
          {events.map((e) => (
            <EventCard key={e.id} event={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
          ))}
        </ul>
      ) : (
        <DataTable
          label="Activity"
          columns={[{ label: 'When', className: 'w-44' }, { label: 'Who', className: 'w-32' }, { label: 'What' }, { label: 'From', className: 'w-32' }]}
        >
          {events.map((e) => (
            <EventRow key={e.id} event={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
          ))}
        </DataTable>
      )}
      <div ref={end} className="flex justify-center py-3">
        {hasNextPage && (
          <Button size="sm" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}

function Filters({ category, setCategory, typed, setTyped, from, setFrom, to, setTo, active, clear }: ReturnType<typeof useFilters>) {
  return (
    <div role="search" aria-label="Filter activity" className="mb-3 flex flex-wrap items-center gap-2">
      <Select variant="field" aria-label="Type of activity" className="w-44" options={CATEGORY_OPTIONS} value={category} onValueChange={setCategory} />
      <TextField aria-label="Person" placeholder="Person (username)" className="w-44" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <div className="flex items-center gap-1.5 text-footnote text-fg-muted">
        <span aria-hidden>From</span>
        <TextField type="date" aria-label="From date" className="w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex items-center gap-1.5 text-footnote text-fg-muted">
        <span aria-hidden>To</span>
        <TextField type="date" aria-label="To date" className="w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </div>
      {active && (
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** Sign-in trouble stands out; the rest is plain. */
export function toneOf(kind: string): BadgeTone {
  if (kind === 'signin.blocked') return 'danger';
  if (kind === 'signin.failed') return 'warning';
  return 'neutral';
}

const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });

function Kind({ kind }: { kind: string }) {
  return <Badge tone={toneOf(kind)}>{AUDIT_CATEGORY_LABELS[auditCategory(kind)] ?? auditCategory(kind)}</Badge>;
}

function EventRow({ event, open, onToggle }: { event: AuditEvent; open: boolean; onToggle(): void }) {
  return (
    <Fragment>
      <TableRow className="h-auto">
        <Cell className="text-footnote whitespace-nowrap tabular-nums">{time(event.at)}</Cell>
        <Cell className="truncate" title={event.actor ?? undefined}>
          {event.actor ?? '—'}
        </Cell>
        <Cell>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex w-full items-start gap-2 rounded-xs py-0.5 text-left outline-none focus-ring hover:text-fg"
          >
            <Icon icon={ChevronRight} size="sm" className={cn('mt-[3px] shrink-0 text-fg-muted transition-transform', open && 'rotate-90')} />
            <span className="min-w-0 flex-1 break-words">
              <Kind kind={event.kind} /> <span className="text-fg">{event.summary}</span>
            </span>
          </button>
        </Cell>
        <Cell className="truncate font-mono text-code" title={event.ip ?? undefined}>
          {event.ip ?? '—'}
        </Cell>
      </TableRow>
      {open && (
        <tr className="border-b border-line-subtle">
          <td colSpan={4} className="pb-3 pl-6">
            <Details event={event} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function EventCard({ event, open, onToggle }: { event: AuditEvent; open: boolean; onToggle(): void }) {
  return (
    <li className="border-b border-line-subtle py-3 last:border-b-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full flex-col gap-1 rounded-xs text-left outline-none focus-ring">
        <span className="text-body break-words text-fg">{event.summary}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-fg-muted">
          <Kind kind={event.kind} />
          <span className="tabular-nums">{time(event.at)}</span>
          {event.actor && <span>{event.actor}</span>}
          {event.ip && <span className="font-mono">{event.ip}</span>}
        </span>
      </button>
      {open && <Details event={event} />}
    </li>
  );
}

/** Everything the event carries, as it was stored. */
function Details({ event }: { event: AuditEvent }) {
  const rows: [string, string][] = [
    ['Event', event.kind],
    ...(event.target ? ([['About', event.target]] as [string, string][]) : []),
    ...Object.entries(event.detail ?? {}).map(([k, v]): [string, string] => [k, v === null ? '—' : String(v)]),
  ];
  return (
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-footnote">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-fg-muted">{k}</dt>
          <dd className="min-w-0 font-mono text-code break-words text-fg-secondary">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function KeepSection({ filter }: { filter: AuditFilter }) {
  const retention = useSetting<number>(['audit', 'retentionDays']);
  const days = retention.value ?? 90;
  const options: SelectOption[] = [...new Set([...RETENTION_CHOICES, days])].sort((a, b) => a - b).map((d) => ({ value: String(d), label: `${d} days` }));
  const [exporting, setExporting] = useState(false);
  // The export follows the filters of the list above: it saves everything that matches, not only what is on screen.
  const save = async () => {
    setExporting(true);
    try {
      const out = await rpc().call('audit.export', filter);
      downloadText(`atelier-activity-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2));
      toast.success(out.truncated ? `Saved the newest ${out.events.length} events.` : `Saved ${out.events.length} events.`);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setExporting(false);
    }
  };
  return (
    <SettingsSection title="Keep and export">
      <SettingRow id="activity.retention" setting={retention}>
        {(label) => <Select {...label} options={options} value={String(days)} onValueChange={(v) => void retention.set(Number(v))} />}
      </SettingRow>
      <SettingRow id="activity.export" detail="Saves everything recorded, or choose filters above first.">
        <Button leadingIcon={Download} loading={exporting} onClick={() => void save()}>
          Export JSON
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
