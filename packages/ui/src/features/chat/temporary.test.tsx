import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type Mode, type SessionSummary, type UserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { Sidebar } from '../../app/sidebar.tsx';
import { callsTo, model, resetBackend, snapshot } from '../settings/test-backend.ts';
import { ChatPage } from './chat-page.tsx';
import { HomePage } from './home-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  mode: 'chat',
  workspaceId: null,
  permissionMode: null,
  title: id,
  projectId: null,
  model: 'fake/m',
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: Date.now(),
  ...extra,
});

let sessions: SessionSummary[];

function setup(prefs: UserPrefs = defaultUserPrefs()) {
  sessions = [summary('Kept chat')];
  resetBackend({
    'prefs.get': () => prefs,
    'settings.get': () => snapshot({ providers: [{ id: 'fake', type: 'ollama', name: 'Fake', baseUrl: 'http://lab:11434', headers: {}, enabled: true }] }),
    'models.list': () => [model('fake', 'm')],
    'workspaces.list': () => [],
    'projects.list': () => [],
    'groups.list': () => [],
    'slash.list': () => [],
    'mcp.status': () => [],
    'search.status': () => ({ enabled: false }),
    // Stale on purpose: it carries the temporary chat, which the sidebar must still leave out.
    'sessions.list': ({ mode }: { mode?: Mode }) => sessions.filter((s) => !mode || s.mode === mode),
    'sessions.create': (input: { temporary?: boolean }) => {
      const created = summary('Temp', { temporary: input.temporary ? prefs.privacy.temporaryChats : null });
      sessions.push(created);
      return created;
    },
    'chat.send': () => ({ userMessageId: 'm1' }),
    'sessions.subscribe': ({ id }: { id: string }) => ({
      session: sessions.find((s) => s.id === id),
      messages: [],
      siblings: {},
      streamingMessageId: null,
      pending: null,
      todos: [],
      tasks: [],
      toolOutput: {},
      context: null,
      compacting: false,
      queued: null,
      phase: null,
      outbox: [],
      seq: 0,
    }),
    'artifacts.list': () => [],
    'sideChats.list': () => [],
    'sessions.markSeen': () => ({ ok: true }),
    'sessions.leave': ({ id }: { id: string }) => {
      sessions = sessions.filter((s) => s.id !== id);
      return { deleted: true };
    },
  });
}

function renderApp(url = '/') {
  const rootRoute = createRootRoute({
    component: () => (
      <div>
        <Sidebar />
        <Outlet />
      </div>
    ),
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: HomePage,
    validateSearch: (s: Record<string, unknown>): { temporary?: boolean } => (s.temporary === true || s.temporary === 'true' ? { temporary: true } : {}),
  });
  const others = ['/projects', '/projects/$projectId', '/artifacts', '/customize', '/work', '/work/$sessionId', '/code', '/code/$sessionId'].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const chat = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$sessionId', component: ChatPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([home, chat, ...others]), history: createMemoryHistory({ initialEntries: [url] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

const composerBox = () => screen.getByRole('textbox').closest('[data-temporary], .rounded-composer');

beforeEach(() => setup());

describe('temporary chats', () => {
  it('turn the new-chat page into the temporary one, with a dashed composer and what happens explained', async () => {
    const router = renderApp();
    const toggle = await screen.findByRole('button', { name: 'Temporary chat' });
    expect(composerBox()?.getAttribute('data-temporary')).toBeNull();
    fireEvent.click(toggle);

    expect(await screen.findByRole('heading', { name: /You’re in a temporary chat/ })).toBeTruthy();
    expect(router.state.location.search).toEqual({ temporary: true });
    expect(screen.getByRole('button', { name: 'Leave temporary chat' })).toBeTruthy();
    await waitFor(() => expect(composerBox()?.getAttribute('data-temporary')).toBe('true'));
    expect(screen.getByText(/stay out of your history and memory, and are deleted when you leave them/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Learn more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Leave temporary chat' }));
    expect(await screen.findByRole('button', { name: 'Temporary chat' })).toBeTruthy();
    expect(router.state.location.search).toEqual({});
  });

  it('says a fresh one ignores memory and personal instructions, and offers no project', async () => {
    const prefs = defaultUserPrefs();
    prefs.privacy.temporaryChats = 'fresh';
    setup(prefs);
    renderApp('/?temporary=true');
    expect(await screen.findByText(/This one starts fresh: no memory, personal instructions or projects/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    expect(screen.queryByText('Project')).toBeNull();
  });

  it('creates a temporary session on send, keeps it out of the sidebar and deletes it on leaving', async () => {
    const router = renderApp('/?temporary=true');
    await screen.findByRole('heading', { name: /temporary chat/ });
    const box = screen.getByRole('textbox');
    await waitFor(() => expect(screen.getByText('m')).toBeTruthy());
    fireEvent.change(box, { target: { value: 'Something private' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.pathname).toBe('/chat/Temp'));
    expect(callsTo('sessions.create')).toEqual([expect.objectContaining({ mode: 'chat', temporary: true })]);
    expect(callsTo('chat.send')).toEqual([{ sessionId: 'Temp', parts: [{ type: 'text', text: 'Something private' }] }]);
    // The session view keeps the temporary look.
    expect(await screen.findByRole('button', { name: 'Leave temporary chat' })).toBeTruthy();
    await waitFor(() => expect(composerBox()?.getAttribute('data-temporary')).toBe('true'));

    const sidebar = await screen.findByRole('navigation', { name: 'Sidebar' });
    await within(sidebar).findByText('Kept chat');
    expect(within(sidebar).queryByText('Temp')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Leave temporary chat' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(callsTo('sessions.leave')).toEqual([{ id: 'Temp' }]), { timeout: 3000 });
  });
});
