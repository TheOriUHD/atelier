import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { FAKE_OLLAMA_PORT, tempConfigDir } from './fixtures.ts';
import { SERVER_URL, signedInClient, startServer, stopServer } from './server-mode.ts';

/** The desktop's own Ollama: another scripted one, on a port of its own. */
const OWN_PORT = FAKE_OLLAMA_PORT + 1;

test('desktop: a model server on the desktop serves its owner on the server, through the desktop, while it is connected', async () => {
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  const own = spawn(process.execPath, ['e2e/fake-ollama.mjs', String(OWN_PORT)], { stdio: 'inherit' });
  const server = await startServer(dataDir);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(configDir);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Connect to a server' }).click();
    await page.getByRole('textbox', { name: 'Server URL' }).fill(SERVER_URL);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    // Settings › Your models, on this desktop: its Ollama, added by its address. The desktop lends the address first.
    await page.evaluate(() => (location.hash = '#/?settings=personal-models'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Add model server' }).click();
    const adding = page.getByRole('dialog', { name: 'Add model server' });
    await adding.getByRole('textbox', { name: 'Name' }).fill('Laptop Ollama');
    await adding.getByRole('textbox', { name: 'Address' }).fill(`http://127.0.0.1:${OWN_PORT}`);
    await adding.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(settings.getByText('Laptop Ollama')).toBeVisible();
    await expect(settings.getByText(/4 models/)).toBeVisible();

    const admin = await signedInClient('admin', PASSWORD);
    const [mine] = await admin.call('personalProviders.list', {});
    expect(mine).toMatchObject({ name: 'Laptop Ollama', type: 'ollama', online: true });
    const lending = JSON.parse(await readFile(join(configDir, 'chromium', 'lending.json'), 'utf8')) as Record<string, { http: unknown[] }>;
    expect(lending[SERVER_URL]?.http).toEqual([{ id: mine!.id, baseUrl: `http://127.0.0.1:${OWN_PORT}` }]);
    const ref = `${mine!.id}/fake-chat:8b`;
    expect((await admin.call('models.list', {})).find((m) => m.ref === ref)).toMatchObject({ personal: { deviceName: mine!.deviceName }, available: true });

    // Only its owner sees it.
    const { temporaryPassword } = await admin.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
    const bob = await signedInClient('bob', temporaryPassword);
    await bob.call('account.changePassword', { current: temporaryPassword, next: 'bob-new-password' });
    expect((await bob.call('models.list', {})).some((m) => m.personal)).toBe(false);
    expect(await bob.call('personalProviders.list', {})).toEqual([]);

    // The model menu has it under this computer's name; a chat on it answers through the desktop.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'fake-chat:8b' }).click();
    await expect(page.getByRole('menu').getByText(mine!.deviceName, { exact: true })).toBeVisible();
    // The shared Fake Ollama's models come first, then the desktop's.
    await page.getByRole('menuitemradio', { name: /^fake-chat:8b/ }).nth(1).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('hello from my laptop');
    await box.press('Enter');
    await expect(page.getByText('You said: hello from my laptop')).toBeVisible();
    const sessions = await admin.call('sessions.list', {});
    expect(sessions[0]?.model).toBe(ref);

    // The desktop goes away: its models stay listed but can't answer, though the server could reach the address itself.
    await app.close();
    app = undefined;
    await expect.poll(async () => (await admin.call('models.list', {})).find((m) => m.ref === ref)?.available).toBe(false);
    const later = await admin.call('sessions.create', { mode: 'chat', model: ref });
    await admin.call('chat.send', { sessionId: later.id, parts: [{ type: 'text', text: 'are you there' }] });
    await expect
      .poll(async () => JSON.stringify((await admin.call('sessions.subscribe', { id: later.id })).messages))
      .toContain(`Laptop Ollama runs on ${mine!.deviceName}, which isn't connected.`);
  } finally {
    await app?.close();
    await stopServer(server);
    own.kill();
    const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    await rm(configDir, retry);
    await rm(dataDir, retry);
  }
});
