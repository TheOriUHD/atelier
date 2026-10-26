import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsage, Message, RunEvent, SessionSnapshot, SessionUsage, UsageRow } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { clockTime } from '../../lib/dates.ts';
import { useLiveSession, type LiveSessionState } from '../../lib/live-session.ts';
import { Transcript } from '../chat/transcript.tsx';
import { backend, callsTo, emit } from '../settings/test-backend.ts';
import { ContextButton, NewSessionContextButton, contextRows, resetsText, windowName } from './context-popover.tsx';
import { formatElapsed, formatTokenCount } from './live-context.ts';
import { LiveStatus } from './live-status.tsx';
import { TranscriptDetail } from '../chat/parts.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
const openSettings = vi.hoisted(() => vi.fn());
vi.mock('../../app/navigation.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useOpenSettings: () => openSettings }));

const NOW = new Date(2026, 9, 14, 12).getTime();
const CONTEXT: ContextUsage = {
  used: 1000,
  limit: 8000,
  threshold: 6000,
  categories: { systemPrompt: 300, systemTools: 400, mcpTools: 100, skills: 50, messages: 150 },
  charsPerToken: 4,
};
const USAGE: SessionUsage = { requests: 3, input: 12_400, output: 950, cacheRead: 0, cacheWrite: 0, costUsd: 0.42, tokensPerSecond: 31.25 };

const row = (day: string, extra: Partial<UsageRow>): UsageRow => ({
  day,
  providerId: 'ollama',
  modelId: 'qwen3:8b',
  mode: 'code',
  requests: 1,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: null,
  unpriced: 1,
  tokensPerSecond: null,
  timed: 0,
  ...extra,
});
/** The person's last 7 days: two priced requests today, three earlier in the week (one without a price). */
const WEEK: UsageRow[] = [
  row('2026-10-14', { requests: 2, input: 1_500, cacheRead: 500, output: 500, costUsd: 0.05, unpriced: 0 }),
  row('2026-10-10', { mode: 'chat', requests: 3, input: 9_000, output: 1_000, costUsd: 0.1, unpriced: 1 }),
];

const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's',
  parentId: null,
  role,
  parts: [],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: NOW - 5_000,
  ...extra,
});

function snapshot(id: string, extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session: { id, mode: 'code', workspaceId: null, permissionMode: null, title: 'Task', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'running', pinnedAt: null, createdAt: 0, updatedAt: 0 },
    messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Fix it' }] }), message('a1', 'assistant')],
    siblings: {},
    streamingMessageId: 'a1',
    pending: null,
    todos: [],
    tasks: [],
    toolOutput: {},
    suggestion: null,
    context: CONTEXT,
    compacting: false,
    queued: null,
    phase: null,
    outbox: [],
    seq: 1,
    ...extra,
  };
}

let seq = 1;
function send(sessionId: string, event: RunEvent) {
  act(() => emit('session.event', { sessionId, seq: ++seq, event }));
}

