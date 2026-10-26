import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@atelier/protocol';
import { useLiveSession } from './live-session.ts';

const handlers = new Map<string, (payload: unknown) => void>();
let subscribes = 0;
const message = (id: string, parentId: string | null, role: Message['role'] = 'user'): Message =>
  ({ id, sessionId: 's1', parentId, role, parts: [{ type: 'text', text: id }], createdAt: 0 }) as Message;
let messages: Message[] = [];

vi.mock('./rpc.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rpc: () => ({
    call: async (method: string) => {
      if (method === 'artifacts.list') return [];
      if (method === 'sessions.subscribe') subscribes++;
      return { session: { id: 's1', mode: 'chat' }, messages, siblings: {}, live: null, pending: null, todos: [], tasks: [], toolOutput: {}, seq: 0 };
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => {};
    },
  }),
}));

let shown: ReturnType<typeof useLiveSession> | null = null;
const see = (state: ReturnType<typeof useLiveSession>) => (shown = state);
function Live() {
  const state = useLiveSession('s1');
  useEffect(() => void see(state));
  return null;
}

beforeEach(() => {
  subscribes = 0;
  messages = [message('m1', null), message('m2', 'm1', 'assistant')];
});

describe('a conversation open in several windows', () => {
  it('loads the branch again when it moved elsewhere, or a message follows one this window never had', async () => {
    render(<Live />);
    await act(async () => {});
    expect(shown?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    const loads = subscribes;

    // Another window switched to the other branch.
    messages = [message('m1', null), message('m3', 'm1', 'assistant')];
    await act(async () => handlers.get('session.event')!({ sessionId: 's1', seq: 1, event: { type: 'branch' } }));
    expect(subscribes).toBe(loads + 1);
    expect(shown?.messages.map((m) => m.id)).toEqual(['m1', 'm3']);

    // A reply on a branch this window doesn't have: read again, not cut down to that one message.
    messages = [message('m1', null), message('m4', 'm1'), message('m5', 'm4', 'assistant')];
    await act(async () => handlers.get('session.event')!({ sessionId: 's1', seq: 2, event: { type: 'message', message: message('m5', 'm4', 'assistant') } }));
    expect(subscribes).toBe(loads + 2);
    expect(shown?.messages.map((m) => m.id)).toEqual(['m1', 'm4', 'm5']);
  });

  it('says so when it was deleted elsewhere', async () => {
    render(<Live />);
    await act(async () => {});
    await act(async () => handlers.get('sessions.removed')!({ id: 's1' }));
    expect(shown).toMatchObject({ status: 'error', error: 'This conversation was deleted.' });
  });
});
