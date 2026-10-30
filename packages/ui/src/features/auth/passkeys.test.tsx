import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuthnError, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthStatus, PasskeySummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { AccountPage } from '../settings/account-page.tsx';
import { callsTo, resetBackend, user } from '../settings/test-backend.ts';
import { AuthGate } from './auth-gate.tsx';
import { LoginScreen } from './auth-screens.tsx';
import { passkeysAvailable } from './passkeys.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

vi.mock('@simplewebauthn/browser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

/** Which app this is: the browser, or the desktop app (which signs in with passwords only). */
const platform = vi.hoisted(() => ({ surface: 'web' }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get surface() {
    return platform.surface;
  },
}));

const REQUEST = { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', userVerification: 'preferred' };
const CREATION = { challenge: 'Y3JlYXRl', rp: { id: 'localhost', name: 'Atelier' }, user: { id: 'dS1hZG1pbg', name: 'ada', displayName: 'Ada' }, pubKeyCredParams: [] };
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} };
const ATTESTATION = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'AA' }, clientExtensionResults: {} };

/** The server's passkey routes: answers by path; `fail` makes one answer with an error instead. */
const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
function serve(fail: Record<string, { code: string; message: string }> = {}) {
  fetchMock.mockImplementation(async (url) => {
    const error = fail[url.pathname];
    if (error) return new Response(JSON.stringify(error), { status: 400 });
    const body = {
      '/api/auth/passkey/options': { flowId: 'flow-in', options: REQUEST },
      '/api/auth/passkey': { user: user() },
      '/api/passkeys/options': { flowId: 'flow-add', options: CREATION },
      '/api/passkeys': { id: 'cred-2', name: 'Work laptop', createdAt: 0, lastUsedAt: null },
    }[url.pathname];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  });
}

/** The JSON bodies posted to the server, by path. */
const posted = () => fetchMock.mock.calls.map(([url, init]) => [url.pathname, JSON.parse(init.body as string)]);

const reload = vi.fn();

