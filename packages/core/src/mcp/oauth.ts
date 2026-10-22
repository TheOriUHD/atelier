/**
 * OAuth sign-in for HTTP connectors (ARCHITECTURE §9-B), on the SDK's `auth()`: discovery (RFC 9728, RFC 8414), PKCE,
 * the RFC 8707 resource indicator and the RFC 9207 `iss` check. An admin signs a connector in once; its client
 * registration and tokens are kept as one secret, `mcp-oauth:<name>`, which every session's connection uses and
 * refreshes. Nothing of it reaches the UI or the logs.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  auth,
  IssuerMismatchError,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { APP } from '@atelier/protocol';
import type { SecretStore } from '../secrets/secret-store.ts';

/** Where sign-ins return: on the web server's public origin, or on the desktop's loopback listener. */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
/** The web server's client ID metadata document. */
export const CLIENT_METADATA_PATH = '/oauth/client-metadata.json';

export type OAuthSecrets = Pick<SecretStore, 'get' | 'set' | 'delete'>;

/** What a signed-in connector keeps. `expiresAt` is when the access token runs out (ms), when the server said. */
export interface Credentials {
  redirectUrl: string;
  client: StoredOAuthClientInformation;
  tokens: StoredOAuthTokens;
  expiresAt?: number;
}

/** The secret holding a connector's sign-in; `:` keeps it apart from every id people or the Connectors page choose. */
export const oauthSecretId = (server: string) => `mcp-oauth:${server}`;

export async function loadCredentials(secrets: OAuthSecrets, server: string): Promise<Credentials | undefined> {
  const text = await secrets.get(oauthSecretId(server));
  return text ? (JSON.parse(text) as Credentials) : undefined;
}

export async function saveCredentials(secrets: OAuthSecrets, server: string, credentials: Credentials): Promise<void> {
  await secrets.set({ id: oauthSecretId(server), label: `Sign-in for ${server}`, kind: 'mcp_oauth', value: JSON.stringify(credentials) });
}

/** What Atelier registers as, or publishes as its client ID metadata document: a public client (PKCE, no secret). */
export function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return { client_name: APP.name, redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}

const expiry = (tokens: StoredOAuthTokens) => (tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000);
const fetchOption = (fetchFn: FetchLike | undefined) => (fetchFn ? { fetchFn } : {});

/**
 * A signed-in connector's credentials, for its connection. An expired access token is refreshed before the next
 * request (once for all requests waiting on it), and one the server refuses is refreshed by the transport. When the
 * authorization server refuses the refresh, or there is nothing to refresh with, the credentials are forgotten: only
 * an admin signing in again starts a new authorization.
 */
export class StoredSignIn implements OAuthClientProvider {
  /** The credentials were forgotten: the connector needs signing in. */
  signedOut = false;
  /** The connection is gone: a refresh still finishing must not save the credentials again. */
  closed = false;
  private refreshing: Promise<unknown> | null = null;

  constructor(
    private readonly secrets: OAuthSecrets,
    private readonly server: string,
    private readonly serverUrl: URL,
    private credentials: Credentials,
    private readonly fetchFn: FetchLike | undefined,
  ) {}

  /** What to mask wherever the connector's output, errors or logs go. */
  get values(): string[] {
    const { client, tokens } = this.credentials;
    return [tokens.access_token, tokens.refresh_token, client.client_secret].filter((v): v is string => !!v);
  }

  get redirectUrl(): string {
    return this.credentials.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.credentials.redirectUrl);
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.signedOut ? undefined : this.credentials.client;
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    // `auth()` reads with a context; the transport reads without one, before each request.
    const { expiresAt } = this.credentials;
    if (!ctx && !this.signedOut && expiresAt !== undefined && Date.now() >= expiresAt) {
      this.refreshing ??= auth(this, { serverUrl: this.serverUrl, ...fetchOption(this.fetchFn) }).finally(() => (this.refreshing = null));
      await this.refreshing;
    }
    return this.signedOut ? undefined : this.credentials.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    if (this.signedOut || this.closed) return;
    this.credentials = { ...this.credentials, tokens, expiresAt: expiry(tokens) };
    await saveCredentials(this.secrets, this.server, this.credentials);
  }

  /** A refresh that failed on the way (the network, the server's own error) is tried again with the next connection. */
  async redirectToAuthorization(): Promise<void> {
    if (!this.credentials.tokens.refresh_token) await this.forget();
  }

  saveCodeVerifier(): void {}

  codeVerifier(): string {
    throw new Error('Only an admin’s sign-in starts an authorization.');
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope !== 'verifier' && scope !== 'discovery') await this.forget();
  }

  /** Unless the connection is gone: a newer one may hold a newer sign-in. */
  private async forget(): Promise<void> {
    if (this.closed) return;
    this.signedOut = true;
    await this.secrets.delete(oauthSecretId(this.server));
  }
}

