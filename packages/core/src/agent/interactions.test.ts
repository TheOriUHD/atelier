import type { PendingInteraction } from '@atelier/protocol';
import { describe, expect, it, vi } from 'vitest';
import { InteractionBroker } from './interactions.ts';

describe('InteractionBroker', () => {
  it('accepts an answer sent as soon as the question is announced', async () => {
    const broker: InteractionBroker = new InteractionBroker(async (sessionId, pending) => {
      // A client on an in-memory transport answers while the question is still being announced.
      if (pending) expect(broker.respond(sessionId, pending.id, { behavior: 'allow' })).toBe(true);
      await Promise.resolve();
    });
    await expect(broker.ask('s1', 'permission', {}, new AbortController().signal, { behavior: 'deny' })).resolves.toEqual({ behavior: 'allow' });
  });

  it('asks one question per session at a time and clears it once answered', async () => {
    const pending: (PendingInteraction | null)[] = [];
    const broker = new InteractionBroker(async (_s, p) => void pending.push(p));
    const signal = new AbortController().signal;
    const first = broker.ask('s1', 'question', { n: 1 }, signal, null);
    const second = broker.ask('s1', 'question', { n: 2 }, signal, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.map((p) => p?.payload)).toEqual([{ n: 1 }]);
    expect(broker.respond('s1', pending[0]!.id, 'one')).toBe(true);
    await expect(first).resolves.toBe('one');
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[1]).toBeNull();
    expect(broker.respond('s1', pending[2]!.id, 'two')).toBe(true);
    await expect(second).resolves.toBe('two');
    expect(broker.respond('s1', pending[2]!.id, 'again')).toBe(false);
  });

  it('resolves with the fallback when stopped and refuses later answers', async () => {
    let id = '';
    const broker = new InteractionBroker(async (_s, p) => void (p && (id = p.id)));
    const controller = new AbortController();
    const asked = broker.ask('s1', 'permission', {}, controller.signal, { behavior: 'deny' });
    await Promise.resolve();
    controller.abort();
    await expect(asked).resolves.toEqual({ behavior: 'deny' });
    expect(broker.respond('s1', id, { behavior: 'allow' })).toBe(false);
  });
});

