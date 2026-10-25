/** Helpers for desktop tests against their own Atelier server (server mode, the device link). */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, type Page } from '@playwright/test';
import { APP, contract, createRpcClient, type RpcMessage } from '../packages/protocol/src/index.ts';
import { PASSWORD } from './desktop-app.ts';
import { WEB_PORT } from './fixtures.ts';

// Its own server, so the admin created here doesn't touch the web project's server.
export const PORT = WEB_PORT + 1;
export const SERVER_URL = `http://127.0.0.1:${PORT}`;
export const SETUP_TOKEN = 'desktop-e2e-setup-token';

/** Stands in for ssh on the desktop: skips options, takes the host, and runs the rest as a shell command here, with HOME at FAKE_SSH_HOME. */
export const FAKE_SSH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += ['-o', '-p', '-i'].includes(args[i]) ? 2 : 1;
i++;
const child = spawn('/bin/sh', ['-c', args.slice(i).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SSH_HOME } });
child.on('close', (code) => process.exit(code ?? 1));
`;

export async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${SERVER_URL}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no server at ${SERVER_URL}`);
}

/** An RPC connection to the test server signed in as `username`, the way the desktop's relay connects. */
export async function signedInClient(username: string, password: string) {
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


/** Starts the server on a data dir of its own and creates its admin (`admin`, the e2e password). */
export async function startServer(dataDir: string, env: Record<string, string> = {}): Promise<ChildProcess> {
  const server = spawn(process.execPath, ['apps/server/dist/server.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, ATELIER_DATA_DIR: dataDir, ATELIER_PORT: String(PORT), ATELIER_SETUP_TOKEN: SETUP_TOKEN, ...env },
  });
  await waitForHealth();
  const setup = await fetch(`${SERVER_URL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, username: 'admin', name: 'Tester', password: PASSWORD }),
  });
  if (setup.status !== 200) throw new Error(`setup failed: ${setup.status}`);
  return server;
}

/** Connects the desktop window to the test server and signs in as its admin. */
export async function connectDesktop(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect to a server' }).click();
  await page.getByRole('textbox', { name: 'Server URL' }).fill(SERVER_URL);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

/** Core's mock MCP server over Streamable HTTP on this computer, with `env` (MOCK_OPEN, MOCK_TOKEN); its URL once it listens. */
export async function startMcpMock(env: Record<string, string>): Promise<{ url: string; process: ChildProcess }> {
  const mock = spawn(process.execPath, ['packages/core/src/mcp/__fixtures__/http-server.ts'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    createInterface({ input: mock.stdout! }).once('line', resolve);
    mock.once('exit', (code) => reject(new Error(`The mock MCP server exited (${code}).`)));
  });
  return { url, process: mock };
}

/** Stops the server and waits for it: Windows won't delete a database file something still has open. */
export async function stopServer(server: ChildProcess): Promise<void> {
  const gone = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await gone;
}
