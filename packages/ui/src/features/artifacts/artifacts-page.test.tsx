import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactListItem } from '@atelier/protocol';
import { useUi } from '../../lib/ui-store.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { ArtifactsPage } from './artifacts-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const item = (id: string, type: ArtifactListItem['type'], sessionTitle = 'Charts', sessionMode: ArtifactListItem['sessionMode'] = 'chat'): ArtifactListItem => ({
  id,
  sessionId: `s-${id}`,
  identifier: id,
  type,
  title: `Artifact ${id}`,
  language: null,
  version: 1,
  versions: 1,
  updatedAt: Date.now(),
  sessionTitle,
  sessionMode,
});

function renderPage() {
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/artifacts', component: ArtifactsPage });
  const chat = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$sessionId', component: () => null });
  const code = createRoute({ getParentRoute: () => rootRoute, path: '/code/$sessionId', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, chat, code]), history: createMemoryHistory({ initialEntries: ['/artifacts'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => useUi.setState({ artifact: null }));

describe('ArtifactsPage', () => {
  it('lists artifacts a page at a time, filters by type, and opens one in its chat with the panel open', async () => {
    resetBackend({
      'artifacts.listAll': ({ cursor, type }: { cursor?: string; type?: string }) =>
        type === 'svg'
          ? { items: [item('logo', 'svg')], nextCursor: null }
          : cursor
            ? { items: [item('second', 'react', '')], nextCursor: null }
            : { items: [item('first', 'html')], nextCursor: '1:first' },
    });
    const router = renderPage();
    const list = await screen.findByRole('list', { name: 'Artifacts' });
    expect(within(list).getByText('Artifact first')).toBeTruthy();
    expect(within(list).getByText(/^Charts ·/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Artifact second')).toBeTruthy();
    // An untitled chat is named the way the sidebar names it.
    expect(within(list).getByText(/^New chat ·/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'SVG' }));
    expect(await screen.findByText('Artifact logo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SVG' }).getAttribute('aria-pressed')).toBe('true');
    expect(callsTo('artifacts.listAll').at(-1)).toEqual({ limit: 60, type: 'svg' });

    fireEvent.click(screen.getByText('Artifact logo'));
    expect(useUi.getState().artifact).toMatchObject({ sessionId: 's-logo', artifactId: 'logo' });
    expect(router.state.location.pathname).toBe('/chat/s-logo');
  });

  it('opens a Code session’s artifact in Code', async () => {
    resetBackend({ 'artifacts.listAll': () => ({ items: [item('page', 'html', 'Landing page', 'code')], nextCursor: null }) });
    const router = renderPage();
    fireEvent.click(await screen.findByText('Artifact page'));
    expect(router.state.location.pathname).toBe('/code/s-page');
  });

  it('says what will show up here while there is nothing yet', async () => {
    resetBackend({ 'artifacts.listAll': () => ({ items: [], nextCursor: null }) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No artifacts yet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    expect(await screen.findByText('No HTML artifacts yet.')).toBeTruthy();
  });
});
