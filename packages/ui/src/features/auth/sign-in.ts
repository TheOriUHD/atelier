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
