import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError, inviteFragment, makeInviteUrl, type AppInfo, type CoopTrack } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { Composer } from '../chat/composer.tsx';
import { Transcript } from '../chat/transcript.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import { NavigatorNotes } from '../code/tool-cards.tsx';
import { CoopButton } from './coop-button.tsx';
import { CoopBanner } from './coop-notices.tsx';
import { useAnswerModels } from './coop-models.tsx';
import { navigatorNotes, useCoopView } from './coop.ts';
import { JoinLinkDialog, pastedInvite } from './join-link-dialog.tsx';
import { ADA, BEN, coopState, guestOf, hosting, liveState, message, renderCoop } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const ALPHA = model('fake', 'alpha');
const BETA = model('fake', 'beta');
const text = (t: string) => [{ type: 'text' as const, text: t }];
const asBen = (extra: Parameters<typeof coopState>[0] = {}) => coopState({ sessionId: guestOf.id, me: BEN.id, role: 'editor', ...extra });
const attachments = (): Attachments => ({ items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: vi.fn(), restore: vi.fn(), uploading: false, parts: () => [] });

beforeEach(() =>
  resetBackend({
    'app.info': () => ({ surface: 'desktop' }) as AppInfo,
    'models.list': () => [ALPHA, BETA],
    'artifacts.list': () => [],
    'slash.list': () => [],
    'chat.secondOpinion': () => ({ ok: true }),
    'chat.react': () => ({ ok: true }),
  }),
);

const reply = [message('u1', 'user', { parts: text('Make the water wave') }), message('a1', 'assistant', { parts: text('Done.'), stopReason: 'end' })];

