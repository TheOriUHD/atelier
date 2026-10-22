import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { crumbs, RemoteFolderDialog } from './remote-folder-dialog.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** A tiny remote file system: folders and their subfolders. */
const TREE: Record<string, string[]> = { '/root': ['project', 'notes'], '/root/project': [], '/root/notes': ['2026'], '/root/notes/2026': [], '/': ['root', 'srv'], '/srv': [] };

beforeEach(() =>
  resetBackend({
    'ssh.browse': ({ path }: { path?: string }) => {
      const dir = path ?? '/root';
      if (!(dir in TREE)) throw new Error(`Can't open ${dir}`);
      return { path: dir, home: '/root', dirs: TREE[dir] };
    },
    'ssh.mkdir': ({ parent, name }: { parent: string; name: string }) => {
      TREE[parent] = [...(TREE[parent] ?? []), name];
      TREE[`${parent}/${name}`] = [];
      return { path: `${parent}/${name}` };
    },
  }),
);

const show = (props: Partial<Parameters<typeof RemoteFolderDialog>[0]> = {}) => {
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RemoteFolderDialog open onOpenChange={() => {}} host="root@192.168.1.50" onSelect={onSelect} {...props} />
    </QueryClientProvider>,
  );
  return { onSelect };
};

describe('crumbs', () => {
  it('starts at the home folder below it, and at / elsewhere', () => {
    expect(crumbs('/root/project', '/root')).toEqual([
      { label: 'root', path: '/root' },
      { label: 'project', path: '/root/project' },
    ]);
    expect(crumbs('/srv/app/web', '/root')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'app', path: '/srv/app' },
      { label: 'web', path: '/srv/app/web' },
    ]);
    expect(crumbs('/root', '/root')).toEqual([{ label: 'root', path: '/root' }]);
  });
});

describe('Select remote folder', () => {
  it('opens in the home folder, goes into subfolders and back by the breadcrumb, and selects where it is', async () => {
    const { onSelect } = show();
    expect(await screen.findByRole('button', { name: 'project' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/root');
    fireEvent.click(screen.getByRole('button', { name: 'notes' }));
    expect(await screen.findByRole('button', { name: '2026' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Path' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['root', 'notes']);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Path' })).getByRole('button', { name: 'root' }));
    await screen.findByRole('button', { name: 'project' });
    fireEvent.click(screen.getByRole('button', { name: 'project' }));
    expect(await screen.findByText('No subdirectories')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }));
    expect(onSelect).toHaveBeenCalledWith('/root/project');
  });

  it('goes to a typed path, and says when it can’t', async () => {
    show();
    await screen.findByRole('button', { name: 'notes' });
    const field = screen.getByRole('textbox', { name: 'Path' });
    fireEvent.change(field, { target: { value: '/srv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('No subdirectories')).toBeTruthy();
    fireEvent.change(field, { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Can't open /nope");
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Select folder' }).disabled).toBe(true);
  });

  it('makes a folder where you are, with a name, and goes into it', async () => {
    const { onSelect } = show();
    await screen.findByRole('button', { name: 'notes' });
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const name = screen.getByRole('textbox', { name: 'New folder name' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'my-project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callsTo('ssh.mkdir')).toEqual([{ host: 'root@192.168.1.50', parent: '/root', name: 'my-project' }]));
    expect(await screen.findByText('No subdirectories')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/root/my-project');
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }));
    expect(onSelect).toHaveBeenCalledWith('/root/my-project');
  });

  it('starts where it is told to', async () => {
    show({ start: '/root/notes' });
    expect(await screen.findByRole('button', { name: '2026' })).toBeTruthy();
    expect(callsTo('ssh.browse')[0]).toEqual({ host: 'root@192.168.1.50', path: '/root/notes' });
  });
});
