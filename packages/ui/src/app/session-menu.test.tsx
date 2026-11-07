import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary, WorkspaceSummary } from '@atelier/protocol';
import { Menu, MenuTrigger } from '../components/ui/index.ts';
import { SessionMenuContent } from './session-menu.tsx';

const desktop = vi.hoisted(() => ({
  device: { id: 'me', name: 'Mac', platform: 'darwin' },
  files: { openIn: vi.fn(async () => true), reveal: vi.fn(async () => true) },
  openWindow: vi.fn(async () => true),
}));
vi.mock('../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), desktop }));

const session: SessionSummary = {
  id: 's1',
  mode: 'code',
  workspaceId: 'w1',
  permissionMode: null,
  title: 'Fix the build',
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
};
const workspace: WorkspaceSummary = { id: 'w1', kind: 'local', name: 'site', root: '/work/site', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 1 };

function open(shown: SessionSummary = session, handlers: { onLeave?: () => void; onDelete?: () => void } = {}) {
  const root = createRootRoute({
    component: () => (
      <Menu defaultOpen>
        <MenuTrigger>Options</MenuTrigger>
        <SessionMenuContent session={shown} workspace={workspace} groups={[]} onRename={() => {}} onDelete={handlers.onDelete ?? (() => {})} {...(handlers.onLeave ? { onLeave: handlers.onLeave } : {})} onNewGroup={() => {}} close={() => {}} />
      </Menu>
    ),
  });
  render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
}

describe('the session menu on the desktop', () => {
  it('opens its Open in submenu (the editors under a labelled group) and opens the folder where asked', async () => {
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in' }));
    const sub = await screen.findByRole('menuitem', { name: /^New window/ });
    expect(sub).toBeTruthy();
    const names = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(names).toEqual(expect.arrayContaining(['New window2', 'Cursor3', 'VS Code4', 'Finder5']));

    fireEvent.click(screen.getByRole('menuitem', { name: /^Cursor/ }));
    await waitFor(() => expect(desktop.files.openIn).toHaveBeenCalledWith('cursor', '/work/site'));
  });

  it('opens it in a new window from its number (Split view is 1)', async () => {
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in' }));
    const submenu = (await screen.findByRole('menuitem', { name: /^New window/ })).closest('[role="menu"]')!;
    fireEvent.keyDown(submenu, { key: '2' });
    await waitFor(() => expect(desktop.openWindow).toHaveBeenCalledWith('#/code/s1?solo=1'));
    expect(within(document.body).queryByText(/Something went wrong/)).toBeNull();
  });
});

describe('the session menu in someone else’s co-op session', () => {
  const joined: SessionSummary = { ...session, id: 'coop_room_s1', workspaceId: null, coop: { role: 'editor', hostName: 'Ada', participants: 2, mirror: true } };

  it('files it in their own sidebar and leaves it, with no fork and no delete', async () => {
    const onLeave = vi.fn();
    open(joined, { onLeave });
    await screen.findByRole('menuitem', { name: /^Pin/ });
    const names = screen.getAllByRole('menuitem').map((m) => m.textContent?.replace(/[A-Z0-9]$/, ''));
    expect(names).toEqual(expect.arrayContaining(['Pin', 'Mark as unread', 'Rename', 'Move to group', 'Archive', 'Leave']));
    expect(names).not.toContain('Fork');
    expect(names).not.toContain('Delete');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Leave/ }));
    expect(onLeave).toHaveBeenCalled();
  });

  it('once co-op ended, removes it from the sidebar instead', async () => {
    const onDelete = vi.fn();
    open({ ...joined, coop: { ...joined.coop!, ended: true } }, { onLeave: () => {}, onDelete });
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Remove from sidebar/ }));
    expect(onDelete).toHaveBeenCalled();
  });
});
