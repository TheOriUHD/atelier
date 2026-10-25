import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { sendWhenIdle, tempConfigDir } from './fixtures.ts';
import { connectDesktop, SERVER_URL, signedInClient, startMcpMock, startServer, stopServer } from './server-mode.ts';

/** The MCP mock server the core tests use, over stdio. */
const MOCK_SERVER = fileURLToPath(new URL('../packages/core/src/mcp/__fixtures__/stdio-server.ts', import.meta.url));

test("desktop signed in to a server: a person's own connector runs on it, and its home folder's config applies", async () => {
  test.setTimeout(180_000);
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  // The desktop's home folder: the person's own instructions and a skill there.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'atelier-desktop-home-')));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'CLAUDE.md'), 'Always mention plum-42 when asked.\n');
  await mkdir(join(home, '.agents', 'skills', 'desk-notes'), { recursive: true });
  await writeFile(join(home, '.agents', 'skills', 'desk-notes', 'SKILL.md'), '---\nname: desk-notes\ndescription: Notes kept on the desktop.\n---\nWrite them down.\n');
  const work = await realpath(await mkdtemp(join(tmpdir(), 'atelier-desktop-work-')));
  execFileSync('git', ['init', '-q', work]);
  const server = await startServer(dataDir);
  let app: ElectronApplication | undefined;
  try {
    // The connector's `${E2E_MOCK_TOKEN}` comes from the desktop's environment, which the server never has.
    app = await launchDesktop(configDir, { HOME: home, E2E_MOCK_TOKEN: 'desktop-only-token' });
    const page = await app.firstWindow();
    await connectDesktop(page);

    const rpc = await signedInClient('admin', PASSWORD);
    const { id: deviceId } = JSON.parse(await readFile(join(configDir, 'chromium', 'device.json'), 'utf8')) as { id: string };
    await expect.poll(async () => (await rpc.call('account.devices', {})).find((d) => d.id === deviceId)?.services).toEqual(expect.arrayContaining(['mcp', 'home']));
    const deviceName = (await rpc.call('account.devices', {})).find((d) => d.id === deviceId)!.name;

    // Customize › Connectors › Your connectors: added on this desktop, its program runs here.
    await page.evaluate(() => (location.hash = '#/customize?tab=connectors'));
    const yours = page.locator('section', { has: page.getByRole('heading', { name: 'Your connectors' }) });
    await yours.getByRole('button', { name: 'Add your own' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add your connector' });
    await dialog.getByLabel('Name').fill('mock');
    await dialog.getByRole('radio', { name: 'stdio' }).click();
    await dialog.getByLabel('Command').fill(process.execPath);
    await dialog.getByLabel('Arguments').fill(MOCK_SERVER);
    await dialog.getByRole('button', { name: 'Add variable' }).click();
    await dialog.getByRole('textbox', { name: 'Variable 1 name' }).fill('MOCK_TOKEN');
    await dialog.getByRole('textbox', { name: 'Variable 1 value' }).fill('${E2E_MOCK_TOKEN}');
    await dialog.getByRole('button', { name: 'Add connector' }).click();
    await expect(dialog).toBeHidden();
    await expect(yours.getByText(`Ready on ${deviceName}`)).toBeVisible({ timeout: 30_000 });
    // Allowed on this computer by exactly what it runs.
    const lending = JSON.parse(await readFile(join(configDir, 'chromium', 'lending.json'), 'utf8')) as Record<string, { connectors: { name: string }[] }>;
    expect(lending[SERVER_URL]?.connectors).toEqual([expect.objectContaining({ name: 'mock' })]);

    // A chat uses its tool; the program got the desktop's own value for the variable.
    await rpc.call('prefs.set', { path: ['permissions', 'allow'], value: ['mcp__mock__whoami'] });
    const chat = await rpc.call('sessions.create', { mode: 'chat' });
    await rpc.call('chat.send', { sessionId: chat.id, parts: [{ type: 'text', text: 'call mcp__mock__whoami {}' }] });
    await expect.poll(async () => JSON.stringify((await rpc.call('sessions.subscribe', { id: chat.id })).messages), { timeout: 30_000 }).toContain('Tool result: token: desktop-only-token');

    // A Code session in a folder on the desktop gets the person's ~/.claude/CLAUDE.md from there, and lists its skills.
    await writeFile(join(configDir, 'chromium', 'trusted-folders.json'), JSON.stringify([work]));
    await rpc.call('devices.register', { id: deviceId, name: deviceName, platform: process.platform });
    expect((await rpc.call('skills.list', {})).find((s) => s.name === 'desk-notes')).toMatchObject({ device: deviceName });
    const folder = await rpc.call('workspaces.addLocal', { path: work });
    const session = await rpc.call('sessions.create', { mode: 'code', workspaceId: folder.id });
    await rpc.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: 'system has plum-42?' }] });
    await expect.poll(async () => JSON.stringify((await rpc.call('sessions.subscribe', { id: session.id })).messages), { timeout: 30_000 }).toContain('System has plum-42: yes.');
  } finally {
    await app?.close();
    await stopServer(server);
    const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    for (const dir of [configDir, dataDir, home, work]) await rm(dir, retry);
  }
});

test('desktop signed in to a server: the assistant adds an MCP server on this computer that the person gave it', async () => {
  test.setTimeout(180_000);
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  // An MCP server on this computer that asks for no credentials, like Fusion 360's.
  const mock = await startMcpMock({ MOCK_OPEN: '1' });
  const server = await startServer(dataDir);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(configDir);
    const page = await app.firstWindow();
    await connectDesktop(page);
    const rpc = await signedInClient('admin', PASSWORD);
    const { id: deviceId } = JSON.parse(await readFile(join(configDir, 'chromium', 'device.json'), 'utf8')) as { id: string };
    await expect.poll(async () => (await rpc.call('account.devices', {})).find((d) => d.id === deviceId)?.services).toEqual(expect.arrayContaining(['http']));

    // Given the address in a chat, the model adds it; the person agrees in this window, which allows it on this computer.
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill(`call AddConnector ${JSON.stringify({ name: 'fusion', url: mock.url })}`);
    await sendWhenIdle(page);
    const card = page.getByRole('region', { name: 'Add fusion to your connectors?' });
    await expect(card).toContainText('reached through this computer');
    await card.getByRole('button', { name: 'Add connector' }).click();
    await expect(page.getByText('Tool result: Added fusion to their own connectors')).toBeVisible({ timeout: 30_000 });
    const lending = JSON.parse(await readFile(join(configDir, 'chromium', 'lending.json'), 'utf8')) as Record<string, { http: { baseUrl: string }[] }>;
    expect(lending[SERVER_URL]?.http).toEqual([expect.objectContaining({ baseUrl: new URL(mock.url).origin })]);

    // Its tools work in the same conversation, reached through this desktop.
    await rpc.call('prefs.set', { path: ['permissions', 'allow'], value: ['mcp__fusion__echo'] });
    await box.fill('call mcp__fusion__echo {"text":"from this computer"}');
    await sendWhenIdle(page);
    await expect(page.getByText('Tool result: from this computer')).toBeVisible({ timeout: 30_000 });
  } finally {
    await app?.close();
    await stopServer(server);
    mock.process.kill();
    const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    for (const dir of [configDir, dataDir]) await rm(dir, retry);
  }
});
