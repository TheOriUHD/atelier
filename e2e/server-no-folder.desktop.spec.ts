import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { sendWhenIdle, tempConfigDir } from './fixtures.ts';
import { connectDesktop, PORT, signedInClient, startServer, stopServer, waitForHealth } from './server-mode.ts';

/** With a server, Code still works with no folder: on this computer, which the server asks once to make folders on. */
test('desktop on a server: Code offers No folder, asks once, works, and still does after the server restarts', async () => {
  test.setTimeout(180_000);
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  let server = await startServer(dataDir);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(configDir);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await connectDesktop(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    const chip = () => page.getByRole('main').getByRole('button', { name: /^(No folder|Select folder…)$/ });
    await chip().click();
    await page.getByRole('menuitemradio', { name: 'No folder' }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello with no folder');
    await sendWhenIdle(page);
    // Lending folders to the server is asked once, on this computer.
    await expect(page.getByText('Make folders on this computer?')).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('You said: hello with no folder')).toBeVisible({ timeout: 30_000 });

    // The server restarts (an update): this computer's link comes back by itself, and No folder with it.
    await stopServer(server);
    server = spawn(process.execPath, ['apps/server/dist/server.mjs'], { stdio: 'inherit', env: { ...process.env, ATELIER_DATA_DIR: dataDir, ATELIER_PORT: String(PORT) } });
    await waitForHealth();
    await expect
      .poll(async () => (await (await signedInClient('admin', PASSWORD)).call('account.devices', {})).some((d) => d.online && d.services?.includes('scratch')), { timeout: 60_000 })
      .toBe(true);
    await page.getByRole('link', { name: 'New', exact: true }).or(page.getByRole('button', { name: 'New', exact: true })).first().click();
    await page.getByRole('radio', { name: 'Code' }).click();
    await chip().click();
    await expect(page.getByRole('menuitemradio', { name: 'No folder' })).toBeVisible();
  } finally {
    await app?.close();
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
