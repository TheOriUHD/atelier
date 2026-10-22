/**
 * The mock server behind OAuth over Streamable HTTP, with a minimal authorization server on the same origin:
 * metadata (RFC 9728, RFC 8414), dynamic client registration, an authorize endpoint that approves at once, and a
 * token endpoint that checks PKCE and the resource indicator and rotates refresh tokens. The origin comes from each
 * request's Host header (or its URL), so it works on whatever port it is served.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createMcpHandler, OAuthError, OAuthErrorCode, oauthMetadataResponse, requireBearerAuth } from '@modelcontextprotocol/server';
import { mockServer, type MockState } from './mock-server.ts';

export interface OAuthMockOptions {
  /** How long access tokens last. */
  tokenSeconds?: number;
  /** Accept client ID metadata documents (any https URL as `client_id`) and offer no registration endpoint. */
  cimd?: boolean;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
}

const random = (prefix: string) => `${prefix}-${randomBytes(12).toString('base64url')}`;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function oauthMock(state: MockState, { tokenSeconds = 3600, cimd = false }: OAuthMockOptions = {}) {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, Grant>();
  const access = new Map<string, { clientId: string; expiresAt: number }>();
  const refresh = new Map<string, string>();
  const grants: string[] = [];
  const handler = createMcpHandler(() => mockServer(state));

  const issue = (clientId: string) => {
    const tokens = { access_token: random('fake-access'), token_type: 'Bearer', expires_in: tokenSeconds, refresh_token: random('fake-refresh') };
    access.set(tokens.access_token, { clientId, expiresAt: Math.floor(Date.now() / 1000) + tokenSeconds });
    refresh.set(tokens.refresh_token, clientId);
    return json(tokens);
  };

  const token = async (form: URLSearchParams) => {
    const clientId = form.get('client_id') ?? '';
    grants.push(form.get('grant_type') ?? '');
    if (form.get('grant_type') === 'authorization_code') {
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      const valid = grant && grant.clientId === clientId && grant.redirectUri === form.get('redirect_uri') && grant.challenge === verifier && grant.resource === form.get('resource');
      return valid ? issue(clientId) : json({ error: 'invalid_grant' }, 400);
    }
    if (form.get('grant_type') === 'refresh_token') {
      const owner = refresh.get(form.get('refresh_token') ?? '');
      refresh.delete(form.get('refresh_token') ?? '');
      return owner === clientId ? issue(clientId) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  };

  const authorize = (url: URL, origin: string) => {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const known = cimd ? clientId.startsWith('https://') : clients.get(clientId)?.includes(redirectUri);
    if (!known || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || q.get('resource') !== `${origin}/mcp`) {
      return json({ error: 'invalid_request' }, 400);
    }
    const code = random('fake-code');
    codes.set(code, { clientId, redirectUri, challenge: q.get('code_challenge') ?? '', resource: q.get('resource')! });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    back.searchParams.set('iss', origin);
    return new Response(null, { status: 302, headers: { location: back.href } });
  };

  return {
    /** The grant types asked for at the token endpoint, in order. */
    grants,
    /** Clients registered so far. */
    clients,
    /** Makes every access token unknown, as when a server revokes them. */
    revokeAccess: () => access.clear(),
    /** Makes every refresh token unknown too: only signing in again helps. */
    revokeAll: () => (access.clear(), refresh.clear()),
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = `http://${request.headers.get('host') ?? url.host}`;
      const metadata = {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(cimd ? { client_id_metadata_document_supported: true } : { registration_endpoint: `${origin}/register` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      };
      const resourceServerUrl = new URL(`${origin}/mcp`);
      const discovery = oauthMetadataResponse(request, { oauthMetadata: metadata, resourceServerUrl, dangerouslyAllowInsecureIssuerUrl: true });
      if (discovery) return discovery;
      if (url.pathname === '/register' && request.method === 'POST' && !cimd) {
        const body = (await request.json()) as { redirect_uris: string[] };
        const clientId = random('fake-client');
        clients.set(clientId, body.redirect_uris);
        return json({ ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
      }
      if (url.pathname === '/authorize') return authorize(url, origin);
      if (url.pathname === '/token' && request.method === 'POST') return token(new URLSearchParams(await request.text()));
      if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
      const gate = requireBearerAuth({
        resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
        verifier: {
          verifyAccessToken: async (value) => {
            const known = access.get(value);
            if (!known) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown token');
            return { token: value, clientId: known.clientId, scopes: [], expiresAt: known.expiresAt };
          },
        },
      });
      const auth = await gate(request);
      return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
    },
  };
}