beforeEach(() => {
  platform.surface = 'web';
  fetchMock.mockReset();
  reload.mockReset();
  vi.mocked(startAuthentication).mockReset().mockResolvedValue(ASSERTION as never);
  vi.mocked(startRegistration).mockReset().mockResolvedValue(ATTESTATION as never);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('PublicKeyCredential', vi.fn());
  vi.spyOn(window.location, 'reload').mockImplementation(reload);
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {node}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const signedOut: AuthStatus = { setupRequired: false, signup: 'invite', user: null, local: false, oidc: [] };

describe('Signing in with a passkey', () => {
  it('runs the browser’s prompt with the server’s options, then reloads signed in', async () => {
    resetBackend({ 'auth.status': () => signedOut });
    renderWith(
      <AuthGate>
        <p>The app</p>
      </AuthGate>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: REQUEST });
    expect(posted()).toEqual([
      ['/api/auth/passkey/options', {}],
      ['/api/auth/passkey', { flowId: 'flow-in', response: ASSERTION }],
    ]);
  });

  it('says so when the prompt was cancelled, and shows the server’s reason for a passkey it doesn’t know', async () => {
    vi.mocked(startAuthentication).mockRejectedValueOnce(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
    serve({ '/api/auth/passkey': { code: 'invalid_credentials', message: 'That passkey isn’t registered here.' } });
    renderWith(<LoginScreen onSignedIn={vi.fn()} onPending={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Sign in with a passkey' });

    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('The passkey request was cancelled or timed out.');
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That passkey isn’t registered here.'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('isn’t offered without WebAuthn or in the desktop app', () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    renderWith(<LoginScreen onSignedIn={vi.fn()} onPending={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();

    vi.stubGlobal('PublicKeyCredential', vi.fn());
    platform.surface = 'desktop';
    renderWith(<LoginScreen onSignedIn={vi.fn()} onPending={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
  });

  it('needs a hostname: WebAuthn refuses sites at an IP address', () => {
    expect(passkeysAvailable()).toBe(true);
    for (const hostname of ['192.168.1.20', '[::1]']) {
      vi.stubGlobal('location', { ...location, hostname });
      expect(passkeysAvailable()).toBe(false);
    }
  });
});

const ADDED = new Date(2026, 9, 1).getTime();
const passkey = (id: string, name: string, extra: Partial<PasskeySummary> = {}): PasskeySummary => ({ id, name, createdAt: ADDED, lastUsedAt: null, ...extra });

/** The person's passkeys as the backend keeps them. Adding one goes through `fetch`, which calls `add`. */
function accountBackend(initial: PasskeySummary[]) {
  let passkeys = initial;
  resetBackend({
    'account.sessions': () => [],
    'account.devices': () => [],
    'account.passkeys': () => passkeys,
    'account.removePasskey': ({ id }: { id: string }) => {
      passkeys = passkeys.filter((p) => p.id !== id);
      return { ok: true };
    },
  });
  return { add: (p: PasskeySummary) => (passkeys = [p, ...passkeys]) };
}

const rows = async () =>
  within(await screen.findByRole('table', { name: 'Passkeys' }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

describe('Passkeys in Settings › Account', () => {
  it('lists them and adds one with a name through the browser’s prompt', async () => {
    const backend = accountBackend([passkey('cred-1', 'Phone', { lastUsedAt: Date.now() - 2 * 86_400_000 })]);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ flowId: 'flow-add', options: CREATION })));
    fetchMock.mockImplementationOnce(async () => {
      backend.add(passkey('cred-2', 'Work laptop'));
      return new Response(JSON.stringify({ id: 'cred-2', name: 'Work laptop', createdAt: 0, lastUsedAt: null }));
    });
    renderWith(<AccountPage />);
    await waitFor(async () => expect(await rows()).toEqual([['Phone', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ADDED), '2 days ago', '']]));

    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add a passkey' }));
    const name = dialog.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: ' ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
    expect(await dialog.findByText('Name it, so you can tell your passkeys apart.')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'Work laptop' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Passkey added. Use it on the sign-in page.')).toBeTruthy();
    await waitFor(async () => expect((await rows()).map((r) => r[0])).toEqual(['Work laptop', 'Phone']));
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION });
    expect(posted()).toEqual([
      ['/api/passkeys/options', {}],
      ['/api/passkeys', { flowId: 'flow-add', response: ATTESTATION, name: 'Work laptop' }],
    ]);
  });

  it('explains when this device already has one', async () => {
    accountBackend([]);
    vi.mocked(startRegistration).mockRejectedValueOnce(
      new WebAuthnError({ message: 'The authenticator was previously registered', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', cause: new Error('InvalidStateError') }),
    );
    renderWith(<AccountPage />);
    expect(await screen.findByText('No passkeys yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add a passkey' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
    expect(await dialog.findByText('This device already has a passkey for your account.')).toBeTruthy();
    expect(posted()).toEqual([['/api/passkeys/options', {}]]);
  });

  it('removes one after saying it should go from the device too', async () => {
    accountBackend([passkey('cred-1', 'Phone'), passkey('cred-3', 'YubiKey')]);
    renderWith(<AccountPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove YubiKey' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Remove “YubiKey”?' }));
    expect(confirm.getByText('It no longer signs you in here. Delete it from your device or password manager too.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Remove' }));

    await waitFor(async () => expect((await rows()).map((r) => r[0])).toEqual(['Phone']));
    expect(callsTo('account.removePasskey')).toEqual([{ id: 'cred-3' }]);
  });

  it('isn’t there without WebAuthn', async () => {
    accountBackend([]);
    vi.stubGlobal('PublicKeyCredential', undefined);
    renderWith(<AccountPage />);
    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).toBeNull();
    expect(callsTo('account.passkeys')).toEqual([]);
  });

  it('isn’t there in the desktop app', async () => {
    accountBackend([]);
    platform.surface = 'desktop';
    renderWith(<AccountPage />);
    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).toBeNull();
  });
});
