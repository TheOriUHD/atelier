import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteFragment, makeInviteUrl, type AppInfo } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, emit, resetBackend } from '../settings/test-backend.ts';
import { JoinPage } from './join-page.tsx';
import { coopState, guestOf } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const shell = vi.hoisted(() => ({ surface: 'desktop' as 'desktop' | 'web' }));
vi.mock('../../lib/platform.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return Object.defineProperty({ ...actual }, 'surface', { get: () => shell.surface, enumerable: true });
});

/** A room id is 16 random bytes and a secret 32, base64url. */
const fragment = inviteFragment(makeInviteUrl('R'.repeat(22), 's'.repeat(43), { hostName: 'Ada', title: 'Minecraft shader', mode: 'code' }));

function show(path = `/join/${fragment}`) {
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/join/$fragment', component: JoinPage }),
    createRoute({ getParentRoute: () => root, path: '/', component: () => <p>Home</p> }),
    createRoute({ getParentRoute: () => root, path: '/code/$sessionId', component: () => <p>In the session</p> }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

let joined: { sessionId: string; waiting: boolean; fingerprint?: string[] };
let state: ReturnType<typeof coopState> | null;

beforeEach(() => {
  shell.surface = 'desktop';
  joined = { sessionId: guestOf.id, waiting: false };
  state = null;
  resetBackend({
    'app.info': () => ({ surface: 'desktop' }) as AppInfo,
    'coop.join': () => joined,
    'coop.state': () => state,
    'coop.leave': () => ({ ok: true }),
  });
});

describe('the join card', () => {
  it('says whose session it is, where it runs and what the guest shares, then joins with the models they chose', async () => {
    const router = show();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toBe('Join Ada’s session Minecraft shader?');
    expect(screen.getByText('It runs on Ada’s computer.')).toBeTruthy();
    const shares = screen.getByRole('region', { name: 'What you share' });
    expect(within(shares).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Your name and picture', 'The messages you send', 'Your models and connectors, only if you choose them']);
    expect(screen.getByRole('radio', { name: 'Ada’s models' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'My models' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(callsTo('coop.join')).toEqual([{ invite: fragment, models: 'own' }]));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/code/${guestOf.id}`));
  });

  it('waits for the host to let them in, with a place for the fingerprint, and goes in once they do', async () => {
    joined = { sessionId: guestOf.id, waiting: true };
    const router = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('heading', { name: 'Waiting for Ada to let you in…' })).toBeTruthy();
    expect(screen.getByLabelText('Fingerprint not known yet')).toBeTruthy();
    expect(screen.getByText(/The same four emoji show on Ada’s screen/)).toBeTruthy();

    state = coopState({ sessionId: guestOf.id, me: 'peer:ben', role: 'editor' });
    await act(async () => emit('sessions.changed', guestOf));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/code/${guestOf.id}`));
  });

  it('shows the fingerprint the join reports, to compare with the host', async () => {
    joined = { sessionId: guestOf.id, waiting: true, fingerprint: ['🐙', '🌵', '🎈', '🚀'] } as typeof joined;
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByLabelText('Fingerprint: 🐙 🌵 🎈 🚀')).toBeTruthy();
  });

  it('can be called off while waiting, and says so when the host declines', async () => {
    joined = { sessionId: guestOf.id, waiting: true };
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    await screen.findByRole('heading', { name: 'Waiting for Ada to let you in…' });
    await act(async () => emit('sessions.removed', { id: guestOf.id }));
    expect(await screen.findByRole('heading', { name: 'Ada didn’t let you in' })).toBeTruthy();
  });

  it('leaves the room when the guest cancels', async () => {
    joined = { sessionId: guestOf.id, waiting: true };
    const router = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(callsTo('coop.leave')).toEqual([{ sessionId: guestOf.id }]));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('explains that joining needs the desktop app, running on this computer', async () => {
    shell.surface = 'web';
    show();
    expect(await screen.findByText(/needs the Atelier desktop app, running on this computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
  });

  it('says so when a desktop app signed in to a server can’t join', async () => {
    resetBackend({ 'app.info': () => ({ surface: 'web' }) as AppInfo });
    show();
    expect(await screen.findByText(/This app is connected to a server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
  });

  it('turns down a link that isn’t an invite', async () => {
    show('/join/not-an-invite');
    expect(await screen.findByRole('heading', { name: 'This invite link doesn’t work' })).toBeTruthy();
  });
});
