import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_LENDING, type DeviceLending } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { queryClient } from '../../lib/queries.ts';
import { resetBackend, user } from '../settings/test-backend.ts';
import { SystemPage } from '../settings/system-page.tsx';
import { LendScratchHost, lendScratch } from './lend-scratch.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

let allowed: DeviceLending | null;
const change = vi.fn(async (c: { kind: string; host?: string; allowed: boolean }) => {
  if (!allowed) return null;
  allowed = c.kind === 'ssh' ? { ...allowed, ssh: c.allowed ? [...allowed.ssh, c.host!] : allowed.ssh.filter((h) => h !== c.host) } : { ...allowed, scratch: c.allowed };
  return allowed;
});

beforeEach(() => {
  allowed = { ...NO_LENDING, scratch: false, ssh: [] };
  change.mockClear();
  queryClient.clear();
  platform.desktop = {
    device: { id: 'd-mac' },
    connection: { get: async () => ({ mode: 'server', serverUrl: 'https://atelier.example.com' }) },
    lending: { get: async () => allowed, change },
    updates: { status: async () => ({ version: '0.2.8', channel: 'stable', automatic: true, state: { kind: 'idle' }, checkedAt: null }), onStatus: () => () => {} },
    system: { get: async () => ({ openAtLogin: false, dataFolder: '/Users/ada/.atelier/data' }) },
  };
});

describe('making folders on this computer for a server', () => {
  it('asks once, and remembers a yes on this computer', async () => {
    render(<LendScratchHost />);
    const asked = lendScratch();
    const dialog = await screen.findByRole('dialog', { name: 'Make folders on this computer?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow' }));
    expect(await asked).toBe(true);
    expect(change).toHaveBeenCalledWith({ kind: 'scratch', allowed: true });
    // Allowed: no question next time.
    expect(await lendScratch()).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts nothing when the person says no, and never asks the app’s own backend', async () => {
    render(<LendScratchHost />);
    const asked = lendScratch();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(await asked).toBe(false);
    expect(change).not.toHaveBeenCalled();
    allowed = null;
    expect(await lendScratch()).toBe(true);
  });
});

describe('Settings › System on a desktop signed in to a server', () => {
  it('lists what the server can do here, and takes it back', async () => {
    allowed = { ...NO_LENDING, scratch: true, ssh: ['gpu', 'build@box'] };
    resetBackend({
      'app.info': () => ({ name: 'Atelier', version: '0.2.8', surface: 'web', platform: 'linux', dataDir: '/data', deviceLink: { protocol: 2, services: ['runner', 'scratch', 'ssh'] } }),
      'account.devices': () => [{ id: 'd-mac', name: 'MacBook', platform: 'darwin', createdAt: 0, lastSeenAt: 0, current: true, online: true, services: ['runner', 'scratch', 'ssh'] }],
      'account.get': () => user(),
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <SystemPage />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const section = (await screen.findByRole('heading', { name: 'What atelier.example.com can do here' })).closest('section')!;
    expect(within(section).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['gpuRemove', 'build@boxRemove']);
    fireEvent.click(within(section).getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(change).toHaveBeenCalledWith({ kind: 'ssh', host: 'gpu', allowed: false }));
    fireEvent.click(within(section).getByRole('switch'));
    await waitFor(() => expect(change).toHaveBeenCalledWith({ kind: 'scratch', allowed: false }));
  });
});
