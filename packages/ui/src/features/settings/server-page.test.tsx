import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type ServerUpdateJob, type ServerUpdateStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';
import { ServerPage } from './server-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const IDLE: ServerUpdateJob = { state: 'idle', message: null, startedAt: null, finishedAt: null, progress: null, pulledAt: null };
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
    'settings.set': () => ({ ok: true }),
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
  it('shows the version and the newer one, and updates at once, without a question first', async () => {
    renderPage();
    const version = await row('server.version');
    expect(await version.findByText('0.1.8')).toBeTruthy();
    expect(version.getByText('Atelier 0.1.9 is available.')).toBeTruthy();

    const update = await row('server.update');
    expect(update.getByText(/^Downloads the new version and restarts the server\./)).toBeTruthy();
    fireEvent.click(update.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(callsTo('server.update')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await update.findByText('Downloading the new version… Pulling atelier')).toBeTruthy();
    expect((update.getByRole('button', { name: /Updating/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows how much of the new version is down on a bar, then the restart', async () => {
    current = status({ job: { ...IDLE, state: 'pulling', startedAt: Date.now(), progress: { done: 120_000_000, total: 300_000_000, percent: 40, unpacking: false } } });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText('Downloading the new version… 40% · 120 MB of 300 MB')).toBeTruthy();
    expect(update.getByRole('progressbar', { name: 'Server update' }).getAttribute('aria-valuenow')).toBe('40');
    current = status({ job: { ...IDLE, state: 'pulling', startedAt: Date.now(), progress: { done: 300_000_000, total: 300_000_000, percent: 99, unpacking: true } } });
    expect(await update.findByText('Unpacking the new version…', undefined, { timeout: 4000 })).toBeTruthy();
    current = status({ job: { ...IDLE, state: 'restarting', startedAt: Date.now(), progress: { done: 300_000_000, total: 300_000_000, percent: 100, unpacking: false } } });
    expect(await update.findByText(/^Restarting the server\./, undefined, { timeout: 4000 })).toBeTruthy();
    expect(update.getByRole('progressbar', { name: 'Server update' }).getAttribute('aria-valuenow')).toBe('100');
  });

  it('says when the server came back on the new version', async () => {
    current = status({ version: '0.1.9', job: { state: 'done', message: null, startedAt: Date.now() - 60_000, finishedAt: Date.now() - 1000, progress: null, pulledAt: null } });
    renderPage();
    const version = await row('server.version');
    expect(await version.findByText(/^Up to date: 0\.1\.9 is the newest release\./)).toBeTruthy();
    const update = await row('server.update');
    expect(update.getByText(/^Updated /)).toBeTruthy();
    expect(update.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(update.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('checks again when asked, past the cache', async () => {
    current = status({ latest: { version: '0.1.8', checkedAt: Date.now() } });
    renderPage();
    fireEvent.click((await row('server.update')).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(callsTo('server.updates')).toContainEqual({ refresh: true }));
  });

  it('says it is checking while it checks, then what it found', async () => {
    current = status({ latest: { version: '0.1.8', checkedAt: Date.now() - 3 * 60_000 } });
    let answer: (value: ServerUpdateStatus) => void = () => undefined;
    resetBackend({
      'settings.get': () => snapshot(),
      'server.updates': (input: { refresh?: boolean }) => (input.refresh ? new Promise<ServerUpdateStatus>((resolve) => (answer = resolve)) : current),
    });
    renderPage();
    const update = await row('server.update');
    fireEvent.click(update.getByRole('button', { name: 'Check now' }));
    const busy = await update.findByRole('button', { name: 'Checking…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    answer(status({ latest: { version: '0.1.8', checkedAt: Date.now() } }));
    await update.findByRole('button', { name: 'Check now' });
    expect((await row('server.version')).getByText(/Up to date: 0\.1\.8 is the newest release\. Checked/)).toBeTruthy();
  });

  it('offers the update channel on a server that has one, and writes it', async () => {
    current = status({ channel: undefined });
    renderPage();
    await row('server.version');
    expect(document.querySelector('[data-setting-row="server.updateChannel"]')).toBeNull();

    current = status({ channel: 'stable', exactVersions: true });
    cleanup();
    renderPage();
    const channel = await row('server.updateChannel');
    fireEvent.click(channel.getByRole('combobox'));
    const beta = await screen.findByRole('option', { name: 'Beta' });
    // Base UI only accepts mouse clicks that started on the option.
    fireEvent.pointerDown(beta, { pointerType: 'mouse' });
    fireEvent.click(beta);
    await waitFor(() => expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['server', 'updateChannel'], value: 'beta' }));
  });

  it('on beta, names a beta as one, and says how to update an updater too old for betas', async () => {
    current = status({ version: '0.10.6', latest: { version: '0.10.7-beta.6', checkedAt: Date.now() }, channel: 'beta', exactVersions: false });
    renderPage();
    expect((await row('server.version')).getByText('Atelier 0.10.7-beta.6 is available (a beta).')).toBeTruthy();
    expect((await row('server.updateChannel')).getByText('docker compose pull updater && docker compose up -d updater')).toBeTruthy();
  });

  it('explains the manual update without an updater service', async () => {
    current = status({ install: 'manual' });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText(/This server has no updater service\./)).toBeTruthy();
    expect(update.getByText('docker compose pull && docker compose up -d')).toBeTruthy();
    expect(update.queryByRole('button', { name: 'Update now' })).toBeNull();
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
    expect(update.queryByRole('button', { name: 'Update now' })).toBeNull();
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
    fireEvent.click(update.getByRole('button', { name: 'Update now' }));
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

const AUTO = { enabled: true, state: 'idle', version: null, waitingFor: null, error: null, retryAt: null, downloadsAhead: true } as const;

describe('Automatic updates', () => {
  it('offers the switch only on a server that does them, and writes the setting', async () => {
    renderPage();
    await row('server.version');
    expect(document.querySelector('[data-setting-row="server.autoUpdate"]')).toBeNull();

    current = status({ auto: { ...AUTO, enabled: false } });
    cleanup();
    renderPage();
    const auto = await row('server.autoUpdate');
    const toggle = auto.getByRole('switch') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['server', 'autoUpdate'], value: true }));
  });

  it('has no switch for a server without an updater service', async () => {
    current = status({ install: 'manual', auto: { ...AUTO, enabled: false } });
    renderPage();
    await row('server.update');
    expect(document.querySelector('[data-setting-row="server.autoUpdate"]')).toBeNull();
  });

  it('says it is updated automatically, and keeps the manual button', async () => {
    current = status({ auto: AUTO });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText(/^This server updates itself as soon as nothing is running\./)).toBeTruthy();
    expect(update.getByRole('button', { name: 'Update now' })).toBeTruthy();
  });

  it('says in words that the new version comes down in the background, over the bar', async () => {
    current = status({
      auto: { ...AUTO, state: 'downloading', version: '0.1.9' },
      job: { ...IDLE, state: 'pulling', startedAt: Date.now(), progress: { done: 120_000_000, total: 300_000_000, percent: 40, unpacking: false } },
    });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText('Downloading Atelier 0.1.9 in the background… 40% · 120 MB of 300 MB')).toBeTruthy();
    expect(update.getByRole('progressbar', { name: 'Server update' }).getAttribute('aria-valuenow')).toBe('40');
  });

  it('says what it waits for, counted', async () => {
    current = status({ auto: { ...AUTO, state: 'waiting', version: '0.1.9', waitingFor: { turns: 2, background: 1 } } });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText('Atelier 0.1.9 is downloaded and installs as soon as nothing is running (2 replies, 1 background task).')).toBeTruthy();
    current = status({ auto: { ...AUTO, state: 'waiting', version: '0.1.9', waitingFor: { turns: 1, background: 0 } } });
    cleanup();
    renderPage();
    expect(await (await row('server.update')).findByText('Atelier 0.1.9 is downloaded and installs as soon as nothing is running (1 reply).')).toBeTruthy();
  });

  it('says when it installs, with the button busy', async () => {
    current = status({ auto: { ...AUTO, state: 'installing', version: '0.1.9' } });
    renderPage();
    const update = await row('server.update');
    expect(await update.findByText('Installing Atelier 0.1.9. This page reconnects in a moment.')).toBeTruthy();
    expect((update.getByRole('button', { name: /Updating/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why a try failed and when the next one is', async () => {
    const retryAt = new Date(2026, 10, 21, 15, 42).getTime();
    current = status({ auto: { ...AUTO, state: 'failed', version: '0.1.9', error: 'manifest unknown', retryAt } });
    renderPage();
    const update = await row('server.update');
    const text = (await update.findByText(/^The automatic update to Atelier 0\.1\.9 didn’t work: manifest unknown\. Trying again at /)).textContent;
    expect(text).toContain(new Date(retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });
});
