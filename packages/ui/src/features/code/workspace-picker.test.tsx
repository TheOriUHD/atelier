import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodespaceSummary, DeviceSummary, WorkspaceSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { TrustWorkspaceHost } from '../workspaces/trust.tsx';
import { FolderBadge, WorkspaceChips, useEnvironment } from './workspace-picker.tsx';

const openSettings = vi.fn();
vi.mock('../../app/navigation.ts', () => ({ useOpenSettings: () => openSettings }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge the chips see; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

function desktopBridge(mode: 'local' | 'server', picked: string | null = null) {
  return { device: { id: 'd-mac' }, connection: { get: vi.fn(async () => ({ mode, serverUrl: null })) }, folders: { pick: vi.fn(async () => picked), trust: vi.fn(async (path: string) => path) } };
}

const ws = (id: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  kind: 'local',
  name: id,
  root: `/work/${id}`,
  host: null,
  deviceId: null,
  available: true,
  scratch: false,
  lastUsedAt: 1,
  ...extra,
});
const device = (id: string, name: string, online: boolean): DeviceSummary => ({ id, name, platform: 'darwin', createdAt: 0, lastSeenAt: 0, current: false, online });
const codespace = (name: string, displayName: string, state: string): CodespaceSummary => ({
  name,
  displayName,
  repo: 'acme/site',
  state,
  machine: null,
  idleTimeoutMinutes: null,
  lastUsedAt: null,
  root: '/workspaces/site',
});

/** The home's wiring: an environment, its folders and the folder (or no folder, on a host) asked for. */
function Home({ mode = 'code', initial = {} }: { mode?: 'code' | 'work'; initial?: { id?: string; host?: string } }) {
  const [requested, setRequested] = useState(initial);
  const { environment, folders, choice, scratchHost, choose } = useEnvironment(mode, requested.id, requested.host);
  return (
    <WorkspaceChips
      environment={environment}
      folders={folders}
      value={choice}
      noFolder={scratchHost !== undefined}
      onEnvironmentChange={(env, id, host) => {
        choose(env);
        setRequested({ id, host });
      }}
      onChange={(id) => setRequested({ id, host: scratchHost ?? undefined })}
    />
  );
}

/** `asking`: the window that asks "Trust this workspace?" is there (the app shell has it); without it the question is answered yes. */
function renderHome(list: WorkspaceSummary[], handlers: Record<string, (input: never) => unknown> = {}, initial?: { id?: string; host?: string }, asking = false) {
  const workspaces = [...list];
  resetBackend({ 'workspaces.list': () => workspaces, ...handlers });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Home initial={initial} />
        {asking && <TrustWorkspaceHost />}
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return workspaces;
}

const openMenu = async (name: string | RegExp) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('menu');
};
/** Escape closes one level at a time. */
const closeMenus = () =>
  waitFor(() => {
    const open = screen.queryAllByRole('menu');
    if (open.length) fireEvent.keyDown(open.at(-1)!, { key: 'Escape' });
    expect(open).toEqual([]);
  });
const openSubmenu = async (menu: HTMLElement, name: string) => {
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
  return (await screen.findAllByRole('menu')).at(-1)!;
};
const rows = (menu: HTMLElement, role: 'menuitem' | 'menuitemradio') =>
  within(menu)
    .getAllByRole(role)
    .map((i) => [i.textContent, i.getAttribute('aria-disabled') === 'true', i.getAttribute('aria-checked') === 'true']);

beforeEach(() => {
  platform.desktop = undefined;
  localStorage.clear();
  openSettings.mockClear();
});

