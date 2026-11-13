import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir } from './fixtures.ts';
import { connectDesktop, startServer, stopServer } from './server-mode.ts';

/** What reached the pretend computer (e2e/fake-computer.mjs), in order. */
const helperLog = async (log: string): Promise<{ method: string; [key: string]: unknown }[]> =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string });

/** Signed in to a server, the desktop lends it computer use: the server's sessions see and use this computer's apps. */
test('desktop on a server: computer use reaches this computer, and its apps are allowed on its own card', async () => {
  test.setTimeout(180_000);
  // The full tier: the fake model counts as compact, which leaves out the app list tools.
  const dataDir = await tempConfigDir({ models: { overrides: { 'fake/fake-chat:8b': { promptTier: 'full' } } } });
  const configDir = await tempConfigDir();
  const log = join(configDir, 'computer.log');
  const server = await startServer(dataDir);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(configDir, { ATELIER_COMPUTER_HELPER: resolve('e2e/fake-computer.mjs'), FAKE_COMPUTER_LOG: log });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await connectDesktop(page);

    // Turned on on this computer, as without a server.
    await page.evaluate(() => (location.hash = '#/?settings=system'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const enable = settings.getByRole('switch', { name: 'Enable computer use' });
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');
    await settings.getByRole('button', { name: 'Close' }).click();

    // A Code session with no folder: the server's session, this computer's apps.
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('main').getByRole('button', { name: /^(No folder|Select folder…)$/ }).click();
    await page.getByRole('menuitemradio', { name: 'No folder' }).click();
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill([call('ComputerAccess', { apps: ['TextEdit'], reason: 'Write the notes into a document.' }), call('Screenshot', { app: 'TextEdit' })].join('\n'));
    await sendWhenIdle(page);
    await expect(page.getByText('Make folders on this computer?')).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();

    // The server can't allow apps here: the card on this computer does, even for an app the person named.
    const access = page.getByRole('region', { name: 'Let Atelier use TextEdit?' });
    await expect(access).toContainText('Write the notes into a document.', { timeout: 30_000 });
    await access.getByRole('button', { name: 'Allow for this session' }).click();

    // The screenshot came from this computer's helper, through the server.
    await expect(page.getByRole('button', { name: 'Screenshot image 1 of 1' })).toBeVisible({ timeout: 30_000 });
    expect((await helperLog(log)).find((e) => e.method === 'window.capture')).toMatchObject({ app: 'com.apple.TextEdit' });
  } finally {
    await app?.close();
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
