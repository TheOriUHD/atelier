import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type ServerUpdateJob, type ServerUpdateStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';
import { ServerPage } from './server-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const IDLE: ServerUpdateJob = { state: 'idle', message: null, startedAt: null, finishedAt: null };
const status = (extra: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
  version: '0.1.8',
  latest: { version: '0.1.9', checkedAt: Date.now() },
  latestError: null,
  install: 'updater',
  image: 'ghcr.io/theoriuhd/atelier:latest',
  updaterError: null,
  job: IDLE,
  ...extra,
});

let current: ServerUpdateStatus | null;
beforeEach(() => {
  current = status();
  resetBackend({
    'settings.get': () => snapshot(),
    'server.updates': () => current,
    'server.update': () => (current = status({ job: { ...IDLE, state: 'pulling', startedAt: Date.now(), message: 'Pulling atelier' } })),
  });
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ServerPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const row = async (id: string) =>
  within(
    await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
      if (!el) throw new Error(`no row ${id}`);
      return el;
    }),
  );

describe('Server page', () => {
  it('shows the version and the newer one, and updates after a confirmation', async () => {
    renderPage();
    const version = await row('server.version');
    expect(await version.findByText('0.1.8')).toBeTruthy();
    expect(version.getByText('Atelier 0.1.9 is available.')).toBeTruthy();

    const update = await row('server.update');
    fireEvent.click(update.getByRole('button', { name: 'Update server' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Update the server to Atelier 0.1.9?')).toBeTruthy();
    expect(callsTo('server.update')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update server' }));

    await waitFor(() => expect(callsTo('server.update')).toHaveLength(1));
    expect(await update.findByText('Downloading the new version… Pulling atelier')).toBeTruthy();
    expect((update.getByRole('button', { name: /Updating/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the server came back on the new version', async () => {
    current = status({ version: '0.1.9', job: { state: 'done', message: null, startedAt: Date.now() - 60_000, finishedAt: Date.now() - 1000 } });
    renderPage();
    const version = await row('server.version');
    expect(await version.findByText(/^Up to date\./)).toBeTruthy();
    const update = await row('server.update');
    expect(update.getByText(/^Updated /)).toBeTruthy();
    expect(update.queryByRole('button', { name: 'Update server' })).toBeNull();
    expect(update.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('checks again when asked, past the cache', async () => {
    current = status({ latest: { version: '0.1.8', checkedAt: Date.now() } });
    renderPage();
    fireEvent.click((await row('server.update')).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(callsTo('server.updates')).toContainEqual({ refresh: true }));
  });

  it('explains the manual update without an updater service', async () => {
    current = status({ install: 'manual' });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText(/This server has no updater service\./)).toBeTruthy();
    expect(update.getByText('docker compose pull && docker compose up -d')).toBeTruthy();
    expect(update.queryByRole('button', { name: 'Update server' })).toBeNull();
  });

  it('names an updater that can’t be reached', async () => {
    current = status({ install: 'manual', updaterError: 'The updater can’t be reached at http://updater:7341: fetch failed' });
    renderPage();
    expect(await (await row('server.update')).findByText(/can’t be reached at http:\/\/updater:7341/)).toBeTruthy();
  });

  it('sends a server built from source to a rebuild instead of a button', async () => {
    current = status({ install: 'source', image: 'atelier:local' });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText('This server was built from source; update it by rebuilding its image.')).toBeTruthy();
    expect(update.queryByRole('button', { name: 'Update server' })).toBeNull();
  });

  it('shows why the last update failed, and why an update was refused', async () => {
    current = status({ job: { ...IDLE, state: 'failed', message: 'manifest unknown', finishedAt: Date.now() } });
    resetBackend({
      'settings.get': () => snapshot(),
      'server.updates': () => current,
      'server.update': () => {
        throw appError('updater_failed', 'The updater answered 500.');
      },
    });
    renderPage();
    const update = await row('server.update');
    expect((await update.findByRole('alert')).textContent).toBe('The last update failed: manifest unknown');
    fireEvent.click(update.getByRole('button', { name: 'Update server' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Update server' }));
    await waitFor(() => expect(update.getByRole('alert').textContent).toBe('The updater answered 500.'));
  });

  it('has no version section on the desktop app’s own backend', async () => {
    current = null;
    renderPage();
    await row('server.signup');
    await waitFor(() => expect(callsTo('server.updates')).toHaveLength(1));
    expect(document.querySelector('[data-setting-row="server.version"]')).toBeNull();
  });
});
