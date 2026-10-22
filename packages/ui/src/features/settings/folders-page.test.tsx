import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type DeviceSummary, type WorkspaceSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { TrustWorkspaceHost } from '../workspaces/trust.tsx';
import { FoldersPage } from './folders-page.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge the page sees; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

function desktopBridge(mode: 'local' | 'server', picked: string | null = null) {
  return { connection: { get: vi.fn(async () => ({ mode, serverUrl: null })) }, folders: { pick: vi.fn(async () => picked), trust: vi.fn(async (path: string) => path) } };
}

const folder = (id: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  kind: 'local',
  name: id,
  root: `/Users/ada/${id}`,
  host: null,
  deviceId: 'd-mac',
  available: true,
  scratch: false,
  lastUsedAt: Date.now() - 3_600_000,
  ...extra,
});

const device = (id: string, name: string, current: boolean): DeviceSummary => ({ id, name, platform: 'darwin', createdAt: 0, lastSeenAt: 0, current, online: current });

/** Folders as the backend keeps them. */
function foldersBackend(initial: WorkspaceSummary[]) {
  let workspaces = initial;
  return {
    'account.devices': () => [device('d-mac', 'Ada’s Mac', true), device('d-pc', 'Studio PC', false)],
    'workspaces.list': () => workspaces,
    'workspaces.remove': ({ id }: { id: string }) => {
      workspaces = workspaces.filter((w) => w.id !== id);
      return { ok: true };
    },
    'workspaces.addLocal': ({ path }: { path: string }) => {
      const added = folder(path.split('/').pop()!, { root: path });
      workspaces = [added, ...workspaces];
      return added;
    },
  };
}

beforeEach(() => {
  platform.desktop = undefined;
  resetBackend(foldersBackend([]));
});