/**
 * One admin's sign-in, from the authorization page to the tokens. What it needs between the two legs (the PKCE
 * verifier, the discovery, the client it registered) stays in memory; `id` is its random, single-use `state`.
 */
export class PendingSignIn implements OAuthClientProvider {
  readonly id = randomBytes(32).toString('base64url');
  private url: URL | undefined;
  private verifier = '';
  private discovery: OAuthDiscoveryState | undefined;
  private client: StoredOAuthClientInformation | undefined;
  private received: StoredOAuthTokens | undefined;

  constructor(
    private readonly serverUrl: URL,
    readonly redirectUrl: string,
    /** Web servers on https: where they serve the client ID metadata document. */
    private readonly metadataUrl: string | undefined,
    private readonly fetchFn: FetchLike | undefined,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.redirectUrl);
  }

  /**
   * A client ID metadata document only for authorization servers that let no client register: they fetch it from
   * this server, which most self-hosted servers, reachable on a private network only, can't serve them.
   */
  get clientMetadataUrl(): string | undefined {
    return this.discovery?.authorizationServerMetadata?.registration_endpoint ? undefined : this.metadataUrl;
  }

  state(): string {
    return this.id;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.client = client;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.received;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.received = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.url = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  /** Discovers the authorization server, registers with it and returns the page to send the person to. */
  async start(): Promise<URL> {
    await auth(this, { serverUrl: this.serverUrl, ...fetchOption(this.fetchFn) });
    const url = this.url;
    if (!url) throw new Error('The server didn’t ask to sign in.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error(`The sign-in page must use https, but it is ${url.origin}.`);
    return url;
  }

  /** Exchanges the code from the callback for tokens; the credentials to keep. */
  async finish(params: URLSearchParams): Promise<Credentials> {
    const code = params.get('code');
    // The callback's own error text could come from anyone: it is never shown.
    if (!code) throw new Error('The sign-in was refused or didn’t finish.');
    try {
      await auth(this, { serverUrl: this.serverUrl, authorizationCode: code, iss: params.get('iss') ?? undefined, ...fetchOption(this.fetchFn) });
    } catch (error) {
      if (error instanceof IssuerMismatchError) throw new Error('The sign-in came back from another authorization server than the one it started at.', { cause: error });
      throw error;
    }
    return { redirectUrl: this.redirectUrl, client: this.client!, tokens: this.received!, expiresAt: expiry(this.received!) };
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Desktop: a listener on 127.0.0.1, on a port of its own, for one sign-in's return. It answers `/oauth/callback`
 * with the page `finish` decides on; the sign-in closes it when it ends.
 */
export async function loopbackCallback(finish: (params: URLSearchParams) => Promise<string | null>): Promise<{ redirectUrl: string; close(): void }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== OAUTH_CALLBACK_PATH) return void res.writeHead(404).end();
    // `Connection: close`, so the listener the sign-in closed meanwhile keeps no connection open either.
    void finish(url.searchParams).then((error) => res.writeHead(error ? 400 : 200, { ...CALLBACK_HEADERS, Connection: 'close' }).end(callbackPage(error)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { redirectUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}${OAUTH_CALLBACK_PATH}`, close: () => void server.close() };
}

/** The callback page is never cached, and its address (with the code) never goes on as a referrer. */
export const CALLBACK_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** What the browser tab shows after the authorization server sent it back: `error`, or that it can be closed. */
export function callbackPage(error: string | null): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const [title, text] = error ? ['Sign-in didn’t finish', error] : ['Signed in', `You can close this tab and go back to ${APP.name}.`];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${title} · ${APP.name}</title><body style="font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem"><h1 style="font-size: 20px">${title}</h1><p>${escape(text)}</p></body></html>`;
}
