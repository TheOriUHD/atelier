import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { APP } from '../packages/protocol/src/index.ts';
import { launchDesktop } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

const PORT = 7396;
const PASSWORD = 'shared on the lan';

test('desktop: Settings › Connection shares Atelier on the network with a password, and stops sharing', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Run on this computer' }).click();
    await page.getByLabel('Your name').fill('Ada');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    await page.evaluate(() => (location.hash = '#/?settings=connection'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('heading', { name: 'Share on your network' })).toBeVisible();
    await settings.getByRole('switch', { name: 'Let other devices use Atelier here' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share Atelier on your network' });
    await expect(dialog.getByText('the connection isn’t encrypted', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Username' })).toHaveValue('ada');
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog.getByText('At least 8 characters', { exact: false }).first()).toBeVisible();
    await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog.getByRole('textbox', { name: 'Port' }).fill(String(PORT));
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(settings.getByText(new RegExp(`^http://.+:${PORT}$`)).first()).toBeVisible();
    await expect(settings.getByText('No device is signed in.', { exact: false })).toBeVisible();

    // A device on the network: the web app, and sign-in with the password.
    const base = `http://127.0.0.1:${PORT}`;
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ app: 'atelier' });
    expect((await fetch(base)).headers.get('content-type')).toContain('text/html');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PASSWORD }) });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain(`${APP.cookie}=`);
    await expect(settings.getByText('One sign-in from the network.', { exact: false })).toBeVisible({ timeout: 15_000 });

    // Stopping signs it out and closes the port.
    await settings.getByRole('switch', { name: 'Let other devices use Atelier here' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Stop sharing on your network?' });
    await confirm.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(settings.getByRole('switch', { name: 'Let other devices use Atelier here' })).not.toBeChecked();
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
