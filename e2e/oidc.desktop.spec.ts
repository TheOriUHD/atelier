import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { FAKE_OIDC_PORT, tempConfigDir } from './fixtures.ts';
import { PORT, SERVER_URL, SETUP_TOKEN, waitForHealth } from './server-mode.ts';

const OIDC = `http://127.0.0.1:${FAKE_OIDC_PORT}`;
const signInAs = (person: Record<string, unknown>) => fetch(`${OIDC}/person`, { method: 'POST', body: JSON.stringify(person) });

test('desktop: connects an identity provider from Settings, in a window of its own', async () => {
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

    // Someone who hasn't signed in at the provider yet gets its page in a window, and can walk away from it.
    await settings.getByRole('button', { name: 'Account', exact: true }).click();
    await signInAs({ hold: true });
    const opening = app.waitForEvent('window');
    await settings.getByRole('button', { name: 'Connect Test IdP' }).click();
    const provider = await opening;
    await expect(provider.getByText('Sign in to continue')).toBeVisible();
    // With no address bar, the title says whose page this is. (Test runs keep windows hidden unless they have a screen of their own.)
    await expect
      .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible() }))))
      .toContainEqual({ title: `Connect Test IdP — 127.0.0.1:${FAKE_OIDC_PORT}`, visible: !!process.env.ATELIER_SHOW_WINDOW });
    await provider.close();
    await expect(settings.getByRole('button', { name: 'Connect Test IdP' })).toBeEnabled();
    await expect(settings.getByRole('alert')).toHaveCount(0);

    // Signed in there, the window comes and goes by itself and the account has it.
    await signInAs({ sub: 'the-admin', preferred_username: 'admin', name: 'Tester', email: 'admin@example.com' });
    await settings.getByRole('button', { name: 'Connect Test IdP' }).click();
    await expect(settings.getByRole('cell', { name: 'admin@example.com' })).toBeVisible();

    // It can be disconnected here too.
    await settings.getByRole('button', { name: 'Disconnect Test IdP' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();

    // For providers that refuse app windows the app knows the way to the browser.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url) => void opened.push(url);
    });
    await settings.getByRole('button', { name: 'Open in browser' }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([`${SERVER_URL}/#/?settings=account&row=account.identities`]);
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
