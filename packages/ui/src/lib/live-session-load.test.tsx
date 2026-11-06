import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, SessionSnapshot } from '@atelier/protocol';
import { backend, callsTo, emit, resetBackend } from '../features/settings/test-backend.ts';
import { useLiveSession } from './live-session.ts';

vi.mock('./rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const message = (id: string, role: Message['role'], parentId: string | null, extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's',
  parentId,
  role,
  parts: [{ type: 'text', text: id }],
  model: null,
  usage: null,
  stopReason: role === 'assistant' ? 'tool_use' : null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
  ...extra,
});

const snapshot = (messages: Message[], seq: number): SessionSnapshot => ({
  session: { id: 's', mode: 'code', workspaceId: null, permissionMode: null, title: 'Task', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'running', pinnedAt: null, createdAt: 0, updatedAt: 0 },
  messages,
  siblings: {},
  streamingMessageId: null,
  pending: null,
  todos: [],
  tasks: [],
  toolOutput: {},
  context: null,
  compacting: false,
  queued: null,
  phase: null,
  outbox: [],
  seq,
});

/** The conversation as the window has it: its messages' ids, in order. */
function Probe() {
  const live = useLiveSession('s');
  return <output>{live.messages.map((m) => m.id).join(',')}</output>;
}
const shown = () => screen.getByRole('status').textContent;

afterEach(() => cleanup());

describe('loading a conversation again after a compaction', () => {
  it('loads once more when a second compaction lands while the first load waits, instead of keeping one message', async () => {
    const before = [message('u1', 'user', null), message('a1', 'assistant', 'u1')];
    // After the first compaction: its summary, then the newest messages.
    const first = [message('c1', 'user', null, { kind: 'compaction_summary' }), message('a2', 'assistant', 'c1')];
    // After the second: a new summary, and the reply that follows it.
    const second = [message('c2', 'user', null, { kind: 'compaction_summary' }), message('a3', 'assistant', 'c2')];
    let release: (s: SessionSnapshot) => void = () => {};
    let loads = 0;
    resetBackend({
      'artifacts.list': () => [],
      'sessions.subscribe': () => {
        loads++;
        if (loads === 1) return snapshot(before, 1);
        if (loads === 2) return new Promise<SessionSnapshot>((resolve) => (release = resolve));
        return snapshot(second, 4);
      },
    });
    render(<Probe />);
    await waitFor(() => expect(shown()).toBe('u1,a1'));

    // The first compaction: the window loads again, and while that waits the second one lands, then a message under it.
    act(() => emit('session.event', { sessionId: 's', seq: 2, event: { type: 'compacted', summaryMessageId: 'c1' } }));
    await waitFor(() => expect(loads).toBe(2));
    act(() => emit('session.event', { sessionId: 's', seq: 3, event: { type: 'compacted', summaryMessageId: 'c2' } }));
    act(() => emit('session.event', { sessionId: 's', seq: 4, event: { type: 'message', message: second[1]! } }));
    await act(async () => release(snapshot(first, 2)));

    await waitFor(() => expect(shown()).toBe('c2,a3'));
    expect(callsTo('sessions.subscribe')).toHaveLength(3);
    expect(backend.calls.length).toBeGreaterThan(0);
  });
});
