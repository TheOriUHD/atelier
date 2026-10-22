import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { resetBackend, snapshot } from '../settings/test-backend.ts';
import { HomePage } from './home-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

function renderHome() {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: HomePage,
    validateSearch: (s: Record<string, unknown>) => s as { settings?: string },
  });
  const router = createRouter({ routeTree: root.addChildren([home]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() =>
  resetBackend({
    'settings.get': () => snapshot({ providers: [] }),
    'models.list': () => [],
    'workspaces.list': () => [],
    'projects.list': () => [],
    'sessions.list': () => [],
    'slash.list': () => [],
    'mcp.status': () => [],
    'search.status': () => ({ enabled: false }),
  }),
);

describe('the home page without a model', () => {
  it('is the normal chat home, and the model menu is where a provider gets added', async () => {
    const router = renderHome();
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
    expect(screen.queryByText('Welcome to Atelier')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Choose a model/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add a provider/ }));
    expect(router.state.location.search).toMatchObject({ settings: 'providers' });
  });
});
