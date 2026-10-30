import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type AuthStatus, type ScreenLockStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, emit, resetBackend, user } from '../settings/test-backend.ts';
import { AuthGate } from './auth-gate.tsx';

const bridge = vi.hoisted(() => ({
  platform: 'darwin',
  connection: { get: vi.fn(), set: vi.fn(), problem: vi.fn(), onProblem: vi.fn(), openNetworkSettings: vi.fn() },
  session: { save: vi.fn(), clear: vi.fn() },
  discovery: { scan: vi.fn() },
  lock: { canUseSystem: vi.fn(), removeWithSystem: vi.fn() },
  system: { get: vi.fn() },
  device: { id: '0b6f0e0e-3c1a-4a4e-9a51-1f6f2b8c9d10', name: 'Ada’s MacBook', platform: 'darwin' },
  connect: vi.fn(),
  onMenu: vi.fn(() => () => {}),
  setTheme: vi.fn(),
  openExternal: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ message: vi.fn() }));

vi.mock('../../components/ui/toaster.tsx', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: Object.assign(vi.fn(), toasts),
}));
const reconnects = vi.hoisted(() => new Set<() => void>());
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  desktop: bridge,
  getTransport: () => ({ onReconnect: (h: () => void) => (reconnects.add(h), () => reconnects.delete(h)) }),
}));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const status = (patch: Partial<AuthStatus> = {}): AuthStatus => ({ setupRequired: false, signup: 'invite', user: null, local: false, oidc: [], ...patch });

beforeEach(() => {
  for (const fn of [bridge.connection.get, bridge.connection.set, bridge.connection.problem, bridge.connection.onProblem, bridge.connection.openNetworkSettings, bridge.session.save, bridge.session.clear, toasts.message]) fn.mockReset();
  bridge.connection.problem.mockResolvedValue(null);
  bridge.connection.onProblem.mockReturnValue(() => {});
  bridge.connection.openNetworkSettings.mockResolvedValue(undefined);
  bridge.connection.get.mockResolvedValue({ mode: 'local', serverUrl: null });
  bridge.connection.set.mockResolvedValue(undefined);
  bridge.discovery.scan.mockReset();
  bridge.discovery.scan.mockResolvedValue([]);
  bridge.session.save.mockResolvedValue(undefined);
  bridge.session.clear.mockResolvedValue(undefined);
  bridge.lock.canUseSystem.mockResolvedValue(false);
  bridge.lock.removeWithSystem.mockResolvedValue('removed');
  bridge.system.get.mockResolvedValue({ openAtLogin: false, dataFolder: '/Users/ada/.atelier/data' });
});

