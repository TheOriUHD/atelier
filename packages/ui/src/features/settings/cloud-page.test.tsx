import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type CodespaceSummary, type SettingsPath, type WorkspaceSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { TrustWorkspaceHost } from '../workspaces/trust.tsx';
import { CloudPage } from './cloud-page.tsx';
import { callsTo, resetBackend, snapshot, user } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const codespace = (name: string, extra: Partial<CodespaceSummary> = {}): CodespaceSummary => ({
  name,
  displayName: name,
  repo: 'ada/site',
  state: 'Available',
  machine: '2 cores, 8 GB RAM',
  idleTimeoutMinutes: 30,
  lastUsedAt: Date.now() - 3_600_000,
  root: '/workspaces/site',
  ...extra,
});

const folder = (name: string): WorkspaceSummary => ({ id: `w-${name}`, kind: 'codespace', name, root: '/workspaces/site', host: name, deviceId: null, available: true, scratch: false, lastUsedAt: 0 });

/** Settings with an OAuth app's client id or none; admins write it. */
function settingsBackend(clientId?: string) {
  let settings = snapshot({ cloud: { github: clientId ? { clientId } : {} } });
  return {
    'settings.get': () => settings,
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      settings = { ...settings, effective: setPath(settings.effective, path, value) };
      return { ok: true };
    },
    'settings.reset': () => ({ ok: true }),
  };
}

/** GitHub as the backend sees it: connected or not, with codespaces that start, stop and go away. */
function cloudBackend({ connected = true, codespaces = [] as CodespaceSummary[], folders = [] as WorkspaceSummary[], clientId = undefined as string | undefined } = {}) {
  let list = codespaces;
  const setState = (name: string, state: string) => (list = list.map((c) => (c.name === name ? { ...c, state } : c)));
  return {
    ...settingsBackend(clientId),
    'github.status': () => (connected ? { connected: true, login: 'ada' } : { connected: false }),
    'github.disconnect': () => ({ ok: true }),
    'codespaces.list': () => list,
    'codespaces.start': ({ name }: { name: string }) => (setState(name, 'Available'), { ok: true }),
    'codespaces.stop': ({ name }: { name: string }) => (setState(name, 'Shutdown'), { ok: true }),
    'codespaces.delete': ({ name }: { name: string }) => ((list = list.filter((c) => c.name !== name)), { ok: true }),
    'workspaces.list': () => folders,
    'workspaces.addCodespace': ({ name }: { name: string }) => ((folders = [...folders, folder(name)]), folder(name)),
  };
}