/** `asking`: the window that asks "Trust this workspace?" is there (the app shell has it); without it the question is answered yes. */
function renderPage(asking = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <FoldersPage />
        <Toaster />
        {asking && <TrustWorkspaceHost />}
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function rows() {
  const table = await screen.findByRole('table', { name: 'Folders' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
}

describe('Folders page', () => {
  it('lists folders on every computer, with where they are and whether they can be used', async () => {
    resetBackend(
      foldersBackend([
        folder('atelier'),
        folder('render-farm', { deviceId: 'd-pc', available: false, root: 'C:\\work\\render-farm' }),
        folder('api', { kind: 'ssh', host: 'homelab', root: '/srv/api', deviceId: null }),
        folder('notes', { deviceId: null }),
        // A session's scratch folder isn't one of the person's folders.
        folder('scratch-2026-10-14-c31ade', { deviceId: null, scratch: true }),
      ]),
    );
    renderPage();
    await waitFor(async () => expect((await rows())[1]![1]).toBe('Studio PCOffline'));
    expect(await rows()).toEqual([
      ['atelier/Users/ada/atelier', 'This computer', '1 hour ago', ''],
      ['render-farmC:\\work\\render-farm', 'Studio PCOffline', '1 hour ago', ''],
      ['apiSSHhomelab:/srv/api', 'homelab', '1 hour ago', ''],
      ['notes/Users/ada/notes', 'This computer', '1 hour ago', ''],
    ]);
    // The browser has no folder picker.
    expect(screen.queryByRole('button', { name: /Open folder/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add SSH folder/ })).toBeNull();
  });

  it('marks a folder the backend does not trust, and trusts it after the question', async () => {
    let trusted = false;
    resetBackend({
      ...foldersBackend([]),
      'workspaces.list': () => [folder('site', { kind: 'codespace', host: 'site-abc', root: '/workspaces/site', deviceId: null, trusted }), folder('atelier', { trusted: true })],
      'workspaces.trust': () => ((trusted = true), folder('site', { kind: 'codespace', host: 'site-abc', trusted })),
    });
    renderPage(true);
    expect(await screen.findByText('Not trusted')).toBeTruthy();
    // Only the folder that needs it offers it.
    expect(screen.getAllByRole('button', { name: /^Trust / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Trust site']);
    fireEvent.click(screen.getByRole('button', { name: 'Trust site' }));
    const question = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(question.textContent).toContain('/workspaces/site');
    expect(callsTo('workspaces.trust')).toEqual([]);
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('workspaces.trust')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Trust site' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this workspace?' })).getByRole('button', { name: 'Trust workspace' }));
    await waitFor(() => expect(screen.queryByText('Not trusted')).toBeNull());
    expect(callsTo('workspaces.trust')).toEqual([{ id: 'site' }]);
    expect(screen.queryByRole('button', { name: /^Trust / })).toBeNull();
  });

  it('explains in the browser where folders come from', async () => {
    renderPage();
    expect(await screen.findByText('No folders yet. Folders come from the desktop app: open one there and it shows up here.')).toBeTruthy();
  });

  it('removes a folder after explaining that only Atelier forgets it', async () => {
    resetBackend(foldersBackend([folder('atelier'), folder('site')]));
    renderPage();
    await screen.findByText('site');
    fireEvent.click(screen.getByRole('button', { name: 'Remove site' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Remove site?' }));
    expect(confirm.getByText('Atelier only forgets this folder. Nothing in it is deleted, and you can open it again any time.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('site')).toBeNull());
    expect(callsTo('workspaces.remove')).toEqual([{ id: 'site' }]);
  });

  it('opens a folder with the desktop’s folder picker', async () => {
    const bridge = desktopBridge('server', '/Users/ada/new-app');
    platform.desktop = bridge;
    renderPage();
    expect(await screen.findByText('No folders yet. Open one to work in it in Code sessions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }));

    expect(await screen.findByText('new-app')).toBeTruthy();
    expect(bridge.folders.pick).toHaveBeenCalledTimes(1);
    expect(callsTo('workspaces.addLocal')).toEqual([{ path: '/Users/ada/new-app' }]);
    // SSH folders need the app's own backend; this one is connected to a server.
    expect(screen.queryByRole('button', { name: 'Add SSH folder…' })).toBeNull();
  });

  it('adds nothing when the picker is cancelled, and shows why a folder can’t be added', async () => {
    const bridge = desktopBridge('local');
    platform.desktop = bridge;
    resetBackend({
      ...foldersBackend([]),
      'workspaces.addLocal': () => {
        throw appError('workspace_unavailable', 'Can’t open /Volumes/usb: not a directory');
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder…' }));
    await waitFor(() => expect(bridge.folders.pick).toHaveBeenCalledTimes(1));
    expect(callsTo('workspaces.addLocal')).toEqual([]);

    bridge.folders.pick.mockResolvedValueOnce('/Volumes/usb');
    fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }));
    expect(await screen.findByText('Can’t open /Volumes/usb: not a directory')).toBeTruthy();
  });

  it('adds an SSH folder from a host in ~/.ssh/config', async () => {
    platform.desktop = desktopBridge('local');
    let fail = true;
    resetBackend({
      ...foldersBackend([]),
      'workspaces.sshHosts': () => ['homelab', 'build-box'],
      'workspaces.addSsh': ({ host }: { host: string }) => {
        if (fail) {
          fail = false;
          throw appError('workspace_unavailable', 'ssh: Could not resolve hostname homelab.');
        }
        return folder('api', { kind: 'ssh', host, root: '/home/ada/api', deviceId: null });
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add SSH folder…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add SSH folder' }));
    const host = dialog.getByRole('combobox', { name: /^Host/ });
    await waitFor(() => expect([...document.querySelectorAll(`#${CSS.escape(host.getAttribute('list')!)} option`)].map((o) => o.getAttribute('value'))).toEqual(['homelab', 'build-box']));

    fireEvent.click(dialog.getByRole('button', { name: 'Add folder' }));
    expect(await dialog.findByText('Choose a host or enter user@host.')).toBeTruthy();
    expect(dialog.getByText('Enter a folder on the host, like ~/projects/app.')).toBeTruthy();

    fireEvent.change(host, { target: { value: 'homelab' } });
    fireEvent.change(dialog.getByRole('textbox', { name: /^Folder/ }), { target: { value: '~/api' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add folder' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('ssh: Could not resolve hostname homelab.');

    fireEvent.click(dialog.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add SSH folder' })).toBeNull());
    expect(callsTo('workspaces.addSsh')).toEqual([
      { host: 'homelab', path: '~/api' },
      { host: 'homelab', path: '~/api' },
    ]);
  });
});