/** Lets the snapshot load and the throttled view catch up. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(150)));

function Session({ id, children }: { id: string; children: React.ReactNode }) {
  useLiveSession(id);
  return children;
}

function show(id: string, snap: SessionSnapshot, ui: React.ReactNode) {
  backend.handlers = {
    'sessions.subscribe': () => snap,
    'artifacts.list': () => [],
    'chat.contextBreakdown': () => ({ context: CONTEXT, usage: USAGE }),
    'chat.compact': () => ({ ok: true }),
    'models.list': () => [],
    'usage.summary': () => WEEK,
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Session id={id}>{ui}</Session>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  backend.calls.length = 0;
  seq = 1;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('formatting', () => {
  it('shortens counts and durations', () => {
    expect([980, 1_234, 804_200, 1_000_000].map(formatTokenCount)).toEqual(['980', '1.2k', '804.2k', '1M']);
    expect([12_400, 2_192_000, 7_500_000].map(formatElapsed)).toEqual(['12s', '36m 32s', '2h 5m']);
  });
});

describe('LiveStatus', () => {
  it("estimates live output with the session's own characters per output token once replies report usage", async () => {
    // A finished reply: 3,000 characters were 1,000 output tokens, while the prompt-side figure says 4.
    const done = message('a0', 'assistant', { parts: [{ type: 'text', text: 'z'.repeat(3_000) }], usage: { input: 500, output: 1_000 } });
    const snap = snapshot('s-calibrated', { messages: [message('u0', 'user', { parts: [{ type: 'text', text: 'Hi' }] }), done, message('u1', 'user', { parts: [{ type: 'text', text: 'Fix it' }] }), message('a1', 'assistant')] });
    show('s-calibrated', snap, <LiveStatus sessionId="s-calibrated" />);
    await settle();
    send('s-calibrated', { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
    send('s-calibrated', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(300) });
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('status').textContent).toContain('↓ 100 tokens');
  });

  it('stays out of the way of a compact run of tool calls in Code, and sits under Chat’s summary of them', async () => {
    const call = message('a1', 'assistant', { parts: [{ type: 'tool_call', id: 'c1', name: 'WebSearch', input: { query: 'x' } }] });
    const result = message('r1', 'tool', { parts: [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'ok' }] }] });
    const snap = snapshot('s-between', { messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Find it' }] }), call, result], streamingMessageId: null });
    // The model has the result and is thinking about the next step: nothing in the tool summary says so.
    show('s-between', snap, <LiveStatus sessionId="s-between" />);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    show('s-between', snap, <LiveStatus sessionId="s-between" withActivity />);
    await settle();
    expect(screen.getByRole('status').textContent).toContain('Thinking…');
    expect(screen.getByRole('status').textContent).toContain('↓');
  });

  it('explains a request that waits in line for the model’s server', async () => {
    show('s-line', snapshot('s-line', { queued: 2, streamingMessageId: null, messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Hi' }] })] }), <LiveStatus sessionId="s-line" />);
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Waiting in line for the model · 2 requests ahead');
    expect(status.getAttribute('title')).toContain('one request at a time');
  });

  it('learns nothing from replies whose reasoning was summarized or hidden, and keeps the ratio plausible', async () => {
    const user = (id: string) => message(id, 'user', { parts: [{ type: 'text', text: 'Q' }] });
    const run = async (id: string, finished: Message[]) => {
      show(id, snapshot(id, { messages: [...finished, user('u1'), message('a1', 'assistant')] }), <LiveStatus sessionId={id} />);
      await settle();
      send(id, { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
      send(id, { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(400) });
      act(() => vi.advanceTimersByTime(150));
      const text = screen.getByRole('status').textContent;
      cleanup();
      return text;
    };
    // Anthropic's summarized thinking: 400 characters stood for 5,000 tokens of reasoning.
    const summarized = message('a0', 'assistant', { parts: [{ type: 'thinking', text: 's'.repeat(300), provider: 'anthropic' }, { type: 'text', text: 't'.repeat(100) }], usage: { input: 10, output: 5_000 } });
    // OpenAI: reasoning tokens with nothing streamed for them.
    const hidden = message('a0', 'assistant', { parts: [{ type: 'text', text: 't'.repeat(400) }], usage: { input: 10, output: 5_000, reasoning: 4_900 } });
    const redacted = message('a0', 'assistant', { parts: [{ type: 'thinking', text: '', provider: 'ollama', redacted: true }, { type: 'text', text: 't'.repeat(400) }], usage: { input: 10, output: 5_000 } });
    for (const [i, finished] of [summarized, hidden, redacted].entries()) expect(await run(`s-hidden-${i}`, [user('u0'), finished])).toContain('↓ 100 tokens');
    // 30 characters a token can't be right: at most 8 count.
    const dense = message('a0', 'assistant', { parts: [{ type: 'text', text: 'z'.repeat(3_000) }], usage: { input: 10, output: 100 } });
    expect(await run('s-dense', [user('u0'), dense])).toContain('↓ 50 tokens');
  });

  it('times a /compact from the command, not from the turn before it, and counts no tokens for it', async () => {
    // The last turn ended five hours ago; the command was sent just now.
    const old = NOW - 5 * 3_600_000;
    const echo = message('c1', 'user', { createdAt: NOW - 2_000, kind: 'context', parts: [{ type: 'context', text: '', notice: { kind: 'command', command: '/compact' } }] });
    const snap = snapshot('s-compact', {
      messages: [message('u1', 'user', { createdAt: old, parts: [{ type: 'text', text: 'Fix it' }] }), message('a1', 'assistant', { createdAt: old + 1000, parts: [{ type: 'text', text: 'Done' }], usage: { input: 10, output: 1800 } }), echo],
      streamingMessageId: null,
      compacting: true,
    });
    show('s-compact', snap, <LiveStatus sessionId="s-compact" />);
    await settle();
    const text = screen.getByRole('status').textContent!;
    expect(text).toContain('Compacting conversation…');
    expect(text).toContain('2s');
    expect(text).not.toContain('tokens');
  });

  it('ticks the output tokens up while the reply streams, at most every 150 ms, then shows the exact count', async () => {
    // Verbose: the line also reports a running tool there (the compact view says that in the activity's own line).
    show('s-live', snapshot('s-live'), <TranscriptDetail.Provider value="verbose"><LiveStatus sessionId="s-live" /></TranscriptDetail.Provider>);
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Thinking…5s · ↓ 0 tokens');

    send('s-live', { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
    send('s-live', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(400) });
    expect(status.textContent).toContain('↓ 0 tokens');
    act(() => vi.advanceTimersByTime(150));
    expect(status.textContent).toContain('Writing…5s · ↓ 100 tokens');
    send('s-live', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'y'.repeat(4_800) });
    act(() => vi.advanceTimersByTime(1_000));
    expect(status.textContent).toContain('Writing…6s · ↓ 1.3k tokens');

    send('s-live', { type: 'done', messageId: 'a1', usage: { input: 900, output: 1_180 }, stopReason: 'tool_use', error: null });
    send('s-live', { type: 'part', messageId: 'a1', index: 1, part: { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } } });
    act(() => vi.advanceTimersByTime(150));
    expect(status.textContent).toContain('Running a command…6s · ↓ 1.2k tokens');

    send('s-live', { type: 'compacting', active: true });
    act(() => vi.advanceTimersByTime(150));
    expect(status.textContent).toContain('Compacting conversation…');
    expect(status.textContent).not.toContain('tokens');
    send('s-live', { type: 'status', status: 'idle' });
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("keeps counting at the model's speed while the server is silent mid-reply, then shows the exact count", async () => {
    const user = (id: string) => message(id, 'user', { parts: [{ type: 'text', text: 'Q' }] });
    const earlier = message('a0', 'assistant', { parts: [{ type: 'text', text: 'z'.repeat(800) }], usage: { input: 10, output: 200, tokensPerSecond: 40 }, stopReason: 'end' });
    show('s-quiet', snapshot('s-quiet', { messages: [user('u0'), earlier, user('u1'), message('a1', 'assistant')] }), <LiveStatus sessionId="s-quiet" />);
    await settle();
    send('s-quiet', { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
    send('s-quiet', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(400) });
    act(() => vi.advanceTimersByTime(150));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('↓ 100 tokens');
    // Nothing arrives (a tool call being written): after the quiet second and a half, 40 tokens a second.
    act(() => vi.advanceTimersByTime(4_000));
    expect(status.textContent).toMatch(/↓ ≈ 1\d\d tokens/);
    send('s-quiet', { type: 'done', messageId: 'a1', usage: { input: 900, output: 260 }, stopReason: 'tool_use', error: null });
    act(() => vi.advanceTimersByTime(150));
    expect(status.textContent).toContain('↓ 260 tokens');
    expect(status.textContent).not.toContain('≈');
  });
});

describe('ContextButton', () => {
  it('grows the ring with the streaming reply and colors it past 75% and 90%', async () => {
    show('s-ring', snapshot('s-ring'), <ContextButton sessionId="s-ring" busy />);
    await settle();
    const ring = screen.getByRole('button', { name: 'Context window: 13% used' });
    expect(ring.querySelector('svg')!.getAttribute('class')).toContain('text-fg-muted');

    send('s-ring', { type: 'part', messageId: 'a1', index: 0, part: { type: 'thinking', text: '' } });
    send('s-ring', { type: 'delta', messageId: 'a1', index: 0, kind: 'thinking', text: 'z'.repeat(20_000) });
    act(() => vi.advanceTimersByTime(150));
    expect(ring.getAttribute('aria-label')).toBe('Context window: 75% used');
    expect(ring.querySelector('svg')!.getAttribute('class')).toContain('text-warning');

    send('s-ring', { type: 'context', context: { ...CONTEXT, used: 7_300 } });
    send('s-ring', { type: 'done', messageId: 'a1', usage: { input: 2_000, output: 5_000 }, stopReason: 'end', error: null });
    act(() => vi.advanceTimersByTime(150));
    expect(ring.getAttribute('aria-label')).toBe('Context window: 91% used');
    expect(ring.querySelector('svg')!.getAttribute('class')).toContain('text-danger');
  });

  it('keeps the breakdown tucked away until the arrow opens it, counts down to auto-compaction and compacts on request', async () => {
    show('s-pop', snapshot('s-pop', { streamingMessageId: null, messages: [message('u1', 'user')], session: { ...snapshot('s-pop').session, status: 'idle' } }), <ContextButton sessionId="s-pop" busy={false} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 13% used' }));
    await settle();
    const popover = screen.getByRole('dialog', { name: 'Context window' });
    expect(popover.textContent).toContain('1k / 8k (13%)');
    // Closed: the figure, the bar, the countdown and what the person's usage is.
    expect(within(popover).queryByRole('table')).toBeNull();
    expect(popover.textContent).toContain('5k until auto-compact');
    expect(within(popover).getByRole('region', { name: 'Your usage' }).textContent).toContain('Today2.5k tokens · $0.05');

    fireEvent.click(within(popover).getByRole('button', { name: 'Show the breakdown' }));
    const rows = within(within(popover).getByRole('table', { name: 'Context window by category' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Messages1501.9%',
      'MCP tools1001.3%',
      'System tools4005%',
      'Skills500.6%',
      'System prompt3003.8%',
      'Autocompact buffer2k25%',
      'Free space5k62.5%',
    ]);
    const usage = within(popover).getByRole('region', { name: 'Session usage' });
    expect(usage.textContent).toContain('Tokens in12.4k');
    expect(usage.textContent).toContain('Cost$0.42');
    expect(usage.textContent).toContain('Last reply31.3 tokens/s');
    fireEvent.click(within(popover).getByRole('button', { name: 'Hide the breakdown' }));
    expect(within(popover).queryByRole('table')).toBeNull();

    fireEvent.click(within(popover).getByRole('button', { name: 'Compact session' }));
    await settle();
    expect(callsTo('chat.compact')).toEqual([{ sessionId: 's-pop' }]);
  });

  it("shows a ChatGPT subscription's own usage windows in place of the person's usage", async () => {
    const resetsAt = NOW + 82 * 60_000;
    show('s-gpt', snapshot('s-gpt', { streamingMessageId: null, session: { ...snapshot('s-gpt').session, status: 'idle' } }), <ContextButton sessionId="s-gpt" busy={false} provider="chatgpt" />);
    backend.handlers['chatgpt.status'] = () => ({
      available: true,
      signedIn: true,
      signingIn: false,
      email: 'a@b.c',
      plan: 'plus',
      limits: { primary: { usedPercent: 42.4, windowMinutes: 300, resetsAt }, secondary: { usedPercent: 91, windowMinutes: 10_080, resetsAt: NOW + 3 * 86_400_000 } },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 13% used' }));
    await settle();
    const popover = screen.getByRole('dialog', { name: 'Context window' });
    const limits = within(popover).getByRole('region', { name: 'Plan usage limits · Plus' });
    expect(limits.textContent).toContain('5-hour limit');
    expect(limits.textContent).toContain('Resets in 1 hr 22 min');
    expect(limits.textContent).toContain('42%');
    expect(within(limits).getByRole('progressbar', { name: 'Weekly limit' }).getAttribute('aria-valuenow')).toBe('91');
    expect(within(popover).queryByRole('region', { name: 'Your usage' })).toBeNull();

    fireEvent.click(within(limits).getByRole('button', { name: 'Open Usage in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('usage');
  });

  it('is one plain bar in Chat and Cowork, with no breakdown and no Compact session, above the plan’s limits', async () => {
    show('s-chat', snapshot('s-chat', { streamingMessageId: null, session: { ...snapshot('s-chat').session, status: 'idle' } }), <ContextButton sessionId="s-chat" busy={false} provider="chatgpt" simple />);
    backend.handlers['chatgpt.status'] = () => ({
      available: true,
      signedIn: true,
      signingIn: false,
      plan: 'plus',
      limits: { primary: { usedPercent: 42, windowMinutes: 300, resetsAt: NOW + 70 * 60_000 }, secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: NOW + 3 * 86_400_000 } },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 13% used' }));
    await settle();
    const popover = screen.getByRole('dialog', { name: 'Context window' });
    expect(popover.textContent).toContain('Older messages are summarized automatically when it fills up.');
    expect(within(popover).queryByRole('button', { name: 'Show the breakdown' })).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'Compact session' })).toBeNull();
    // One color: the categories' colors are Code's.
    expect(popover.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(1);
    const limits = within(popover).getByRole('region', { name: 'Plan usage limits · Plus' });
    expect(limits.textContent).toContain('Resets in 1 hr 10 min');
    fireEvent.click(within(limits).getByRole('button', { name: 'Open Usage in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('usage');
  });

  it('says when a limit resets as a time once its countdown is clicked, and keeps it that way', async () => {
    const resetsAt = NOW + 82 * 60_000;
    const weekly = NOW + 3 * 86_400_000;
    show('s-gpt', snapshot('s-gpt', { streamingMessageId: null, session: { ...snapshot('s-gpt').session, status: 'idle' } }), <ContextButton sessionId="s-gpt" busy={false} provider="chatgpt" />);
    backend.handlers['chatgpt.status'] = () => ({
      available: true,
      signedIn: true,
      signingIn: false,
      plan: 'plus',
      limits: { primary: { usedPercent: 42, windowMinutes: 300, resetsAt }, secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: weekly } },
    });
    const ring = () => screen.getByRole('button', { name: 'Context window: 13% used' });
    const limits = () => screen.getByRole('region', { name: 'Plan usage limits · Plus' });
    await settle();
    fireEvent.click(ring());
    await settle();
    // The weekly window already names its time: only the countdown switches.
    const weeklyText = `Resets ${clockTime(weekly, { weekday: true })}`;
    expect(limits().textContent).toContain(weeklyText);
    expect(within(limits()).queryByRole('button', { name: weeklyText })).toBeNull();

    fireEvent.click(within(limits()).getByRole('button', { name: 'Resets in 1 hr 22 min' }));
    expect(within(limits()).getByRole('button', { name: `Resets ${clockTime(resetsAt)}` })).toBeTruthy();

    fireEvent.click(ring());
    await settle();
    fireEvent.click(ring());
    await settle();
    fireEvent.click(within(limits()).getByRole('button', { name: `Resets ${clockTime(resetsAt)}` }));
    expect(within(limits()).getByRole('button', { name: 'Resets in 1 hr 22 min' })).toBeTruthy();
    expect(localStorage.getItem('atelier.resetsExact')).toBeNull();
  });

  it.each([['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['pro_500', 'Pro 500'], ['promax', 'Pro 500']])('shows %s with only its weekly usage window', async (plan, label) => {
    show('s-pro', snapshot('s-pro'), <ContextButton sessionId="s-pro" busy={false} provider="chatgpt" />);
    backend.handlers['chatgpt.status'] = () => ({ available: true, signedIn: true, signingIn: false, plan,
      limits: { primary: { usedPercent: 0, windowMinutes: 0, resetsAt: NOW }, secondary: { usedPercent: 25, windowMinutes: 10_080, resetsAt: NOW + 86_400_000 } },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Context window:/ }));
    await settle();
    const limits = screen.getByRole('region', { name: `Plan usage limits · ${label}` });
    expect(within(limits).getAllByRole('progressbar')).toHaveLength(1);
    expect(within(limits).getByRole('progressbar', { name: 'Weekly limit' })).toBeTruthy();
    expect(limits.textContent).not.toContain('0-day');
  });

  it('says the limits come with the next reply while none is known, and shows what a hosted API has cost', async () => {
    show('s-new', snapshot('s-new', { streamingMessageId: null, session: { ...snapshot('s-new').session, status: 'idle' } }), <ContextButton sessionId="s-new" busy={false} provider="chatgpt" />);
    backend.handlers['chatgpt.status'] = () => ({ available: true, signedIn: true, signingIn: false });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 13% used' }));
    await settle();
    expect(screen.getByRole('region', { name: 'Plan usage limits' }).textContent).toContain('after the next message');
    cleanup();

    show('s-api', snapshot('s-api', { streamingMessageId: null, session: { ...snapshot('s-api').session, status: 'idle' } }), <ContextButton sessionId="s-api" busy={false} provider="anthropic" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 13% used' }));
    await settle();
    const cost = screen.getByRole('region', { name: 'Cost' });
    expect([...cost.querySelectorAll('dt, dd')].map((e) => e.textContent)).toEqual(['This session', '$0.42', 'Today', '2.5k tokens · $0.05', 'Last 7 days', '12.5k tokens · $0.15']);
  });

  it('asks the backend when the session has no live figure yet', async () => {
    show('s-idle', snapshot('s-idle', { context: null, streamingMessageId: null }), <ContextButton sessionId="s-idle" busy={false} />);
    await settle();
    expect(callsTo('chat.contextBreakdown')).toEqual([{ sessionId: 's-idle' }]);
    expect(screen.getByRole('button', { name: 'Context window: 13% used' })).toBeTruthy();
  });

  it('fills the window with the categories, the buffer and the free space', () => {
    const over = { ...CONTEXT, used: 6_500, categories: { ...CONTEXT.categories, messages: 5_650 } };
    const rows = contextRows(over);
    expect(rows.reduce((n, r) => n + r.tokens, 0)).toBe(over.limit);
    expect(rows.at(-1)).toMatchObject({ label: 'Free space', tokens: 0 });
  });
});

describe('plan limits', () => {
  it('names a window by its length and says when it resets', () => {
    expect([300, 10_080, 1_440, 4_320, 45, null].map(windowName)).toEqual(['5-hour limit', 'Weekly limit', '1-day limit', '3-day limit', '45-minute limit', 'Usage limit']);
    expect(resetsText(NOW + 82 * 60_000, NOW)).toBe('Resets in 1 hr 22 min');
    expect(resetsText(NOW + 3 * 3_600_000, NOW)).toBe('Resets in 3 hr');
    expect(resetsText(NOW + 40_000, NOW)).toBe('Resets in 1 min');
    expect(resetsText(NOW - 1, NOW)).toBe('Resets soon');
    expect(resetsText(null, NOW)).toBe('');
    expect(resetsText(NOW + 3 * 86_400_000, NOW)).toMatch(/^Resets \w+ /);
  });

  it('names the time within a day too when asked, with the weekday once it is another day', () => {
    const today = NOW + 82 * 60_000;
    const tomorrow = NOW + 13 * 3_600_000;
    expect(resetsText(today, NOW, true)).toBe(`Resets ${clockTime(today)}`);
    expect(resetsText(tomorrow, NOW, true)).toBe(`Resets ${clockTime(tomorrow, { weekday: true })}`);
    expect(resetsText(NOW + 3 * 86_400_000, NOW, true)).toBe(resetsText(NOW + 3 * 86_400_000, NOW));
    expect(resetsText(NOW - 1, NOW, true)).toBe('Resets soon');
  });
});

describe('NewSessionContextButton', () => {
  function showNew(rows: UsageRow[]) {
    backend.calls.length = 0;
    backend.handlers = { 'usage.summary': () => rows };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <NewSessionContextButton limit={128_000} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('opens before the session exists: an empty window of the model’s size, then the person’s usage today and this week', async () => {
    showNew(WEEK);
    expect(callsTo('usage.summary')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 0% used' }));
    await settle();
    const popover = screen.getByRole('dialog', { name: 'Context window' });
    expect(popover.textContent).toContain('Context window0 / 128k (0%)');
    expect(within(popover).queryByRole('table')).toBeNull();
    const usage = within(popover).getByRole('region', { name: 'Your usage' });
    expect([...usage.querySelectorAll('dt, dd')].map((e) => e.textContent)).toEqual(['Today', '2.5k tokens · $0.05', 'Last 7 days', '12.5k tokens · $0.15']);
    expect(callsTo('usage.summary')).toEqual([{ days: 7, timezoneOffset: new Date(NOW).getTimezoneOffset() }]);

    fireEvent.click(within(usage).getByRole('button', { name: 'Open Usage in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('usage');
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Context window' })).toBeNull();
  });

  it("shows what a local model's server does in place of Thinking, the line changing only when it has more to say, until output arrives", async () => {
    show('s-phase', snapshot('s-phase', { phase: 'loading' }), <LiveStatus sessionId="s-phase" />);
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading the model…5s · ↓ 0 tokens');
    // Three seconds later it still says the same thing.
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(status.textContent).toContain('Loading the model…8s · ↓ 0 tokens');
    // After 20 seconds in the phase (the time shown also counts the 5 before the line appeared) it says it is taking a while.
    await act(async () => void (await vi.advanceTimersByTimeAsync(16_000)));
    expect(status.textContent).toContain('Loading the model…24s');
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(status.textContent).toContain('Still loading the model, a large one takes a while…25s');

    // Loaded: reading starts over at its first line.
    send('s-phase', { type: 'phase', phase: 'reading' });
    await settle();
    expect(status.textContent).toContain('Reading the conversation…');
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(status.textContent).toContain('Still reading, a long conversation takes a while…');

    // The first output: the usual verbs again.
    send('s-phase', { type: 'phase', phase: null });
    send('s-phase', { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
    send('s-phase', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(400) });
    await settle();
    expect(status.textContent).toContain('Writing…');
    expect(status.textContent).toContain('↓ 100 tokens');
  });

  it('counts tokens alone when no request had a price, and nothing yet on a quiet day', async () => {
    showNew([row('2026-10-12', { requests: 4, unpriced: 4, input: 800, output: 200 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Context window: 0% used' }));
    await settle();
    const usage = screen.getByRole('region', { name: 'Your usage' });
    expect([...usage.querySelectorAll('dd')].map((e) => e.textContent)).toEqual(['0 tokens', '1k tokens']);
  });
});

describe('Transcript', () => {
  it('shows one status while a request waits behind others, not the reply’s dots as well', async () => {
    const snap = snapshot('s-queued', { streamingMessageId: null, messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Hi' }] }), message('a1', 'assistant')], queued: 1 });
    const live: LiveSessionState = { ...snap, suggestion: null, status: 'ready', error: null, toolInputs: {}, artifacts: {} };
    show('s-queued', snap, <Transcript sessionId="s-queued" live={live} />);
    await settle();
    expect(screen.getByText(/Waiting in line for the model · 1 request ahead/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Thinking' })).toBeNull();
    // Without a queue the empty reply shows its dots.
    cleanup();
    const quiet: LiveSessionState = { ...live, queued: null };
    show('s-quiet-dots', { ...snap, queued: null }, <Transcript sessionId="s-quiet-dots" live={quiet} />);
    await settle();
    expect(screen.getByRole('img', { name: 'Thinking' })).toBeTruthy();
  });

  it('shows a /compact the person ran as their own message', async () => {
    const echo = message('c1', 'user', { kind: 'context', parts: [{ type: 'context', text: '', notice: { kind: 'command', command: '/compact decisions' } }] });
    const snap = snapshot('s-echo', { streamingMessageId: null, messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Next step' }] }), echo] });
    const live: LiveSessionState = { ...snap, suggestion: null, status: 'ready', error: null, toolInputs: {}, artifacts: {} };
    show('s-echo', snap, <Transcript sessionId="s-echo" live={live} />);
    await settle();
    // The command is blue, its argument as typed.
    const command = screen.getByText('/compact');
    expect(command.className).toContain('text-interactive-text');
    expect(command.parentElement!.textContent).toBe('/compact decisions');
  });

  it('shows a compaction as a muted line with what it saved, and opens its summary', async () => {
    const summary = message('c2', 'user', {
      kind: 'compaction_summary',
      parts: [
        { type: 'text', text: 'This conversation was compacted. Summary of everything before this point:\n\nThe build was fixed.' },
        { type: 'context', text: 'notes', notice: { kind: 'compaction', saved: 666_200 } },
      ],
    });
    const snap = snapshot('s-saved', { streamingMessageId: null, messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Next step' }] }), summary] });
    const live: LiveSessionState = { ...snap, suggestion: null, status: 'ready', error: null, toolInputs: {}, artifacts: {} };
    show('s-saved', snap, <Transcript sessionId="s-saved" live={live} />);
    await settle();
    const line = screen.getByRole('button', { name: 'Compacted session · saved 666.2k tokens' });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/The build was fixed/)).toBeNull();
    fireEvent.click(line);
    expect(screen.getByText(/The build was fixed/)).toBeTruthy();
    expect(line.getAttribute('aria-expanded')).toBe('true');
  });

  it('says the conversation is being compacted, in Chat and Cowork too', async () => {
    const snap = snapshot('s-chat', { streamingMessageId: null, messages: [message('u1', 'user', { parts: [{ type: 'text', text: 'Next step' }] })], compacting: true });
    const live: LiveSessionState = { ...snap, suggestion: null, status: 'ready', error: null, toolInputs: {}, artifacts: {} };
    show('s-chat', snap, <Transcript sessionId="s-chat" live={live} />);
    await settle();
    expect(screen.getByText('Compacting conversation…')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Waiting for the reply' })).toBeNull();
  });
});
