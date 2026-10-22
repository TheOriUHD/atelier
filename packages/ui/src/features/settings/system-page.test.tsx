import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import type { UpdateStatus } from '../../lib/platform.ts';
import { SystemPage } from './system-page.tsx';

/** The desktop bridge and OS the page sees. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown, isMac: false, os: 'linux', openExternal: vi.fn() }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openExternal: (url: string) => platform.openExternal(url),
  get desktop() {
    return platform.desktop;
  },
  get isMac() {
    return platform.isMac;
  },
  get os() {
    return platform.os;
  },
}));

/** Main's side of Settings › System: update status with its events, the login item and the data folder. */
function desktopBridge(initial: Partial<UpdateStatus> = {}) {
  let status: UpdateStatus = { version: '0.2.0', channel: 'stable', automatic: true, state: { kind: 'idle' }, checkedAt: null, ...initial };
  const listeners = new Set<(s: UpdateStatus) => void>();
  const push = (next: Partial<UpdateStatus>) => {
    status = { ...status, ...next };
    act(() => listeners.forEach((l) => l(status)));
  };
  let openAtLogin = false;
  const bridge = {
    updates: {
      status: vi.fn(async () => status),
      check: vi.fn(async () => push({ state: { kind: 'checking' } })),
      setChannel: vi.fn(async (channel: UpdateStatus['channel']) => push({ channel })),
      setAutomatic: vi.fn(async (automatic: boolean) => push({ automatic })),
      download: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      onStatus: (handler: (s: UpdateStatus) => void) => {
        listeners.add(handler);
        return () => void listeners.delete(handler);
      },
    },
    system: {
      get: vi.fn(async () => ({ openAtLogin, dataFolder: '/Users/ada/.atelier/data' })),
      setOpenAtLogin: vi.fn(async (open: boolean) => (openAtLogin = open)),
      showDataFolder: vi.fn(async () => undefined),
    },
  };
  platform.desktop = bridge;
  return { bridge, push };
}

beforeEach(() => {
  platform.isMac = false;
  platform.os = 'linux';
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SystemPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`)!;

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('System page', () => {
  it('shows the version and checks for updates on demand', async () => {
    const { bridge } = desktopBridge();
    renderPage();
    await waitFor(() => expect(row('system.version').textContent).toContain('0.2.0'));
    expect(row('system.updates').textContent).toContain('Atelier checks when it starts and every 5 minutes.');

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(row('system.updates').textContent).toContain('Checking for updates…'));
    expect(bridge.updates.check).toHaveBeenCalledTimes(1);
  });

  it('says when it last found nothing newer', async () => {
    desktopBridge({ checkedAt: Date.now() });
    renderPage();
    await waitFor(() => expect(row('system.updates').textContent).toContain('Up to date. Checked just now.'));
  });

  it('downloads by itself on Windows and Linux, then offers to restart', async () => {
    const { bridge, push } = desktopBridge();
    renderPage();
    await screen.findByRole('button', { name: 'Check now' });

    push({ state: { kind: 'available', version: '0.3.0' } });
    await waitFor(() => expect(row('system.updates').textContent).toContain('Atelier 0.3.0 is available. Downloading…'));
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    push({ state: { kind: 'downloading', percent: 42, version: '0.3.0' } });
    await waitFor(() => expect(row('system.updates').textContent).toContain('Downloading Atelier 0.3.0… 42%'));
    push({ state: { kind: 'downloaded', version: '0.3.0' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(row('system.updates').textContent).toContain('It installs when you quit Atelier');
    await waitFor(() => expect(bridge.updates.install).toHaveBeenCalledTimes(1));
  });

  it('downloads the disk image on a Mac and says how to install it', async () => {
    platform.isMac = true;
    platform.os = 'darwin';
    const { bridge, push } = desktopBridge({ state: { kind: 'available', version: '0.3.0', manual: true } });
    renderPage();
    await waitFor(() => expect(row('system.updates').textContent).toContain('Atelier 0.3.0 is available.'));

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(bridge.updates.download).toHaveBeenCalledTimes(1));
    push({ state: { kind: 'saved', version: '0.3.0' } });
    await waitFor(() => expect(row('system.updates').textContent).toContain('Open the downloaded file and drag Atelier to Applications to update.'));
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show in Finder' })).toBeTruthy();
  });

  it('shows what went wrong under the row', async () => {
    desktopBridge({ state: { kind: 'error', message: 'net::ERR_CONNECTION_REFUSED' } });
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe('net::ERR_CONNECTION_REFUSED');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('points to the releases page when this app has no update feed', async () => {
    desktopBridge({ state: { kind: 'unsupported', reason: 'This copy has no update source, so it can’t check for new versions. Get them from the Releases page.' } });
    renderPage();
    await waitFor(() => expect(row('system.updates').textContent).toContain('no update source'));
    fireEvent.click(screen.getByRole('button', { name: 'Releases page' }));
    expect(platform.openExternal).toHaveBeenCalledWith(APP.releases);
    expect(screen.getByRole('combobox', { name: 'Update channel' }).hasAttribute('data-disabled')).toBe(true);
  });

  it('switches the update channel', async () => {
    const { bridge } = desktopBridge();
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Update channel' });
    await waitFor(() => expect(select.textContent).toContain('Stable'));
    fireEvent.click(select);
    pick(await screen.findByRole('option', { name: 'Beta' }));
    await waitFor(() => expect(select.textContent).toContain('Beta'));
    expect(bridge.updates.setChannel).toHaveBeenCalledWith('beta');
  });

  it('turns automatic update checks on and off', async () => {
    const { bridge } = desktopBridge();
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Check for updates automatically' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(bridge.updates.setAutomatic).toHaveBeenCalledWith(false);
    await waitFor(() => expect(row('system.updates').textContent).toContain('Automatic checks are off'));
  });

  it('turns launch at login on and off as the system reports it', async () => {
    const { bridge } = desktopBridge();
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Launch at login' });
    await waitFor(() => expect(toggle.getAttribute('aria-disabled')).not.toBe('true'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(bridge.system.setOpenAtLogin).toHaveBeenLastCalledWith(true);

    bridge.system.setOpenAtLogin.mockRejectedValueOnce(new Error('The system refused.'));
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe('The system refused.');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the data folder and opens it', async () => {
    const { bridge } = desktopBridge();
    renderPage();
    await waitFor(() => expect(row('system.dataFolder').textContent).toContain('/Users/ada/.atelier/data'));
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(bridge.system.showDataFolder).toHaveBeenCalledTimes(1));
  });
});
