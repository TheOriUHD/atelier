import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OidcProviderInput, type SignupPolicy } from '@atelier/protocol';
import { SecretStore } from '../secrets/secret-store.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { userIdentities, users } from '../store/schema.ts';
import { AccountService, type ClientInfo } from './account-service.ts';
import { Oidc } from './oidc.ts';

const ISSUER = 'https://idp.test/application/o/atelier/';
const REDIRECT = 'https://atelier.test/api/auth/oidc/authentik/callback';
const web: ClientInfo = { clientKind: 'web', ip: '10.0.0.1' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A provider on the other side of the fake `fetch`: who signs in next, and what it was asked. */
class FakeIdp {
  person: Record<string, unknown> = { sub: 'sub-1', preferred_username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
  metadata: Record<string, unknown> = {};
  issuer = ISSUER;
  /** Authentik signs with the client secret when no signing key is chosen. */
  hmacKey: string | null = null;
  down = false;
  requests: { url: string; headers: Headers; body: URLSearchParams }[] = [];
  private nonces = new Map<string, { nonce: string; challenge: string }>();

  /** The provider's side of the browser's visit: remembers the request and sends back a code. */
  authorize(url: string): string {
    const params = new URL(url).searchParams;
    const code = `code-${this.nonces.size}`;
    this.nonces.set(code, { nonce: params.get('nonce')!, challenge: params.get('code_challenge')! });
    return `?code=${code}&state=${params.get('state')}`;
  }

  fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (this.down) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    const body = new URLSearchParams(String(init?.body ?? ''));
    this.requests.push({ url: url.href, headers: new Headers(init?.headers), body });
    const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      if (url.href !== `${ISSUER}.well-known/openid-configuration`) return json({}, 404);
      return json({
        issuer: this.issuer,
        authorization_endpoint: 'https://idp.test/authorize',
        token_endpoint: 'https://idp.test/token',
        userinfo_endpoint: 'https://idp.test/userinfo',
        jwks_uri: 'https://idp.test/jwks',
        response_types_supported: ['code'],
        ...this.metadata,
      });
    }
    if (url.pathname === '/token') {
      const grant = this.nonces.get(body.get('code')!);
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (!grant || grant.challenge !== challenge) return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const payload = `${b64({ alg: this.hmacKey ? 'HS256' : 'RS256', typ: 'JWT' })}.${b64({ iss: this.issuer, sub: this.person.sub, aud: 'client', iat: now, exp: now + 60, nonce: grant.nonce })}`;
      const signature = this.hmacKey ? createHmac('sha256', this.hmacKey).update(payload).digest() : sign('sha256', Buffer.from(payload), privateKey);
      return json({ access_token: 'access', token_type: 'Bearer', expires_in: 60, id_token: `${payload}.${signature.toString('base64url')}` });
    }
    if (url.pathname === '/userinfo') return json(this.person);
    return json({}, 404);
  };
}

const provider: OidcProviderInput = { name: 'Authentik', issuer: ISSUER, clientId: 'client', clientSecret: 'the-secret', newAccounts: 'pending' };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

let db: Db;
let accounts: AccountService;
let secrets: SecretStore;
let idp: FakeIdp;
let oidc: Oidc;
let logged: string[];

/** One round trip, as a browser makes it. */
async function visit(userId: string | null = null, by = userId) {
  const { flowId, url } = await oidc.begin('authentik', REDIRECT, userId);
  return oidc.finish('authentik', flowId, idp.authorize(url), by, web);
}
const signedIn = async (userId?: string | null) => {
  const result = await visit(userId);
  if (!('signedIn' in result)) throw new Error('not signed in');
  return result.signedIn.user;
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  accounts = new AccountService(db, (): SignupPolicy => 'invite');
  secrets = new SecretStore(db, { encrypt: async (v) => `x${v}`, decrypt: async (v) => v.slice(1) });
  idp = new FakeIdp();
  logged = [];
  oidc = new Oidc({ db, accounts, secrets, log: (message, reason) => logged.push(`${message}: ${reason}`), fetch: idp.fetch });
  await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
  await oidc.save(provider);
});
afterEach(() => db.$client.close());