describe('the environment and folder chips in the browser', () => {
  it('offer Cloud and Remote Control, start with the latest folder’s computer and list its folders', async () => {
    renderHome([ws('site', { deviceId: 'd-pc', lastUsedAt: 2 }), ws('laptop-repo', { deviceId: 'd-laptop', available: false, lastUsedAt: 3 }), ws('app', { kind: 'codespace', host: 'cs-2' })], {
      'account.devices': () => [device('d-pc', 'Studio PC', true), device('d-laptop', 'Travel laptop', false)],
    });
    const env = await openMenu('Environment: Studio PC');
    expect(within(env).queryByRole('menuitemradio', { name: 'Local' })).toBeNull();
    expect(within(env).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cloud', 'Remote Control']);
    expect(rows(await openSubmenu(env, 'Remote Control'), 'menuitemradio')).toEqual([
      ['Travel laptopOffline', true, false],
      ['Studio PC', false, true],
    ]);
    await closeMenus();

    const folders = await openMenu('site');
    expect(rows(folders, 'menuitemradio')).toEqual([
      ['laptop-repoIts computer is offline', true, false],
      ['site', false, true],
    ]);
    // Plain rows; where a folder is, is its tooltip and accessible description.
    expect(within(folders).getByRole('menuitemradio', { name: 'site' }).getAttribute('title')).toBe('Studio PC · /work/site');
    // Folders on other computers are added there, not from here.
    expect(within(folders).queryByRole('menuitem')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open folder|Open a repository/ })).toBeNull();
  });

  it('works in a codespace, making its checkout a folder first', async () => {
    const workspaces = renderHome([ws('site', { deviceId: 'd-pc' })], {
      'account.devices': () => [device('d-pc', 'Studio PC', true)],
      'github.status': () => ({ connected: true, login: 'ada' }),
      'codespaces.list': () => [codespace('cs-1', 'site (main)', 'Shutdown'), codespace('cs-2', 'api', 'Available')],
      'workspaces.addCodespace': ({ name }: { name: string }) => {
        const added = ws('site-cs', { kind: 'codespace', host: name, name: 'site', root: '/workspaces/site' });
        workspaces.unshift(added);
        return added;
      },
    });
    const cloud = await openSubmenu(await openMenu('Environment: Studio PC'), 'Cloud');
    expect((await within(cloud).findAllByRole('menuitemradio')).map((i) => i.textContent)).toEqual(['site (main)Stoppedacme/site', 'apiRunningacme/site']);
    fireEvent.click(within(cloud).getByRole('menuitemradio', { name: /site \(main\)/ }));
    expect(await screen.findByRole('button', { name: 'site Codespace' })).toBeTruthy();
    expect(callsTo('workspaces.addCodespace')).toEqual([{ name: 'cs-1', trust: true }]);
    expect(screen.getByRole('button', { name: 'Environment: Cloud' })).toBeTruthy();
    expect(localStorage.getItem('atelier.environment.code')).toBe('cloud');
    expect(screen.getByRole('button', { name: 'Open a repository…' })).toBeTruthy();
  });

  it('opens a repository from a searchable list: its codespace is found, woken or created for you', async () => {
    const workspaces = renderHome([ws('site', { deviceId: 'd-pc' })], {
      'account.devices': () => [device('d-pc', 'Studio PC', true)],
      'github.status': () => ({ connected: true, login: 'ada' }),
      'codespaces.list': () => [codespace('cs-1', 'site (main)', 'Shutdown')],
      'github.repos': () => [
        { fullName: 'acme/site', private: true, defaultBranch: 'main', pushedAt: 3 },
        { fullName: 'acme/api', private: false, defaultBranch: 'main', pushedAt: 2 },
        { fullName: 'acme/docs', private: false, defaultBranch: 'main', pushedAt: 1 },
      ],
      'codespaces.open': ({ repo }: { repo: string }) => {
        const added = ws('api-cs', { kind: 'codespace', host: 'api-space', name: repo.split('/')[1]!, root: '/workspaces/api' });
        workspaces.unshift(added);
        return added;
      },
    });
    fireEvent.click(within(await openSubmenu(await openMenu('Environment: Studio PC'), 'Cloud')).getByRole('menuitem', { name: 'Open a repository…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a repository' });
    // Every repository, the one with a sleeping codespace marked as such.
    expect((await within(dialog).findAllByRole('button', { name: /acme\// })).map((b) => b.textContent)).toEqual(['acme/siteStopped', 'acme/api', 'acme/docs']);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search repositories' }), { target: { value: 'ap' } });
    expect(within(dialog).getAllByRole('button', { name: /acme\// }).map((b) => b.textContent)).toEqual(['acme/api']);
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'Search repositories' }), { key: 'Enter' });
    expect(await screen.findByRole('button', { name: 'api Codespace' })).toBeTruthy();
    expect(callsTo('codespaces.open')).toEqual([{ repo: 'acme/api', trust: true }]);
    expect(screen.getByRole('button', { name: 'Environment: Cloud' })).toBeTruthy();
  });

  it('asks Trust this workspace? before it opens a repository’s codespace, and opens nothing when the person says no', async () => {
    const workspaces = renderHome(
      [ws('site', { deviceId: 'd-pc' })],
      {
        'account.devices': () => [device('d-pc', 'Studio PC', true)],
        'github.status': () => ({ connected: true, login: 'ada' }),
        'codespaces.list': () => [],
        'github.repos': () => [{ fullName: 'acme/api', private: false, defaultBranch: 'main', pushedAt: 2 }],
        'codespaces.open': () => {
          const added = ws('api-cs', { kind: 'codespace', host: 'api-space', name: 'api', root: '/workspaces/api', trusted: true });
          workspaces.unshift(added);
          return added;
        },
      },
      undefined,
      true,
    );
    fireEvent.click(within(await openSubmenu(await openMenu('Environment: Studio PC'), 'Cloud')).getByRole('menuitem', { name: 'Open a repository…' }));
    const repos = await screen.findByRole('dialog', { name: 'Open a repository' });

    fireEvent.click(await within(repos).findByRole('button', { name: /acme\/api/ }));
    const question = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(question.textContent).toContain('acme/api');
    expect(question.textContent).toContain('on a GitHub codespace');
    // Nothing is woken or created (it can cost money) before the person agreed.
    expect(callsTo('codespaces.open')).toEqual([]);
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Trust this workspace?' })).toBeNull());
    expect(callsTo('codespaces.open')).toEqual([]);

    // The list is still there to choose from; this time the answer is yes.
    fireEvent.click(within(repos).getByRole('button', { name: /acme\/api/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this workspace?' })).getByRole('button', { name: 'Trust workspace' }));
    expect(await screen.findByRole('button', { name: 'api Codespace' })).toBeTruthy();
    expect(callsTo('codespaces.open')).toEqual([{ repo: 'acme/api', trust: true }]);
  });

  it('opens a repository whose codespace is already a trusted folder without asking again', async () => {
    const trusted = ws('site-cs', { kind: 'codespace', host: 'cs-1', name: 'site', root: '/workspaces/site', trusted: true });
    renderHome(
      [ws('site', { deviceId: 'd-pc' }), trusted],
      {
        'account.devices': () => [device('d-pc', 'Studio PC', true)],
        'github.status': () => ({ connected: true, login: 'ada' }),
        'codespaces.list': () => [codespace('cs-1', 'site (main)', 'Available')],
        'github.repos': () => [{ fullName: 'acme/site', private: true, defaultBranch: 'main', pushedAt: 3 }],
        'codespaces.open': () => trusted,
      },
      undefined,
      true,
    );
    fireEvent.click(within(await openSubmenu(await openMenu('Environment: Studio PC'), 'Cloud')).getByRole('menuitem', { name: 'Open a repository…' }));
    const repos = await screen.findByRole('dialog', { name: 'Open a repository' });
    fireEvent.click(await within(repos).findByRole('button', { name: /acme\/site/ }));
    await waitFor(() => expect(callsTo('codespaces.open')).toEqual([{ repo: 'acme/site' }]));
    expect(screen.queryByRole('dialog', { name: 'Trust this workspace?' })).toBeNull();
  });

  it('asks Trust this workspace? before a codespace of the menu becomes a folder', async () => {
    const workspaces = renderHome([ws('site', { deviceId: 'd-pc' })], {
      'account.devices': () => [device('d-pc', 'Studio PC', true)],
      'github.status': () => ({ connected: true, login: 'ada' }),
      'codespaces.list': () => [codespace('cs-1', 'site (main)', 'Shutdown')],
      'workspaces.addCodespace': ({ name }: { name: string }) => {
        const added = ws('site-cs', { kind: 'codespace', host: name, name: 'site', root: '/workspaces/site', trusted: true });
        workspaces.unshift(added);
        return added;
      },
    }, undefined, true);
    const pick = async () => fireEvent.click(await within(await openSubmenu(await openMenu(/^Environment:/), 'Cloud')).findByRole('menuitemradio', { name: /site \(main\)/ }));

    await pick();
    const question = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(question.textContent).toContain('acme/site');
    expect(question.textContent).toContain('on GitHub codespace cs-1');
    expect(callsTo('workspaces.addCodespace')).toEqual([]);
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('workspaces.addCodespace')).toEqual([]);

    await pick();
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this workspace?' })).getByRole('button', { name: 'Trust workspace' }));
    expect(await screen.findByRole('button', { name: 'site Codespace' })).toBeTruthy();
    expect(callsTo('workspaces.addCodespace')).toEqual([{ name: 'cs-1', trust: true }]);
  });

  it('connects GitHub right where a codespace is wanted, then lists the repositories', async () => {
    let connected = false;
    renderHome([ws('site', { deviceId: 'd-pc' })], {
      'account.devices': () => [device('d-pc', 'Studio PC', true)],
      'github.status': () => ({ connected }),
      'github.connectToken': () => {
        connected = true;
        return { connected: true, login: 'ada' };
      },
      'codespaces.list': () => [],
      'github.repos': () => [{ fullName: 'acme/site', private: true, defaultBranch: 'main', pushedAt: 3 }],
    });
    const cloud = await openSubmenu(await openMenu('Environment: Studio PC'), 'Cloud');
    fireEvent.click(await within(cloud).findByRole('menuitem', { name: /Connect GitHub/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a repository' });
    expect(await within(dialog).findByText('Connect GitHub to see your repositories')).toBeTruthy();
    expect(callsTo('github.repos')).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use a token…' }));
    const tokenDialog = await screen.findByRole('dialog', { name: 'Connect with a token' });
    fireEvent.change(within(tokenDialog).getByLabelText('Personal access token'), { target: { value: 'ghp_0123456789abcdef' } });
    fireEvent.click(within(tokenDialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByRole('button', { name: /acme\/site/ })).toBeTruthy();
  });

  it('explains where folders come from when none can be used', async () => {
    localStorage.setItem('atelier.environment.code', 'remote');
    renderHome([ws('laptop-repo', { deviceId: 'd-laptop', available: false })], { 'account.devices': () => [] });
    const menu = await openMenu('Select folder…');
    expect(rows(menu, 'menuitem')).toEqual([['No folder availableOpen folders in the desktop app first', true, false]]);
  });
});

describe('the environment and folder chips in the desktop app', () => {
  it('start on this computer, open a folder with the add button and offer SSH hosts with its own backend', async () => {
    platform.desktop = desktopBridge('local', '/work/new');
    const workspaces = renderHome([ws('a')], {
      'ssh.list': () => [{ id: 'c1', name: 'devbox', host: 'devbox', port: null, keyPath: null, folder: null, passwordSaved: false }],
      'workspaces.addLocal': ({ path }: { path: string }) => {
        const added = ws('new', { root: path, lastUsedAt: 5 });
        workspaces.unshift(added);
        return added;
      },
    });
    const env = await openMenu('Environment: Local');
    expect(within(env).getByRole('menuitemradio', { name: 'Local' }).getAttribute('aria-checked')).toBe('true');
    expect(rows(await openSubmenu(env, 'Remote Control'), 'menuitem')).toEqual([['No other computersShown when connected to an Atelier server', true, false]]);
    await closeMenus();
    const ssh = await openSubmenu(await openMenu('Environment: Local'), 'SSH');
    expect(await within(ssh).findByRole('menuitemradio', { name: 'devbox' })).toBeTruthy();
    expect(within(ssh).getByRole('menuitem', { name: 'Add SSH connection…' })).toBeTruthy();
    await closeMenus();

    fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }));
    expect(await screen.findByRole('button', { name: 'new' })).toBeTruthy();
    expect(callsTo('workspaces.addLocal')).toEqual([{ path: '/work/new' }]);
  });

  it('names SSH folders host:path, and starts with no folder on a host that has none yet', async () => {
    platform.desktop = desktopBridge('local');
    renderHome([ws('a', { lastUsedAt: 9 }), ws('api', { kind: 'ssh', host: 'devbox', root: '/srv/api' })], {
      'ssh.list': () => [{ id: 'c2', name: 'gpu', host: 'gpu', port: null, keyPath: null, folder: null, passwordSaved: false }],
      'ssh.browse': () => ({ path: '/home/me', home: '/home/me', dirs: ['app'] }),
    });
    fireEvent.click(within(await openSubmenu(await openMenu('Environment: Local'), 'SSH')).getByRole('menuitemradio', { name: 'devbox' }));
    expect(await screen.findByRole('button', { name: 'devbox:/srv/api SSH' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Environment: devbox' })).toBeTruthy();

    fireEvent.click(await within(await openSubmenu(await openMenu('Environment: devbox'), 'SSH')).findByRole('menuitemradio', { name: 'gpu' }));
    expect(await screen.findByRole('button', { name: 'Environment: gpu' })).toBeTruthy();
    expect(rows(await openMenu('No folder'), 'menuitemradio')).toEqual([
      ['No folder', false, true],
      ['devbox:/srv/apiSSH', false, false],
    ]);
    await closeMenus();
    // Folders on the host are chosen in its remote folder browser, which is trusted before anything is added.
    fireEvent.click(screen.getByRole('button', { name: 'Browse remote folder…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Select remote folder' });
    expect(dialog.textContent).toContain('Folders on gpu.');
    expect(callsTo('ssh.browse')[0]).toEqual({ host: 'gpu' });
  });

  it('offer No folder first on this computer, chosen until a folder is, and leave scratch folders out of Recent', async () => {
    platform.desktop = desktopBridge('local');
    renderHome([ws('site', { lastUsedAt: 3 }), ws('scratch-2026-10-14-c31ade', { scratch: true, lastUsedAt: 5 })]);
    const menu = await openMenu('No folder');
    const order = [...menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="separator"]')].map((e) => (e.getAttribute('role') === 'separator' ? '—' : e.textContent));
    expect(order).toEqual(['No folder', '—', 'site', '—', 'Open folder…']);
    expect(within(menu).getByRole('menuitemradio', { name: 'No folder' }).getAttribute('title')).toBe('A new, empty folder for each session');
    expect(within(menu).getByRole('menuitemradio', { name: 'site' }).getAttribute('title')).toBe('/work/site');
    expect(within(within(menu).getByRole('group', { name: 'Recent' })).getByRole('menuitemradio').textContent).toBe('site');
    expect(rows(menu, 'menuitemradio')).toEqual([
      ['No folder', false, true],
      ['site', false, false],
    ]);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /site/ }));
    expect(await screen.findByRole('button', { name: 'site' })).toBeTruthy();
    fireEvent.click(within(await openMenu('site')).getByRole('menuitemradio', { name: /No folder/ }));
    expect(await screen.findByRole('button', { name: 'No folder' })).toBeTruthy();
  });

  it('start no folder on this computer unless a host is named, whatever environment was picked last', async () => {
    platform.desktop = desktopBridge('local');
    localStorage.setItem('atelier.environment.code', 'ssh');
    renderHome([ws('api', { kind: 'ssh', host: 'devbox', root: '/srv/api' }), ws('scratch-2026-10-14-c31ade', { scratch: true, lastUsedAt: 5 })], {}, { id: 'none' });
    expect(await screen.findByRole('button', { name: 'No folder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Environment: Local' })).toBeTruthy();
  });

  it('go on in the scratch folder /clear asks for, offering a new one too', async () => {
    platform.desktop = desktopBridge('local');
    const scratch = ws('scratch-2026-10-14-c31ade', { scratch: true, root: '/data/scratch-workspaces/u1/scratch-2026-10-14-c31ade', lastUsedAt: 5 });
    renderHome([ws('site', { lastUsedAt: 3 }), scratch], {}, { id: scratch.id });
    const menu = await openMenu('scratch-2026-10-14-c31ade');
    expect(rows(menu, 'menuitemradio')).toEqual([
      ['No folder', false, false],
      ['scratch-2026-10-14-c31ade', false, true],
      ['site', false, false],
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'scratch-2026-10-14-c31ade' }).getAttribute('title')).toBe(scratch.root);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'No folder' }));
    expect(await screen.findByRole('button', { name: 'No folder' })).toBeTruthy();
  });

  it('start with no folder in a fresh desktop app', async () => {
    platform.desktop = desktopBridge('local');
    renderHome([]);
    expect(rows(await openMenu('No folder'), 'menuitemradio')).toEqual([['No folder', false, true]]);
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open folder…']);
  });

  it('in server mode, tells this computer’s folders from other computers’ and leaves SSH out', async () => {
    platform.desktop = desktopBridge('server');
    renderHome([ws('mine', { deviceId: 'd-mac' }), ws('theirs', { deviceId: 'd-pc', lastUsedAt: 4 })], { 'account.devices': () => [device('d-pc', 'Studio PC', true)] });
    expect(await screen.findByRole('button', { name: 'mine' })).toBeTruthy();
    // This computer's folders are lent to the server there: no scratch folders.
    expect(within(await openMenu('mine')).queryByRole('menuitemradio', { name: /No folder/ })).toBeNull();
    await closeMenus();
    const env = await openMenu('Environment: Local');
    await waitFor(() => expect(callsTo('workspaces.list').length).toBeGreaterThan(0));
    expect(within(env).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cloud', 'Remote Control']);
    fireEvent.click(within(await openSubmenu(env, 'Remote Control')).getByRole('menuitemradio', { name: 'Studio PC' }));
    expect(await screen.findByRole('button', { name: 'theirs' })).toBeTruthy();
    expect(localStorage.getItem('atelier.environment.code')).toBe('remote');
  });
});

describe('the chips on a desktop that lends itself to its server', () => {
  const SERVER_INFO = { name: 'Atelier', version: '0.2.8', surface: 'web', platform: 'linux', dataDir: '/data', deviceLink: { protocol: 2, services: ['runner', 'scratch', 'ssh'] } };
  const lendingBridge = () => {
    const bridge = desktopBridge('server');
    let allowed = { scratch: false, ssh: [] as string[] };
    const change = vi.fn(async (c: { kind: string; host?: string; allowed: boolean }) => {
      allowed = c.kind === 'ssh' ? { ...allowed, ssh: c.allowed ? [...allowed.ssh, c.host!] : allowed.ssh.filter((h) => h !== c.host) } : { ...allowed, scratch: c.allowed };
      return allowed;
    });
    return { ...bridge, lending: { get: vi.fn(async () => allowed), change } };
  };

  it('offers SSH hosts and No folder there, and lets the server reach a host chosen here', async () => {
    const bridge = lendingBridge();
    platform.desktop = bridge;
    renderHome([ws('mine', { deviceId: 'd-mac' })], {
      'app.info': () => SERVER_INFO,
      'account.devices': () => [{ ...device('d-mac', 'MacBook', true), current: true, services: ['runner', 'scratch', 'ssh'], lending: { scratch: false, ssh: [] } }],
      'ssh.list': () => [{ id: 'c1', name: 'gpu', host: 'gpu', port: null, keyPath: null, folder: null, passwordSaved: false }],
    });
    expect(await screen.findByRole('button', { name: 'mine' })).toBeTruthy();
    await waitFor(async () => {
      await closeMenus();
      expect(within(await openMenu('Environment: Local')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cloud', 'Remote Control', 'SSH']);
    });
    await closeMenus();
    expect(within(await openMenu('mine')).getByRole('menuitemradio', { name: 'No folder' })).toBeTruthy();
    await closeMenus();
    fireEvent.click(await within(await openSubmenu(await openMenu('Environment: Local'), 'SSH')).findByRole('menuitemradio', { name: 'gpu' }));
    expect(await screen.findByRole('button', { name: 'Environment: gpu' })).toBeTruthy();
    await waitFor(() => expect(bridge.lending.change).toHaveBeenCalledWith({ kind: 'ssh', host: 'gpu', allowed: true }));
  });

  it('shows an SSH folder another computer reaches as that computer’s', async () => {
    platform.desktop = lendingBridge();
    renderHome([ws('api', { kind: 'ssh', host: 'devbox', root: '/srv/api', deviceId: 'd-pc' })], {
      'app.info': () => SERVER_INFO,
      'account.devices': () => [device('d-pc', 'Studio PC', true)],
    }, { id: 'api' });
    expect(await screen.findByRole('button', { name: 'Environment: Studio PC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'devbox:/srv/api SSH' })).toBeTruthy();
  });
});

describe('the folder badge of a session', () => {
  it('says when the folder is not trusted and its own settings are ignored', () => {
    const { rerender } = render(<FolderBadge workspace={ws('site', { kind: 'codespace', host: 'cs-1', trusted: false })} />);
    expect(screen.getByText('Not trusted').getAttribute('title')).toMatch(/ignored until you trust it/);
    rerender(<FolderBadge workspace={ws('site', { kind: 'codespace', host: 'cs-1', trusted: true })} />);
    expect(screen.queryByText('Not trusted')).toBeNull();
    // A server from before the question was asked doesn't say.
    rerender(<FolderBadge workspace={ws('site', { kind: 'codespace', host: 'cs-1' })} />);
    expect(screen.queryByText('Not trusted')).toBeNull();
  });
});
