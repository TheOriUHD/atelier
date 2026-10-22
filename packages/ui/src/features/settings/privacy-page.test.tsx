import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, defaultUserPrefs, type SettingsPath, type UserPrefs } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { PrivacyPage } from './privacy-page.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** Preferences as the backend keeps them: each write answers with the whole document. */
function prefsBackend(initial: UserPrefs = defaultUserPrefs()) {
  let prefs = initial;
  return {
    'prefs.get': () => prefs,
    'prefs.set': ({ path, value }: { path: SettingsPath; value: unknown }) => (prefs = setPath(prefs, path, value)),
  };
}

const EXPORT = { sha256: 'a'.repeat(64), name: 'atelier-export-2026-10-14.zip' };

beforeEach(() => resetBackend({ ...prefsBackend(), 'privacy.export': () => EXPORT, 'privacy.deleteConversations': () => ({ deleted: 3 }) }));
afterEach(() => vi.restoreAllMocks());

/** The page under Settings over the app's routes, starting at `url`. */
async function renderPage(url = '/?settings=privacy') {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <PrivacyPage />
      </>
    ),
    validateSearch: (s: Record<string, unknown>) => (typeof s.settings === 'string' ? { settings: s.settings } : {}),
  });
  const routes = ['/', '/chat/$sessionId', '/code', '/code/$sessionId'].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: [url] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.prefs, queryFn: () => rpc().call('prefs.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { location: () => router.state.location };
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('Privacy page', () => {
  it('keeps everything by default and writes the retention period in days, or null to keep everything', async () => {
    await renderPage();
    const select = await screen.findByRole('combobox', { name: 'Keep conversations' });
    expect(select.textContent).toContain('Keep everything');

    fireEvent.click(select);
    pick(await screen.findByRole('option', { name: '90 days' }));
    await waitFor(() => expect(select.textContent).toContain('90 days'));
    fireEvent.click(select);
    pick(await screen.findByRole('option', { name: 'Keep everything' }));

    await waitFor(() =>
      expect(callsTo('prefs.set')).toEqual([
        { path: ['privacy', 'historyRetentionDays'], value: 90 },
        { path: ['privacy', 'historyRetentionDays'], value: null },
      ]),
    );
  });

  it('saves how private temporary chats are', async () => {
    await renderPage();
    const select = await screen.findByRole('combobox', { name: 'Temporary chats' });
    expect(select.textContent).toContain('Don’t save (default)');
    fireEvent.click(select);
    pick(await screen.findByRole('option', { name: /Start fresh/ }));
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['privacy', 'temporaryChats'], value: 'fresh' }]));
    await waitFor(() => expect(select.textContent).toContain('Start fresh'));
  });

  it('shows a period set some other way as it is', async () => {
    resetBackend(prefsBackend({ ...defaultUserPrefs(), privacy: { historyRetentionDays: 14, temporaryChats: 'private' } }));
    await renderPage();
    expect((await screen.findByRole('combobox', { name: 'Keep conversations' })).textContent).toContain('14 days');
  });

  it('exports everything and downloads the zip from the blob store under its name', async () => {
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));

    await waitFor(() => expect(clicked).toEqual([{ href: `${location.origin}/api/blobs/${EXPORT.sha256}`, download: EXPORT.name }]));
    expect(callsTo('privacy.export')).toEqual([{}]);
  });

  it('shows why the export failed', async () => {
    resetBackend({
      ...prefsBackend(),
      'privacy.export': () => {
        throw appError('failed', 'The disk is full.');
      },
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The disk is full.');
  });

  it('deletes all conversations only after DELETE is typed, then leaves the deleted conversation', async () => {
    const { location } = await renderPage('/chat/s-1?settings=privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete all conversations?' }));
    expect(dialog.getByText(/Projects stay, without their chats\. This can’t be undone\./)).toBeTruthy();
    const confirm = dialog.getByRole('button', { name: 'Delete all conversations' }) as HTMLButtonElement;
    const field = dialog.getByRole('textbox', { name: 'Type DELETE to confirm' });

    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.submit(field.closest('form')!);
    expect(callsTo('privacy.deleteConversations')).toEqual([]);

    fireEvent.change(field, { target: { value: 'DELETE' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(await screen.findByText('Deleted 3 conversations.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete all conversations?' })).toBeNull());
    expect(callsTo('privacy.deleteConversations')).toEqual([{}]);
    await waitFor(() => expect(location().pathname).toBe('/'));
    expect(location().search).toEqual({ settings: 'privacy' });
  });

  it('keeps the dialog open with the reason when deleting fails, and stays on the page', async () => {
    resetBackend({
      ...prefsBackend(),
      'privacy.deleteConversations': () => {
        throw appError('failed', 'The database is locked.');
      },
    });
    const { location } = await renderPage('/code?settings=privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete all conversations?' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }), { target: { value: 'DELETE' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Delete all conversations' }));

    expect(await dialog.findByText('The database is locked.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete all conversations?' })).toBeTruthy();
    expect(location().pathname).toBe('/code');
  });
});