const unlocked: ScreenLockStatus = { enabled: false, kind: null, autoLockMinutes: 0, locked: false, retryAt: null };
const lockedPin: ScreenLockStatus = { enabled: true, kind: 'pin', autoLockMinutes: 0, locked: true, retryAt: null };

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AuthGate in the desktop app', () => {
  it('asks how to connect on first run, before talking to any backend', async () => {
    bridge.connection.get.mockResolvedValue({ mode: null, serverUrl: null });
    resetBackend({});
    renderGate();

    // Saving reloads the window, so the call never settles; the choice stays busy until then.
    bridge.connection.set.mockReturnValue(new Promise(() => {}));
    fireEvent.click(await screen.findByRole('button', { name: 'Run on this computer' }));
    await waitFor(() => expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'local' }));
    expect(screen.getByRole('button', { name: 'Run on this computer' }).getAttribute('aria-busy')).toBe('true');
    expect(callsTo('auth.status')).toEqual([]);
  });

  it('opens the getting started guide from the first-run choice', async () => {
    bridge.connection.get.mockResolvedValue({ mode: null, serverUrl: null });
    resetBackend({});
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(bridge.openExternal).toHaveBeenCalledWith('https://docs.atelierhq.dev/getting-started/');
  });

  it('connects to a server by URL', async () => {
    bridge.connection.get.mockResolvedValue({ mode: null, serverUrl: null });
    resetBackend({});
    renderGate();
    bridge.connection.set.mockRejectedValue(new Error('No Atelier server answered at https://atelier.lan.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to a server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Enter the server’s address/)).toBeTruthy();
    expect(bridge.connection.set).not.toHaveBeenCalled();

    // Without a scheme the desktop's main process tries https://, then http://.
    type('Server URL', '192.168.77.25:7340');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'server', serverUrl: '192.168.77.25:7340' }));

    type('Server URL', 'https://atelier.lan/');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('No Atelier server answered at https://atelier.lan.')).toBeTruthy();
    expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'server', serverUrl: 'https://atelier.lan' });
  });

  it('lists Atelier servers found on the network as they answer, and connects to one in a click', async () => {
    bridge.connection.get.mockResolvedValue({ mode: null, serverUrl: null });
    resetBackend({});
    let found: (server: unknown) => void = () => {};
    let done: (servers: unknown[]) => void = () => {};
    bridge.discovery.scan.mockImplementation((onFound: (server: unknown) => void) => {
      found = onFound;
      return new Promise((resolve) => (done = resolve));
    });
    bridge.connection.set.mockReturnValue(new Promise(() => {}));
    renderGate();
    // Nobody is asked before the person chose a server: macOS asks once whether Atelier may use the local network.
    await screen.findByRole('button', { name: 'Connect to a server' });
    expect(bridge.discovery.scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect to a server' }));

    const list = await screen.findByRole('region', { name: 'Found on your network' });
    expect(within(list).getByText('Searching…')).toBeTruthy();
    const studio = { url: 'http://192.168.77.25:7340', host: '192.168.77.25:7340', version: '0.1.8', name: 'Studio' };
    act(() => found(studio));
    act(() => found(studio));
    act(() => found({ url: 'http://127.0.0.1:7340', host: 'This computer', version: null, name: null }));
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['Studio192.168.77.25:7340 · Atelier 0.1.8', 'This computerhttp://127.0.0.1:7340']);
    await act(async () => done([studio]));
    expect(within(list).queryByText('Searching…')).toBeNull();

    fireEvent.click(within(list).getByRole('button', { name: /Studio/ }));
    await waitFor(() => expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'server', serverUrl: 'http://192.168.77.25:7340' }));
    expect((screen.getByRole('textbox', { name: 'Server URL' }) as HTMLInputElement).value).toBe('http://192.168.77.25:7340');
  });

  it('shows nothing under the server field when no server was found', async () => {
    bridge.connection.get.mockResolvedValue({ mode: null, serverUrl: null });
    resetBackend({});
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to a server' }));
    expect(await screen.findByText('Searching…')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Found on your network' })).toBeNull();
  });

  it('sets up the owner of this computer from a name alone, keeps the token and registers this computer', async () => {
    const ada = user();
    resetBackend({
      'auth.status': () => status({ setupRequired: true, local: true }),
      'lock.status': () => unlocked,
      'auth.setupLocal': () => ({ token: 'secret-token', user: ada }),
      'devices.register': () => ({ ...bridge.device, createdAt: 0, lastSeenAt: 0, current: true, online: true }),
    });
    renderGate();
    await screen.findByRole('heading', { name: 'Set up Atelier' });
    expect(screen.queryByLabelText(/^Setup token/)).toBeNull();
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    expect(screen.queryByLabelText(/^Username/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your name.')).toBeTruthy();
    type(/^Your name/, 'Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('The app')).toBeTruthy();
    expect(callsTo('auth.setupLocal')).toEqual([{ name: 'Ada Lovelace', clientKind: 'desktop' }]);
    expect(bridge.session.save).toHaveBeenCalledWith('secret-token');
    await waitFor(() => expect(callsTo('devices.register')).toContainEqual(bridge.device));
    expect(document.body.textContent).not.toContain('secret-token');
  });

  it('registers this computer again on every new connection and reads everything shown again', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    resetBackend({ 'auth.status': () => status({ user: user() }), 'devices.register': () => ({}) });
    renderGate();
    await screen.findByText('The app');
    await waitFor(() => expect(callsTo('devices.register')).toHaveLength(1));
    invalidate.mockClear();
    act(() => reconnects.forEach((h) => h()));
    await waitFor(() => expect(callsTo('devices.register')).toEqual([bridge.device, bridge.device]));
    // A device that came back online while the connection was down would otherwise stay "Offline".
    expect(invalidate).toHaveBeenCalledWith();
    invalidate.mockRestore();
  });

  it('signs in anyway, and says so, when this computer has no secure storage to keep the sign-in in', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    bridge.session.save.mockResolvedValue({ remembered: false });
    resetBackend({
      'auth.status': () => status(),
      'auth.login': () => ({ token: 'secret-token', user: user() }),
      'devices.register': () => ({}),
    });
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    type('Username', 'Ada');
    type('Password', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('The app')).toBeTruthy();
    expect(toasts.message).toHaveBeenCalledWith('You’re signed in for now', expect.objectContaining({ description: expect.stringContaining('sign in again next time') }));
  });

  it('never traps anyone on this computer: setup and sign-in both lead to the choice of a server', async () => {
    resetBackend({ 'auth.status': () => status({ setupRequired: true, local: true }), 'lock.status': () => unlocked });
    renderGate();
    await screen.findByRole('heading', { name: 'Set up Atelier' });
    fireEvent.click(screen.getByRole('button', { name: 'Use a server instead' }));
    expect(await screen.findByRole('button', { name: 'Connect to a server' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set up Atelier' })).toBeNull();
  });

  it('signs the owner of this computer in without a password when no sign-in was kept', async () => {
    resetBackend({
      'auth.status': () => status({ local: true }),
      'lock.status': () => unlocked,
      'auth.localSignIn': () => ({ token: 'fresh-token', user: user() }),
      'devices.register': () => ({}),
    });
    renderGate();
    expect(await screen.findByText('The app')).toBeTruthy();
    expect(callsTo('auth.localSignIn')).toEqual([{ clientKind: 'desktop' }]);
    expect(bridge.session.save).toHaveBeenCalledWith('fresh-token');
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).toBeNull();
  });

  it('falls back to the password sign-in, with the same way out, when this computer has no active owner', async () => {
    resetBackend({
      'auth.status': () => status({ local: true }),
      'lock.status': () => unlocked,
      'auth.localSignIn': () => {
        throw appError('not_found', 'No owner.');
      },
    });
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.getByRole('button', { name: 'Use a server instead' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I have a code' })).toBeNull();
  });

  it('signs in to a server over RPC and offers to change the server', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    resetBackend({
      'auth.status': () => status(),
      'auth.login': () => ({ token: 'secret-token', user: user() }),
      'devices.register': () => ({}),
    });
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.getByRole('button', { name: 'Change server' })).toBeTruthy();
    type('Username', 'Ada');
    type('Password', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('The app')).toBeTruthy();
    expect(callsTo('auth.login')).toEqual([{ username: 'ada', password: 'correct horse', clientKind: 'desktop' }]);
    expect(bridge.session.save).toHaveBeenCalledWith('secret-token');
  });

  it('joins a server with an invite code over RPC, and offers no code on this computer', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    resetBackend({
      'auth.status': () => status(),
      'auth.checkInvite': () => ({ ok: true }),
      'auth.acceptInvite': () => ({ token: 'invited-token', user: user({ username: 'bob' }) }),
      'devices.register': () => ({}),
    });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'I have a code' }));
    type('Invite code', 'a1b2c3d4e5f6g7h8');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'You’re invited' });
    type('Full name', 'Bob');
    type(/^Username/, 'bob');
    type(/^Password/, 'long enough');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('The app')).toBeTruthy();
    expect(callsTo('auth.checkInvite')).toEqual([{ invite: 'A1B2C3D4E5F6G7H8' }]);
    expect(callsTo('auth.acceptInvite')).toEqual([{ name: 'Bob', username: 'bob', password: 'long enough', invite: 'A1B2C3D4E5F6G7H8', clientKind: 'desktop' }]);
    expect(bridge.session.save).toHaveBeenCalledWith('invited-token');
  });

  it('offers to change the server while it can’t be reached, without waiting for it', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    resetBackend({ 'auth.status': () => new Promise(() => {}) });
    renderGate();
    expect(await screen.findByText('Connecting to https://atelier.lan…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change server' }));

    expect(((await screen.findByRole('textbox', { name: 'Server URL' })) as HTMLInputElement).value).toBe('https://atelier.lan');
  });

  it('says why the server can’t be reached, offers macOS’s local network switch, and carries on by itself', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    let announce: (problem: unknown) => void = () => {};
    bridge.connection.onProblem.mockImplementation((handler: (problem: unknown) => void) => {
      announce = handler;
      return () => {};
    });
    resetBackend({ 'auth.status': () => new Promise(() => {}) });
    renderGate();
    expect(await screen.findByText('Connecting to https://atelier.lan…')).toBeTruthy();
    expect(screen.queryByText(/Can’t reach/)).toBeNull();

    act(() => announce({ code: 'EHOSTUNREACH', message: 'macOS isn’t letting Atelier reach atelier.lan.', localNetwork: true }));
    expect(await screen.findByText('Can’t reach https://atelier.lan yet')).toBeTruthy();
    expect(screen.getByText('macOS isn’t letting Atelier reach atelier.lan.')).toBeTruthy();
    expect(screen.queryByText('Connecting to https://atelier.lan…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Local Network settings' }));
    expect(bridge.connection.openNetworkSettings).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change server' })).toBeTruthy();

    // A problem that isn't macOS's has no settings button.
    act(() => announce({ code: 'ECONNREFUSED', message: 'atelier.lan refused the connection.' }));
    expect(await screen.findByText('atelier.lan refused the connection.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Local Network settings' })).toBeNull();

    act(() => announce(null));
    expect(await screen.findByText('Connecting to https://atelier.lan…')).toBeTruthy();
  });

  it('shows a problem the app already knew about when the screen opens', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    bridge.connection.problem.mockResolvedValue({ code: 'ENOTFOUND', message: 'There is no server named atelier.lan on this network.' });
    resetBackend({ 'auth.status': () => new Promise(() => {}) });
    renderGate();
    expect(await screen.findByText('There is no server named atelier.lan on this network.')).toBeTruthy();
  });

  it('asks for the setup token when the server has no accounts yet', async () => {
    bridge.connection.get.mockResolvedValue({ mode: 'server', serverUrl: 'https://atelier.lan' });
    resetBackend({ 'auth.status': () => status({ setupRequired: true }) });
    renderGate();
    expect(await screen.findByLabelText(/^Setup token/)).toBeTruthy();
  });

  it('forgets the saved sign-in when the backend signs this app out', async () => {
    resetBackend({ 'auth.status': () => status({ user: user() }), 'devices.register': () => ({}) });
    renderGate();
    await screen.findByText('The app');

    act(() => emit('auth.signedOut', {}));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(bridge.session.clear).toHaveBeenCalled();
  });
});

