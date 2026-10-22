import { act, render } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveSession } from './live-session.ts';

const calls: { method: string; input: unknown }[] = [];
let temporary = false;
vi.mock('./rpc.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rpc: () => ({
    call: async (method: string, input: unknown) => {
      calls.push({ method, input });
      const session = temporary ? { id: (input as { id: string }).id, mode: 'chat', temporary: 'private' } : null;
      return method === 'artifacts.list' ? [] : { session, messages: [], siblings: {}, live: null, pending: null, todos: [], tasks: [], toolOutput: {}, seq: 0 };
    },
    on: () => () => {},
  }),
}));

const unsubscribes = (id: string) => calls.filter((c) => c.method === 'sessions.unsubscribe' && (c.input as { id: string }).id === id);

function Live({ id, fail = false }: { id: string; fail?: boolean }) {
  useLiveSession(id);
  if (fail) throw new Error('render failed after the hook');
  return null;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('live session subscriptions', () => {
  it('end 30 s after the last component lets go', async () => {
    const view = render(<Live id="s1" />);
    await act(async () => {});
    view.unmount();
    await act(async () => vi.advanceTimersByTime(29_000));
    expect(unsubscribes('s1')).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(unsubscribes('s1')).toHaveLength(1);
  });

  it('end on their own when the render that made them never committed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Boundary>
        <Live id="s2" fail />
      </Boundary>,
    );
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(unsubscribes('s2')).toHaveLength(1);
  });
});

describe('temporary chats', () => {
  it('are left, which deletes them, a moment after the last component lets go', async () => {
    temporary = true;
    try {
      const view = render(<Live id="t1" />);
      await act(async () => {});
      view.unmount();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(calls.filter((c) => c.method === 'sessions.leave')).toEqual([{ method: 'sessions.leave', input: { id: 't1' } }]);
      expect(unsubscribes('t1')).toHaveLength(0);
    } finally {
      temporary = false;
    }
  });
});
