import { expect, test, type Browser, type Page } from '@playwright/test';

/** A new person on the server, joined with an invite code the admin creates. */
async function newMember(page: Page, browser: Browser, baseURL: string | undefined, name: string, username: string): Promise<Page> {
  await page.goto('/#/?settings=users');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Create invite code' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite code' });
  await invite.getByRole('button', { name: 'Create code' }).click();
  const code = await invite.getByRole('textbox', { name: 'Invite code' }).inputValue();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const member = await (await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })).newPage();
  await member.goto('/');
  await member.getByRole('button', { name: 'I have a code' }).click();
  await member.getByLabel('Invite code').fill(code);
  await member.getByRole('button', { name: 'Continue' }).click();
  await member.getByLabel('Full name').fill(name);
  await member.getByLabel(/^Username/).fill(username);
  await member.getByLabel(/^Password/).fill(`${username}s password`);
  await member.getByRole('button', { name: 'Create account' }).click();
  await expect(member.getByRole('heading', { level: 1 })).toBeVisible();
  return member;
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

test('a teammate joins a chat on the server, writes in it as themselves, and is removed', async ({ page, browser, baseURL }) => {
  const ben = await newMember(page, browser, baseURL, 'Ben Coop', 'bencoop');

  // The host's chat, with one exchange in it.
  await page.goto('/');
  await send(page, 'hello from the host');
  await expect(page.getByText('You said: hello from the host', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/chat\//);
  const url = page.url();

  // Co-op on this server: add Ben, who can chat.
  await page.getByRole('button', { name: 'Co-op', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Co-op' });
  await popover.getByRole('button', { name: 'Start co-op' }).click();
  await popover.getByRole('checkbox', { name: 'Ben Coop' }).check();
  await popover.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(popover.getByRole('region', { name: 'People' })).toContainText('Ben Coop');
  await page.keyboard.press('Escape');

  // Ben finds it in their sidebar and sees the conversation so far.
  await ben.goto('/');
  const sidebar = ben.getByRole('navigation', { name: 'Sidebar' });
  const row = sidebar.getByRole('link', { name: /Co-op with Tester/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(ben).toHaveURL(new RegExp(`${url.split('#')[1]!.replace(/[/]/g, '\\/')}$`));
  await expect(ben.getByText('You said: hello from the host', { exact: true })).toBeVisible();

  // Ben writes; the host sees it under Ben's name, answered as Ben's turn.
  await ben.getByRole('textbox', { name: 'Message' }).fill('calmer waves please');
  await expect(page.getByText(/Ben Coop is typing/)).toBeVisible();
  await ben.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(page.getByText('You said: calmer waves please', { exact: true })).toBeVisible();
  await expect(ben.getByText('You said: calmer waves please', { exact: true })).toBeVisible();
  await expect(page.getByText('Ben Coop', { exact: true }).first()).toBeVisible();

  // The host removes Ben: the session leaves Ben's sidebar.
  await page.getByRole('button', { name: /^Co-op:/ }).click();
  await popover.getByRole('button', { name: 'More for Ben Coop' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: 'Remove Ben Coop?' }).getByRole('button', { name: 'Remove' }).click();
  await ben.goto('/');
  await expect(sidebar.getByRole('link', { name: /Co-op with Tester/ })).toHaveCount(0, { timeout: 15_000 });
});
