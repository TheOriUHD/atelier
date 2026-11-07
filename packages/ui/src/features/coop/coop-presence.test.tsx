import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { Composer } from '../chat/composer.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import { CoopBanner, CoopTyping, coopReadOnly } from './coop-notices.tsx';
import { typingLine, useCoopView } from './coop.ts';
import { ADA, BEN, coopState, guestOf, hosting, liveState, person, renderCoop } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() => resetBackend({ 'coop.typing': () => ({ ok: true }), 'models.list': () => [], 'slash.list': () => [] }));

const CY = person('account:cy', 'Cy', 'editor');
const attachments = (): Attachments => ({ items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: vi.fn(), restore: vi.fn(), uploading: false, parts: () => [] });

/** The page's typing line, banner and message box, from the co-op view. */
function Foot({ live }: { live: Parameters<typeof CoopTyping>[0]['live'] }) {
  const coop = useCoopView();
  return (
    <>
      {coop.shared && <span data-testid="shared" />}
      <CoopTyping live={live} coop={coop} />
      <CoopBanner coop={coop} />
      <Composer variant="reply" attachments={attachments()} model={undefined} anyModel={!coop.isHost} streaming={false} onSubmit={vi.fn()} onTyping={coop.typing} readOnly={coopReadOnly(coop)} />
    </>
  );
}

describe('who is typing', () => {
  it('words one, two or more people', () => {
    expect(typingLine([])).toBeNull();
    expect(typingLine(['Ben'])).toBe('Ben is typing…');
    expect(typingLine(['Ben', 'Cy'])).toBe('Ben and Cy are typing…');
    expect(typingLine(['Ben', 'Cy', 'Dee'])).toBe('3 people are typing…');
  });

  it('shows the others typing in the last 5 s above the message box, never the viewer', async () => {
    const live = liveState(hosting, { typing: { [BEN.id]: Date.now(), [CY.id]: Date.now() - 1000, [ADA.id]: Date.now(), 'peer:old': Date.now() - 6000 } });
    renderCoop((l) => <Foot live={l} />, { live, state: coopState({ participants: [ADA, BEN, CY] }) });
    expect(await screen.findByText('Ben and Cy are typing…')).toBeTruthy();
  });

  it('tells the others while the viewer types, at most every 2 s', async () => {
    renderCoop((l) => <Foot live={l} />, { live: liveState(hosting), state: coopState() });
    await screen.findByTestId('shared');
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.change(box, { target: { value: 'ab' } });
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(callsTo('coop.typing')).toEqual([{ sessionId: hosting.id }]);
  });
});

describe('a guest’s message box', () => {
  const asBen = coopState({ sessionId: guestOf.id, me: BEN.id, role: 'editor' });

  it('sends without a model of their own (the host’s answers), and says when the host’s computer is away', async () => {
    renderCoop((l) => <Foot live={l} />, { live: liveState(guestOf, { hostAway: true }), state: asBen });
    expect(await screen.findByText(/Ada’s computer is asleep or offline: the session continues when it’s back/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(false);
  });

  it('reads “Co-op ended” once it ended, with where the copy went', async () => {
    renderCoop((l) => <Foot live={l} />, { live: liveState(guestOf), state: { ...asBen, ended: true } });
    expect(await screen.findByText('Co-op ended. Your copy is in your sidebar.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('is read-only for someone who watches', async () => {
    renderCoop((l) => <Foot live={l} />, { live: liveState(guestOf), state: { ...asBen, role: 'viewer', participants: [ADA, { ...BEN, role: 'viewer' }] } });
    expect(await screen.findByText('You’re watching. Ada decides who can chat.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('ends when the guest is no longer among the people (removed, or the host ended co-op)', async () => {
    renderCoop((l) => <Foot live={l} />, { live: liveState(guestOf, { participants: [] }), state: asBen });
    expect(await screen.findByText(/^Co-op ended\./)).toBeTruthy();
  });
});
