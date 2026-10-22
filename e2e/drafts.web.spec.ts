import { expect, test } from '@playwright/test';

test('an unsent message stays in its box: the new chat and the new Cowork task share one, Code keeps its own', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('plan the trip');

  await sidebar.getByRole('link', { name: 'Cowork', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^What should we get done/ })).toBeVisible();
  await expect(box).toHaveValue('plan the trip');
  await box.fill('plan the trip to Rome');

  await sidebar.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Code' }).click();
  await expect(page).toHaveURL(/#\/code$/);
  await expect(box).toHaveValue('');
  await box.fill('fix the build');

  await sidebar.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Chat' }).click();
  await sidebar.getByRole('link', { name: 'New', exact: true }).click();
  await expect(box).toHaveValue('plan the trip to Rome');

  await page.reload();
  await expect(box).toHaveValue('plan the trip to Rome');
  await page.goto('/#/code');
  await expect(box).toHaveValue('fix the build');
});

test('a chat keeps its own unsent reply, and sending it clears it', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('a chat with a draft');
  await box.press('Enter');
  await expect(page).toHaveURL(/#\/chat\//);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });
  const chat = page.url();
  await box.fill('a reply for later');

  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'New', exact: true }).click();
  await expect(box).toHaveValue('');
  await page.goto(chat);
  await expect(box).toHaveValue('a reply for later');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await page.reload();
  await expect(box).toHaveValue('');
});
