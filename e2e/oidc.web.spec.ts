import { expect, test, type Browser, type Page } from '@playwright/test';
import { FAKE_OIDC_PORT } from './fixtures.ts';

const OIDC = `http://127.0.0.1:${FAKE_OIDC_PORT}`;
const ISSUER = `${OIDC}/application/o/atelier/`;

const signInAs = (person: Record<string, string>) => fetch(`${OIDC}/person`, { method: 'POST', body: JSON.stringify(person) });

async function signedOutPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  return (await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })).newPage();
}

async function openSettings(page: Page, settingsPage: string) {
  // Only the hash would change otherwise, and an open Settings stays on its page.
  await page.goto('about:blank');
  await page.goto(`/#/?settings=${settingsPage}`);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const signedInAs = (page: Page, name: string) => expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name} · `) })).toBeVisible();

test('an identity provider signs people in: set up, connected, and for someone new', async ({ page, browser, baseURL }) => {
  // The admin adds it, and sees what to tell the provider before anything is saved.
  const settings = await openSettings(page, 'server');
  await settings.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an identity provider' });
  await dialog.getByLabel('Name').fill('Test IdP');
  await expect(dialog.getByRole('textbox', { name: 'Redirect URI' })).toHaveValue(`${baseURL}/api/auth/oidc/test-idp/callback`);
  await dialog.getByLabel('Issuer').fill('http://127.0.0.1:9/nothing/');
  await dialog.getByLabel('Client ID').fill('atelier-e2e');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Couldn’t read the provider’s configuration');
  // Without the trailing slash, as people paste it.
  await dialog.getByLabel('Issuer').fill(ISSUER.slice(0, -1));
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog).toBeHidden();
  await expect(settings.getByRole('cell', { name: 'Test IdP', exact: true })).toBeVisible();

  // Signed-out visitors see it, and someone with the admin's name there doesn't get the admin's account.
  await signInAs({ sub: 'someone-new', preferred_username: 'tester', name: 'Someone New', email: 'new@example.com' });
  const visitor = await signedOutPage(browser, baseURL);
  await visitor.goto('/');
  await visitor.getByRole('button', { name: 'Continue with Test IdP' }).click();
  await expect(visitor.getByRole('alert')).toHaveText('Your account is waiting for an admin to approve it.');
  await expect(visitor).toHaveURL(`${baseURL}/`);

  // The admin connects their own account from Settings › Account.
  await signInAs({ sub: 'the-admin', preferred_username: 'tester', name: 'Tester', email: 'tester@example.com' });
  const account = await openSettings(page, 'account');
  await account.getByRole('button', { name: 'Connect Test IdP' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('cell', { name: 'tester@example.com' })).toBeVisible();

  // From now on the provider signs them in to that account.
  const admin = await signedOutPage(browser, baseURL);
  await admin.goto('/');
  await admin.getByRole('button', { name: 'Continue with Test IdP' }).click();
  await signedInAs(admin, 'Tester');

  // The person who was waiting is approved in Users, and gets in.
  const users = await openSettings(page, 'users');
  await users.getByRole('button', { name: 'Approve Someone New' }).click();

  await signInAs({ sub: 'someone-new', preferred_username: 'tester', name: 'Someone New', email: 'new@example.com' });
  await visitor.getByRole('button', { name: 'Continue with Test IdP' }).click();
  await signedInAs(visitor, 'Someone New');

  // Their account has no password yet, so setting one asks for no current one; the desktop app needs it.
  const own = await openSettings(visitor, 'account');
  await own.getByRole('button', { name: 'Set a password' }).click();
  const password = visitor.getByRole('dialog', { name: 'Set a password' });
  await expect(password.getByLabel('Current password')).toHaveCount(0);
  await password.getByLabel('New password', { exact: true }).fill('a-new-password');
  await password.getByLabel('Confirm new password').fill('a-new-password');
  await password.getByRole('button', { name: 'Set password' }).click();
  await expect(password).toBeHidden();
  await expect(own.getByRole('button', { name: 'Change password' })).toBeVisible();

  // A callback in a browser that never started the flow gets nowhere, and says so.
  const stranger = await signedOutPage(browser, baseURL);
  await stranger.goto('/api/auth/oidc/test-idp/callback?code=stolen&state=stolen');
  await expect(stranger.getByRole('alert')).toHaveText('That sign-in expired. Try again.');
  await expect(stranger).toHaveURL(`${baseURL}/`);

  // The other specs see the sign-in page without it.
  const server = await openSettings(page, 'server');
  await server.getByRole('button', { name: 'Remove Test IdP' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(server.getByText('No identity providers yet.')).toBeVisible();
});