describe('a second opinion', () => {
  it('asks another model the host has, as a new version of the reply', async () => {
    renderCoop((live) => <Transcript sessionId={hosting.id} live={live} />, { live: liveState(hosting, { messages: reply }), state: coopState() });
    fireEvent.click(await screen.findByRole('button', { name: 'Second opinion' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /beta/ }));
    await waitFor(() => expect(callsTo('chat.secondOpinion')).toEqual([{ sessionId: hosting.id, messageId: 'a1', model: 'host:fake/beta' }]));
  });

  it('offers a guest across computers the models the host shares', async () => {
    const state = asBen({ hostModels: [{ ref: 'openai/gpt-6', displayName: 'GPT-6' }] });
    renderCoop((live) => <Transcript sessionId={guestOf.id} live={live} />, { live: liveState(guestOf, { messages: reply }), state });
    fireEvent.click(await screen.findByRole('button', { name: 'Second opinion' }));
    expect(screen.queryByText('Ada’s list isn’t shown on this computer.')).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: /GPT-6/ }));
    await waitFor(() => expect(callsTo('chat.secondOpinion')).toEqual([{ sessionId: guestOf.id, messageId: 'a1', model: 'host:openai/gpt-6' }]));
  });

  it('greys out a guest’s own models while the host hasn’t agreed to them', async () => {
    renderCoop((live) => <Transcript sessionId={guestOf.id} live={live} />, { live: liveState(guestOf, { messages: reply }), state: asBen({ settings: { ...coopState().settings, allowGuestModels: false } }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Second opinion' }));
    const beta = await screen.findByRole('menuitem', { name: /beta/ });
    expect(beta.getAttribute('aria-disabled')).toBe('true');
    expect(beta.textContent).toContain('Ada hasn’t agreed to send this session to guests’ own models.');
    // Across computers the host's own list isn't known here.
    expect(screen.getByText('Ada’s list isn’t shown on this computer.')).toBeTruthy();
  });
});

describe('naming a model with @', () => {
  /** A message box with the co-op view's models. */
  function Box({ onSubmit }: { onSubmit: (text: string, options?: { answerWith?: string }) => void }) {
    const coop = useCoopView();
    const models = useAnswerModels(coop).flatMap((g) => g.models);
    return <Composer variant="reply" attachments={attachments()} model={ALPHA} streaming={false} onSubmit={onSubmit} answerModels={models} />;
  }

  it('offers the models after @, shows the one picked as a chip and sends it with the message', async () => {
    const onSubmit = vi.fn();
    renderCoop(<Box onSubmit={onSubmit} />, { live: liveState(guestOf), state: asBen({ via: 'server' }) });
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    // Wait for the models to come in, then mention one.
    await waitFor(() => {
      fireEvent.change(box, { target: { value: '@bet', selectionStart: 4 } });
      fireEvent.select(box, { target: { selectionStart: 4 } });
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['betaAda’s models', 'betaYour models']);
    fireEvent.click(options[1]!);
    expect(await screen.findByText('beta')).toBeTruthy();
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'try it your way' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('try it your way', { answerWith: 'own:fake/beta' });
    expect(screen.queryByRole('button', { name: 'Don’t ask beta' })).toBeNull();
  });

  it('says on a message which model it asked for', async () => {
    const messages = [message('u1', 'user', { parts: text('Your take?'), author: BEN.id, answerWith: 'own:fake/beta' })];
    renderCoop((live) => <Transcript sessionId={hosting.id} live={live} />, { live: liveState(hosting, { messages }), state: coopState() });
    expect(await screen.findByText('Ben · asked for beta')).toBeTruthy();
  });
});

describe('reactions', () => {
  it('show who reacted, and take the viewer’s own off or put a new one on', async () => {
    const live = liveState(guestOf, { messages: reply, reactions: { u1: [{ emoji: '👍', participants: [ADA.id, BEN.id] }] } });
    renderCoop((l) => <Transcript sessionId={guestOf.id} live={l} />, { live, state: asBen() });
    const pill = await screen.findByRole('button', { name: '👍 2: Ada, You' });
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pill);
    await waitFor(() => expect(callsTo('chat.react')).toEqual([{ sessionId: guestOf.id, messageId: 'u1', emoji: '👍', on: false }]));

    fireEvent.click(screen.getAllByRole('button', { name: 'React' }).at(-1)!);
    fireEvent.click(await screen.findByRole('button', { name: '🎉' }));
    await waitFor(() => expect(callsTo('chat.react').at(-1)).toEqual({ sessionId: guestOf.id, messageId: 'a1', emoji: '🎉', on: true }));
  });
});

describe('the navigator', () => {
  it('is someone turning their model’s reviews on for themselves', async () => {
    resetBackend({ 'app.info': () => ({ surface: 'desktop' }) as AppInfo, 'models.list': () => [], 'coop.navigate': () => asBen({ settings: { ...coopState().settings, navigator: BEN.id } }) });
    renderCoop(<CoopButton session={guestOf} />, { live: liveState(guestOf), state: asBen() });
    fireEvent.click(await screen.findByRole('button', { name: /^Co-op/ }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Review edits with my model (navigator)' }));
    await waitFor(() => expect(callsTo('coop.navigate')).toEqual([{ sessionId: guestOf.id, on: true }]));
  });

  it('can be turned off by the host, while no one else can take it over', async () => {
    resetBackend({ 'app.info': () => ({ surface: 'desktop' }) as AppInfo, 'coop.settings': () => coopState() });
    renderCoop(<CoopButton session={hosting} />, { live: liveState(hosting), state: coopState({ settings: { ...coopState().settings, navigator: BEN.id } }) });
    fireEvent.click(await screen.findByRole('button', { name: /^Co-op/ }));
    const own = await screen.findByRole('switch', { name: 'Review edits with my model (navigator)' });
    expect(own.hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByText('Ben reviews the edits now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Ben’s reviews' }));
    await waitFor(() => expect(callsTo('coop.settings')).toEqual([{ sessionId: hosting.id, settings: { navigator: null } }]));
  });

  it('adds its notes to an edit’s result, shown under the change', () => {
    const result = 'Edited src/water.ts.\n<navigator name="Ben">\nThe wave speed is per frame, not per second.\n</navigator>';
    expect(navigatorNotes(result)).toEqual({ notes: [{ name: 'Ben', text: 'The wave speed is per frame, not per second.' }], rest: 'Edited src/water.ts.' });
    render(<NavigatorNotes text={result} />);
    const note = screen.getByRole('complementary', { name: 'Navigator · Ben' });
    expect(note.textContent).toContain('per frame, not per second');
  });
});

describe('parallel tracks', () => {
  const tracks: CoopTrack[] = [
    { id: 't1', title: 'Foam on the waves', participantId: BEN.id, branch: 'coop/foam', status: 'working', createdAt: 0 },
    { id: 't2', title: 'Faster water shader', participantId: ADA.id, branch: 'coop/faster', status: 'done', createdAt: 0 },
  ];
  const code = { ...hosting, mode: 'code' as const };

  it('start with a task, show each one’s author and status, and merge for the host, saying why a merge was refused', async () => {
    resetBackend({
      'app.info': () => ({ surface: 'desktop' }) as AppInfo,
      'coop.tracks': () => tracks,
      'coop.track': (input: { task: string }) => ({ id: 't3', title: input.task, participantId: ADA.id, branch: 'coop/t3', status: 'working', createdAt: 1 }),
      'coop.mergeTrack': () => {
        throw new RpcError(-32000, 'CONFLICT (content): Merge conflict in src/water.ts', { code: 'track_failed' });
      },
      'coop.trackDiff': () => ({ diff: 'diff --git a/src/water.ts b/src/water.ts\n--- a/src/water.ts\n+++ b/src/water.ts\n@@ -1 +1 @@\n-speed = 1\n+speed = 2\n', truncated: false, base: 'main' }),
    });
    renderCoop(<CoopButton session={code} />, { live: liveState(code), state: coopState() });
    fireEvent.click(await screen.findByRole('button', { name: /^Co-op/ }));
    const section = await screen.findByRole('region', { name: 'Tracks' });
    const foam = await within(section).findByRole('listitem', { name: 'Foam on the waves' });
    expect(foam.textContent).toContain('Ben · Working…');
    const faster = within(section).getByRole('listitem', { name: 'Faster water shader' });
    expect(faster.textContent).toContain('You · Ready to merge');

    fireEvent.click(within(faster).getByRole('button', { name: 'Merge' }));
    expect((await within(faster).findByRole('alert')).textContent).toBe('CONFLICT (content): Merge conflict in src/water.ts');

    fireEvent.click(within(faster).getByRole('button', { name: 'View changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Changes in “Faster water shader”' });
    expect(await within(dialog).findByText('src/water.ts')).toBeTruthy();
    await waitFor(() => expect(callsTo('coop.trackDiff')).toEqual([{ sessionId: code.id, trackId: 't2' }]));
  });

  it('start from a task anyone who can chat gives, and leave merging to the host', async () => {
    const guestCode = { ...guestOf, mode: 'code' as const };
    resetBackend({ 'app.info': () => ({ surface: 'desktop' }) as AppInfo, 'models.list': () => [], 'coop.tracks': () => tracks, 'coop.track': (input: { task: string }) => ({ id: 't3', title: input.task, participantId: BEN.id, branch: 'coop/t3', status: 'working', createdAt: 1 }) });
    renderCoop(<CoopButton session={guestCode} />, { live: liveState(guestCode), state: asBen() });
    fireEvent.click(await screen.findByRole('button', { name: /^Co-op/ }));
    const section = await screen.findByRole('region', { name: 'Tracks' });
    await within(section).findByRole('listitem', { name: 'Faster water shader' });
    expect(within(section).queryByRole('button', { name: 'Merge' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Start a track…' }));
    fireEvent.change(within(section).getByRole('textbox', { name: 'The track’s task' }), { target: { value: 'Add foam' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Start track' }));
    await waitFor(() => expect(callsTo('coop.track')).toEqual([{ sessionId: guestCode.id, task: 'Add foam' }]));
    expect(await within(section).findByRole('listitem', { name: 'Add foam' })).toBeTruthy();
  });
});

describe('what the host’s backend refused', () => {
  it('says so calmly above the message box', async () => {
    renderCoop((live) => <Banner live={live} />, { live: liveState(guestOf, { coopNotice: 'The host doesn’t share their models in this session.' }), state: asBen() });
    expect(await screen.findByText('The host doesn’t share their models in this session.')).toBeTruthy();
  });
});

/** The banner with the page's co-op view. */
function Banner({ live }: { live: Parameters<typeof CoopBanner>[0]['live'] }) {
  return <CoopBanner coop={useCoopView()} live={live} />;
}

describe('joining from a pasted link', () => {
  const fragment = inviteFragment(makeInviteUrl('R'.repeat(22), 's'.repeat(43), { hostName: 'Ada', title: 'Minecraft shader', mode: 'code' }));

  it('takes the web link, the app link or the bare invite', () => {
    expect(pastedInvite(`https://atelierhq.dev/join#${fragment}`)).toBe(fragment);
    expect(pastedInvite(` atelier://join#${fragment} `)).toBe(fragment);
    expect(pastedInvite(fragment)).toBe(fragment);
    expect(pastedInvite('https://example.com')).toBeNull();
  });

  it('goes to the join card, or says what a link looks like', async () => {
    const root = createRootRoute({ component: () => <JoinLinkDialog open onOpenChange={() => {}} /> });
    const join = createRoute({ getParentRoute: () => root, path: '/join/$fragment', component: () => null });
    const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
    const router = createRouter({ routeTree: root.addChildren([home, join]), history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const field = await screen.findByRole('textbox', { name: 'Paste the invite link' });
    fireEvent.change(field, { target: { value: 'not a link' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/That isn’t an invite link/)).toBeTruthy();
    fireEvent.change(field, { target: { value: `https://atelierhq.dev/join#${fragment}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/join/${fragment}`));
  });
});