beforeEach(() => resetBackend(cloudBackend()));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `asking`: the window that asks "Trust this workspace?" is there (the app shell has it); without it the question is answered yes. */
async function renderPage(asking = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CloudPage />
        <Toaster />
        {asking && <TrustWorkspaceHost />}
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Advances the fake clock by `ms`. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Lets the calls and renders set off so far finish: a zero timer set while timers run fires a millisecond later. */
const settle = () => advance(5);

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('Cloud page: GitHub', () => {
  it('connects with a token, showing GitHub’s answer at the field', async () => {
    let attempts = 0;
    resetBackend({
      ...cloudBackend({ connected: false }),
      'github.connectToken': ({ token }: { token: string }) => {
        if (attempts++ === 0) throw appError('github_failed', 'That token lacks the “codespace” scope. Create one with codespace and repo.');
        return { connected: true, login: 'ada', token };
      },
    });
    await renderPage();
    expect(await screen.findByText('Not connected')).toBeTruthy();
    // Without an OAuth app, a token is the only way in.
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByText('Connect with a personal access token. Signing in with GitHub needs an OAuth app: add its client id below.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use a token…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Connect with a token' }));
    const field = dialog.getByLabelText('Personal access token');
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    expect(await dialog.findByText('Paste the whole token.')).toBeTruthy();

    fireEvent.change(field, { target: { value: '  ghp_fake0123456789  ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    expect(await dialog.findByText('That token lacks the “codespace” scope. Create one with codespace and repo.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected as @ada')).toBeTruthy();
    expect(callsTo('github.connectToken')).toEqual([{ token: 'ghp_fake0123456789' }, { token: 'ghp_fake0123456789' }]);
    expect(await screen.findByText('No codespaces yet. Create one for a repository to run Code sessions in the cloud.')).toBeTruthy();
  });

  it('signs in with the device flow, polling no faster than GitHub asks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const answers = [{ status: 'pending' }, { status: 'pending', interval: 10 }, { status: 'connected', login: 'ada' }];
    resetBackend({
      ...cloudBackend({ connected: false, clientId: 'Ov23liFake' }),
      'github.deviceStart': () => ({ flowId: 'flow-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 }),
      'github.devicePoll': () => answers.shift(),
    });
    await renderPage();
    await settle();
    expect(screen.getByText('Sign in with GitHub, or connect with a personal access token.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await settle();
    expect(screen.getByLabelText('Your code').textContent).toBe('WDJB-MJHT');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code and open GitHub' }));
    expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank', 'noopener,noreferrer');

    // Every 5 seconds, as GitHub said…
    await advance(4980);
    expect(callsTo('github.devicePoll')).toEqual([]);
    await advance(30);
    expect(callsTo('github.devicePoll')).toEqual([{ flowId: 'flow-1' }]);
    await advance(4950);
    expect(callsTo('github.devicePoll')).toHaveLength(1);
    await advance(100);
    expect(callsTo('github.devicePoll')).toHaveLength(2);
    // …until it asks to slow down to 10.
    await advance(9900);
    expect(callsTo('github.devicePoll')).toHaveLength(2);
    await advance(150);
    expect(callsTo('github.devicePoll')).toHaveLength(3);
    await settle();
    expect(screen.getByText('Connected as @ada')).toBeTruthy();
    expect(screen.queryByLabelText('Your code')).toBeNull();
  });

  it('says when the code expired or sign-in was denied, and stops asking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answers = [{ status: 'expired' }, { status: 'denied' }];
    resetBackend({
      ...cloudBackend({ connected: false, clientId: 'Ov23liFake' }),
      'github.deviceStart': () => ({ flowId: 'flow-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 }),
      'github.devicePoll': () => answers.shift(),
    });
    await renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await settle();
    await advance(5000);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('The code expired. Start again for a new one.');
    await advance(60_000);
    expect(callsTo('github.devicePoll')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await settle();
    await advance(5000);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('GitHub sign-in was denied.');
  });

  it('cancels the device flow without polling again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetBackend({
      ...cloudBackend({ connected: false, clientId: 'Ov23liFake' }),
      'github.deviceStart': () => ({ flowId: 'flow-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 }),
      'github.devicePoll': () => ({ status: 'pending' }),
    });
    await renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await advance(30_000);
    expect(callsTo('github.devicePoll')).toEqual([]);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });

  it('disconnects after explaining what happens to the codespaces', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Disconnect GitHub?' }));
    expect(confirm.getByText(/keep running on GitHub until their idle timeout/)).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(callsTo('github.disconnect')).toEqual([{}]);
    expect(screen.queryByRole('heading', { name: 'Codespaces' })).toBeNull();
  });

  it('lets admins set the OAuth app’s client id, and clears it when emptied', async () => {
    await renderPage();
    const field = await screen.findByRole('textbox', { name: 'GitHub OAuth app' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: ' Ov23liFake ' } });
    fireEvent.blur(field);
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['cloud', 'github', 'clientId'], value: 'Ov23liFake' }]));

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['cloud', 'github', 'clientId'] }]));
  });

  it('hides the client id from everyone else, who are told to ask an admin', async () => {
    resetBackend({ ...cloudBackend({ connected: false }), 'account.get': () => user({ role: 'user' }) });
    await renderPage();
    expect(await screen.findByText('Connect with a personal access token. Signing in with GitHub needs an OAuth app, which an admin adds in Settings.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'GitHub OAuth app' })).toBeNull();
  });
});

