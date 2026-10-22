import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '@atelier/core';
import { APP, contract, createMemoryTransportPair, createRpcClient, type AppContract, type McpServerStatus, type RpcClient } from '@atelier/protocol';
import { oauthRoutes } from './oauth.ts';

// The core tests' MCP mock behind its own OAuth authorization server, which approves every sign-in at once.
const MOCK = fileURLToPath(new URL('../../../packages/core/src/mcp/__fixtures__/http-server.ts', import.meta.url));
const ORIGIN = 'http://atelier.test';

let mock: ChildProcess;
let mcpUrl: string;
let dir: string;
let backend: Backend;
let app: Hono;
let admin: RpcClient<AppContract>;
let adminToken: string;

beforeAll(async () => {
  mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_OAUTH: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  mcpUrl = await new Promise<string>((resolve) => createInterface({ input: mock.stdout! }).once('line', resolve));
});
afterAll(() => void mock.kill());

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-oauth-'));
  backend = await createBackend({ surface: 'web', configDir: dir, dataDir: dir, cipher: { encrypt: async (s) => s, decrypt: async (s) => s }, env: {}, logger: { info: () => {}, error: () => {} } });
  app = new Hono();
  oauthRoutes(app, backend, { cookie: APP.cookie, originOf: () => ORIGIN });
  admin = connect();
  adminToken = (await admin.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' })).token;
  await admin.call('settings.set', { layer: 'global', path: ['mcpServers', 'mock'], value: { type: 'http', url: mcpUrl, auth: 'oauth' } });
});

afterEach(async () => {
  await backend.dispose();
  await rm(dir, { recursive: true, force: true });
});

function connect(): RpcClient<AppContract> {
  const [clientSide, serverSide] = createMemoryTransportPair();
  backend.connect(serverSide, { client: { clientKind: 'web' }, origin: ORIGIN });
  return createRpcClient(contract, clientSide);
}

/** Starts a sign-in and follows the authorization page back: the callback's path and query. */
async function authorized(): Promise<string> {
  const { url } = await admin.call('mcp.signIn', { name: 'mock' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
  expect(back.origin + back.pathname).toBe(`${ORIGIN}/oauth/callback`);
  return back.pathname + back.search;
}

const callback = (path: string, token?: string) => app.request(path, token ? { headers: { cookie: `${APP.cookie}=${token}` } } : {});

async function status(): Promise<McpServerStatus> {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const mock = (await admin.call('mcp.status', {}))[0]!;
    if (mock.state !== 'connecting') return mock;
  }
  throw new Error('still connecting');
}

describe('/oauth/callback', () => {
  it('finishes a sign-in once, for the admin who started it in this browser', async () => {
    expect(await status()).toMatchObject({ state: 'error', signIn: 'needed' });

    // Without the admin's cookie, or with someone else's, the sign-in doesn't finish (and can't be retried).
    expect((await callback(await authorized())).status).toBe(400);
    const { temporaryPassword } = await admin.call('users.create', { username: 'bob', name: 'Bob', role: 'admin' });
    const bob = await connect().call('auth.login', { username: 'bob', password: temporaryPassword, clientKind: 'web' });
    const refused = await callback(await authorized(), bob.token);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('where you started it');

    const path = await authorized();
    const done = await callback(path, adminToken);
    expect(done.status).toBe(200);
    expect(done.headers.get('cache-control')).toBe('no-store');
    expect(done.headers.get('referrer-policy')).toBe('no-referrer');
    const page = await done.text();
    expect(page).toContain('You can close this tab');
    expect(page).not.toContain(new URLSearchParams(path.split('?')[1]).get('code'));
    expect(await status()).toMatchObject({ state: 'ready', tools: expect.arrayContaining([expect.objectContaining({ name: 'echo' })]) });

    const again = await callback(path, adminToken);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('expired or was used already');
    expect((await callback('/oauth/callback?code=x&state=made-up', adminToken)).status).toBe(400);
  });

  it('forgets the sign-in when the connector is removed, and keeps it out of Keys & secrets', async () => {
    expect((await callback(await authorized(), adminToken)).status).toBe(200);
    expect(await status()).toMatchObject({ state: 'ready' });
    expect(await admin.call('secrets.list', {})).toEqual([]);

    await admin.call('settings.reset', { layer: 'global', path: ['mcpServers', 'mock'] });
    await admin.call('settings.set', { layer: 'global', path: ['mcpServers', 'mock'], value: { type: 'http', url: mcpUrl, auth: 'oauth' } });
    expect(await status()).toMatchObject({ state: 'error', signIn: 'needed' });
  });

  it('serves the client ID metadata document for this origin', async () => {
    expect(await (await app.request('/oauth/client-metadata.json')).json()).toEqual({
      client_id: `${ORIGIN}/oauth/client-metadata.json`,
      client_name: APP.name,
      redirect_uris: [`${ORIGIN}/oauth/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });
});
