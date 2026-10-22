import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type Mode, type Project, type SessionSummary, type SettingsPath, type WorkspaceSummary } from '@atelier/protocol';
import { TooltipProvider } from '../components/ui/index.ts';
import { callsTo, resetBackend } from '../features/settings/test-backend.ts';
import { setPath } from '../lib/json-path.ts';
import { useUi } from '../lib/ui-store.ts';
import { Sidebar } from './sidebar.tsx';

vi.mock('../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const today = Date.now();
const yesterday = new Date().setHours(0, 0, 0, 0) - 12 * 3_600_000;

const session = (id: string, mode: Mode, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  mode,
  workspaceId: null,
  permissionMode: null,
  title: id,
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: today,
  ...extra,
});
const project = (id: string, pinnedAt: number | null): Project & { fileCount: number; sessionCount: number } => ({
  id,
  name: id,
  description: '',
  instructions: '',
  pinnedAt,
  createdAt: 0,
  updatedAt: 0,
  fileCount: 0,
  sessionCount: 0,
});
const folder: WorkspaceSummary = { id: 'w1', kind: 'local', name: 'site', root: '/home/ada/site', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 1 };

const SESSIONS: Record<Mode, SessionSummary[]> = {
  chat: [
    session('Pinned chat', 'chat', { pinnedAt: 5 }),
    session('Charts', 'chat', { produced: true, status: 'running' }),
    session('Old chat', 'chat', { updatedAt: yesterday }),
  ],
  work: [session('Quarterly report', 'work', { workspaceId: 'w1', updatedAt: today - 1000 })],
  code: [
    session('Fix the build', 'code', { workspaceId: 'w1', status: 'running' }),
    session('Tidy up', 'code', { workspaceId: 'w1', updatedAt: today - 1000 }),
    session('Scratch', 'code', { workspaceId: 'gone', updatedAt: yesterday }),
  ],
};

beforeEach(() => {
  useUi.setState({ activeCell: null });
  let prefs = defaultUserPrefs();
  resetBackend({
    'prefs.get': () => prefs,
    'prefs.set': ({ path, value }: { path: SettingsPath; value: unknown }) => (prefs = setPath(prefs, path, value)),
    'groups.list': () => [],
    'sessions.list': ({ mode }: { mode: Mode }) => SESSIONS[mode],
    'projects.list': () => [project('Garden', 9), project('Taxes', null)],
    'workspaces.list': () => [folder],
  });
});

function renderSidebar(url: string) {
  const rootRoute = createRootRoute({ component: Sidebar });
  const paths = ['/', '/projects', '/projects/$projectId', '/artifacts', '/customize', '/work', '/work/$sessionId', '/chat/$sessionId', '/code', '/code/$sessionId'];
  const routes = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: [url] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

const nav = () => screen.findByRole('navigation', { name: 'Sidebar' });
const links = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.textContent);

