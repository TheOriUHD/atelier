import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Participant } from '@atelier/protocol';
import { useLiveSession } from './live-session.ts';

const MIRROR = 'coop_room_s1';
const handlers = new Map<string, (payload: unknown) => void>();
let subscribes = 0;
const message = (id: string): Message => ({ id, sessionId: MIRROR, parentId: null, role: 'user', parts: [{ type: 'text', text: id }], createdAt: 0 }) as Message;

vi.mock('./rpc.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rpc: () => ({
    call: async (method: string) => {
      if (method === 'artifacts.list') return [];
      if (method === 'sessions.subscribe') subscribes++;
      return { session: { id: MIRROR, mode: 'chat', coop: { role: 'editor', hostName: 'Ada', participants: 2, mirror: true } }, messages: [message('m1')], siblings: {}, pending: null, todos: [], tasks: [], toolOutput: {}, outbox: [], seq: 7 };
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
  const state = useLiveSession(MIRROR);
  useEffect(() => void see(state));
  return null;
}
const send = (seq: number, event: unknown) => act(async () => handlers.get('session.event')!({ sessionId: MIRROR, seq, event }));

beforeEach(() => {
  subscribes = 0;
});

describe('a co-op session on a guest’s own computer', () => {
  it('takes what its own backend says about the link whatever its number, and keeps the host’s numbering', async () => {
    render(<Live />);
    await act(async () => {});
    expect(shown?.seq).toBe(7);

    await send(7, { type: 'host_away', away: true });
    expect(shown?.hostAway).toBe(true);
    expect(shown?.seq).toBe(7);

    const loads = subscribes;
    await send(7, { type: 'resync' });
    expect(subscribes).toBe(loads + 1);

    // An old presence from the host is ignored; the one saying co-op ended (nobody left) is not.
    await send(5, { type: 'presence', participants: [{ id: 'account:ada' } as Participant] });
    expect(shown?.participants).toBeUndefined();
    await send(7, { type: 'presence', participants: [] });
    expect(shown?.participants).toEqual([]);
    expect(shown?.seq).toBe(7);

    // The host's own next event still counts.
    await send(8, { type: 'typing', participantId: 'account:ada' });
    expect(Object.keys(shown?.typing ?? {})).toEqual(['account:ada']);
    expect(shown?.seq).toBe(8);
  });
});