describe('Signing in with an identity provider', () => {
  it('never takes over an account for having the same name: a new one is made, and it waits for approval', async () => {
    expect(await code(visit())).toBe('pending');
    const rows = await db.select().from(users).all();
    expect(rows.map((r) => [r.username, r.role])).toEqual([['ada', 'admin'], ['ada2', 'pending']]);
    expect(rows[1]!.passwordHash).toBe('');
  });

  it('keeps someone waiting out until an admin approves them, then signs them in', async () => {
    await expect(signedIn()).rejects.toMatchObject({ code: 'pending' });
    await expect(signedIn()).rejects.toMatchObject({ code: 'pending' });
    const row = (await db.select().from(users).all())[1]!;
    await accounts.adminUpdate(row.id, { role: 'user' });
    expect((await signedIn()).id).toBe(row.id);
  });

  it('turns people away when new accounts are off', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'none' });
    expect(await code(visit())).toBe('no_account');
    expect(await db.select().from(users).all()).toHaveLength(1);
  });

  it('lets people straight in when the provider is trusted for it', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    const user = await signedIn();
    expect(user).toMatchObject({ username: 'ada2', name: 'Ada Lovelace', role: 'user', hasPassword: false });
  });

  it('connects a provider to the account that asked, and then signs that account in', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    expect(await visit(admin.id)).toEqual({ connected: true });
    expect((await signedIn()).id).toBe(admin.id);
    expect(await db.select().from(users).all()).toHaveLength(1);
    expect((await oidc.identities(admin.id)).connected).toMatchObject([{ provider: 'Authentik', label: 'ada@example.com' }]);
    expect((await oidc.identities(admin.id)).available).toEqual([]);
  });

  it('refuses to connect a sign-in that belongs to someone else', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    await visit(admin.id);
    const { user: bob } = await accounts.create({ username: 'bob', name: 'Bob', role: 'user' });
    expect(await code(visit(bob.id))).toBe('identity_taken');
  });

  it('connecting finishes only for the person who started it', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    expect(await code(visit(admin.id, 'someone-else'))).toBe('expired');
    expect(await db.select().from(userIdentities).all()).toEqual([]);
  });

  it('uses a flow once, in the browser that started it, and only with its state', async () => {
    const { flowId, url } = await oidc.begin('authentik', REDIRECT, null);
    const answer = idp.authorize(url);
    expect(await code(oidc.finish('authentik', 'another-browser', answer, null, web))).toBe('expired');
    expect(await code(oidc.finish('authentik', flowId, answer.replace(/state=.*/, 'state=forged'), null, web))).toBe('oidc_failed');
    expect(await code(oidc.finish('authentik', flowId, answer, null, web))).toBe('expired');
    expect(logged.join()).toContain('Sign-in with identity provider authentik failed');
  });

  it('asks with PKCE, state and a nonce, and refuses an ID token for another nonce', async () => {
    const { flowId, url } = await oidc.begin('authentik', REDIRECT, null);
    const params = new URL(url).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('openid profile email');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    const answer = idp.authorize(url.replace(/nonce=[^&]+/, 'nonce=stolen'));
    expect(await code(oidc.finish('authentik', flowId, answer, null, web))).toBe('oidc_failed');
  });

  it('takes an ID token signed with the client secret, and names from the userinfo endpoint', async () => {
    idp.hmacKey = 'the-secret';
    idp.metadata = { id_token_signing_alg_values_supported: ['HS256'] };
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    expect(await signedIn()).toMatchObject({ name: 'Ada Lovelace', username: 'ada2' });
  });

  it('signs in with what the ID token says when the userinfo endpoint fails', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    const answer = idp.fetch;
    idp.fetch = async (input, init) => (String(input).endsWith('/userinfo') ? new Response('nope', { status: 500 }) : answer(input, init));
    oidc = new Oidc({ db, accounts, secrets, log: () => undefined, fetch: (input, init) => idp.fetch(input as never, init) });
    expect(await signedIn()).toMatchObject({ username: 'user', name: 'New member' });
  });

  it('refuses a disabled account', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    const user = await signedIn();
    await accounts.adminUpdate(user.id, { disabled: true });
    expect(await code(visit())).toBe('disabled');
  });

  it('says when the person said no at the provider', async () => {
    const { flowId, url } = await oidc.begin('authentik', REDIRECT, null);
    const state = new URL(url).searchParams.get('state');
    expect(await code(oidc.finish('authentik', flowId, `?error=access_denied&state=${state}`, null, web))).toBe('denied');
  });

  it('does not match a subject from another issuer', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    await visit(admin.id);
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'none' });
    await db.update(userIdentities).set({ issuer: 'https://elsewhere.test/' });
    expect(await code(visit())).toBe('no_account');
  });
});

