/**
 * Code's context ring and its popover (design/components.md › Context popover): what fills the window by category,
 * how far auto-compaction is, Compact session, the tokens the session used, and the person's usage across Atelier
 * The ring grows while a reply streams. A new session's composer has
 * the ring too, with an empty window and the same usage.
 */
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { chatGptPlanLabel, type ContextUsage, type ProviderType, type SessionUsage } from '@atelier/protocol';
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger, ProgressRing, Tooltip, cn } from '../../components/ui/index.ts';
import { popupScrollClass } from '../../components/ui/styles.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { clockTime } from '../../lib/dates.ts';
import { useThrottledLive } from '../../lib/live-session.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { compactSession } from '../chat/session-view.tsx';
import { formatUsd, totals, totalsSince, type UsageTotals } from '../settings/usage-data.ts';
import { formatTokenCount, liveContext } from './live-context.ts';

const CATEGORIES = [
  { key: 'messages', label: 'Messages', color: 'bg-interactive' },
  { key: 'mcpTools', label: 'MCP tools', color: 'bg-accent' },
  { key: 'systemTools', label: 'System tools', color: 'bg-success' },
  { key: 'skills', label: 'Skills', color: 'bg-warning' },
  { key: 'systemPrompt', label: 'System prompt', color: 'bg-fg-muted' },
] as const;

/** The categories, then the room kept for the reply above the auto-compact threshold, then what is left; they fill the window. */
export function contextRows(c: ContextUsage): { label: string; color: string; tokens: number }[] {
  return [
    ...CATEGORIES.map(({ key, label, color }) => ({ label, color, tokens: c.categories[key] })),
    { label: 'Autocompact buffer', color: 'bg-line-stronger', tokens: Math.max(0, Math.min(c.limit - c.threshold, c.limit - c.used)) },
    { label: 'Free space', color: 'bg-fill-control', tokens: Math.max(0, c.threshold - c.used) },
  ];
}

const percent = (tokens: number, limit: number) => `${+((tokens / limit) * 100).toFixed(1)}%`;

const RING_CLASS = 'flex size-6 items-center justify-center rounded-md outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover';
/** A figure, a bar, a few rows. */
const POPOVER_CLASS = cn('flex w-[min(328px,calc(100vw-32px))] flex-col gap-3 p-3.5', popupScrollClass);

/** Closes the popover, then opens Settings › Usage. */
function useOpenUsage(close: () => void) {
  const openSettings = useOpenSettings();
  return () => {
    close();
    openSettings('usage');
  };
}

/**
 * `provider` is the type of the session's model provider: a ChatGPT subscription shows its plan's usage limits, and a
 * hosted API shows what the session cost.
 */
export function ContextButton({ sessionId, busy, provider = null }: { sessionId: string; busy: boolean; provider?: ProviderType | null }) {
  const [open, setOpen] = useState(false);
  const openUsage = useOpenUsage(() => setOpen(false));
  const live = useThrottledLive(sessionId, liveContext, 150);
  // An idle session the backend hasn't measured since it started has no live figure: ask for one.
  const breakdown = useQuery({
    queryKey: ['context-breakdown', sessionId],
    queryFn: () => rpc().call('chat.contextBreakdown', { sessionId }),
    enabled: open || !live,
  });
  const context = live ?? breakdown.data?.context;
  if (!context) return null;
  const fraction = context.used / context.limit;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void breakdown.refetch();
      }}
    >
      <PopoverTrigger render={<button type="button" aria-label={`Context window: ${Math.round(fraction * 100)}% used`} className={RING_CLASS} />}>
        <ProgressRing value={fraction} aria-hidden="true" />
      </PopoverTrigger>
      <ContextPopover
        context={context}
        usage={breakdown.data?.usage}
        provider={provider}
        busy={busy}
        onCompact={() => {
          setOpen(false);
          compactSession(sessionId);
        }}
        onOpenUsage={openUsage}
      />
    </Popover>
  );
}

