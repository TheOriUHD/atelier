import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP, defaultUserPrefs, type AppInfo } from '@atelier/protocol';
import { TooltipProvider } from '../components/ui/index.ts';
import { resetBackend, user } from '../features/settings/test-backend.ts';
import type { UpdateStatus } from '../lib/platform.ts';
import { Sidebar } from './sidebar.tsx';
import { VersionNotice } from './version-notice.tsx';

vi.mock('../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge (absent in a browser) with the app's own update status. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

const desktopApp = (state: UpdateStatus['state'] = { kind: 'idle' }) => {
  const status: UpdateStatus = { version: APP.version, channel: 'stable', automatic: true, state, checkedAt: null };
  platform.desktop = { updates: { status: async () => status, onStatus: () => () => {}, install: vi.fn(), download: vi.fn() } };
};

/** `APP.version` moved by one patch release either way. */
const bump = (by: number) => {
  const [major, minor, patch] = APP.version.split(/[.-]/).map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + by}`;
};
const newer = bump(1);
const older = bump(-1);

function backendAt(version: string, { surface = 'web', role = 'admin' }: { surface?: AppInfo['surface']; role?: 'admin' | 'user' } = {}) {
  resetBackend({
    'app.info': (): AppInfo => ({ name: 'Atelier', version, surface, platform: 'linux', dataDir: '/data' }),
    'account.get': () => user({ role }),
    'prefs.get': () => defaultUserPrefs(),
    'groups.list': () => [],
    'sessions.list': () => [],
    'projects.list': () => [],
    'workspaces.list': () => [],
  });
}

/** Renders `component` at `/`, with the router the settings link needs. */
function show(component: () => ReactNode) {
  const rootRoute = createRootRoute({ component });
  const router = createRouter({ routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  platform.desktop = undefined;
});

describe('the version notice', () => {
  it('warns a desktop app that its server is newer', async () => {
    desktopApp();
    backendAt(newer);
    show(VersionNotice);
    expect((await screen.findByRole('status')).textContent).toBe(`The server runs Atelier ${newer}, newer than this app. Some features may not work as intended.`);
  });

  it('tells an admin whose server is older where to update it', async () => {
    desktopApp();
    backendAt(older);
    const router = show(VersionNotice);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toBe(`The server runs an older version (${older}). Update it in Settings › Admin › Server.`);
    fireEvent.click(within(notice).getByRole('button', { name: 'Settings › Admin › Server' }));
    expect(router.state.location.search).toMatchObject({ settings: 'server' });
  });

  it('says nothing about an older server to people who can’t update it', async () => {
    desktopApp();
    backendAt(older, { role: 'user' });
    show(VersionNotice);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing when the versions match', async () => {
    desktopApp();
    backendAt(APP.version);
    show(VersionNotice);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing on the desktop app’s own backend', async () => {
    desktopApp();
    backendAt(newer, { surface: 'desktop' });
    show(VersionNotice);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers a web page a reload once its server was updated', async () => {
    backendAt(newer);
    show(VersionNotice);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain(`The server was updated to Atelier ${newer}.`);
    expect(within(notice).getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('stacks above the app’s own update notice in the sidebar, both visible', async () => {
    desktopApp({ kind: 'downloaded', version: newer });
    backendAt(newer);
    show(() => <Sidebar />);
    await screen.findByText(`Update ${newer} is ready`);
    await screen.findByText(/newer than this app/);
    const notices = screen.getAllByRole('status');
    expect(notices.map((n) => n.textContent)).toEqual([`The server runs Atelier ${newer}, newer than this app. Some features may not work as intended.`, `Update ${newer} is readyRestart`]);
  });
});
