import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { chooseLocalFolder, requestTrust, trustWorkspace, TrustWorkspaceHost } from './trust.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge the helpers see; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

const workspace = (root: string) => ({ id: 'w1', kind: 'local', name: 'app', root, deviceId: null, host: null, available: true, scratch: false, lastUsedAt: 1 });

beforeEach(() => {
  resetBackend({ 'workspaces.list': () => [workspace('/work/app')] });
  platform.desktop = undefined;
});

describe('Trust this workspace?', () => {
  it('shows the folder (and the host), and says whether it was trusted', async () => {
    render(<TrustWorkspaceHost />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = requestTrust('/root/project', 'root@192.168.1.50');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(dialog.textContent).toContain('/root/project');
    expect(dialog.textContent).toContain('on root@192.168.1.50');
    fireEvent.click(screen.getByRole('button', { name: 'Trust workspace' }));
    expect(await answer).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() => {
      answer = requestTrust('/tmp/x');
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await answer).toBe(false);
  });

  it('asks about a workspace the backend does not trust, tells it the answer, and leaves trusted ones alone', async () => {
    resetBackend({ 'workspaces.trust': ({ id }: { id: string }) => ({ ...workspace('/workspaces/site'), id, trusted: true }) });
    render(<TrustWorkspaceHost />);
    const codespace = { ...workspace('/workspaces/site'), id: 'w-cs', kind: 'codespace' as const, host: 'fluffy-space', trusted: false };

    let answer!: Promise<boolean>;
    act(() => {
      answer = trustWorkspace(codespace);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(dialog.textContent).toContain('/workspaces/site');
    expect(dialog.textContent).toContain('on GitHub codespace fluffy-space');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await answer).toBe(false);
    expect(callsTo('workspaces.trust')).toEqual([]);

    act(() => {
      answer = trustWorkspace(codespace);
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Trust workspace' }));
    expect(await answer).toBe(true);
    expect(callsTo('workspaces.trust')).toEqual([{ id: 'w-cs' }]);

    // Trusted, or from a server that doesn't say: no question.
    expect(await trustWorkspace({ ...codespace, trusted: true })).toBe(true);
    expect(await trustWorkspace({ ...codespace, trusted: undefined })).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo('workspaces.trust')).toHaveLength(1);
  });

  it('asks about a new local folder before trusting it, and not about one already in the list', async () => {
    const bridge = { folders: { pick: vi.fn(async () => '/work/new'), trust: vi.fn(async (p: string) => p) } };
    platform.desktop = bridge;
    render(<TrustWorkspaceHost />);
    let chosen!: Promise<string | null>;
    act(() => {
      chosen = chooseLocalFolder();
    });
    await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(bridge.folders.trust).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Trust workspace' }));
    expect(await chosen).toBe('/work/new');
    expect(bridge.folders.trust).toHaveBeenCalledWith('/work/new');

    bridge.folders.pick.mockResolvedValueOnce('/work/app');
    expect(await chooseLocalFolder()).toBe('/work/app');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Declining trusts nothing.
    bridge.folders.trust.mockClear();
    bridge.folders.pick.mockResolvedValueOnce('/work/other');
    act(() => {
      chosen = chooseLocalFolder();
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await chosen).toBeNull();
    expect(bridge.folders.trust).not.toHaveBeenCalled();
    expect(callsTo('workspaces.list').length).toBeGreaterThan(0);
  });
});