describe('Cloud page: codespaces', () => {
  it('lists codespaces with their state, machine, idle timeout and whether they are folders', async () => {
    resetBackend(
      cloudBackend({
        codespaces: [codespace('site-abc', { displayName: 'Site' }), codespace('api-xyz', { displayName: 'API', repo: 'ada/api', state: 'Shutdown', idleTimeoutMinutes: 60, machine: null })],
        folders: [folder('site-abc')],
      }),
    );
    await renderPage();
    const items = within(await screen.findByRole('list', { name: 'Codespaces' })).getAllByRole('listitem');
    await waitFor(() => expect(within(items[0]!).queryByText('Folder')).toBeTruthy());
    expect(items.map((i) => i.querySelector('p')!.textContent)).toEqual([
      'ada/site · 2 cores, 8 GB RAM · stops after 30 min idle · used 1 hour ago',
      'ada/api · stops after 60 min idle · used 1 hour ago',
    ]);
    expect(within(items[0]!).getByText('Running')).toBeTruthy();
    expect(within(items[1]!).getByText('Stopped')).toBeTruthy();
    // The one that is a folder already doesn't offer it again.
    expect(within(items[0]!).queryByRole('button', { name: 'Use as folder' })).toBeNull();
    expect(screen.getByText(/runs at most 12 hours at a time/)).toBeTruthy();
  });

  it('stops, starts, uses as a folder and deletes a codespace', async () => {
    resetBackend(cloudBackend({ codespaces: [codespace('site-abc', { displayName: 'Site' })] }));
    await renderPage();
    const item = await screen.findByRole('listitem');
    fireEvent.click(within(item).getByRole('button', { name: 'Stop' }));
    fireEvent.click(await within(item).findByRole('button', { name: 'Start' }));
    await within(item).findByRole('button', { name: 'Stop' });

    fireEvent.click(within(item).getByRole('button', { name: 'Use as folder' }));
    expect(await screen.findByText('Site is one of your folders now. Pick it for a Code session.')).toBeTruthy();
    await waitFor(() => expect(within(item).queryByRole('button', { name: 'Use as folder' })).toBeNull());

    fireEvent.click(within(item).getByRole('button', { name: 'Delete Site' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Delete Site?' }));
    expect(confirm.getByText('GitHub deletes the codespace and everything in it. Changes that aren’t committed and pushed are lost.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('No codespaces yet. Create one for a repository to run Code sessions in the cloud.')).toBeTruthy();
    expect(callsTo('codespaces.stop')).toEqual([{ name: 'site-abc' }]);
    expect(callsTo('codespaces.start')).toEqual([{ name: 'site-abc' }]);
    expect(callsTo('workspaces.addCodespace')).toEqual([{ name: 'site-abc', trust: true }]);
    expect(callsTo('codespaces.delete')).toEqual([{ name: 'site-abc' }]);
  });

  it('asks Trust this workspace? before a codespace becomes a folder, and adds nothing when the person says no', async () => {
    resetBackend(cloudBackend({ codespaces: [codespace('site-abc', { displayName: 'Site' })] }));
    await renderPage(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Use as folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(dialog.textContent).toContain('ada/site');
    expect(dialog.textContent).toContain('on GitHub codespace site-abc');
    expect(callsTo('workspaces.addCodespace')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('workspaces.addCodespace')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Use as folder' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this workspace?' })).getByRole('button', { name: 'Trust workspace' }));
    await waitFor(() => expect(callsTo('workspaces.addCodespace')).toEqual([{ name: 'site-abc', trust: true }]));
  });

  it('shows why a codespace couldn’t be used as a folder', async () => {
    resetBackend({
      ...cloudBackend({ codespaces: [codespace('site-abc')] }),
      'workspaces.addCodespace': () => {
        throw appError('workspace_unavailable', 'gh codespace ssh failed: sshd is not running in the codespace.');
      },
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use as folder' }));
    expect(await screen.findByText('gh codespace ssh failed: sshd is not running in the codespace.')).toBeTruthy();
  });

  it('creates a codespace on a machine for the repository, showing progress until it is available', async () => {
    let finish!: () => void;
    const machines = [
      { name: 'basicLinux32gb', displayName: '2 cores, 8 GB RAM, 32 GB storage', cpus: 2, memoryBytes: 8e9 },
      { name: 'standardLinux32gb', displayName: '4 cores, 16 GB RAM, 32 GB storage', cpus: 4, memoryBytes: 16e9 },
    ];
    resetBackend({
      ...cloudBackend(),
      'codespaces.machines': () => machines,
      'codespaces.create': () => new Promise((resolve) => (finish = () => resolve(codespace('site-new', { displayName: 'site (main)' })))),
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New codespace' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New codespace' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create codespace' }));
    expect(await dialog.findByText('Enter a repository as owner/repo.')).toBeTruthy();
    expect(dialog.getByText('Choose a machine.')).toBeTruthy();

    const repo = dialog.getByRole('textbox', { name: 'Repository' });
    fireEvent.change(repo, { target: { value: 'https://github.com/ada/site.git' } });
    fireEvent.blur(repo);
    const machine = dialog.getByRole('combobox', { name: 'Machine' });
    await waitFor(() => expect(machine.textContent).toContain('2 cores, 8 GB RAM, 32 GB storage'));
    expect(callsTo('codespaces.machines')).toEqual([{ repo: 'ada/site' }]);
    fireEvent.click(machine);
    pick(await screen.findByRole('option', { name: '4 cores, 16 GB RAM, 32 GB storage' }));
    fireEvent.click(dialog.getByRole('combobox', { name: 'Idle timeout' }));
    pick(await screen.findByRole('option', { name: '1 hour' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create codespace' }));

    expect((await dialog.findByRole('status')).textContent).toMatch(/^Creating the codespace, usually one to three minutes \(0:00\)/);
    expect(callsTo('codespaces.create')).toEqual([{ repo: 'ada/site', machine: 'standardLinux32gb', idleTimeoutMinutes: 60 }]);
    await act(async () => finish());

    expect(await screen.findByText('site (main) is ready.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New codespace' })).toBeNull());
  });

  it('still says so when creating fails after the dialog was closed', async () => {
    let fail!: () => void;
    const machines = [{ name: 'basicLinux32gb', displayName: '2 cores, 8 GB RAM, 32 GB storage', cpus: 2, memoryBytes: 8e9 }];
    resetBackend({
      ...cloudBackend(),
      'codespaces.machines': () => machines,
      'codespaces.create': () => new Promise((_resolve, reject) => (fail = () => reject(appError('github_failed', 'You have reached your codespace quota.')))),
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New codespace' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New codespace' }));
    const repo = dialog.getByRole('textbox', { name: 'Repository' });
    fireEvent.change(repo, { target: { value: 'ada/site' } });
    fireEvent.blur(repo);
    await waitFor(() => expect(dialog.getByRole('combobox', { name: 'Machine' }).textContent).toContain('2 cores'));
    fireEvent.click(dialog.getByRole('button', { name: 'Create codespace' }));
    await dialog.findByRole('status');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New codespace' })).toBeNull());
    await act(async () => fail());
    expect(await screen.findByText('Creating the codespace failed: You have reached your codespace quota.')).toBeTruthy();
  });

  it('shows GitHub’s reason when a repository’s machines can’t be listed', async () => {
    resetBackend({
      ...cloudBackend(),
      'codespaces.machines': () => {
        throw appError('github_failed', 'Not Found');
      },
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New codespace' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New codespace' }));
    const repo = dialog.getByRole('textbox', { name: 'Repository' });
    fireEvent.change(repo, { target: { value: 'ada/nope' } });
    fireEvent.blur(repo);
    expect(await dialog.findByText('Not Found')).toBeTruthy();
  });
});
