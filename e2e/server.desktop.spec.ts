import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { APP, contract, createRpcClient, type RpcMessage } from '../packages/protocol/src/index.ts';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { tempConfigDir, WEB_PORT } from './fixtures.ts';

// Its own server, so the admin created here doesn't touch the web project's server.
const PORT = WEB_PORT + 1;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const SETUP_TOKEN = 'desktop-e2e-setup-token';

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${SERVER_URL}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no server at ${SERVER_URL}`);
}

/** An RPC connection to the test server signed in as `username`, the way the desktop's relay connects. */
async function signedInClient(username: string, password: string) {
  const login = await fetch(`${SERVER_URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const token = new RegExp(`${APP.cookie}=([^;]+)`).exec(login.headers.get('set-cookie') ?? '')?.[1];
  if (!token) throw new Error(`login failed: ${login.status}`);
  const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const socket = new NodeWebSocket(`${SERVER_URL.replace('http', 'ws')}/api/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
  const handlers = new Set<(m: RpcMessage) => void>();
  socket.onmessage = (e: MessageEvent) => handlers.forEach((h) => h(JSON.parse(e.data as string) as RpcMessage));
  return createRpcClient(contract, { send: (m) => socket.send(JSON.stringify(m)), onMessage: (h) => (handlers.add(h), () => handlers.delete(h)) });
}

test('desktop: connects to an Atelier server, signs in, chats through the relay and lends its runner', async () => {
  // The server's data dir gets the same settings as the other tests: the scripted fake Ollama.
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  const server = spawn(process.execPath, ['apps/server/dist/server.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, ATELIER_DATA_DIR: dataDir, ATELIER_PORT: String(PORT), ATELIER_SETUP_TOKEN: SETUP_TOKEN },
  });
  let app: ElectronApplication | undefined;
  try {
    await waitForHealth();
    const setup = await fetch(`${SERVER_URL}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: SETUP_TOKEN, username: 'admin', name: 'Tester', password: PASSWORD }),
    });
    expect(setup.status).toBe(200);

    app = await launchDesktop(configDir);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Connect to a server' }).click();
    await page.getByRole('textbox', { name: 'Server URL' }).fill(SERVER_URL);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('hello from the desktop');
    await box.press('Enter');
    await expect(page.getByText('You said: hello from the desktop')).toBeVisible();

    // Relaunched, the app reconnects to the server with the stored token: no sign-in screen.
    await app.close();
    app = await launchDesktop(configDir);
    await expect((await app.firstWindow()).getByRole('textbox', { name: 'Message' })).toBeVisible();

    // The device link: the server runs a workspace in a folder trusted on this desktop, through its runner.
    // (The folder picker writes trusted-folders.json; the test writes it directly.)
    const work = await realpath(await mkdtemp(join(tmpdir(), 'atelier-device-work-')));
    execFileSync('git', ['init', '-q', work]);
    await writeFile(join(work, 'notes.md'), 'from the desktop\n');
    await writeFile(join(configDir, 'chromium', 'trusted-folders.json'), JSON.stringify([work]));
    const { id: deviceId } = JSON.parse(await readFile(join(configDir, 'chromium', 'device.json'), 'utf8')) as { id: string };
    const rpc = await signedInClient('admin', PASSWORD);
    // Adding a folder needs a connection from that device, as the desktop UI's own requests are.
    await rpc.call('devices.register', { id: deviceId, name: 'E2E', platform: 'macOS' });
    await expect.poll(async () => (await rpc.call('account.devices', {})).find((d) => d.id === deviceId)?.online).toBe(true);
    const ws = await rpc.call('workspaces.addLocal', { path: work });
    expect(ws).toMatchObject({ root: work, deviceId, available: true });
    expect((await rpc.call('workspaces.files', { workspaceId: ws.id, dir: '' })).map((e) => e.name)).toEqual(['notes.md']);
    expect(await rpc.call('workspaces.readFile', { workspaceId: ws.id, path: 'notes.md' })).toMatchObject({ content: 'from the desktop\n' });
    await expect(rpc.call('workspaces.addLocal', { path: await realpath(tmpdir()) })).rejects.toThrow(/isn't a folder you opened/);
    await rm(work, { recursive: true, force: true });

    // Log out revokes this app's sign-in and goes back to the first-run choice; an address without a scheme finds the
    // server over plain http once https doesn't answer.
    const signedIn = (await rpc.call('account.sessions', {})).length;
    const page2 = await app.firstWindow();
    await page2.evaluate(() => (location.hash = '#/?settings=account'));
    await page2.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page2.getByRole('heading', { name: 'Welcome to Atelier' })).toBeVisible();
    await expect.poll(async () => (await rpc.call('account.sessions', {})).length).toBe(signedIn - 1);
    await page2.getByRole('button', { name: 'Connect to a server' }).click();
    await page2.getByRole('textbox', { name: 'Server URL' }).fill(`127.0.0.1:${PORT}`);
    await page2.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page2.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(JSON.parse(await readFile(join(configDir, 'chromium', 'connection.json'), 'utf8'))).toEqual({ mode: 'server', serverUrl: SERVER_URL });
  } finally {
    await app?.close();
    // Wait for the server to be gone: Windows won't delete a database file something still has open.
    const gone = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await gone;
    const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    await rm(configDir, retry);
    await rm(dataDir, retry);
  }
});
