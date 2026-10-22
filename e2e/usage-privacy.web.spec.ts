import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/** A chat with the fake model, finished and titled. */
async function chat(page: Page) {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Show me some markdown');
  await box.press('Enter');
  await expect(page.getByText('Sorting at a glance')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Sorting algorithms compared').first()).toBeVisible();
}

test('Usage counts a chat’s tokens by model, from what the provider reported', async ({ page }) => {
  await chat(page);
  await page.goto('/#/?settings=usage');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByText(/^\d+ requests? and [\d.,]+K? tokens in the last 30 days\.$/)).toBeVisible();
  // The fake model reports its prompt and output tokens and their timing; nothing has a price.
  const row = dialog.getByRole('table', { name: 'By model' }).getByRole('row').filter({ hasText: 'fake-chat:8b' });
  await expect(row).toContainText('Fake Ollama');
  await expect(row).toContainText('tokens/s');
  await expect(row.getByRole('cell').nth(3)).toHaveText('—');
  await expect(dialog.getByText(/requests? without a price\. Add prices below to count their cost\./)).toBeVisible();
});

test('Privacy exports everything as a zip, and deleting all conversations empties Recents', async ({ page }) => {
  await chat(page);
  const recents = page.getByRole('navigation', { name: 'Sidebar' }).locator('a[href*="/chat/"]');
  await expect(recents.first()).toBeVisible();

  await page.goto('/#/?settings=privacy');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^atelier-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await readFile(await download.path());
  expect(zip.subarray(0, 2).toString()).toBe('PK');
  expect(zip.includes('conversations/Sorting algorithms compared')).toBe(true);

  await dialog.getByRole('button', { name: 'Delete all…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all conversations?' });
  const button = confirm.getByRole('button', { name: 'Delete all conversations' });
  await expect(button).toBeDisabled();
  await confirm.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
  await button.click();
  await expect(page.getByText(/^Deleted \d+ conversations?\.$/)).toBeVisible();
  // The sidebar is behind the Settings dialog until it closes.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(recents).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(recents).toHaveCount(0);
});
