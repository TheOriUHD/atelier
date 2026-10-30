import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { chromium, expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { FAKE_OIDC_PORT, tempConfigDir } from './fixtures.ts';
import { PORT, SERVER_URL, SETUP_TOKEN, waitForHealth } from './server-mode.ts';

const OIDC = `http://127.0.0.1:${FAKE_OIDC_PORT}`;

test('desktop: shows connected sign-ins and sends you to the browser to connect one', async () => {
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  const server = spawn(process.execPath, ['apps/server/dist/server.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, ATELIER_DATA_DIR: dataDir, ATELIER_PORT: String(PORT), ATELIER_SETUP_TOKEN: SETUP_TOKEN },
  });
  const chrome = await chromium.launch();
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
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    // An admin adds the provider in the app.
    await page.evaluate(() => (location.hash = '#/?settings=server'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Add provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add an identity provider' });
    await dialog.getByLabel('Name').fill('Test IdP');
    await dialog.getByLabel('Issuer').fill(`${OIDC}/application/o/atelier/`);
    await dialog.getByLabel('Client ID').fill('atelier-e2e');
    await dialog.getByRole('button', { name: 'Add provider' }).click();
    await expect(dialog).toBeHidden();

    // The system browser is a page here; the app can't connect by itself, so it says where.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url) => void opened.push(url);
    });
    await settings.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(settings.getByRole('heading', { name: 'Connected sign-ins' })).toBeVisible();
    await settings.getByRole('button', { name: 'Open in browser' }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([`${SERVER_URL}/#/?settings=account&row=account.identities`]);

    // In the browser you sign in with your password, land on the section and connect.
    await fetch(`${OIDC}/person`, { method: 'POST', body: JSON.stringify({ sub: 'the-admin', preferred_username: 'admin', name: 'Tester', email: 'admin@example.com' }) });
    const browser = await chrome.newPage();
    await browser.goto(`${SERVER_URL}/#/?settings=account&row=account.identities`);
    await browser.getByLabel('Username', { exact: true }).fill('admin');
    await browser.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await browser.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browser.getByRole('button', { name: 'Connect Test IdP' }).click();
    await expect(browser.getByRole('cell', { name: 'admin@example.com' })).toBeVisible();

    // Back in the app it shows, and can be disconnected there.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(settings.getByRole('cell', { name: 'admin@example.com' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Open in browser' })).toBeHidden();
    await settings.getByRole('button', { name: 'Disconnect Test IdP' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect(settings.getByRole('button', { name: 'Open in browser' })).toBeVisible();
  } finally {
    await chrome.close();
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
