import { renderHook, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxMessage } from '@atelier/protocol';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { Transcript } from '../chat/transcript.tsx';
import { useSessionSend } from '../chat/outbox.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import { ADA, BEN, coopState, guestOf, liveState, message, renderCoop } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() =>
  resetBackend({
    'models.list': () => [],
    'artifacts.list': () => [],
    'chat.unqueue': () => ({ parts: [{ type: 'text', text: 'also tests' }] }),
    'chat.queue': () => ({ id: 'q2', queued: true }),
    'chat.sendNow': () => ({ ok: true }),
    'chat.stop': () => ({ ok: true }),
  }),
);

const text = (t: string) => [{ type: 'text' as const, text: t }];
/** Ben's view of a session Ada hosts. */
const asBen = coopState({ sessionId: guestOf.id, me: BEN.id, role: 'editor' });

/** The row a message's text is in: its author label, bubble and actions. */
const rowOf = (t: string) => screen.getByText(t).closest<HTMLElement>('[data-last]')!;

describe('who wrote what in a shared session', () => {
  it('names each person’s message, and whom a reply was for when it wasn’t the viewer', async () => {
    const messages = [
      message('u1', 'user', { parts: text('Make the water wave') }),
      message('a1', 'assistant', { parts: text('The water waves now.'), stopReason: 'end' }),
      message('u2', 'user', { parts: text('Slower, please'), author: BEN.id }),
      message('a2', 'assistant', { parts: text('Slowed it down.'), stopReason: 'end', author: BEN.id }),
      message('u3', 'user', { parts: text('Hi all'), author: 'peer:gone' }),
    ];
    renderCoop((live) => <Transcript sessionId={guestOf.id} live={live} />, { live: liveState(guestOf, { messages }), state: asBen });

    // A message without an author is the host's; the viewer's own read "You"; someone no longer here is named so.
    await waitFor(() => expect(within(rowOf('Make the water wave')).getByText('Ada')).toBeTruthy());
    expect(within(rowOf('Slower, please')).getByText('You')).toBeTruthy();
    expect(within(rowOf('Hi all')).getByText('Someone who left')).toBeTruthy();

    // Ada's turn is labelled for Ben, who is looking; Ben's own isn't.
    expect(screen.getAllByText(/^for /).map((n) => n.textContent)).toEqual(['for Ada']);

    // A guest edits their own messages only, and branches and rewinds are the host's.
    expect(within(rowOf('Slower, please')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(rowOf('Make the water wave')).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('names whom a reply was for from the reply itself (a retry by someone else)', async () => {
    const messages = [message('u1', 'user', { parts: text('Make the water wave') }), message('a1', 'assistant', { parts: text('Waves.'), stopReason: 'end', author: BEN.id })];
    renderCoop((live) => <Transcript sessionId="s1" live={live} />, { live: liveState({ ...guestOf, id: 's1', coop: { role: 'host', hostName: 'Ada', participants: 2 } }, { messages }), state: coopState() });
    expect(await screen.findByText('for Ben')).toBeTruthy();
  });

  it('shows the host’s view without author labels outside co-op', async () => {
    const solo = liveState({ ...guestOf, id: 's1', coop: undefined }, { messages: [message('u1', 'user', { parts: text('Just me') })] });
    renderCoop((live) => <Transcript sessionId="s1" live={live} />, { live: solo, state: null });
    expect(await screen.findByText('Just me')).toBeTruthy();
    expect(screen.queryByText('Ada')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });
});

describe('waiting messages in a shared session', () => {
  const waiting: OutboxMessage[] = [
    { id: 'b1', parts: text('also tests'), author: BEN.id },
    { id: 'a1', parts: text('and docs') },
  ];

  it('show their author; the viewer takes back or joins only their own while someone else’s turn runs', async () => {
    const actions = { onTakeBack: vi.fn(), onSendNow: vi.fn(), onJoinTurn: vi.fn() };
    const live = liveState({ ...guestOf, status: 'running' }, { messages: [message('u1', 'user', { parts: text('Make it rain') })], outbox: waiting });
    renderCoop((l) => <Transcript sessionId={guestOf.id} live={l} outbox={actions} />, { live, state: asBen });

    const [mine, adas] = await screen.findAllByTestId('waiting-message');
    await waitFor(() => expect(within(mine!).getByText('You')).toBeTruthy());
    expect(within(mine!).getByText('Waits for its own turn')).toBeTruthy();
    expect(within(adas!).getByText('Ada')).toBeTruthy();
    // Ada's turn is the one running: her message joins it at its next step, and it isn't Ben's to handle.
    expect(within(adas!).getByText('Waiting for the next step')).toBeTruthy();
    expect(within(adas!).queryByRole('button')).toBeNull();

    fireEvent.click(within(mine!).getByRole('button', { name: 'Join this turn' }));
    expect(actions.onJoinTurn).toHaveBeenCalledWith('b1');
    fireEvent.click(within(mine!).getByRole('button', { name: 'Take back and edit' }));
    expect(actions.onTakeBack).toHaveBeenCalledWith('b1');
  });

  it('says when one asked to join the running turn', async () => {
    const live = liveState({ ...guestOf, status: 'running' }, { messages: [message('u1', 'user', { parts: text('Make it rain') })], outbox: [{ ...waiting[0]!, joinTurn: true }] });
    renderCoop((l) => <Transcript sessionId={guestOf.id} live={l} outbox={{ onTakeBack: vi.fn(), onSendNow: vi.fn(), onJoinTurn: vi.fn() }} />, { live, state: asBen });
    const [mine] = await screen.findAllByTestId('waiting-message');
    await waitFor(() => expect(within(mine!).getByText('Joins this turn at its next step')).toBeTruthy());
    expect(within(mine!).queryByRole('button', { name: 'Join this turn' })).toBeNull();
  });
});

describe('sending in a shared session', () => {
  const attachments = (): Attachments => ({ items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: vi.fn(), restore: vi.fn(), uploading: false, parts: () => [] });
  const hook = (coop: { shared: boolean; me: string; hostId: string; isHost: boolean }, outbox: OutboxMessage[] = []) => {
    const composer = { current: { setText: vi.fn(), append: vi.fn(), mention: vi.fn(), focus: vi.fn() } };
    const { result } = renderHook(() => useSessionSend({ sessionId: 's1', busy: false, outbox, attachments: attachments(), composer, follow: vi.fn(), coop }));
    return { result, composer };
  };
  const ben = { shared: true, me: BEN.id, hostId: ADA.id, isHost: false };
  const ada = { shared: true, me: ADA.id, hostId: ADA.id, isHost: true };

  it('always queues, so a message sent during someone else’s turn waits instead of being refused', async () => {
    hook(ben).result.current.send('my turn next');
    await waitFor(() => expect(callsTo('chat.queue')).toEqual([{ sessionId: 's1', parts: text('my turn next') }]));
  });

  it('joins the running turn: a guest’s Send now, the host’s message queued again to join', async () => {
    hook(ben).result.current.actions.onJoinTurn('b1');
    await waitFor(() => expect(callsTo('chat.sendNow')).toEqual([{ sessionId: 's1', id: 'b1' }]));
    hook(ada).result.current.actions.onJoinTurn('a1');
    await waitFor(() => expect(callsTo('chat.queue')).toEqual([{ sessionId: 's1', parts: text('also tests'), joinTurn: true }]));
    expect(callsTo('chat.unqueue')).toEqual([{ sessionId: 's1', id: 'a1' }]);
  });

  it('gives back only the viewer’s own waiting messages on Stop', async () => {
    const { result, composer } = hook(ben, [
      { id: 'b1', parts: text('mine'), author: BEN.id },
      { id: 'a1', parts: text('the host’s') },
    ]);
    result.current.stop();
    await waitFor(() => expect(composer.current.append.mock.calls).toEqual([['mine']]));
  });
});
