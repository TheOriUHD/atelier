import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, WEB_PORT } from './fixtures.ts';

/** A fresh browser window nobody is signed in to (the specs otherwise start as the admin). */
async function signedOutPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Password').press('Enter');
}

async function openSettings(page: Page, settingsPage: string) {
  await page.goto(`/#/?settings=${settingsPage}`);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('signing in and out', async ({ browser, baseURL }) => {
  const page = await signedOutPage(browser, baseURL);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await signIn(page, ADMIN.username, 'not the password');
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');

  await signIn(page, ADMIN.username, ADMIN.password);
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();
  // A second tab shares the cookie, so it signs out with the first.
  const other = await page.context().newPage();
  await other.goto('/');
  await expect(other.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();

  await page.getByRole('button', { name: 'Tester' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('a regular user sees neither admin settings nor anyone else’s chats', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('a chat only the admin has');
  await box.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Scripted demo chat')).toBeVisible();

  const settings = await openSettings(page, 'users');
  await settings.getByRole('button', { name: 'Add user' }).click();
  const add = page.getByRole('dialog', { name: 'Add user' });
  await add.getByLabel('Full name').fill('Bob');
  await add.getByLabel(/^Username/).fill('bob');
  await add.getByRole('button', { name: 'Add user' }).click();
  const temporary = await page.getByRole('textbox', { name: 'Temporary password' }).inputValue();
  expect(temporary.length).toBeGreaterThanOrEqual(8);

  const bob = await signedOutPage(browser, baseURL);
  await signIn(bob, 'bob', temporary);
  await expect(bob.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await bob.getByLabel('Temporary password').fill(temporary);
  await bob.getByLabel(/^New password/).fill('bobs own password');
  await bob.getByLabel('Confirm new password').fill('bobs own password');
  await bob.getByRole('button', { name: 'Save and continue' }).click();
  await expect(bob.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Bob · / })).toBeVisible();
  await expect(bob.getByRole('navigation', { name: 'Sidebar' }).getByText('Scripted demo chat')).toHaveCount(0);

  await bob.keyboard.press('ControlOrMeta+,');
  const bobSettings = bob.getByRole('dialog', { name: 'Settings' });
  await expect(bobSettings.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(bobSettings.getByRole('heading', { name: 'Admin' })).toHaveCount(0);
  await expect(bobSettings.getByRole('button', { name: 'Users' })).toHaveCount(0);
  const search = bobSettings.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('provider');
  // Model providers are the admin's; the only match is importing memory from other AI providers, which is everyone's.
  await expect(bob.locator('#settings-search-results').getByRole('button')).toHaveText([/^Import memory from other AI providers/]);
  await search.fill('');

  // A link to an admin page shows General instead.
  await bob.goto('/#/?settings=providers');
  await expect(bobSettings.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
});

test('an invite code creates a working account, once', async ({ page, browser, baseURL }) => {
  const settings = await openSettings(page, 'users');
  await settings.getByRole('button', { name: 'Create invite code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite code' });
  await dialog.getByRole('button', { name: 'Create code' }).click();
  const code = await dialog.getByRole('textbox', { name: 'Invite code' }).inputValue();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  await expect(dialog).toContainText(`127.0.0.1:${WEB_PORT}`);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(settings.getByRole('table', { name: 'Open invite codes' })).toContainText(`••••-••••-••••-${code.slice(-4)}`);

  const join = async (username: string, typed: string) => {
    const guest = await signedOutPage(browser, baseURL);
    await guest.goto('/');
    await guest.getByRole('button', { name: 'I have a code' }).click();
    await guest.getByLabel('Invite code').fill(typed);
    await guest.getByRole('button', { name: 'Continue' }).click();
    return guest;
  };

  // Typed in lowercase without dashes, the code still works.
  const carol = await join('carol', code.toLowerCase().replace(/-/g, ''));
  await expect(carol.getByRole('heading', { name: 'You’re invited' })).toBeVisible();
  await carol.getByLabel('Full name').fill('Carol');
  await carol.getByLabel(/^Username/).fill('carol');
  await carol.getByLabel(/^Password/).fill('carols password');
  await carol.getByRole('button', { name: 'Create account' }).click();
  await expect(carol.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Carol · / })).toBeVisible();

  const again = await join('carol2', code);
  await expect(again.getByText('This invite code is wrong, already used or expired.')).toBeVisible();
});

test('with open sign-up, new accounts wait until an admin approves them', async ({ page, browser, baseURL }) => {
  const settings = await openSettings(page, 'server');
  await settings.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Open, with approval' }).click();
  await expect(settings.getByRole('combobox')).toHaveText(/Open, with approval/);

  const dan = await signedOutPage(browser, baseURL);
  await dan.goto('/');
  await dan.getByRole('button', { name: 'Create an account' }).click();
  await dan.getByLabel('Full name').fill('Dan');
  await dan.getByLabel(/^Username/).fill('dan');
  await dan.getByLabel(/^Password/).fill('dans password');
  await dan.getByRole('button', { name: 'Request account' }).click();
  await expect(dan.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();

  await signIn(dan, 'dan', 'dans password');
  await expect(dan.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();

  await settings.getByRole('button', { name: 'Users' }).click();
  await settings.getByRole('button', { name: 'Approve Dan' }).click();
  await expect(settings.getByRole('table', { name: 'Users' }).getByText('Dan', { exact: true })).toBeVisible();

  await signIn(dan, 'dan', 'dans password');
  await expect(dan.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Dan · / })).toBeVisible();
});
