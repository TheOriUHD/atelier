import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerStatus, PluginSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { resetBackend, snapshot, user } from '../settings/test-backend.ts';
import { CUSTOMIZE_TABS, CustomizePage, type CustomizeSearch } from './customize-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const github: McpServerStatus = {
  name: 'github',
  type: 'http',
  state: 'ready',
  tools: [
    { name: 'search_issues', readOnly: true, enabled: true },
    { name: 'create_issue', readOnly: false, enabled: true },
  ],
};
const reviewKit: PluginSummary = { id: 'review-kit@acme', name: 'review-kit', description: 'Reviews pull requests.', version: '1.2.0', source: 'atelier', enabled: true, skills: ['review-kit:lint'], commands: [], agents: [] };

function renderPage(role: 'admin' | 'user', url = '/customize') {
  resetBackend({
    'account.get': () => user({ role }),
    'settings.get': () => snapshot(),
    'app.info': () => ({ name: 'Atelier', version: '0', surface: 'web', platform: 'darwin', dataDir: '/data' }),
    'workspaces.list': () => [],
    'skills.list': () => [{ name: 'pdf', description: 'Work with PDFs', scope: 'global', manualOnly: false, warnings: [], installed: null }],
    'mcp.status': () => [github],
    'plugins.list': () => [reviewKit],
  });
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/customize',
    component: CustomizePage,
    validateSearch: (s: Record<string, unknown>): CustomizeSearch => (CUSTOMIZE_TABS.includes(s.tab as never) ? { tab: s.tab as CustomizeSearch['tab'] } : {}),
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: [url] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('CustomizePage', () => {
  it('shows skills, connectors and plugins as tabs, the tab kept in the address', async () => {
    const router = renderPage('admin');
    expect((await screen.findAllByRole('tab')).map((t) => t.textContent)).toEqual(['Skills', 'Connectors', 'Plugins']);
    expect(await screen.findByText('pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
    expect(router.state.location.search).toEqual({ tab: 'plugins' });
    expect(await screen.findByRole('switch', { name: 'Enable review-kit' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Add from a marketplace' })).toBeTruthy();
  });

  it('shows connectors and plugins read-only to people who aren’t admins', async () => {
    renderPage('user', '/customize?tab=connectors');
    const table = await screen.findByRole('table', { name: 'Connectors' });
    const row = within(table).getByText('github').closest('tr')!;
    expect(row.textContent).toContain('2 tools: search_issues, create_issue');
    expect(row.textContent).toContain('Ready');
    expect(within(table).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add connector/ })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
    expect(await screen.findByText('review-kit')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add from a marketplace' })).toBeNull();
  });
});
