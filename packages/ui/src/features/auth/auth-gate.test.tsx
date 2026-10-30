import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type AuthStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, emit, resetBackend, user } from '../settings/test-backend.ts';
import { AuthGate, inviteToken, screenFor } from './auth-gate.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const status = (patch: Partial<AuthStatus> = {}): AuthStatus => ({ setupRequired: false, signup: 'invite', user: null, local: false, oidc: [], ...patch });

const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
const reload = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  reload.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window.location, 'reload').mockImplementation(reload);
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

/** The JSON body of the last POST to /api/auth/<path>. */
function posted(path: string): unknown {
  const call = fetchMock.mock.calls.findLast(([url]) => url.pathname === `/api/auth/${path}`);
  return call && JSON.parse(call[1].body as string);
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Identity providers on the sign-in page', () => {
  const answered = (url: string) => fetchMock.mockResolvedValue(new Response(JSON.stringify({ url }), { status: 200 }));

  it('offers each one and sends the browser there', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    answered('https://auth.example.com/authorize?x=1');
    resetBackend({ 'auth.status': () => status({ oidc: [{ id: 'authentik', name: 'Authentik' }] }) });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Authentik' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1'));
    expect(fetchMock.mock.calls[0]![0].pathname).toBe('/api/auth/oidc/authentik/start');
    expect(screen.getByRole('button', { name: 'Continue with Authentik' }).getAttribute('aria-busy')).toBe('true');
  });

  it('says why when the server can’t start it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'oidc_failed', message: 'Authentik isn’t answering.' }), { status: 400 }));
    resetBackend({ 'auth.status': () => status({ oidc: [{ id: 'authentik', name: 'Authentik' }] }) });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Authentik' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Authentik isn’t answering.');
    expect(screen.getByRole('button', { name: 'Continue with Authentik' }).getAttribute('aria-busy')).toBeNull();
  });

  it('shows what went wrong when the browser comes back, once', async () => {
    history.replaceState(null, '', '/?signIn=pending');
    resetBackend({ 'auth.status': () => status({ oidc: [{ id: 'authentik', name: 'Authentik' }] }) });
    renderGate();
    expect((await screen.findByRole('alert')).textContent).toBe('Your account is waiting for an admin to approve it.');
    expect(location.search).toBe('');
  });

  it('never repeats a code it doesn’t know', async () => {
    history.replaceState(null, '', '/?signIn=%3Cscript%3E');
    resetBackend({ 'auth.status': () => status({ oidc: [] }) });
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.queryByText('<script>')).toBeNull();
  });
});

describe('screenFor', () => {
  it('sends a signed-in user to the app, or to a new password first', () => {
    expect(screenFor(status({ user: user() }), null)).toEqual({ name: 'app', user: user() });
    const temporary = user({ mustChangePassword: true });
    expect(screenFor(status({ user: temporary }), 'tok')).toEqual({ name: 'changePassword', user: temporary });
  });

  it('asks for the first account before anything else, then an invite, then sign-in', () => {
    expect(screenFor(status({ setupRequired: true }), 'tok')).toEqual({ name: 'setup' });
    expect(screenFor(status(), 'tok')).toEqual({ name: 'invite', token: 'tok' });
    expect(screenFor(status({ signup: 'open' }), null)).toEqual({ name: 'login' });
  });

  it('reads the token of an invite link', () => {
    expect(inviteToken('#/invite/abc_DEF-123')).toBe('abc_DEF-123');
    expect(inviteToken('#/invite/abc?x=1')).toBe('abc');
    expect(inviteToken('#/chat/abc')).toBeNull();
    expect(inviteToken('')).toBeNull();
  });
});

