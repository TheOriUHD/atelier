import { expect, test } from '@playwright/test';
import { contract, createRpcClient, type RpcMessage } from '../packages/protocol/src/index.ts';
import { WEB_PORT } from './fixtures.ts';

/** A terminal's connection: no cookie, a bearer-less WebSocket, the terminal app's user agent. */
async function terminal() {
  const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const socket = new NodeWebSocket(`ws://127.0.0.1:${WEB_PORT}/api/ws`, { headers: { 'User-Agent': 'Atelier CLI/test (e2e)' } });
  await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
  const handlers = new Set<(m: RpcMessage) => void>();
  socket.onmessage = (e: MessageEvent) => handlers.forEach((h) => h(JSON.parse(e.data as string) as RpcMessage));
  const rpc = createRpcClient(contract, { send: (m) => socket.send(JSON.stringify(m)), onMessage: (h) => (handlers.add(h), () => handlers.delete(h)) });
  return { rpc, close: () => socket.close() };
}

test('a terminal signs in when someone signed in approves its code on #/link', async ({ page }) => {
  const t = await terminal();
  try {
    const start = await t.rpc.call('auth.terminalStart', { deviceName: 'e2e-box · terminal', platform: 'Linux' });
    expect(start.verifyUrlComplete).toContain(`/#/link?code=${start.code}`);
    expect(await t.rpc.call('auth.terminalPoll', { pollToken: start.pollToken })).toEqual({ state: 'pending' });

    await page.goto(`/#/link?code=${start.code}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in Atelier CLI on e2e-box · terminal?' })).toBeVisible();
    await expect(page.getByText('Only approve a terminal you just started yourself')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { name: 'Your terminal is signed in' })).toBeVisible();

    const done = await t.rpc.call('auth.terminalPoll', { pollToken: start.pollToken });
    expect(done).toMatchObject({ state: 'approved', user: { username: 'tester' } });
    // The poll signed this connection in too, and the sign-in is a terminal's.
    const sessions = await t.rpc.call('account.sessions', {});
    expect(sessions.find((s) => s.current)?.clientKind).toBe('cli');
    // Settings › Account lists it as the terminal app.
    await page.goto('/#/?settings=account');
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Atelier CLI').first()).toBeVisible();
  } finally {
    t.close();
  }
});

test('a denied code signs nothing in', async ({ page }) => {
  const t = await terminal();
  try {
    const start = await t.rpc.call('auth.terminalStart', { deviceName: 'someone else’s box', platform: 'Linux' });
    await page.goto('/#/link');
    await page.getByPlaceholder('K7QF-3MZD').fill(start.code.toLowerCase());
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByRole('heading', { name: 'Sign-in denied' })).toBeVisible();
    expect(await t.rpc.call('auth.terminalPoll', { pollToken: start.pollToken })).toEqual({ state: 'denied' });
  } finally {
    t.close();
  }
});
