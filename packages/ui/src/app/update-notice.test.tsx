import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../lib/platform.ts';

const bridge = vi.hoisted(() => ({
  status: { version: '0.1.0', channel: 'stable', automatic: true, state: { kind: 'idle' }, checkedAt: null } as UpdateStatus,
  install: vi.fn(),
  download: vi.fn(),
  mac: false,
  listener: null as ((status: UpdateStatus) => void) | null,
}));
vi.mock('../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  desktop: { updates: { status: async () => bridge.status, onStatus: (listener: (status: UpdateStatus) => void) => ((bridge.listener = listener), () => {}), install: bridge.install, download: bridge.download } },
  get isMac() {
    return bridge.mac;
  },
}));

const { UpdateNotice } = await import('./update-notice.tsx');
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UpdateNotice />
    </QueryClientProvider>,
  );

beforeEach(() => {
  bridge.mac = false;
  bridge.install.mockClear();
  bridge.download.mockClear();
});

describe('the update notice', () => {
  it('says nothing while the app is up to date', async () => {
    show();
    await Promise.resolve();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers a restart once an update is downloaded (Windows, Linux)', async () => {
    bridge.status = { ...bridge.status, state: { kind: 'downloaded', version: '0.2.0' } };
    show();
    expect((await screen.findByRole('status')).textContent).toContain('Update 0.2.0 is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(bridge.install).toHaveBeenCalled();
  });

  it('offers a restart on a Mac too: it replaces its own app', async () => {
    bridge.mac = true;
    bridge.status = { ...bridge.status, state: { kind: 'downloaded', version: '0.2.0' } };
    show();
    expect((await screen.findByRole('status')).textContent).toContain('Update 0.2.0 is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(bridge.install).toHaveBeenCalled();
  });

  it('shows the download’s progress, then offers the restart once it is done', async () => {
    bridge.status = { ...bridge.status, state: { kind: 'downloading', percent: 42, version: '0.1.7' } };
    show();
    expect((await screen.findByRole('status')).textContent).toContain('Downloading Atelier 0.1.7');
    const bar = screen.getByRole('progressbar', { name: 'Downloading Atelier 0.1.7' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuetext')).toBe('42%');
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();

    act(() => bridge.listener!({ ...bridge.status, state: { kind: 'downloaded', version: '0.1.7' } }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Update 0.1.7 is ready'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(bridge.install).toHaveBeenCalled();
  });

  it('names no version when an older app sends none', async () => {
    bridge.status = { ...bridge.status, state: { kind: 'downloading', percent: 5 } };
    show();
    expect(await screen.findByRole('progressbar', { name: 'Downloading an update' })).toBeTruthy();
  });

  it('says nothing while a Mac that can update itself is still downloading', async () => {
    bridge.mac = true;
    bridge.status = { ...bridge.status, state: { kind: 'available', version: '0.2.0' } };
    show();
    await Promise.resolve();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers the download to a Mac whose app cannot be replaced where it is', async () => {
    bridge.mac = true;
    bridge.status = { ...bridge.status, state: { kind: 'available', version: '0.2.0', manual: true } };
    show();
    expect((await screen.findByRole('status')).textContent).toContain('0.2.0 is available');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(bridge.download).toHaveBeenCalled();
  });
});