describe('AuthGate in a browser', () => {
  it('renders the app for a signed-in user', async () => {
    resetBackend({ 'auth.status': () => status({ user: user() }) });
    renderGate();
    expect(await screen.findByText('The app')).toBeTruthy();
  });

  it('creates the first account with the setup token over HTTP, then reloads', async () => {
    resetBackend({ 'auth.status': () => status({ setupRequired: true }) });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user: user() })));
    renderGate();
    await screen.findByRole('heading', { name: 'Set up Atelier' });

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter the setup token from the server log.')).toBeTruthy();
    expect(screen.getByText('Enter your name.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    type(/^Setup token/, 'tok-123');
    type('Full name', 'Ada Lovelace');
    type(/^Username/, 'Ada');
    type(/^Password/, 'correct horse');
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!);

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(posted('setup')).toEqual({ setupToken: 'tok-123', name: 'Ada Lovelace', username: 'ada', password: 'correct horse' });
  });

  it('points to the guide for the setup token', async () => {
    resetBackend({ 'auth.status': () => status({ setupRequired: true }) });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Where do I find the setup token?' }));
    expect(open).toHaveBeenCalledWith('https://docs.atelierhq.dev/self-hosting/#run-it', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('shows a wrong setup token at its field', async () => {
    resetBackend({ 'auth.status': () => status({ setupRequired: true }) });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_credentials', message: 'That setup token is wrong. It is printed in the server log.' }), { status: 400 }),
    );
    renderGate();
    await screen.findByRole('heading', { name: 'Set up Atelier' });
    type(/^Setup token/, 'nope');
    type('Full name', 'Ada');
    type(/^Username/, 'ada');
    type(/^Password/, 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('That setup token is wrong. It is printed in the server log.')).toBeTruthy();
    expect(screen.getByLabelText(/^Setup token/).getAttribute('aria-invalid')).toBe('true');
    expect(reload).not.toHaveBeenCalled();
  });

  it('signs in on Enter and shows the backend’s message when it fails', async () => {
    resetBackend({ 'auth.status': () => status() });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'invalid_credentials', message: 'Wrong username or password.' }), { status: 400 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user: user() })));
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.queryByText('Create an account')).toBeNull();

    type('Username', 'ada');
    type('Password', 'wrong');
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Wrong username or password.');

    type('Password', 'right one');
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(posted('login')).toEqual({ username: 'ada', password: 'right one' });
  });

  it('shows the pending screen when an account still waits for approval', async () => {
    resetBackend({ 'auth.status': () => status() });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'pending', message: 'Your account is waiting for an admin to approve it.' }), { status: 400 }));
    renderGate();
    await screen.findByRole('heading', { name: 'Welcome back' });
    type('Username', 'eve');
    type('Password', 'whatever1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Waiting for approval' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
  });

  it('offers sign-up only when it is open, and then waits for approval', async () => {
    resetBackend({ 'auth.status': () => status({ signup: 'open' }), 'auth.signup': () => ({ pending: true }) });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    await screen.findByRole('heading', { name: 'Create an account' });
    type('Full name', 'Eve');
    type(/^Username/, 'eve');
    type(/^Password/, 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Request account' }));
    expect(await screen.findByText('At least 8 characters')).toBeTruthy();

    type(/^Password/, 'long enough');
    fireEvent.click(screen.getByRole('button', { name: 'Request account' }));
    expect(await screen.findByRole('heading', { name: 'Waiting for approval' })).toBeTruthy();
    expect(callsTo('auth.signup')).toEqual([{ username: 'eve', name: 'Eve', password: 'long enough' }]);
  });

  it('accepts an invite from #/invite/<token>', async () => {
    history.replaceState(null, '', '/#/invite/tok_0123456789abcdef');
    resetBackend({ 'auth.status': () => status() });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'exists', message: 'The username “bob” is taken.' }), { status: 400 }));
    renderGate();
    await screen.findByRole('heading', { name: 'You’re invited' });
    type('Full name', 'Bob');
    type(/^Username/, 'bob');
    type(/^Password/, 'long enough');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('The username “bob” is taken.')).toBeTruthy();
    expect(screen.getByLabelText(/^Username/).getAttribute('aria-invalid')).toBe('true');
    expect(posted('invite')).toEqual({ name: 'Bob', username: 'bob', password: 'long enough', invite: 'tok_0123456789abcdef' });
  });

  it('creates an account with an invite code from the sign-in screen', async () => {
    resetBackend({
      'auth.status': () => status(),
      'auth.checkInvite': ({ invite }: { invite: string }) => {
        if (invite !== 'A1B2C3D4E5F6G7H8') throw appError('invalid_invite', 'This invite code is wrong, already used or expired.');
        return { ok: true };
      },
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user: user({ username: 'bob' }) }), { status: 200 }));
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'I have a code' }));
    await screen.findByRole('heading', { name: 'Join with a code' });

    type('Invite code', 'nope');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/An invite code has 16 letters and digits/)).toBeTruthy();
    expect(callsTo('auth.checkInvite')).toEqual([]);

    type('Invite code', 'A1B2-C3D4-E5F6-G7HX');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('This invite code is wrong, already used or expired.')).toBeTruthy();

    type('Invite code', ' a1b2 c3d4 e5f6 g7h8 ');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'You’re invited' });
    type('Full name', 'Bob');
    type(/^Username/, 'bob');
    type(/^Password/, 'long enough');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(posted('invite')).toEqual({ name: 'Bob', username: 'bob', password: 'long enough', invite: 'A1B2C3D4E5F6G7H8' });
  });

  it('makes a user with a temporary password choose a new one first', async () => {
    let changed = false;
    resetBackend({
      'auth.status': () => status({ user: user({ name: 'Bob', mustChangePassword: !changed }) }),
      'account.changePassword': ({ current }: { current: string }) => {
        if (current !== 'tmp-pass') throw appError('invalid_credentials', 'The current password is wrong.');
        changed = true;
        return { ok: true };
      },
    });
    renderGate();
    await screen.findByRole('heading', { name: 'Choose a new password' });
    type('Temporary password', 'nope');
    type(/^New password/, 'brand new pass');
    type('Confirm new password', 'brand new pas');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('The passwords don’t match.')).toBeTruthy();

    type('Confirm new password', 'brand new pass');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('The current password is wrong.')).toBeTruthy();

    type('Temporary password', 'tmp-pass');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('The app')).toBeTruthy();
    expect(callsTo('account.changePassword').at(-1)).toEqual({ current: 'tmp-pass', next: 'brand new pass' });
  });

  it('returns to sign-in when the backend signs this connection out', async () => {
    resetBackend({ 'auth.status': () => status({ user: user() }) });
    renderGate();
    await screen.findByText('The app');

    act(() => emit('auth.signedOut', {}));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(screen.queryByText('The app')).toBeNull();
  });
});
