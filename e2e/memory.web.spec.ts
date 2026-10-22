import { expect, test } from '@playwright/test';

test('Settings › Memory: tell it something, open the entry, and see a chat look at memory', async ({ page }) => {
  await page.goto('/#/?settings=memory');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: 'Memory', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const label of ['Search and reference chats', 'Generate memory from chats', 'Include sensitive topics in memory']) await expect(settings.getByRole('switch', { name: label })).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Include sensitive topics in memory' })).toHaveAttribute('aria-checked', 'false');
  const preferences = settings.getByRole('button', { name: /^Preferences/ });
  await expect(preferences).toContainText('Empty');

  // The import dialog: the prompt to copy, and nothing to add until something is pasted.
  await settings.getByRole('button', { name: 'Start import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import memory to Atelier' });
  await expect(dialog.getByLabel('Import prompt')).toContainText('[YYYY-MM-DD] - Entry');
  await expect(dialog.getByRole('button', { name: 'Add to memory' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  const bar = settings.getByRole('textbox', { name: 'Tell Atelier something to remember' });
  await bar.fill('Keep lists under five things');
  await bar.press('Enter');
  await expect(settings.getByRole('status').filter({ hasText: 'Saved Preferences' })).toBeVisible({ timeout: 20_000 });
  await expect(preferences).toContainText('Updated just now');

  await preferences.click();
  await expect(settings.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  await expect(settings.getByText('Keep lists under five things')).toBeVisible();
  await settings.getByRole('button', { name: 'Memory', exact: true }).first().click();
  await expect(settings.getByRole('heading', { name: 'You' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // A chat's model looks at memory: the step opens to the memory it read, which opens its page in Settings.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('call MemorySearch {"query":"lists"}');
  await box.press('Enter');
  const step = page.getByRole('button', { name: 'Looked at memories' });
  await expect(step).toBeVisible({ timeout: 20_000 });
  await step.click();
  await page.getByRole('button', { name: /^Preferences/ }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Preferences' })).toBeVisible();
});
