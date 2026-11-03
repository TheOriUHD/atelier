import { expect, test, type Browser, type Page } from '@playwright/test';

async function signedOutPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function openSettings(page: Page, settingsPage: string) {
  await page.goto(`/#/?settings=${settingsPage}`);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Sends a message in a new chat and waits for the scripted model's answer. */
async function say(page: Page, text: string) {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

test('an admin limits one person, who is stopped with a plain message until the admin lifts it', async ({ page, browser, baseURL }) => {
  // The person to limit. The limit is theirs alone (an override), so the admin's own chats in other specs are untouched.
  const users = await openSettings(page, 'users');
  await users.getByRole('button', { name: 'Add user' }).click();
  const add = page.getByRole('dialog', { name: 'Add user' });
  await add.getByLabel('Full name').fill('Lim');
  await add.getByLabel(/^Username/).fill('lim');
  await add.getByRole('button', { name: 'Add user' }).click();
  const temporary = await page.getByRole('textbox', { name: 'Temporary password' }).inputValue();

  const lim = await signedOutPage(browser, baseURL);
  await lim.goto('/');
  await lim.getByLabel('Username').fill('lim');
  await lim.getByLabel('Password').fill(temporary);
  await lim.getByLabel('Password').press('Enter');
  await lim.getByLabel('Temporary password').fill(temporary);
  await lim.getByLabel(/^New password/).fill('lims own password');
  await lim.getByLabel('Confirm new password').fill('lims own password');
  await lim.getByRole('button', { name: 'Save and continue' }).click();
  await expect(lim.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Lim · / })).toBeVisible();

  // Nothing is limited, and the Usage page has no limits section.
  await say(lim, 'first question');
  await expect(lim.getByText('You said: first question', { exact: true })).toBeVisible();
  await lim.goto('/#/?settings=usage');
  await expect(lim.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Your limits' })).toHaveCount(0);

  // The admin gives Lim a limit of 1 token a day. Whatever Lim used today is already over it.
  const limits = await openSettings(page, 'limits');
  await expect(limits.getByRole('heading', { name: 'Limits for everyone' })).toBeVisible();
  await limits.getByRole('button', { name: 'Edit the limits of Lim' }).click();
  const edit = page.getByRole('dialog', { name: 'Limits for Lim' });
  await edit.getByRole('combobox', { name: 'Tokens per day for Lim' }).click();
  await page.getByRole('option', { name: 'Own limit' }).click();
  await edit.getByRole('textbox', { name: 'Tokens per day amount' }).fill('1');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toHaveCount(0);
  const row = limits.getByRole('row', { name: /Lim/ });
  await expect(row).toContainText('Own limits');
  await expect(row).toContainText('At limit');

  // Lim's next message is answered with the limit, in words, and nothing can be retried.
  await say(lim, 'second question');
  const alert = lim.getByRole('alert').filter({ hasText: 'You’ve reached your limit of 1 tokens (tokens per day)' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('It lets requests through again at 00:00 UTC');
  await expect(alert).toContainText('Ask an admin (Tester)');
  // (The first answer has its own Retry; the error has none.)
  await expect(alert.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(lim.getByText('You said: second question', { exact: true })).toHaveCount(0);

  // Lim sees why on the Usage page.
  await alert.getByRole('button', { name: 'See your usage' }).click();
  const usage = lim.getByRole('dialog', { name: 'Settings' });
  await expect(usage.getByRole('heading', { name: 'Your limits' })).toBeVisible();
  await expect(usage.getByRole('progressbar', { name: 'Tokens per day: 100% used' })).toBeVisible();
  await expect(usage.getByText(/^Limit reached\./)).toBeVisible();
  await expect(usage.getByRole('button', { name: 'Limits' })).toHaveCount(0);

  // The admin exempts Lim, who carries on.
  await limits.getByRole('button', { name: 'Edit the limits of Lim' }).click();
  await edit.getByRole('switch', { name: 'No limits for this person' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(limits.getByRole('row', { name: /Lim/ })).toContainText('Exempt');
  await say(lim, 'third question');
  await expect(lim.getByText('You said: third question', { exact: true })).toBeVisible();
});
