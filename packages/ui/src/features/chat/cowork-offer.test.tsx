import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type Message, type Part } from '@atelier/protocol';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { CoworkOffer, usedSandbox } from './cowork-offer.tsx';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const message = (role: Message['role'], parts: Part[]): Message => ({
  id: Math.random().toString(36),
  sessionId: 's1',
  parentId: null,
  role,
  parts,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
});
const ask = (text: string) => message('user', [{ type: 'text', text }]);
const cloned = message('assistant', [{ type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'git clone https://github.com/acme/app.git' } }]);
const answered = message('assistant', [{ type: 'text', text: 'It is a todo app.' }]);

function show(messages: Message[], running = false, offer = true) {
  resetBackend({
    'prefs.get': () => ({ ...defaultUserPrefs(), chat: { coworkOffer: offer } }),
    'prefs.set': ({ value }: { value: boolean }) => ({ ...defaultUserPrefs(), chat: { coworkOffer: value } }),
    'sessions.continueInCowork': () => ({ id: 'task-1' }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CoworkOffer sessionId="s1" messages={messages} running={running} />
    </QueryClientProvider>,
  );
}

beforeEach(() => navigate.mockReset());

describe('the offer to continue a chat in Cowork', () => {
  it('follows a reply that worked in the sandbox, and only that reply', () => {
    expect(usedSandbox([ask('look at acme/app'), cloned, answered])).toBe(true);
    expect(usedSandbox([ask('look at acme/app'), cloned, answered, ask('thanks!'), message('assistant', [{ type: 'text', text: 'Anytime.' }])])).toBe(false);
    expect(usedSandbox([ask('hi'), answered])).toBe(false);
  });

  it('continues the chat as a Cowork task and opens it', async () => {
    show([ask('look at acme/app'), cloned, answered]);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue in Cowork' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/work/$sessionId', params: { sessionId: 'task-1' } }));
    expect(callsTo('sessions.continueInCowork')).toEqual([{ id: 's1' }]);
  });

  it('is gone for good once dismissed', async () => {
    show([ask('look at acme/app'), cloned, answered]);
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t offer Cowork again' }));
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['chat', 'coworkOffer'], value: false }]));
    await waitFor(() => expect(screen.queryByRole('note', { name: 'Continue in Cowork' })).toBeNull());
  });

  it('waits while the reply runs, and never shows after being turned off', async () => {
    show([ask('look at acme/app'), cloned], true);
    expect(screen.queryByRole('note')).toBeNull();
    show([ask('look at acme/app'), cloned, answered], false, false);
    await waitFor(() => expect(callsTo('prefs.get').length).toBeGreaterThan(0));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
