import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { APP, contract, createMemoryTransportPair, createRpcClient, type AppContract, type RpcClient, type RpcMessage } from '@atelier/protocol';
import { createBackend, type Backend } from '../backend/backend.ts';
import { localHostName, shareAddresses } from './share-server.ts';

const PASSWORD = 'correct horse';
const quiet = { info: () => {}, error: () => {} };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { data?: { code?: string } }) => e.data?.code ?? String(e));

const cleanup: (() => Promise<unknown>)[] = [];
// Each test starts and stops a whole backend, which takes seconds when the full suite runs alongside.
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
}, 60_000);

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** The desktop app's own backend with a stand-in web app build. */
async function desktop(home: string): Promise<Backend> {
  const ui = join(home, 'ui');
  await mkdir(join(ui, 'artifact-runtime'), { recursive: true });
  await mkdir(join(ui, 'assets'), { recursive: true });
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Atelier</title>');
  await writeFile(join(ui, 'artifact-runtime', 'index.html'), '<!doctype html><title>runtime</title>');
  await writeFile(join(ui, 'inline-visual.html'), '<!doctype html><title>inline</title>');
  await writeFile(join(ui, 'assets', 'app.js'), 'export {};');
  await writeFile(join(home, 'secret.txt'), 'not for the network');
  const backend = await createBackend({
    surface: 'desktop',
    configDir: home,
    dataDir: join(home, 'data'),
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: {},
    logger: quiet,
    fetch: async () => Promise.reject(new Error('offline')),
    share: { uiDir: ui },
  });
  return backend;
}

/** This computer's own window, as the desktop app connects it. */
function window(backend: Backend): RpcClient<AppContract> {
  const [clientSide, serverSide] = createMemoryTransportPair();
  backend.connect(serverSide, { client: { clientKind: 'desktop', userAgent: 'test' } });
  return createRpcClient(contract, clientSide);
}