/** A new Code session's ring, before the session exists: nothing in the model's window yet, and the person's usage. */
export function NewSessionContextButton({ limit, provider = null }: { limit: number; provider?: ProviderType | null }) {
  const [open, setOpen] = useState(false);
  const openUsage = useOpenUsage(() => setOpen(false));
  const titleId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" aria-label="Context window: 0% used" className={RING_CLASS} />}>
        <ProgressRing value={0} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} aria-labelledby={titleId} className={POPOVER_CLASS}>
        <WindowHeading titleId={titleId} used={0} limit={limit} />
        <div className="h-1.5 shrink-0 rounded-full bg-fill-control" aria-hidden="true" />
        <UsageSection provider={provider} sessionCost={null} onOpenUsage={openUsage} />
      </PopoverContent>
    </Popover>
  );
}

function ContextPopover({
  context,
  usage,
  provider,
  busy,
  onCompact,
  onOpenUsage,
}: {
  context: ContextUsage;
  usage: SessionUsage | undefined;
  provider: ProviderType | null;
  busy: boolean;
  onCompact(): void;
  onOpenUsage(): void;
}) {
  const titleId = useId();
  const detailsId = useId();
  // The breakdown by category (and the session's tokens) stays tucked away until it is asked for.
  const [expanded, setExpanded] = useState(false);
  const rows = contextRows(context);
  const left = context.threshold - context.used;
  return (
    <PopoverContent side="top" align="end" sideOffset={8} aria-labelledby={titleId} className={POPOVER_CLASS}>
      <WindowHeading
        titleId={titleId}
        used={context.used}
        limit={context.limit}
        toggle={{ expanded, controls: detailsId, onToggle: () => setExpanded((e) => !e) }}
      />
      <div className="flex h-1.5 shrink-0 overflow-hidden rounded-full bg-fill-control" aria-hidden="true">
        {rows.map((r) => r.tokens > 0 && <span key={r.label} className={r.color} style={{ width: `${(r.tokens / context.limit) * 100}%` }} />)}
      </div>
      {expanded && (
        <div id={detailsId} className="flex flex-col gap-3">
          <table className="w-full text-body tabular-nums">
            <caption className="sr-only">Context window by category</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Tokens</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="h-6">
                  <th scope="row" className="text-left font-normal text-fg">
                    <span className="flex items-center gap-2.5">
                      <span className={`size-2.5 shrink-0 rounded-[3px] ${r.color}`} aria-hidden="true" />
                      {r.label}
                    </span>
                  </th>
                  <td className="w-20 text-right text-fg-secondary">{formatTokenCount(r.tokens)}</td>
                  <td className="w-14 text-right text-fg-muted">{percent(r.tokens, context.limit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage && (
            <section aria-label="Session usage" className="border-t border-line pt-3">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body tabular-nums">
                <Stat label="Tokens in" value={formatTokenCount(usage.input)} />
                <Stat label="Tokens out" value={formatTokenCount(usage.output)} />
                {(usage.cacheRead > 0 || usage.cacheWrite > 0) && <Stat label="Cache read / write" value={`${formatTokenCount(usage.cacheRead)} / ${formatTokenCount(usage.cacheWrite)}`} />}
                {usage.costUsd !== null && <Stat label="Cost" value={formatUsd(usage.costUsd)} />}
                {usage.tokensPerSecond !== null && <Stat label="Last reply" value={`${usage.tokensPerSecond.toFixed(1)} tokens/s`} />}
              </dl>
            </section>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-fg-secondary">{left > 0 ? `${formatTokenCount(left)} until auto-compact` : 'Compacts before the next request'}</span>
        <Button size="sm" disabled={busy} onClick={onCompact}>
          Compact session
        </Button>
      </div>
      <UsageSection provider={provider} sessionCost={usage?.costUsd ?? null} onOpenUsage={onOpenUsage} />
    </PopoverContent>
  );
}

/** "Context window" and how much of it is used, as "804.2k / 1M (80%)"; with a chevron that opens the breakdown. */
function WindowHeading({
  titleId,
  used,
  limit,
  toggle,
}: {
  titleId: string;
  used: number;
  limit: number;
  toggle?: { expanded: boolean; controls: string; onToggle(): void };
}) {
  const figure = (
    <span className="text-body text-fg-secondary tabular-nums">
      {formatTokenCount(used)} / {formatTokenCount(limit)} ({Math.round((used / limit) * 100)}%)
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={titleId} className="text-body-strong text-fg">
        Context window
      </h2>
      {toggle ? (
        <button
          type="button"
          aria-expanded={toggle.expanded}
          aria-controls={toggle.controls}
          aria-label={toggle.expanded ? 'Hide the breakdown' : 'Show the breakdown'}
          onClick={toggle.onToggle}
          className="flex items-center gap-1 rounded-sm outline-none focus-ring hover:text-fg"
        >
          {figure}
          <ChevronRight aria-hidden className={cn('size-4 text-fg-muted transition-transform duration-(--at-duration-snap) ease-snap', toggle.expanded && 'rotate-90')} />
        </button>
      ) : (
        figure
      )}
    </div>
  );
}

/** "48.2k tokens · $0.12", with the cost when any of the requests had a price. */
const spent = (t: UsageTotals) => `${formatTokenCount(t.tokens)} tokens${t.unpriced < t.requests ? ` · ${formatUsd(t.cost)}` : ''}`;

/** "5-hour limit", "Weekly limit": a usage window of the plan by its length. */
export function windowName(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return 'Usage limit';
  if (minutes === 10_080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/**
 * "Resets in 1 hr 22 min" within a day, "Resets Tue 8:00 AM" after; `exact` names the time within a day too:
 * "Resets 2:25 PM" today, with the weekday on another day. Times follow the computer's 12- or 24-hour clock.
 */
export function resetsText(resetsAt: number | null, now: number, exact = false): string {
  if (resetsAt === null) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return 'Resets soon';
  if (ms < 24 * 3_600_000 && !exact) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `Resets in ${[h ? `${h} hr` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ')}`;
  }
  const today = new Date(resetsAt).toDateString() === new Date(now).toDateString();
  return `Resets ${clockTime(resetsAt, { weekday: !today })}`;
}

const EXACT_KEY = 'atelier.resetsExact';

/** Whether the plan's limits say when they reset as a time rather than how long until; clicking one switches, and it stays. */
function useExactResets(): [boolean, () => void] {
  const [exact, setExact] = useState(() => {
    try {
      return localStorage.getItem(EXACT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setExact(!exact);
    try {
      if (exact) localStorage.removeItem(EXACT_KEY);
      else localStorage.setItem(EXACT_KEY, '1');
    } catch {
      // Storage unavailable; the switch still holds while the app runs.
    }
  };
  return [exact, toggle];
}

const barTone = (percent: number) => (percent >= 90 ? 'bg-danger' : percent >= 75 ? 'bg-warning' : 'bg-interactive');

/**
 * Below the context window, the plan usage limits: for a ChatGPT subscription the plan's own
 * windows (what ChatGPT reports with each reply), for a hosted API what it cost, and otherwise the person's token use.
 */
function UsageSection({ provider, sessionCost, onOpenUsage }: { provider: ProviderType | null; sessionCost: number | null; onOpenUsage(): void }) {
  if (provider === 'chatgpt') return <PlanLimits onOpenUsage={onOpenUsage} />;
  const hosted = provider === 'anthropic' || provider === 'openai' || provider === 'openai-compatible';
  return <YourUsage onOpenUsage={onOpenUsage} cost={hosted ? { session: sessionCost } : null} />;
}

function SectionHeading({ id, children, onOpenUsage }: { id: string; children: string; onOpenUsage(): void }) {
  return (
    <div className="flex h-6 items-center justify-between gap-3">
      <h3 id={id} className="text-body-strong text-fg">
        {children}
      </h3>
      <IconButton icon={ArrowRight} label="Open Usage in Settings" size="xs" className="text-fg-secondary" onClick={onOpenUsage} />
    </div>
  );
}

/** The subscription's usage windows: how much of each is used and when it resets. */
function PlanLimits({ onOpenUsage }: { onOpenUsage(): void }) {
  const titleId = useId();
  const status = useQuery({ queryKey: keys.chatgpt, queryFn: () => rpc().call('chatgpt.status', {}), staleTime: 0 });
  const rawPlan = status.data?.plan?.toLowerCase();
  const pro = !!rawPlan?.startsWith('pro');
  const windows = [status.data?.limits?.primary, status.data?.limits?.secondary].filter(
    (w): w is NonNullable<typeof w> => !!w && (w.windowMinutes === null || w.windowMinutes > 0) && (!pro || w.windowMinutes === 10_080),
  );
  const plan = rawPlan ? chatGptPlanLabel(rawPlan) : null;
  const now = status.dataUpdatedAt || 0;
  const [exact, toggleExact] = useExactResets();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2.5 border-t border-line pt-3">
      <SectionHeading id={titleId} onOpenUsage={onOpenUsage}>
        {plan ? `Plan usage limits · ${plan}` : 'Plan usage limits'}
      </SectionHeading>
      {windows.length === 0 ? (
        <p className="text-body text-fg-muted">{status.isPending ? 'Loading…' : 'ChatGPT reports your usage with each reply: it shows after the next message.'}</p>
      ) : (
        windows.map((w) => {
          const pct = Math.min(100, Math.max(0, Math.round(w.usedPercent)));
          const resets = resetsText(w.resetsAt, now, exact);
          return (
            <div key={w.windowMinutes ?? 'window'} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-body">
                <span className="text-fg">{windowName(w.windowMinutes)}</span>
                <span className="flex items-baseline gap-3 tabular-nums">
                  {/* A window more than a day out names its time either way: nothing to switch. */}
                  {resets === resetsText(w.resetsAt, now, !exact) ? (
                    <span className="text-footnote text-fg-muted">{resets}</span>
                  ) : (
                    <Tooltip content={exact ? 'Show the time left' : 'Show the time'}>
                      <button type="button" onClick={toggleExact} className="rounded-sm text-footnote text-fg-muted outline-none focus-ring hover:text-fg-secondary">
                        {resets}
                      </button>
                    </Tooltip>
                  )}
                  <span className="w-9 text-right text-fg-secondary">{pct}%</span>
                </span>
              </div>
              <div role="progressbar" aria-label={windowName(w.windowMinutes)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-fill-control">
                <span className={cn('block h-full rounded-full', barTone(pct))} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * The signed-in person's usage in every mode, today and over the last 7 days (Settings › Usage's figures), and the way
 * there; with `cost` (a hosted API) the session's own cost comes first and the rows are dollars where priced.
 */
function YourUsage({ onOpenUsage, cost }: { onOpenUsage(): void; cost: { session: number | null } | null }) {
  const titleId = useId();
  const { data: rows, error } = useQuery({
    queryKey: [...keys.usage, 7, false],
    queryFn: () => rpc().call('usage.summary', { days: 7, timezoneOffset: new Date().getTimezoneOffset() }),
    staleTime: 0,
  });
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 border-t border-line pt-3">
      <SectionHeading id={titleId} onOpenUsage={onOpenUsage}>
        {cost ? 'Cost' : 'Your usage'}
      </SectionHeading>
      {rows ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body tabular-nums">
          {cost && <Stat label="This session" value={cost.session !== null ? formatUsd(cost.session) : 'Not priced'} />}
          <Stat label="Today" value={spent(totalsSince(rows, 1))} />
          <Stat label="Last 7 days" value={spent(totals(rows))} />
        </dl>
      ) : error ? (
        <p role="alert" className="text-body text-danger-text">
          {describeError(error).message}
        </p>
      ) : (
        <p className="text-body text-fg-muted">Loading…</p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-secondary">{label}</dt>
      <dd className="text-right text-fg">{value}</dd>
    </>
  );
}
