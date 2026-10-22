import { expect, test, type Browser, type Page } from '@playwright/test';

/** A new person with no chats, joined with an invite code the admin creates. */
async function newMember(page: Page, browser: Browser, baseURL: string | undefined, username: string): Promise<Page> {
  await page.goto('/#/?settings=users');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Create invite code' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite code' });
  await invite.getByRole('button', { name: 'Create code' }).click();
  const code = await invite.getByRole('textbox', { name: 'Invite code' }).inputValue();

  const member = await (await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })).newPage();
  await member.goto('/');
  await member.getByRole('button', { name: 'I have a code' }).click();
  await member.getByLabel('Invite code').fill(code);
  await member.getByRole('button', { name: 'Continue' }).click();
  await member.getByLabel('Full name').fill('Erin');
  await member.getByLabel(/^Username/).fill(username);
  await member.getByLabel(/^Password/).fill('erins password');
  await member.getByRole('button', { name: 'Create account' }).click();
  await expect(member.getByRole('heading', { level: 1 })).toBeVisible();
  return member;
}

test('two mode tabs: Chat with Cowork inside it, and Code with its own entries', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const tabs = sidebar.getByRole('radiogroup', { name: 'Mode' });
  await expect(tabs.getByRole('radio')).toHaveCount(2);
  await expect(tabs.getByRole('radio', { name: 'Chat' })).toBeChecked();
  for (const name of ['New', 'Projects', 'Artifacts', 'Cowork', 'Customize']) await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();

  // More opens in place onto the less used places.
  await sidebar.getByRole('button', { name: 'More', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');

  await sidebar.getByRole('link', { name: 'Cowork', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await expect(page.getByRole('heading', { name: /^What should we get done/ })).toBeVisible();
  await expect(tabs.getByRole('radio', { name: 'Chat' })).toBeChecked();
  await expect(sidebar.getByText('Atelier', { exact: true })).toBeVisible();

  await tabs.getByRole('radio', { name: 'Code' }).click();
  await expect(page).toHaveURL(/#\/code$/);
  await expect(sidebar.getByText('Atelier Code')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Projects' })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Cowork' })).toHaveCount(0);
  // Customize, opened from Code, keeps Code's sidebar.
  await sidebar.getByRole('link', { name: 'Customize' }).click();
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible();
  await expect(sidebar.getByText('Atelier Code')).toBeVisible();
});

test('Artifacts lists an artifact made in a chat and opens it in its chat', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('make an artifact to find later');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: /Click counter/ })).toBeVisible();
  const chat = page.url();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });

  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Artifacts' }).click();
  const list = page.getByRole('list', { name: 'Artifacts' });
  await expect(list.getByRole('link').first()).toContainText('Click counter');
  await page.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'SVG' }).click();
  await expect(page.getByText('No SVG artifacts yet.')).toBeVisible();
  await page.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'HTML' }).click();
  await list.getByRole('link').first().click();

  await expect(page).toHaveURL(chat);
  await expect(page.getByRole('complementary', { name: 'Artifact' }).or(page.getByRole('region', { name: 'Artifact' }))).toBeVisible();
});

test('right-clicking a chat in the sidebar opens its menu at the pointer, and it stays open', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('a chat to right-click');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });
  await page.goto('/');

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const row = sidebar.getByRole('link', { name: 'Scripted demo chat' }).first();
  const box2 = (await row.boundingBox())!;
  await row.click({ button: 'right', position: { x: 40, y: box2.height / 2 } });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  // At the pointer, not beside the ⋯ button at the row's end.
  const at = (await menu.boundingBox())!;
  expect(Math.abs(at.x - (box2.x + 40))).toBeLessThan(24);
  await expect(page).not.toHaveURL(/\/chat\//);

  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: /^Delete/ })).toBeVisible();
});

test('Customize has Skills, Connectors and Plugins; + › Add plugins opens Plugins', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.getByRole('menuitem', { name: 'Add plugins' }).click();
  await expect(page).toHaveURL(/#\/customize\?tab=plugins/);
  await expect(page.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('switch', { name: 'Enable review-kit' })).toBeVisible();

  await page.getByRole('tab', { name: 'Skills' }).click();
  await expect(page.getByText('e2e-style', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Connectors' }).click();
  await expect(page.getByRole('button', { name: 'Add connector' })).toBeVisible();
});

test('a new person gets starter ideas that fill the message box, and sees admin settings read-only', async ({ page, browser, baseURL }) => {
  const member = await newMember(page, browser, baseURL, 'erin');
  await member.getByRole('group', { name: 'Ideas to start with' }).getByRole('button', { name: 'Learn' }).click();
  await member.getByRole('region', { name: 'Learn' }).getByRole('button', { name: 'Give me a ten-minute crash course on compound interest' }).click();
  await expect(member.getByRole('textbox', { name: 'Message' })).toHaveValue('Give me a ten-minute crash course on compound interest');
  await expect(member.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Erin · Member' })).toBeVisible();

  // No plugins to add for people who aren't admins; Customize shows what the admin set up.
  await member.getByRole('button', { name: 'Add files and more' }).click();
  await expect(member.getByRole('menuitem', { name: /Upload or add files/ })).toBeVisible();
  await expect(member.getByRole('menuitem', { name: 'Add plugins' })).toHaveCount(0);
  await member.keyboard.press('Escape');
  await member.goto('/#/customize?tab=plugins');
  await expect(member.getByText('review-kit', { exact: true })).toBeVisible();
  await expect(member.getByRole('switch')).toHaveCount(0);
  await member.context().close();
});