describe('the screen lock on this computer', () => {
  function lockedBackend(extra: Record<string, (input: never) => unknown> = {}) {
    resetBackend({
      'auth.status': () => status({ local: true, user: user() }),
      'lock.status': () => lockedPin,
      'lock.unlock': ({ secret }: { secret: string }) => {
        if (secret !== '2468') throw appError('wrong_secret', 'That PIN is wrong.', { retryAt: null });
        return { ...lockedPin, locked: false };
      },
      'devices.register': () => ({}),
      ...extra,
    });
  }

  it('shows only the lock screen at launch, and the app once the backend says it is unlocked', async () => {
    lockedBackend();
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Atelier is locked' })).toBeTruthy();
    expect(screen.queryByText('The app')).toBeNull();
    // Nothing that needs the app unlocked is asked for.
    expect(callsTo('devices.register')).toEqual([]);

    type('PIN', '13a57');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('1357');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('That PIN is wrong.')).toBeTruthy();
    expect(screen.queryByText('The app')).toBeNull();

    type('PIN', '2468');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(callsTo('lock.unlock')).toEqual([{ secret: '1357' }, { secret: '2468' }]));
    act(() => emit('lock.changed', { ...lockedPin, locked: false }));
    expect(await screen.findByText('The app')).toBeTruthy();

    // "Lock now" in any window locks every window.
    act(() => emit('lock.changed', lockedPin));
    expect(await screen.findByRole('heading', { name: 'Atelier is locked' })).toBeTruthy();
    expect(screen.queryByText('The app')).toBeNull();
  });

  it('makes the next try wait after too many wrong ones', async () => {
    lockedBackend({
      'lock.unlock': () => {
        throw appError('rate_limited', 'Too many wrong tries.', { retryAt: Date.now() + 90_000 });
      },
    });
    renderGate();
    await screen.findByLabelText('PIN');
    type('PIN', '0000');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Too many wrong tries. Try again in 2 minutes.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a forgotten PIN with Touch ID where the Mac has it', async () => {
    bridge.lock.canUseSystem.mockResolvedValue(true);
    lockedBackend();
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Forgot your PIN?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove lock with Touch ID' }));
    await waitFor(() => expect(bridge.lock.removeWithSystem).toHaveBeenCalled());
  });

  it('says which file to delete for a forgotten PIN where there is no Touch ID', async () => {
    lockedBackend();
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Forgot your PIN?' }));
    expect(await screen.findByText('/Users/ada/.atelier/data')).toBeTruthy();
    expect(screen.getByText('screen-lock.json')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove lock with Touch ID' })).toBeNull();
  });
});
