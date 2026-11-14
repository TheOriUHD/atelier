import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { contentHashInput, leadingZeroBits, powInput } from '../packages/protocol/src/reports.ts';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { FAKE_OLLAMA_PORT, tempConfigDir } from './fixtures.ts';

interface Received {
  headers: IncomingMessage['headers'];
  parts: { name: string; type: string; bytes: Buffer }[];
  proofOk: boolean;
}

/** The collector as the app sees it: a challenge, then a multipart report whose proof of work it checks. */
async function fakeCollector(): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const send = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/v1/challenge') return send(200, { challenge: 'e2e.8.x.y', bits: 8, expiresAt: Date.now() + 600_000 });
    if (req.url !== '/v1/reports') return send(404, { error: 'Not found.' });
    const form = await new Request('http://collector/v1/reports', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body }).formData();
    const parts = await Promise.all([...form.entries()].map(async ([name, value]) => ({ name, type: (value as Blob).type, bytes: Buffer.from(await (value as Blob).arrayBuffer()) })));
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    const contentHash = sha(contentHashInput(parts.map((p) => ({ name: p.name, sha256: sha(p.bytes) }))));
    const proof = createHash('sha256').update(powInput(String(req.headers['x-atelier-challenge']), contentHash, String(req.headers['x-atelier-nonce']))).digest();
    received.push({ headers: req.headers, parts, proofOk: leadingZeroBits(proof) >= 8 });
    send(201, { id: 'I-7F3K2Q', receivedAt: Date.now() });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, server };
}

const KEY = 'sekrit-e2e-key-1234567890';

test('desktop: the report shortcut attaches the window, and the report carries diagnostics and the chat without keys', async () => {
  test.setTimeout(180_000);
  const collector = await fakeCollector();
  const configDir = await tempConfigDir({
    providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${FAKE_OLLAMA_PORT}`, headers: { 'X-Api-Key': KEY } }],
  });
  const app = await launchDesktop(configDir, { ATELIER_REPORTS_URL: collector.url });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);

    // A conversation to attach, with a key in it.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(`what is a shader? my key is sk-proj-${'a'.repeat(30)}`);
    await box.press('Enter');
    await expect(page.getByText(/You said: what is a shader/)).toBeVisible({ timeout: 30_000 });

    // Help › Report an Issue… is on F1; the menu sends the window the command (sent here directly: a hidden window is never
    // the focused one the menu sends to).
    const help = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()?.items.find((i) => i.role === 'help' || i.label === 'Help');
      return menu?.submenu?.items.map((i) => ({ label: i.label, accelerator: i.accelerator ?? null })) ?? [];
    });
    expect(help).toContainEqual({ label: 'Report an Issue…', accelerator: 'F1' });
    expect(help.map((i) => i.label)).toContain('Request a Feature…');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu', 'report-issue'));

    const dialog = page.getByRole('dialog', { name: 'Report an issue' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'Screenshot of Atelier' })).toBeVisible({ timeout: 15_000 });

    // Padding isn't a report.
    await dialog.getByLabel('Title').fill('Bad');
    await dialog.getByLabel('What happened?').fill('Chat doesnt work. AAAAAAAAAAAAAAAA');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByText('Leave out the repeated characters.')).toBeVisible();
    expect(collector.received).toHaveLength(0);

    await dialog.getByLabel('Title').fill('Shader answer is too short');
    await dialog.getByLabel('What happened?').fill('I asked about shaders and the reply only repeated my question back to me.');
    // Diagnostics are on for an issue; the open conversation is offered first.
    await expect(dialog.getByRole('switch', { name: 'Diagnostics' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('switch', { name: 'A conversation' }).click();
    await expect(dialog.getByText(/All \d+ messages/)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Show' }).first().click();
    await expect(dialog.getByText(/"hardware"/).first()).toBeVisible({ timeout: 30_000 });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('report-id')).toHaveText('I-7F3K2Q', { timeout: 60_000 });

    const [got] = collector.received;
    expect(got!.proofOk).toBe(true);
    expect(got!.headers['user-agent']).toMatch(/^Atelier\//);
    expect(got!.parts.map((p) => p.name)).toEqual(['report', 'chat', 'shot0']);
    const report = JSON.parse(got!.parts[0]!.bytes.toString('utf8'));
    const chat = JSON.parse(got!.parts[1]!.bytes.toString('utf8'));
    expect(report).toMatchObject({ v: 1, kind: 'issue', title: 'Shader answer is too short', app: { surface: 'desktop', mode: 'desktop-local' }, attachments: { chat: true, screenshots: [{ name: 'shot0', mime: 'image/webp' }] } });
    expect(report.diagnostics.backend.kind).toBe('desktop');
    expect(report.diagnostics.client.hardware.displays.length).toBeGreaterThan(0);
    expect(report.diagnostics.providers[0]).toMatchObject({ type: 'ollama', host: expect.stringMatching(/^localhost:/), keySet: true });
    expect(report.diagnostics.inference[0]).toMatchObject({ kind: 'ollama', version: '0.0.0-fake' });
    expect(chat.messages[0].parts[0].text).toContain('what is a shader?');
    expect(got!.parts[2]!.type).toBe('image/webp');
    // No key anywhere, in the diagnostics or the conversation.
    const everything = got!.parts.slice(0, 2).map((p) => p.bytes.toString('utf8')).join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('sk-proj-aaaa');

    // Done; a feature request from the sidebar starts without diagnostics.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Request a feature' }).click();
    const feature = page.getByRole('dialog', { name: 'Request a feature' });
    await expect(feature.getByRole('switch', { name: 'Diagnostics' })).toHaveAttribute('aria-checked', 'false');
    await expect(feature.getByRole('img')).toHaveCount(0);
  } finally {
    await app.close();
    collector.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
