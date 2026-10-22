import { expect, test } from '@playwright/test';

// A full Memory page, for a member of their own (the admin's memory is other specs'): the bar stays on the panel's
// bottom edge, never over a row, and a long entry scrolls.
test('Settings › Memory: with many long entries the bar stays at the bottom and an entry page scrolls', async ({ page, browser, baseURL }) => {
  await page.goto('/#/?settings=users');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Create invite code' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite code' });
  await invite.getByRole('button', { name: 'Create code' }).click();
  const code = await invite.getByRole('textbox', { name: 'Invite code' }).inputValue();

  const member = await (await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } })).newPage();
  await member.goto('/');
  await member.getByRole('button', { name: 'I have a code' }).click();
  await member.getByLabel('Invite code').fill(code);
  await member.getByRole('button', { name: 'Continue' }).click();
  await member.getByLabel('Full name').fill('Mara');
  await member.getByLabel(/^Username/).fill('mara');
  await member.getByLabel(/^Password/).fill('maras password');
  await member.getByRole('button', { name: 'Create account' }).click();
  await expect(member.getByRole('heading', { level: 1 })).toBeVisible();

  await member.goto('/#/?settings=memory');
  const settings = member.getByRole('dialog', { name: 'Settings' });
  const bar = settings.getByRole('textbox', { name: 'Tell Atelier something to remember' });
  await bar.fill('fill memory');
  await bar.press('Enter');
  await expect(settings.getByRole('button', { name: /^Entry 24/ })).toBeAttached({ timeout: 20_000 });

  const panel = (await settings.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  // Near the panel's bottom edge: its padding and the one status line under it.
  expect(panel.y + panel.height - (barBox.y + barBox.height)).toBeLessThan(72);

  // The last row can be scrolled into view above the bar, not under it.
  const last = settings.getByRole('button', { name: /^Entry 24/ });
  await last.scrollIntoViewIfNeeded();
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);

  // A long entry scrolls to its last fact, which ends above the entry's own bar.
  await settings.getByRole('button', { name: /^Preferences/ }).click();
  await expect(settings.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  const lastFact = settings.getByText('Preference fact 40:', { exact: false });
  await lastFact.scrollIntoViewIfNeeded();
  await expect(lastFact).toBeInViewport();
  const fact = (await lastFact.boundingBox())!;
  const entryBar = (await settings.getByRole('textbox', { name: /Tell Atelier what to change/ }).boundingBox())!;
  expect(fact.y + fact.height).toBeLessThanOrEqual(entryBar.y);
  await member.screenshot({ path: 'test-results/memory-entry-end.png' });
});
