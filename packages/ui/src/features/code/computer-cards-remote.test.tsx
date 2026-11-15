import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingInteraction } from '@atelier/protocol';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { InteractionCard } from './interaction-card.tsx';

// The desktop app on the Mac, signed in to a server; the session runs on the PC (Remote Control).
const { grant } = vi.hoisted(() => ({ grant: vi.fn() }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  desktop: { computer: { grant, allowControl: vi.fn(), status: async () => null, onChanged: () => () => {} }, device: { id: 'mac', name: 'MacBook', platform: 'darwin' } },
}));
vi.mock('../../lib/lending.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useConnection: () => ({ data: { mode: 'server', serverUrl: 'https://atelier.example' } }) }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() => {
  grant.mockClear();
  resetBackend({ 'chat.respond': () => ({ ok: true }) });
});

const pc = { deviceId: 'pc', name: 'Gaming PC' };
const card = (toolName: string, input: Record<string, unknown>): PendingInteraction => ({ kind: 'permission', id: 'i1', payload: { callId: 'c1', toolName, input: { reason: '', ...input }, reason: '', suggestedRule: '' } });
const answers = () => callsTo('chat.respond').map((c) => (c as { answer: unknown }).answer);
const show = (pending: PendingInteraction) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InteractionCard sessionId="s" pending={pending} />
    </QueryClientProvider>,
  );

describe("computer use cards for another of the person's computers", () => {
  it('are allowed here: the answer carries the apps and what each may do, for that computer to allow', async () => {
    show(card('ComputerAccess', { apps: [{ app: { id: 'steam', name: 'Steam' }, category: 'other', tier: 'full', maxTier: 'full', denied: false, granted: null }], computer: pc }));
    expect(screen.getByText(/For Gaming PC, where this session runs/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', computer: { grants: [{ id: 'steam', tier: 'full' }], always: true } }]));
    // Nothing is allowed on this computer.
    expect(grant).not.toHaveBeenCalled();
  });

  it('let it take over the mouse and keyboard there', async () => {
    show(card('FullControl', { apps: [], computer: pc }));
    fireEvent.click(screen.getByRole('button', { name: /^Allow/ }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', computer: { always: false } }]));
  });

  it('are allowed on this computer as before when they are for it', async () => {
    show(card('ComputerAccess', { apps: [{ app: { id: 'steam', name: 'Steam' }, category: 'other', tier: 'full', maxTier: 'full', denied: false, granted: null }], computer: { deviceId: 'mac', name: 'MacBook' } }));
    fireEvent.click(screen.getByRole('button', { name: /Allow for this session/ }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow' }]));
    expect(grant).toHaveBeenCalledWith({ backend: 'https://atelier.example', sessionId: 's', grants: [{ id: 'steam', tier: 'full' }], always: false });
  });
});