describe('Sidebar', () => {
  it('has two mode tabs; Chat lists New, Projects, Artifacts, Cowork and Customize, and More opens in place', async () => {
    const router = renderSidebar('/');
    const sidebar = await nav();
    const tabs = within(sidebar).getByRole('radiogroup', { name: 'Mode' });
    expect(within(tabs).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Chat', 'Code']);
    expect(within(sidebar).getByText('Atelier')).toBeTruthy();
    expect(links(sidebar).slice(0, 5)).toEqual(['New', 'Projects', 'Artifacts', 'Cowork', 'Customize']);

    fireEvent.click(within(sidebar).getByRole('link', { name: 'Cowork' }));
    expect(router.state.location.pathname).toBe('/work');
    // Cowork belongs to Chat: the Chat tab stays.
    expect(within(tabs).getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true');

    const more = within(sidebar).getByRole('button', { name: 'More' });
    expect(within(sidebar).queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('pins projects and conversations, then lists chats and Cowork tasks by day, filtered from the first group', async () => {
    renderSidebar('/');
    const sidebar = await nav();
    const pinned = await within(sidebar).findByRole('region', { name: 'Pinned' });
    await within(pinned).findByText('Garden');
    expect(links(pinned)).toEqual(['Garden', 'Pinned chat']);
    expect(within(pinned).getByRole('img', { name: 'Project' })).toBeTruthy();

    const todayGroup = await within(sidebar).findByRole('region', { name: 'Today' });
    await within(todayGroup).findByText('Quarterly report');
    expect(links(todayGroup)).toEqual(['Charts', 'Quarterly report']);
    expect(within(todayGroup).getByRole('img', { name: 'Cowork task' })).toBeTruthy();
    expect(within(todayGroup).getByRole('img', { name: 'Made an artifact' })).toBeTruthy();
    expect(within(todayGroup).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(links(within(sidebar).getByRole('region', { name: 'Yesterday' }))).toEqual(['Old chat']);

    fireEvent.click(within(todayGroup).getByRole('button', { name: 'Filter recents' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Cowork tasks' }));
    expect(within(sidebar).queryByText('Charts')).toBeNull();
    expect(within(sidebar).queryByText('Pinned chat')).toBeNull();
    expect(within(sidebar).getByText('Quarterly report')).toBeTruthy();
    expect(within(sidebar).getByText('Garden')).toBeTruthy();
  });

  it('colors a Code session’s dot yellow when it needs you and blue when a turn finished while you were away', async () => {
    const code = [
      session('Needs a decision', 'code', { workspaceId: 'w1', status: 'waiting' }),
      session('All done', 'code', { workspaceId: 'w1', finishedUnseen: true, updatedAt: today - 1000 }),
      session('Seen already', 'code', { workspaceId: 'w1', finishedUnseen: false, updatedAt: today - 2000 }),
    ];
    resetBackend({
      'sessions.list': ({ mode }: { mode: Mode }) => (mode === 'code' ? code : []),
      'projects.list': () => [],
      'workspaces.list': () => [folder],
    });
    renderSidebar('/code');
    const site = await within(await nav()).findByRole('region', { name: 'site' });
    const row = (name: string) => within(site).getByRole('link', { name: new RegExp(name) });
    expect(within(row('Needs a decision')).getByRole('img', { name: 'Needs your attention' }).className).toContain('bg-warning');
    expect(within(row('All done')).getByRole('img', { name: 'Finished' }).className).toContain('bg-interactive');
    expect(within(row('Seen already')).queryByRole('img')).toBeNull();
  });

  it('offers a Code session’s menu: pin, unread, rename, fork, move to a group, archive, delete, each with its key', async () => {
    resetBackend({
      'prefs.get': () => defaultUserPrefs(),
      'groups.list': () => [{ id: 'g1', name: 'Aperture', collapsed: false, createdAt: 1 }],
      'sessions.list': () => [session('Tidy up', 'code', { workspaceId: 'w1' })],
      'workspaces.list': () => [folder],
      'projects.list': () => [],
      'sessions.update': ({ id }: { id: string }) => session(id, 'code'),
      'sessions.fork': () => session('Fork of Tidy up', 'code', { id: 'fork-1' }),
    });
    renderSidebar('/code');
    const sidebar = await nav();
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Options for Tidy up' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((e) => e.textContent);
    expect(items).toEqual(['Open in', 'PinP', 'Mark as unreadU', 'RenameR', 'ForkF', 'Move to group', 'ArchiveA', 'DeleteD']);

    fireEvent.keyDown(menu, { key: 'u' });
    await waitFor(() => expect(callsTo('sessions.update')).toEqual([{ id: 'Tidy up', unread: true }]));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Options for Tidy up' }));
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'a' });
    await waitFor(() => expect(callsTo('sessions.update')).toContainEqual({ id: 'Tidy up', archived: true }));

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Options for Tidy up' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Move to group/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Aperture/ }));
    await waitFor(() => expect(callsTo('sessions.update')).toContainEqual({ id: 'Tidy up', groupId: 'g1' }));

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Options for Tidy up' }));
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'f' });
    await waitFor(() => expect(callsTo('sessions.fork')).toEqual([{ id: 'Tidy up' }]));
  });

  it('opens a session’s menu on right-click too, at the pointer, without opening the session', async () => {
    resetBackend({
      'prefs.get': () => defaultUserPrefs(),
      'groups.list': () => [],
      'sessions.list': () => [session('Tidy up', 'code', { workspaceId: 'w1' })],
      'workspaces.list': () => [folder],
      'projects.list': () => [],
      'sessions.update': ({ id }: { id: string }) => session(id, 'code'),
    });
    const router = renderSidebar('/code');
    const sidebar = await nav();
    const row = await within(sidebar).findByRole('link', { name: /Tidy up/ });
    expect(fireEvent.contextMenu(row, { clientX: 40, clientY: 120 })).toBe(false);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((e) => e.textContent)).toContain('DeleteD');
    expect(router.state.location.pathname).toBe('/code');

    fireEvent.keyDown(menu, { key: 'p' });
    await waitFor(() => expect(callsTo('sessions.update')).toEqual([{ id: 'Tidy up', pinned: true }]));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opens a Code session beside the one open now (split view), and marks both rows as open', async () => {
    resetBackend({
      'prefs.get': () => defaultUserPrefs(),
      'groups.list': () => [],
      'sessions.list': () => [session('First', 'code', { workspaceId: 'w1' }), session('Second', 'code', { workspaceId: 'w1', updatedAt: today - 1000 })],
      'workspaces.list': () => [folder],
      'projects.list': () => [],
    });
    const router = renderSidebar('/code/First');
    const sidebar = await nav();
    // The one open has nothing to split with itself.
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Options for First' }));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: 'Open in' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Options for Second' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Split view/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/code/First'));
    expect(router.state.location.search).toEqual({ split: 'Second' });
    const row = (name: string) => within(sidebar).getByRole('link', { name: new RegExp(name) });
    await waitFor(() => expect(row('Second').classList.contains('bg-fill-ghost-selected')).toBe(true));
  });

  it('replaces the active cell of a split view with the session picked, and puts New into it', async () => {
    resetBackend({
      'prefs.get': () => defaultUserPrefs(),
      'groups.list': () => [],
      'sessions.list': () => [session('First', 'code', { workspaceId: 'w1' }), session('Second', 'code', { workspaceId: 'w1', updatedAt: today - 1000 }), session('Third', 'code', { workspaceId: 'w1', updatedAt: today - 2000 })],
      'workspaces.list': () => [folder],
      'projects.list': () => [],
    });
    const router = renderSidebar('/code/First?split=Second');
    const sidebar = await nav();
    const row = (name: string) => within(sidebar).getByRole('link', { name: new RegExp(name) });
    await within(sidebar).findByRole('link', { name: /Third/ });
    // Both open sessions are marked; the one that is not open is not.
    expect(row('Second').classList.contains('bg-fill-ghost-selected')).toBe(true);
    expect(row('Third').classList.contains('bg-fill-ghost-selected')).toBe(false);

    // First is the active cell: Third takes its place.
    fireEvent.click(row('Third'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/code/Third'));
    expect(router.state.location.search).toEqual({ split: 'Second' });

    // A session that is open already is just made the active cell, with no change to the cells.
    fireEvent.click(row('Second'));
    await waitFor(() => expect(router.state.location.search).toEqual({ split: 'Second' }));
    expect(router.state.location.pathname).toBe('/code/Third');

    // New goes into the active cell (now Second).
    fireEvent.click(within(sidebar).getByRole('link', { name: 'New' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ split: 'new' }));
    expect(router.state.location.pathname).toBe('/code/Third');
  });

  it('groups by the person’s own groups, with a fold per group', async () => {
    let collapsed = false;
    let prefs = defaultUserPrefs();
    resetBackend({
      'prefs.get': () => prefs,
      'prefs.set': ({ path, value }: { path: SettingsPath; value: unknown }) => (prefs = setPath(prefs, path, value)),
      'groups.list': () => [{ id: 'g1', name: 'Aperture', collapsed, createdAt: 1 }],
      'groups.update': ({ collapsed: next }: { collapsed: boolean }) => ((collapsed = next), { id: 'g1', name: 'Aperture', collapsed, createdAt: 1 }),
      'sessions.list': () => [session('In the group', 'code', { workspaceId: 'w1', groupId: 'g1' }), session('Loose', 'code', { workspaceId: 'w1' })],
      'workspaces.list': () => [folder],
      'projects.list': () => [],
    });
    prefs = setPath(prefs, ['sidebar', 'groupBy'], 'custom');
    renderSidebar('/code');
    const sidebar = await nav();
    const aperture = await within(sidebar).findByRole('region', { name: 'Aperture' });
    expect(links(aperture)).toEqual(['In the group']);
    expect(links(within(sidebar).getByRole('region', { name: 'Ungrouped' }))).toEqual(['Loose']);

    fireEvent.click(within(aperture).getByRole('button', { name: 'Aperture' }));
    await waitFor(() => expect(callsTo('groups.update')).toEqual([{ id: 'g1', collapsed: true }]));
  });

  it('shows Code with its own title and rows, sessions by folder with a + and a filter, and the profile', async () => {
    const router = renderSidebar('/code');
    const sidebar = await nav();
    expect(within(sidebar).getByText('Atelier Code')).toBeTruthy();
    const site = await within(sidebar).findByRole('region', { name: 'site' });
    expect(links(sidebar).slice(0, 2)).toEqual(['New', 'Customize']);
    expect(within(sidebar).getByRole('link', { name: 'Customize' }).getAttribute('href')).toContain('mode=code');
    expect(links(site)).toEqual(['Fix the build', 'Tidy up']);
    expect(within(site).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(links(within(sidebar).getByRole('region', { name: 'Ungrouped' }))).toEqual(['Scratch']);

    fireEvent.click(within(site).getByRole('button', { name: 'New session in site' }));
    expect(router.state.location.search).toEqual({ workspace: 'w1' });

    // The view options: group by state, then by nothing, then back by folder.
    fireEvent.click(within(site).getByRole('button', { name: 'View options for sessions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Group by/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'State' }));
    expect(await within(sidebar).findByRole('region', { name: 'Running' })).toBeTruthy();
    expect(links(within(sidebar).getByRole('region', { name: 'Running' }))).toEqual(['Fix the build']);
    expect(links(within(sidebar).getByRole('region', { name: 'Idle' }))).toEqual(['Tidy up', 'Scratch']);

    fireEvent.click(within(sidebar).getByRole('button', { name: 'View options for sessions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Group by/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'None' }));
    expect(links(await within(sidebar).findByRole('region', { name: 'Recents' }))).toEqual(['Fix the build', 'Tidy up', 'Scratch']);
    expect(callsTo('prefs.set')).toEqual([
      { path: ['sidebar', 'groupBy'], value: 'state' },
      { path: ['sidebar', 'groupBy'], value: 'none' },
    ]);

    expect(within(sidebar).getByRole('button', { name: 'Ada Lovelace · Admin' })).toBeTruthy();
    expect(within(sidebar).getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('groups Code sessions started with no folder under “No folder”, whose + starts another one', async () => {
    const scratch = (id: string): WorkspaceSummary => ({ ...folder, id, name: `scratch-2026-10-14-${id}`, root: `/data/scratch-workspaces/u1/scratch-2026-10-14-${id}`, scratch: true });
    resetBackend({
      'sessions.list': () => [
        session('Try an idea', 'code', { workspaceId: 's1', updatedAt: today }),
        session('Fix the build', 'code', { workspaceId: 'w1', updatedAt: today - 1000 }),
        session('Quick script', 'code', { workspaceId: 's2', updatedAt: today - 2000 }),
      ],
      'projects.list': () => [],
      'workspaces.list': () => [folder, scratch('s1'), scratch('s2')],
    });
    const router = renderSidebar('/code');
    const sidebar = await nav();
    const none = await within(sidebar).findByRole('region', { name: 'No folder' });
    expect(within(sidebar).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['No folder', 'site']);
    expect(links(none)).toEqual(['Try an idea', 'Quick script']);
    fireEvent.click(within(none).getByRole('button', { name: 'New session with no folder' }));
    expect(router.state.location.search).toEqual({ workspace: 'none' });
  });
});