describe('Identity providers as an admin sets them up', () => {
  it('keeps the client secret out of the row and shows only its tail', async () => {
    expect(await oidc.list()).toMatchObject([{ id: 'authentik', secret: '••••cret', clientId: 'client', people: 0 }]);
    expect(await secrets.get('oidc-authentik')).toBe('the-secret');
    await oidc.save({ ...provider, id: 'authentik', clientSecret: undefined, name: 'Our login' });
    expect(await oidc.list()).toMatchObject([{ id: 'authentik', name: 'Our login', secret: '••••cret' }]);
    await oidc.save({ ...provider, id: 'authentik', clientSecret: '' });
    expect(await oidc.list()).toMatchObject([{ secret: null }]);
  });

  it('takes the issuer with or without its trailing slash, or the configuration document’s address', async () => {
    await oidc.remove('authentik');
    expect((await oidc.save({ ...provider, issuer: ISSUER.slice(0, -1) })).issuer).toBe(ISSUER);
    await oidc.remove('authentik');
    expect((await oidc.save({ ...provider, issuer: `${ISSUER}.well-known/openid-configuration` })).issuer).toBe(ISSUER);
  });

  it('says what is wrong instead of saving a provider that doesn’t answer', async () => {
    idp.down = true;
    await expect(oidc.save({ ...provider, name: 'Broken' })).rejects.toMatchObject({ code: 'oidc_failed', message: expect.stringContaining('ECONNREFUSED') });
    expect(await oidc.list()).toHaveLength(1);
  });

  it('refuses a second provider with the same name', async () => {
    expect(await code(oidc.save(provider))).toBe('exists');
  });

  it('removes the people’s connections with the provider, and its secret', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    await visit(admin.id);
    await oidc.remove('authentik');
    expect(await db.select().from(userIdentities).all()).toEqual([]);
    expect(await secrets.has('oidc-authentik')).toBe(false);
  });

  it('sends the client secret the way the provider says it takes it', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    await visit(admin.id);
    expect(idp.requests.find((r) => r.url.endsWith('/token'))!.headers.get('authorization')).toMatch(/^Basic /);

    idp.metadata = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
    await oidc.save({ ...provider, id: 'authentik' });
    idp.requests = [];
    await visit(admin.id);
    const token = idp.requests.find((r) => r.url.endsWith('/token'))!;
    expect(token.body.get('client_secret')).toBe('the-secret');
    expect(token.headers.get('authorization')).toBeNull();
  });
});

describe('Disconnecting', () => {
  it('won’t remove the only way in to an account', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    const user = await signedIn();
    const [identity] = (await oidc.identities(user.id)).connected;
    expect(await code(oidc.removeIdentity(user.id, identity!.id))).toBe('last_sign_in');

    await accounts.changePassword(user.id, '', 'a-new-password', null);
    expect((await accounts.get(user.id)).hasPassword).toBe(true);
    expect(await code(oidc.removeIdentity(user.id, identity!.id))).toBe('ok');
    expect((await oidc.identities(user.id)).connected).toEqual([]);
  });

  it('touches only the person’s own connections', async () => {
    const admin = (await db.select().from(users).all())[0]!;
    await visit(admin.id);
    const [identity] = (await oidc.identities(admin.id)).connected;
    const { user: bob } = await accounts.create({ username: 'bob', name: 'Bob', role: 'user' });
    await oidc.removeIdentity(bob.id, identity!.id);
    expect((await oidc.identities(admin.id)).connected).toHaveLength(1);
  });
});

describe('An account without a password', () => {
  it('can’t be signed in to with an empty or any other password', async () => {
    await oidc.save({ ...provider, id: 'authentik', newAccounts: 'user' });
    await signedIn();
    expect(await code(accounts.login({ username: 'ada2', password: '' }, web))).toBe('invalid_credentials');
    expect(await code(accounts.login({ username: 'ada2', password: 'anything' }, web))).toBe('invalid_credentials');
  });
});
