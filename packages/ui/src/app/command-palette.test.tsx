import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs, type Mode, type SessionSummary } from '@atelier/protocol';
import { resetBackend, snapshot } from '../features/settings/test-backend.ts';
import { useUi } from '../lib/ui-store.ts';
import { CommandPalette } from './command-palette.tsx';

vi.mock('../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const session = (id: string, mode: Mode, updatedAt: number): SessionSummary => ({
  id,
  mode,
  workspaceId: mode === 'work' ? 'w1' : null,
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
  updatedAt,
});
const SESSIONS: Partial<Record<Mode, SessionSummary[]>> = {
  chat: [session('Older chat', 'chat', 1_000)],
  work: [session('Quarterly report', 'work', 2_000)],
};

/** `unified`: the backend says Chat and Cowork are one; without it, a server from before that. */
function renderPalette(unified: boolean) {
  resetBackend({
    'app.info': () => ({ name: 'Atelier', version: '0.7.6', surface: 'web', platform: 'linux', dataDir: '', ...(unified ? { unifiedChat: true } : {}) }),
    'settings.get': () => snapshot(defaultSettings()),
    'prefs.get': () => defaultUserPrefs(),
    'sessions.list': ({ mode }: { mode: Mode }) => SESSIONS[mode] ?? [],
  });
  useUi.setState({ paletteOpen: true });
  const rootRoute = createRootRoute({ component: CommandPalette });
  const routes = ['/', '/chat/$sessionId'].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const recent = async () => within((await screen.findByText('Recent chats')).closest('[cmdk-group]') as HTMLElement).getAllByRole('option').map((o) => o.textContent);

beforeEach(() => useUi.setState({ paletteOpen: false }));

describe('the search palette', () => {
  it('lists chats only on a server where Chat and Cowork are still separate', async () => {
    renderPalette(false);
    expect((await recent()).join()).toContain('Older chat');
    expect((await recent()).join()).not.toContain('Quarterly report');
  });

  it('finds old Cowork tasks among the chats, newest first', async () => {
    renderPalette(true);
    await screen.findByText('Quarterly report');
    const rows = await recent();
    expect(rows[0]).toContain('Quarterly report');
    expect(rows[1]).toContain('Older chat');
  });
});
