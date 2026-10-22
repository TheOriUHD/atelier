import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsage, Message, RunEvent, SessionSnapshot } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { backend, emit } from '../settings/test-backend.ts';
import { LiveStatus } from './live-status.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const NOW = new Date(2026, 9, 14, 12).getTime();
const context = (used: number, limit: number): ContextUsage => ({
  used,
  limit,
  threshold: limit * 0.8,
  categories: { systemPrompt: 0, systemTools: 0, mcpTools: 0, skills: 0, messages: used },
  charsPerToken: 4,
});

const message = (id: string, role: Message['role']): Message => ({
  id,
  sessionId: 's',
  parentId: null,
  role,
  parts: role === 'user' ? [{ type: 'text', text: 'Fix it' }] : [],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: NOW - 5_000,
});

const snapshot = (id: string, ctx: ContextUsage | null): SessionSnapshot => ({
  session: { id, mode: 'chat', workspaceId: null, permissionMode: null, title: 'Task', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'running', pinnedAt: null, createdAt: 0, updatedAt: 0 },
  messages: [message('u1', 'user'), message('a1', 'assistant')],
  siblings: {},
  streamingMessageId: 'a1',
  pending: null,
  todos: [],
  tasks: [],
  toolOutput: {},
  context: ctx,
  compacting: false,
  queued: null,
  phase: null,
  outbox: [],
  seq: 1,
});

let seq = 1;
const send = (sessionId: string, event: RunEvent) => act(() => emit('session.event', { sessionId, seq: ++seq, event }));
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(150)));

function Session({ id }: { id: string }) {
  useLiveSession(id);
  return <LiveStatus sessionId={id} withActivity />;
}

function show(id: string, ctx: ContextUsage | null) {
  backend.handlers = { 'sessions.subscribe': () => snapshot(id, ctx), 'artifacts.list': () => [], 'models.list': () => [] };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Session id={id} />
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

describe('LiveStatus context fill', () => {
  it('shows only reconnect count and the independent elapsed clock while retrying', async () => {
    show('s-retry', context(20_000, 32_000));
    await settle();
    send('s-retry', { type: 'phase', phase: 'retrying', retryAttempt: 2 });
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Connection interrupted. Retry 2 of 10');
    expect(status.textContent).not.toMatch(/tokens|context|in 10 seconds|Waiting to reconnect/);
    act(() => vi.advanceTimersByTime(2000));
    expect(status.textContent).toContain('7s');
    send('s-retry', { type: 'phase', phase: 'retrying', retryAttempt: 3 });
    await settle();
    expect(status.textContent).toContain('Retry 3 of 10');
    expect(status.textContent).toContain('7s');
  });
  it('shows how full the window is next to the output tokens, growing with the streaming reply', async () => {
    show('s-fill', context(20_000, 32_000));
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Thinking…5s · ↓ 0 tokens · context 20k / 32k');
    expect(screen.getByText('context 20k / 32k').className).not.toMatch(/text-(warning|danger)/);

    send('s-fill', { type: 'part', messageId: 'a1', index: 0, part: { type: 'text', text: '' } });
    send('s-fill', { type: 'delta', messageId: 'a1', index: 0, kind: 'text', text: 'x'.repeat(4_000) });
    act(() => vi.advanceTimersByTime(150));
    expect(status.textContent).toContain('↓ 1k tokens · context 21k / 32k');
  });

  it('takes the context ring’s warning colour from 75% full', async () => {
    show('s-warn', context(20_000, 32_000));
    await settle();
    expect(screen.getByText('context 20k / 32k').className).not.toContain('text-warning');
    send('s-warn', { type: 'context', context: context(24_000, 32_000) });
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByText('context 24k / 32k').className).toContain('text-warning');
  });

  it('leaves the context out while the window is unknown', async () => {
    show('s-unknown', null);
    await settle();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('↓ 0 tokens');
    expect(status.textContent).not.toContain('context');
  });
});
