import { expect, test } from '@playwright/test';
import { ADMIN, WEB_PORT } from './fixtures.ts';

// WebAuthn needs a hostname (not an IP) as the site, so this spec uses localhost, signed out at first.
test.use({ storageState: { cookies: [], origins: [] } });

test('a passkey added in Settings › Account signs in from the login screen', async ({ page }) => {
  const base = `http://localhost:${WEB_PORT}`;
  await page.goto(base);
  // Chromium's virtual authenticator answers the browser's passkey prompts.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();

  await page.goto(`${base}/#/?settings=account&row=account.passkeys`);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Add passkey' }).click();
  const add = page.getByRole('dialog', { name: 'Add a passkey' });
  await add.getByRole('textbox', { name: 'Name' }).fill('Test key');
  await add.getByRole('button', { name: 'Continue' }).click();
  const passkeys = settings.getByRole('table', { name: 'Passkeys' });
  await expect(passkeys.getByRole('row').filter({ hasText: 'Test key' })).toContainText('Never');

  await page.request.post(`${base}/api/auth/logout`);
  await page.goto(base);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();

  await page.goto(`${base}/#/?settings=account&row=account.passkeys`);
  await expect(passkeys.getByRole('row').filter({ hasText: 'Test key' })).toContainText('just now');
});