/** An HTTP request with headers fetch won't send (Host, Origin). */
function http(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function login(port: number, password = PASSWORD) {
  const res = await http(port, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password }) });
  const token = new RegExp(`${APP.cookie}=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''))?.[1];
  return { status: res.status, token };
}

/** A device on the network: the socket with a browser's cookie (or nothing), and the events it got. */
async function device(port: number, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
  });
  cleanup.push(async () => socket.close());
  const handlers = new Set<(m: RpcMessage) => void>();
  socket.on('message', (data) => handlers.forEach((h) => h(JSON.parse(String(data)) as RpcMessage)));
  const rpc = createRpcClient(contract, { send: (m) => socket.send(JSON.stringify(m)), onMessage: (h) => (handlers.add(h), () => handlers.delete(h)) });
  const events: string[] = [];
  rpc.on('auth.signedOut', () => events.push('auth.signedOut'));
  rpc.on('lock.changed', () => events.push('lock.changed'));
  return { rpc, events };
}

describe('sharing this computer on the network', { timeout: 90_000 }, () => {
  it('signs devices in with the password and keeps what only this computer may do to this computer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-share-'));
    const backend = await desktop(home);
    cleanup.push(() => rm(home, { recursive: true, force: true }), () => backend.dispose());
    const own = window(backend);
    const { token: ownToken } = await own.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    expect(await own.call('app.info', {})).toMatchObject({ networkShare: true });
    expect(await own.call('network.status', {})).toMatchObject({ enabled: false, listening: false, username: 'ada', passwordSet: false, signedIn: 0 });

    // A password comes first; then it answers on the port.
    const port = await freePort();
    expect(await code(own.call('network.set', { enabled: true, port }))).toBe('invalid_input');
    const on = await own.call('network.set', { enabled: true, port, password: PASSWORD });
    expect(on).toMatchObject({ enabled: true, listening: true, error: null, passwordSet: true, port });
    expect(on.addresses.at(-1)).toMatch(new RegExp(`^http://.+:${port}$`));

    expect(JSON.parse((await http(port, '/api/health')).body)).toMatchObject({ ok: true, app: 'atelier', version: APP.version });
    const page = await http(port, '/sessions/abc');
    expect(page.body).toContain('<title>Atelier</title>');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await http(port, '/assets/app.js')).headers['content-type']).toContain('text/javascript');
    expect((await http(port, '/artifact-runtime/x')).headers['content-security-policy']).toContain('sandbox allow-scripts');
    // Nothing outside the web app's folder.
    expect((await http(port, '/%2e%2e/secret.txt')).body).not.toContain('not for the network');
    expect((await http(port, '/..%2fsecret.txt')).body).not.toContain('not for the network');
    // A page that pointed its own domain at this computer is refused.
    expect((await http(port, '/api/health', { headers: { host: `evil.example.com:${port}` } })).status).toBe(421);
    expect((await http(port, '/api/health', { headers: { host: `studio.local:${port}` } })).status).toBe(200);

    // Sign-in: the password; another site's form can't.
    expect((await login(port, 'wrong password')).status).toBe(400);
    expect((await http(port, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' }, body: JSON.stringify({ username: 'ada', password: PASSWORD }) })).status).toBe(403);
    const { status, token } = await login(port);
    expect(status).toBe(200);
    expect(token).toBeTruthy();

    const browser = await device(port, { cookie: `${APP.cookie}=${token}`, origin: `http://127.0.0.1:${port}` });
    expect(await browser.rpc.call('auth.status', {})).toMatchObject({ local: false, user: { username: 'ada' } });
    expect(await browser.rpc.call('app.info', {})).toMatchObject({ sharedComputer: true });
    expect((await browser.rpc.call('app.info', {})).networkShare).toBeUndefined();
    expect(Array.isArray(await browser.rpc.call('sessions.list', {}))).toBe(true);
    for (const refused of [
      browser.rpc.call('network.status', {}),
      browser.rpc.call('network.set', { enabled: false }),
      browser.rpc.call('auth.localSignIn', { clientKind: 'desktop' }),
      browser.rpc.call('invites.create', { role: 'user' }),
      browser.rpc.call('workspaces.addLocal', { path: home }),
      browser.rpc.call('lock.set', { lock: { kind: 'pin', secret: '2468' } }),
    ]) {
      expect(await code(refused)).toBe('forbidden');
    }
    expect(await own.call('network.status', {})).toMatchObject({ signedIn: 1 });

    // No way in without the password: not the no-password sign-in, not this computer's own token, not another site's page.
    const stranger = await device(port);
    expect(await stranger.rpc.call('auth.status', {})).toMatchObject({ user: null, local: false });
    expect(await code(stranger.rpc.call('auth.localSignIn', { clientKind: 'desktop' }))).toBe('forbidden');
    expect(await code(stranger.rpc.call('sessions.list', {}))).toBe('unauthenticated');
    const borrowed = await device(port, { authorization: `Bearer ${ownToken}` });
    expect(await borrowed.rpc.call('auth.status', {})).toMatchObject({ user: null });
    await expect(device(port, { cookie: `${APP.cookie}=${token}`, origin: 'http://evil.example.com' })).rejects.toThrow('refused: 403');
    const blob = await http(port, `/api/blobs/${'0'.repeat(64)}`, { headers: { authorization: `Bearer ${ownToken}` } });
    expect(blob.status).toBe(401);

    // The screen lock is this computer's: locked, its windows wait and the network goes on.
    await own.call('lock.set', { lock: { kind: 'pin', secret: '2468' } });
    await own.call('lock.lock', {});
    expect(await code(own.call('sessions.list', {}))).toBe('locked');
    expect(Array.isArray(await browser.rpc.call('sessions.list', {}))).toBe(true);
    expect(browser.events).not.toContain('lock.changed');
    await own.call('lock.unlock', { secret: '2468' });

    // "Sign everyone out" ends the sign-in for good; turning it off closes the port.
    expect(await own.call('network.signOutAll', {})).toMatchObject({ signedIn: 0, listening: true });
    await expect.poll(() => browser.events).toContain('auth.signedOut');
    expect(await code(browser.rpc.call('sessions.list', {}))).toBe('unauthenticated');
    expect((await device(port, { cookie: `${APP.cookie}=${token}` }).then((d) => d.rpc.call('auth.status', {}))).user).toBeNull();
    expect(await own.call('network.set', { enabled: false })).toMatchObject({ enabled: false, listening: false });
    await expect(http(port, '/api/health')).rejects.toThrow();
  });

  it('starts sharing again with the app, and a new password signs every device out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-share-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const port = await freePort();
    let backend = await desktop(home);
    const own = window(backend);
    await own.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    await own.call('network.set', { enabled: true, port, password: PASSWORD });
    await backend.dispose();

    backend = await desktop(home);
    cleanup.push(() => backend.dispose());
    expect((await http(port, '/api/health')).status).toBe(200);
    const { token } = await login(port);
    const browser = await device(port, { cookie: `${APP.cookie}=${token}` });
    expect((await browser.rpc.call('auth.status', {})).user).toMatchObject({ username: 'ada' });

    const again = window(backend);
    await again.call('auth.localSignIn', { clientKind: 'desktop' });
    await again.call('network.set', { enabled: true, password: 'a new password' });
    await expect.poll(() => browser.events).toContain('auth.signedOut');
    expect((await login(port)).status).toBe(400);
    expect((await login(port, 'a new password')).status).toBe(200);
    // Its own windows stay signed in.
    expect(Array.isArray(await again.call('sessions.list', {}))).toBe(true);
  });

  it('says when the port is taken', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-share-'));
    const backend = await desktop(home);
    cleanup.push(() => rm(home, { recursive: true, force: true }), () => backend.dispose());
    const own = window(backend);
    await own.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    cleanup.push(() => new Promise((resolve) => taken.close(resolve)));
    const { port } = taken.address() as { port: number };
    const status = await own.call('network.set', { enabled: true, port, password: PASSWORD });
    expect(status).toMatchObject({ enabled: true, listening: false, error: `Port ${port} is in use by another program on this computer. Choose another port.` });
  });

  it('isn’t offered on a server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-share-'));
    const server = await createBackend({ surface: 'web', configDir: home, dataDir: home, cipher: { encrypt: async (s) => s, decrypt: async (s) => s }, env: {}, logger: quiet, setupToken: 't' });
    cleanup.push(() => rm(home, { recursive: true, force: true }), () => server.dispose());
    const [clientSide, serverSide] = createMemoryTransportPair();
    server.connect(serverSide, { client: { clientKind: 'web', ip: '10.0.0.2' } });
    const c = createRpcClient(contract, clientSide);
    await c.call('auth.setup', { username: 'admin', name: 'Admin', password: PASSWORD, setupToken: 't', clientKind: 'web' });
    expect((await c.call('app.info', {})).networkShare).toBeUndefined();
    expect(await code(c.call('network.status', {}))).toBe('unsupported');
  });
});

describe('the names a shared computer answers to', () => {
  it('takes addresses, single-label names and the local network’s suffixes, not other domains', () => {
    for (const ok of ['192.168.1.20:7340', '[fe80::1]:7340', 'localhost:7340', 'studio:7340', 'studio.local', 'nas.lan', 'box.home.arpa', 'pc.tailnet-1.ts.net']) {
      expect(localHostName(ok), ok).toBe(true);
    }
    for (const no of [undefined, '', 'evil.example.com', 'attacker.com:7340', '192.168.1.20.nip.io']) expect(localHostName(no), String(no)).toBe(false);
  });

  it('lists the local network’s addresses first, then others, then the computer’s name', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.1.20', family: 'IPv4', internal: false },
      ],
      bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
    } as never;
    const addresses = shareAddresses(7340, interfaces, 'studio');
    expect(addresses.slice(0, 2)).toEqual(['http://192.168.1.20:7340', 'http://100.101.102.103:7340']);
    expect(addresses[2]).toMatch(/^http:\/\/studio(\.local)?:7340$/);
    expect(addresses).toHaveLength(3);
  });
});
