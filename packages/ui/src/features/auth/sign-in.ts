/**
 * Signing in and out (ARCHITECTURE §21). Browsers sign in over HTTP so the token lands in an HttpOnly
 * cookie, then reload so the WebSocket reconnects with it. The desktop app signs in over its existing
 * connection and keeps the token in the OS keychain for the next start.
 */
import { appError, type UserSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/toaster.tsx';
import { desktop } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { isLocal } from './screen-lock.ts';

export interface NewAccount {
  username: string;
  name: string;
  password: string;
}

/** POSTs JSON to a server route (`api/…`, under the app's base URL) and resolves to its JSON answer; failures throw its `{ code, message }`. */
export async function postJson(path: string, body: object): Promise<unknown> {
  const res = await fetch(new URL(path, document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (res.ok) return data;
  throw appError(data.code ?? 'failed', data.message ?? `The server answered ${res.status}.`);
}

const post = (path: 'setup' | 'login' | 'invite' | 'logout', body: object) => postJson(`api/auth/${path}`, body);

/**
 * Sends the browser to an identity provider to sign in or, with `link`, to connect it to the signed-in account. The
 * server takes it from there and the page loads again when it comes back, so the promise never settles.
 */
export async function oidcStart(id: string, link = false): Promise<never> {
  const { url } = (await postJson(`api/auth/oidc/${id}/start`, { link })) as { url: string };
  location.assign(url);
  return new Promise(() => {});
}

let offered = false;
/** Whether this browser can sign in with an identity provider here; the backend says so with the sign-in status. */
export const identityProvidersOffered = () => offered;
export function setIdentityProvidersOffered(available: boolean): void {
  offered = available && !desktop;
}

const OIDC_ERRORS: Record<string, string> = {
  no_account: 'There’s no account for this sign-in here. Ask an admin for one, or sign in another way and connect it in Settings › Account.',
  pending: 'Your account is waiting for an admin to approve it.',
  disabled: 'This account is disabled. Ask an admin to re-enable it.',
  denied: 'The identity provider didn’t allow this sign-in.',
  expired: 'That sign-in expired. Try again.',
  identity_taken: 'That sign-in is already connected to another account.',
  not_found: 'That sign-in isn’t set up on this server any more.',
};

/** What went wrong when the server sent the browser back from an identity provider (`?signIn=<code>`). */
export function oidcError(): string | undefined {
  const code = new URLSearchParams(location.search).get('signIn');
  if (!code) return undefined;
  return OIDC_ERRORS[code] ?? 'That sign-in didn’t work. The server’s log says why.';
}

/** Takes `?signIn=<code>` out of the address, so a reload doesn't show it again. */
export function clearOidcError(): void {
  if (location.search) history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

/** Reloads the page; the returned promise never settles, so forms stay busy until the page goes. */
export function reload(): Promise<never> {
  location.reload();
  return new Promise(() => {});
}

/** Keeps a desktop sign-in for the next start, and says so when this computer can't. */
async function keep({ token, user }: { token: string; user: UserSummary }): Promise<UserSummary> {
  const saved = await desktop!.session.save(token);
  if (saved?.remembered === false) {
    toast.message('You’re signed in for now', {
      description: 'This computer has no secure storage Atelier can use, so it can’t keep you signed in. You’ll sign in again next time.',
      duration: 12_000,
    });
  }
  return user;
}

/** On desktop: saves the token and resolves to the user. In a browser the page reloads instead. */
async function signIn(
  path: 'setup' | 'login' | 'invite',
  body: object,
  desktopCall: () => Promise<{ token: string; user: UserSummary }>,
): Promise<UserSummary> {
  if (desktop) return keep(await desktopCall());
  await post(path, body);
  return reload();
}

/** Creates the first account, which becomes the admin. Servers ask for the token printed in their log. */
export function setup(input: NewAccount & { setupToken?: string }): Promise<UserSummary> {
  return signIn('setup', input, () => rpc().call('auth.setup', { ...input, clientKind: 'desktop' }));
}

/** "Run on this computer": the owner's account from their name; there is no password. */
export async function setupLocal(name: string): Promise<UserSummary> {
  return keep(await rpc().call('auth.setupLocal', { name, clientKind: 'desktop' }));
}

/** "Run on this computer": signs the owner in again without a password (the keychain had no sign-in). */
export async function localSignIn(): Promise<UserSummary> {
  return keep(await rpc().call('auth.localSignIn', { clientKind: 'desktop' }));
}

export function login(input: { username: string; password: string }): Promise<UserSummary> {
  return signIn('login', input, () => rpc().call('auth.login', { ...input, clientKind: 'desktop' }));
}

export function acceptInvite(invite: string, input: NewAccount): Promise<UserSummary> {
  return signIn('invite', { ...input, invite }, () =>
    rpc().call('auth.acceptInvite', { ...input, invite, clientKind: 'desktop' }),
  );
}

/** Resolves when an invite code is open, so the account form comes only after a code that works. */
export async function checkInvite(invite: string): Promise<void> {
  await rpc().call('auth.checkInvite', { invite });
}

/** Asks for an account under open sign-up. It waits for an admin's approval; nobody is signed in. */
export async function signup(input: NewAccount): Promise<void> {
  await rpc().call('auth.signup', input);
}

/** How long "Sign out" waits for a server to revoke the sign-in before leaving anyway. */
const LOGOUT_WAIT_MS = 5000;

/** Desktop: back to the first-run choice; a server's sign-in is revoked first where it answers in time. */
export async function leaveSetup(): Promise<void> {
  if (!isLocal()) {
    // An unreachable server can't revoke it; it stays listed under Active sessions there, where it can be revoked.
    await Promise.race([rpc().call('auth.logout', {}), new Promise((resolve) => setTimeout(resolve, LOGOUT_WAIT_MS))]).catch(() => undefined);
  }
  await desktop!.connection.reset!();
}

/** Ends this sign-in. On desktop the backend's `auth.signedOut` then takes the app back to sign-in. */
export async function logout(): Promise<void> {
  if (desktop) {
    await rpc().call('auth.logout', {});
    await desktop.session.clear();
    return;
  }
  await post('logout', {});
  await reload();
}
