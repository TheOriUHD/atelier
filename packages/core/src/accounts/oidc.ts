/**
 * Signing in with an identity provider such as Authentik or Keycloak (OpenID Connect, ARCHITECTURE §21), in browsers
 * only: authorization code with PKCE, state and nonce. Accounts are found by issuer and subject and never by email
 * address or username, so someone who gets a matching name at the provider doesn't get the account: an existing account
 * joins a provider from Settings › Account, signed in. A flow lives in memory for a few minutes and is used once.
 */
import * as oidc from 'openid-client';
import { and, count, eq, ne } from 'drizzle-orm';
import { oidcProviderId, type IdentitySummary, type OidcProviderInput, type OidcProviderSummary, type OidcSignInOption, type UserSummary } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { oidcProviders, passkeys, userIdentities, users } from '../store/schema.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import { newId } from '../util/ids.ts';
import { AccountError, usernameFrom, type AccountService, type ClientInfo } from './account-service.ts';
import { newToken } from './passwords.ts';

const FLOW_TTL_MS = 10 * 60_000;
/** Starting a sign-in needs no account, so open flows are capped; the oldest give way. */
const MAX_OPEN_FLOWS = 1000;
const DISCOVERY_TTL_MS = 3600_000;
const SCOPE = 'openid profile email';
const DISCOVERY_SUFFIX = /\/\.well-known\/openid-configuration\/?$/;

type ProviderRow = typeof oidcProviders.$inferSelect;

interface Flow {
  providerId: string;
  redirectUri: string;
  verifier: string;
  state: string;
  nonce: string;
  /** Connecting a provider to this signed-in account; null when signing in. */
  userId: string | null;
  expires: number;
}

export interface OidcDeps {
  db: Db;
  accounts: AccountService;
  secrets: SecretStore;
  /** What admins read in the server's log: people only see that it failed. */
  log(message: string, reason: string): void;
  /** The HTTP client for the provider's endpoints; tests pass a fake. */
  fetch?: oidc.CustomFetch;
}

/** What a browser came back with: signed in, or a provider connected to the account that asked. */
export type OidcResult = { signedIn: { token: string; user: UserSummary } } | { connected: true };

