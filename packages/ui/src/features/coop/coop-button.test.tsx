import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo, CoopState } from '@atelier/protocol';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { CoopButton } from './coop-button.tsx';
import { ADA, BEN, coopState, guestOf, hosting, liveState, person, renderCoop, summary } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const writeText = vi.fn(async (_text: string) => {});
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

const appInfo = (surface: AppInfo['surface']) => ({ surface }) as AppInfo;

beforeEach(() => {
  writeText.mockClear();
  resetBackend({ 'app.info': () => appInfo('desktop'), 'models.list': () => [model('fake', 'alpha'), model('fake', 'beta')] });
});

/** Opens the header's Co-op popover and returns it. */
async function open(name: RegExp | string = /^Co-op/) {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: 'Co-op' });
}

describe('the host’s Co-op popover', () => {
  it('starts co-op on a desktop, then copies an invite link that can be made again', async () => {
    let current: CoopState | null = null;
    resetBackend({
      'app.info': () => appInfo('desktop'),
      'coop.start': () => (current = coopState({ participants: [ADA] })),
      'coop.invite': () => ({ url: `https://atelierhq.dev/join#v1.room.secret${callsTo('coop.invite').length}`, expiresAt: Date.now() + 24 * 3600_000 }),
    });
    renderCoop(<CoopButton session={summary()} />, { live: liveState(summary()), state: () => current });
    const popover = await open('Co-op');
    expect(await within(popover).findByText(/It keeps running on this computer/)).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: 'Start co-op' }));
    await waitFor(() => expect(callsTo('coop.start')).toEqual([{ sessionId: 's1' }]));

    const panel = await screen.findByRole('dialog', { name: 'Co-op' });
    expect(await within(panel).findByText('Runs on this computer')).toBeTruthy();
    expect(within(panel).getByText(/Nobody has joined yet/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://atelierhq.dev/join#v1.room.secret1'));
    expect(await within(panel).findByText('Expires in 24 h')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Make a new link' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('https://atelierhq.dev/join#v1.room.secret2'));
    expect(callsTo('coop.invite')).toHaveLength(2);
  });

  it('adds teammates on a server instead of making a link', async () => {
    resetBackend({
      'app.info': () => appInfo('web'),
      'coop.directory': () => [
        { userId: 'ben', name: 'Ben', avatar: null },
        { userId: 'cy', name: 'Cy', avatar: null },
      ],
      'coop.add': () => (current = coopState({ via: 'server', participants: [ADA, person('account:cy', 'Cy', 'editor')] })),
    });
    let current: CoopState | null = null;
    renderCoop(<CoopButton session={summary()} />, { live: liveState(summary()), state: () => current });
    const popover = await open('Co-op');
    expect(await within(popover).findByText(/up to three teammates on this server/)).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: 'Start co-op' }));
    fireEvent.click(await within(popover).findByRole('checkbox', { name: 'Cy' }));
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(callsTo('coop.add')).toEqual([{ sessionId: 's1', userIds: ['cy'], role: 'editor' }]));
  });

  it('lets in whoever knocks after comparing the fingerprint both sides see, or declines them', async () => {
    const knock = { id: 'k1', name: 'Ben', fingerprint: ['🐙', '🌵', '🎈'] };
    resetBackend({ 'app.info': () => appInfo('desktop'), 'coop.admit': () => ({ ok: true }) });
    renderCoop(<CoopButton session={hosting} />, { live: liveState(hosting), state: coopState({ participants: [ADA], knocking: [knock] }) });
    const popover = await open('Co-op: Ben wants to join');
    const card = within(popover).getByRole('region', { name: 'Ben wants to join' });
    expect(within(card).getByLabelText('Fingerprint: 🐙 🌵 🎈')).toBeTruthy();
    expect(card.textContent).toContain('The same three emoji show on Ben’s screen');
    fireEvent.click(within(card).getByRole('button', { name: 'Let in' }));
    await waitFor(() => expect(callsTo('coop.admit')).toEqual([{ sessionId: 's1', knockId: 'k1', allow: true }]));
  });

  it('changes what guests may use, with daily caps where empty means none', async () => {
    const settings = vi.fn((input: { settings: Partial<CoopState['settings']> }) => coopState({ settings: { ...coopState().settings, ...input.settings } }));
    resetBackend({ 'app.info': () => appInfo('desktop'), 'coop.settings': settings });
    renderCoop(<CoopButton session={hosting} />, { live: liveState(hosting), state: coopState() });
    const popover = await open('Co-op: you, Ben');

    const requests = within(popover).getByRole<HTMLInputElement>('textbox', { name: 'Requests a day per guest' });
    expect(requests.value).toBe('50');
    fireEvent.focus(requests);
    fireEvent.change(requests, { target: { value: '20' } });
    fireEvent.blur(requests);
    await waitFor(() => expect(settings).toHaveBeenLastCalledWith({ sessionId: 's1', settings: { sharedRequestsPerDay: 20 } }));

    const dollars = within(popover).getByRole<HTMLInputElement>('textbox', { name: 'Dollars a day per guest' });
    fireEvent.focus(dollars);
    fireEvent.change(dollars, { target: { value: '' } });
    fireEvent.blur(dollars);
    await waitFor(() => expect(settings).toHaveBeenLastCalledWith({ sessionId: 's1', settings: { sharedSpendPerDayUsd: null } }));

    fireEvent.click(within(popover).getByRole('switch', { name: 'Guests keep a copy when co-op ends' }));
    await waitFor(() => expect(settings).toHaveBeenLastCalledWith({ sessionId: 's1', settings: { guestsKeepCopy: false } }));
    fireEvent.click(within(popover).getByRole('switch', { name: 'Guests’ own models read what the session reads' }));
    await waitFor(() => expect(settings).toHaveBeenLastCalledWith({ sessionId: 's1', settings: { allowGuestModels: false } }));
    fireEvent.click(within(popover).getByRole('switch', { name: 'Guests can use my models' }));
    await waitFor(() => expect(settings).toHaveBeenLastCalledWith({ sessionId: 's1', settings: { shareModels: false } }));
  });

  it('trusts a guest with approvals (saying what that means), removes them and ends co-op', async () => {
    resetBackend({
      'app.info': () => appInfo('desktop'),
      'coop.participant': () => coopState({ participants: [ADA, { ...BEN, trusted: true }] }),
      'coop.remove': () => ({ ok: true }),
      'coop.end': () => ({ ok: true }),
    });
    renderCoop(<CoopButton session={hosting} />, { live: liveState(hosting), state: coopState() });
    const popover = await open('Co-op: you, Ben');
    const people = within(popover).getByRole('region', { name: 'People' });
    expect(within(people).getByText('Ada')).toBeTruthy();
    expect(within(people).getByText('(you)')).toBeTruthy();
    expect(within(people).getByText('Host')).toBeTruthy();
    expect(within(people).getByRole('combobox', { name: 'What Ben can do' })).toBeTruthy();

    fireEvent.click(within(people).getByRole('button', { name: 'More for Ben' }));
    const trust = await screen.findByRole('menuitemcheckbox', { name: /Trust with approvals/ });
    expect(trust.textContent).toContain('Ben can approve commands on your computer.');
    fireEvent.click(trust);
    await waitFor(() => expect(callsTo('coop.participant')).toEqual([{ sessionId: 's1', participantId: 'peer:ben', trusted: true }]));

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const removing = await screen.findByRole('alertdialog', { name: 'Remove Ben?' });
    fireEvent.click(within(removing).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('coop.remove')).toEqual([{ sessionId: 's1', participantId: 'peer:ben' }]));

    fireEvent.click(within(popover).getByRole('button', { name: 'End co-op' }));
    const ending = await screen.findByRole('alertdialog', { name: 'End co-op?' });
    expect(ending.textContent).toContain('Everyone else leaves this session and keeps a copy of the conversation');
    fireEvent.click(within(ending).getByRole('button', { name: 'End co-op' }));
    await waitFor(() => expect(callsTo('coop.end')).toEqual([{ sessionId: 's1' }]));
  });
});