const secretId = (id: string) => `oidc-${id}`;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export class Oidc {
  private flows = new Map<string, Flow>();
  private discovered = new Map<string, { key: string; config: oidc.Configuration; at: number }>();

  constructor(private readonly deps: OidcDeps) {}

  async options(): Promise<OidcSignInOption[]> {
    return this.deps.db.select({ id: oidcProviders.id, name: oidcProviders.name }).from(oidcProviders).orderBy(oidcProviders.name).all();
  }

  async list(): Promise<OidcProviderSummary[]> {
    const rows = await this.deps.db.select().from(oidcProviders).orderBy(oidcProviders.name).all();
    return Promise.all(rows.map((r) => this.summary(r)));
  }

  /** Reads the provider's configuration before saving, so a typing mistake shows here and not on the sign-in page. */
  async save(input: OidcProviderInput): Promise<OidcProviderSummary> {
    const { db, secrets } = this.deps;
    const id = input.id ?? oidcProviderId(input.name);
    const existing = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get();
    if (input.id && !existing) throw new AccountError('not_found', 'No such provider.');
    if (!input.id && existing) throw new AccountError('exists', `There already is a provider called ${existing.name}.`);
    const secret = input.clientSecret === undefined ? await secrets.get(secretId(id)) : input.clientSecret;
    const config = await this.discover(input.issuer, input.clientId, secret).catch((e: unknown) => {
      throw new AccountError('oidc_failed', `Couldn’t read the provider’s configuration at ${input.issuer}: ${reason(e)}`);
    });
    const issuer = config.serverMetadata().issuer;
    const row = { name: input.name, issuer, clientId: input.clientId, newAccounts: input.newAccounts };
    await db
      .insert(oidcProviders)
      .values({ id, ...row, createdAt: Date.now() })
      .onConflictDoUpdate({ target: oidcProviders.id, set: row });
    if (input.clientSecret) await secrets.set({ id: secretId(id), label: `${input.name} client secret`, kind: 'oidc', value: input.clientSecret });
    else if (input.clientSecret === '') await secrets.delete(secretId(id));
    this.discovered.delete(id);
    return this.summary(await this.provider(id));
  }

  /** Those who sign in only with it can't sign in any more; an admin can give them a password. */
  async remove(id: string): Promise<void> {
    await this.deps.db.delete(oidcProviders).where(eq(oidcProviders.id, id));
    await this.deps.secrets.delete(secretId(id));
    this.discovered.delete(id);
  }

  /** Starts a sign-in (or, with `userId`, connects the provider to that account). The browser keeps `flowId` in a cookie. */
  async begin(id: string, redirectUri: string, userId: string | null): Promise<{ flowId: string; url: string }> {
    const provider = await this.provider(id);
    const config = await this.configFor(provider).catch((e: unknown) => {
      this.deps.log(`Identity provider ${id} unavailable`, reason(e));
      throw new AccountError('oidc_failed', `${provider.name} isn’t answering. Try again, or ask an admin.`);
    });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const flowId = newToken();
    this.remember(flowId, { providerId: id, redirectUri, verifier, state, nonce, userId, expires: Date.now() + FLOW_TTL_MS });
    return { flowId, url: url.href };
  }

  /**
   * Finishes a flow when the browser comes back with the provider's answer (`search`). `flowId` is its cookie, so an
   * answer can't be finished in a browser that didn't start the flow; `userId` is who that browser is signed in as now.
   */
  async finish(id: string, flowId: string, search: string, userId: string | null, client: ClientInfo): Promise<OidcResult> {
    const flow = this.flows.get(flowId);
    this.flows.delete(flowId);
    if (!flow || flow.expires < Date.now() || flow.providerId !== id || (flow.userId && flow.userId !== userId)) {
      throw new AccountError('expired', 'That sign-in expired. Try again.');
    }
    const provider = await this.provider(id);
    const { claims, issuer } = await this.exchange(provider, flow, search);
    const { db, accounts } = this.deps;
    const subject = claims.sub;
    const found = await db.select().from(userIdentities).where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject))).get();
    const now = Date.now();

    if (flow.userId) {
      if (found && found.userId !== flow.userId) throw new AccountError('identity_taken', 'That sign-in is already connected to another account.');
      if (!found) await this.connect(provider.id, flow.userId, issuer, claims);
      return { connected: true };
    }
    if (found) {
      await db.update(userIdentities).set({ lastUsedAt: now }).where(eq(userIdentities.id, found.id));
      return { signedIn: await accounts.signInAs(found.userId, client) };
    }
    if (provider.newAccounts === 'none') throw new AccountError('no_account', 'There’s no account for this sign-in here.');
    const user = await accounts.createForIdentity({
      username: usernameFrom(text(claims.preferred_username) || text(claims.email).split('@')[0] || text(claims.name) || 'user'),
      name: text(claims.name) || text(claims.preferred_username) || 'New member',
      role: provider.newAccounts,
    });
    await this.connect(provider.id, user.id, issuer, claims);
    return { signedIn: await accounts.signInAs(user.id, client) };
  }

  async identities(userId: string): Promise<{ connected: IdentitySummary[]; available: OidcSignInOption[] }> {
    const { db } = this.deps;
    const connected = await db
      .select({
        id: userIdentities.id,
        providerId: userIdentities.providerId,
        provider: oidcProviders.name,
        label: userIdentities.label,
        createdAt: userIdentities.createdAt,
        lastUsedAt: userIdentities.lastUsedAt,
      })
      .from(userIdentities)
      .innerJoin(oidcProviders, eq(oidcProviders.id, userIdentities.providerId))
      .where(eq(userIdentities.userId, userId))
      .orderBy(oidcProviders.name)
      .all();
    const taken = new Set(connected.map((c) => c.providerId));
    return { connected, available: (await this.options()).filter((p) => !taken.has(p.id)) };
  }

  /** Refused when it is the account's only way in. */
  async removeIdentity(userId: string, id: string): Promise<void> {
    const { db } = this.deps;
    const others = await db.select({ n: count() }).from(userIdentities).where(and(eq(userIdentities.userId, userId), ne(userIdentities.id, id))).get();
    const keys = await db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId)).get();
    const account = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
    if (!others?.n && !keys?.n && !account?.hash) throw new AccountError('last_sign_in', 'This is how you sign in. Set a password or add a passkey first.');
    await db.delete(userIdentities).where(and(eq(userIdentities.userId, userId), eq(userIdentities.id, id)));
  }

  // ------------------------------------------------------------------ internals

  private async summary(r: ProviderRow): Promise<OidcProviderSummary> {
    const { db, secrets } = this.deps;
    const people = await db.select({ n: count() }).from(userIdentities).where(eq(userIdentities.providerId, r.id)).get();
    const stored = await secrets.tail(secretId(r.id));
    return { id: r.id, name: r.name, issuer: r.issuer, clientId: r.clientId, secret: stored === undefined ? null : `••••${stored}`, newAccounts: r.newAccounts, people: people?.n ?? 0 };
  }

  private async provider(id: string): Promise<ProviderRow> {
    const row = await this.deps.db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get();
    if (!row) throw new AccountError('not_found', 'That sign-in isn’t set up on this server any more.');
    return row;
  }

  private async configFor(provider: ProviderRow): Promise<oidc.Configuration> {
    const secret = await this.deps.secrets.get(secretId(provider.id));
    const key = JSON.stringify([provider.issuer, provider.clientId, secret]);
    const cached = this.discovered.get(provider.id);
    if (cached?.key === key && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.config;
    const config = await this.discover(provider.issuer, provider.clientId, secret);
    this.discovered.set(provider.id, { key, config, at: Date.now() });
    return config;
  }

  /**
   * Issuers must match to the character, and providers differ on the trailing slash (Authentik's has one, Google's
   * doesn't), so the other spelling is tried too; so is a pasted address of the configuration document itself.
   */
  private async discover(issuer: string, clientId: string, secret: string | undefined): Promise<oidc.Configuration> {
    const entered = issuer.trim().replace(DISCOVERY_SUFFIX, '');
    const other = entered.endsWith('/') ? entered.slice(0, -1) : `${entered}/`;
    let failure: unknown;
    for (const candidate of [entered, other]) {
      const url = new URL(candidate);
      try {
        return await oidc.discovery(url, clientId, undefined, clientAuth(secret), {
          ...(this.deps.fetch ? { [oidc.customFetch]: this.deps.fetch } : {}),
          // A provider on the local network often has no certificate. It's the admin's own choice of address.
          ...(url.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : {}),
        });
      } catch (e) {
        failure ??= e;
      }
    }
    throw failure;
  }

  private async exchange(provider: ProviderRow, flow: Flow, search: string): Promise<{ claims: oidc.IDToken & Record<string, unknown>; issuer: string }> {
    try {
      const config = await this.configFor(provider);
      // Rebuilt from the address the flow began with: this is what the provider compares with the one it was given.
      const answer = new URL(flow.redirectUri);
      answer.search = search;
      const tokens = await oidc.authorizationCodeGrant(config, answer, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims) throw new Error('the provider sent no ID token');
      // Many providers put the name and email address only here. Sign-in doesn't depend on it: the ID token says who it is.
      const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub).catch(() => ({}));
      return { claims: { ...info, ...claims }, issuer: config.serverMetadata().issuer };
    } catch (e) {
      this.deps.log(`Sign-in with identity provider ${provider.id} failed`, reason(e));
      if (e instanceof oidc.AuthorizationResponseError && e.error === 'access_denied') throw new AccountError('denied', `${provider.name} didn’t allow this sign-in.`);
      throw new AccountError('oidc_failed', `The sign-in with ${provider.name} didn’t work. The server’s log says why.`);
    }
  }

  private async connect(providerId: string, userId: string, issuer: string, claims: oidc.IDToken & Record<string, unknown>): Promise<void> {
    const now = Date.now();
    await this.deps.db.insert(userIdentities).values({
      id: newId(),
      userId,
      providerId,
      issuer,
      subject: claims.sub,
      label: text(claims.email) || text(claims.preferred_username) || text(claims.name) || claims.sub,
      createdAt: now,
      lastUsedAt: now,
    });
  }

  private remember(flowId: string, flow: Flow): void {
    const now = Date.now();
    for (const [id, f] of this.flows) if (f.expires < now) this.flows.delete(id);
    if (this.flows.size >= MAX_OPEN_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    this.flows.set(flowId, flow);
  }
}

/** HTTP Basic is what OpenID Connect assumes when a provider doesn't say, so it is preferred; some accept only the form. */
function clientAuth(secret: string | undefined): oidc.ClientAuth {
  if (!secret) return oidc.None();
  return (as, client, body, headers) => {
    const methods = as.token_endpoint_auth_methods_supported;
    const auth = !methods || methods.includes('client_secret_basic') ? oidc.ClientSecretBasic(secret) : oidc.ClientSecretPost(secret);
    return auth(as, client, body, headers);
  };
}

/** Why a request to the provider failed, for admins: the library's error and the cause under it ("connect ECONNREFUSED"). */
function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}