describe('a guest’s Co-op popover', () => {
  const asGuest = (extra: Partial<CoopState> = {}) =>
    coopState({ sessionId: guestOf.id, me: BEN.id, role: 'editor', sharedUse: { requests: 12, spentUsd: 0.4 }, ...extra });

  it('lists who is in, read-only, and answers with the host’s models within what they share', async () => {
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest() });
    const popover = await open('Co-op: Ada, you');
    expect(within(popover).getByText('Runs on Ada’s computer')).toBeTruthy();
    expect(within(popover).queryByRole('combobox')).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'End co-op' })).toBeNull();
    expect(within(popover).getByRole('radio', { name: 'Ada’s models' }).getAttribute('aria-checked')).toBe('true');
    expect(popover.textContent).toContain('12 of 50 today · $0.40 of $2.00');
  });

  it('switches to their own models and picks one of them', async () => {
    let state = asGuest();
    resetBackend({
      'models.list': () => [model('fake', 'alpha'), model('fake', 'beta')],
      'coop.models': (input: { models: 'host' | 'own'; model: string | null }) => {
        state = asGuest({ participants: [ADA, { ...BEN, models: input.models, model: input.model }], sharedUse: null });
        return state;
      },
    });
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: () => state });
    const popover = await open('Co-op: Ada, you');
    fireEvent.click(within(popover).getByRole('radio', { name: 'My models' }));
    await waitFor(() => expect(callsTo('coop.models')).toEqual([{ sessionId: guestOf.id, models: 'own', model: null }]));
    expect(await within(popover).findByText('Choose a model to answer your messages.')).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: 'My model' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /beta/ }));
    await waitFor(() => expect(callsTo('coop.models').at(-1)).toEqual({ sessionId: guestOf.id, models: 'own', model: 'fake/beta' }));
  });

  it('only offers their own models while the host doesn’t share theirs', async () => {
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest({ settings: { ...coopState().settings, shareModels: false }, sharedUse: null }) });
    const popover = await open('Co-op: Ada, you');
    expect(within(popover).queryByRole('radio')).toBeNull();
    expect(popover.textContent).toContain('Ada doesn’t share their models in this session.');
  });

  it('lends their own connectors to their turns when they say so', async () => {
    resetBackend({ 'models.list': () => [], 'coop.lend': () => ({ ok: true }) });
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest() });
    const popover = await open('Co-op: Ada, you');
    const lend = within(popover).getByRole('switch', { name: 'Use my connectors in my turns' });
    expect(lend.getAttribute('aria-checked')).toBe('false');
    expect(popover.textContent).toContain('Each call asks you first.');
    fireEvent.click(lend);
    await waitFor(() => expect(callsTo('coop.lend')).toEqual([{ sessionId: guestOf.id, lend: true }]));
  });

  it('starts the lending switch from what the guest’s own backend says', async () => {
    resetBackend({ 'models.list': () => [] });
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest({ lending: true }) });
    const popover = await open('Co-op: Ada, you');
    expect(within(popover).getByRole('switch', { name: 'Use my connectors in my turns' }).getAttribute('aria-checked')).toBe('true');
  });

  it('leaves, and goes back to the mode’s home', async () => {
    resetBackend({ 'models.list': () => [], 'coop.leave': () => ({ ok: true }) });
    const router = renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest() });
    const popover = await open('Co-op: Ada, you');
    fireEvent.click(within(popover).getByRole('button', { name: 'Leave' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Leave Ada’s session?' });
    expect(confirm.textContent).toContain('You keep a copy of the conversation in your sidebar.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(callsTo('coop.leave')).toEqual([{ sessionId: guestOf.id }]));
    await waitFor(() => expect(router.state.location.pathname).toBe('/code'));
  });

  it('says when they only watch', async () => {
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asGuest({ role: 'viewer', participants: [ADA, { ...BEN, role: 'viewer' }] }) });
    const popover = await open('Co-op: Ada, you');
    expect(popover.textContent).toContain('You’re watching. Ada decides who can chat.');
    expect(within(popover).queryByRole('radio')).toBeNull();
  });
});
