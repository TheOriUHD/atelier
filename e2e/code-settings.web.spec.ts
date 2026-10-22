import { expect, test } from '@playwright/test';

test('an admin edits the system AGENTS.md and a rule list, and both persist', async ({ page }) => {
  await page.goto('/#/?settings=admin-code');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const editor = dialog.getByRole('textbox', { name: 'System AGENTS.md' });
  await expect(editor).toBeEnabled();

  await editor.fill('# Conventions\n\nUse pnpm.\n');
  await expect(dialog.getByText(/Unsaved changes/)).toBeVisible();
  await dialog.locator('[data-setting-row="instructions.system"]').getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText(/Unsaved changes/)).toBeHidden();

  const field = dialog.getByRole('textbox', { name: 'New deny rule' });
  await field.fill('read(.env)');
  await field.press('Enter');
  await expect(dialog.getByText('Tool names start with a capital letter, like Bash, Read or WebFetch.')).toBeVisible();
  await field.fill('Read(./.env)');
  await field.press('Enter');
  const deny = dialog.getByRole('list', { name: 'Deny rules' });
  await expect(deny.getByRole('listitem')).toHaveText(['Read(./.env)']);

  await page.reload();
  await expect(dialog.getByRole('textbox', { name: 'System AGENTS.md' })).toHaveValue('# Conventions\n\nUse pnpm.\n');
  await expect(deny.getByRole('listitem')).toHaveText(['Read(./.env)']);

  // Removing persists too, which leaves the server as the other specs expect it.
  await deny.getByRole('button', { name: 'Remove Read(./.env)' }).click();
  await expect(deny).toBeHidden();
  await page.reload();
  await expect(dialog.getByRole('textbox', { name: 'New deny rule' })).toBeVisible();
  await expect(deny).toBeHidden();
});

test('syntax themes and the code font apply to the whole app and persist', async ({ page }) => {
  await page.goto('/#/?settings=code');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const html = page.locator('html');
  const codeFont = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--at-font-code'));

  await dialog.getByRole('combobox', { name: 'Dark theme' }).click();
  await page.getByRole('option', { name: 'Dracula Theme', exact: true }).click();
  await expect(html).toHaveAttribute('data-syntax-dark', 'dracula');
  await dialog.getByRole('textbox', { name: 'Code font' }).fill('Fira Code');
  await dialog.getByRole('textbox', { name: 'Code font' }).blur();
  await expect.poll(codeFont).toBe('"Fira Code", var(--at-font-mono)');

  await page.reload();
  await expect(html).toHaveAttribute('data-syntax-dark', 'dracula');
  await expect(dialog.getByRole('combobox', { name: 'Dark theme' })).toHaveText('Dracula Theme');
  await expect.poll(codeFont).toBe('"Fira Code", var(--at-font-mono)');

  // Back to the bundled look.
  await dialog.getByRole('combobox', { name: 'Dark theme' }).click();
  await page.getByRole('option', { name: 'Atelier Dark' }).click();
  await dialog.getByRole('textbox', { name: 'Code font' }).fill('');
  await dialog.getByRole('textbox', { name: 'Code font' }).blur();
  await expect(html).toHaveAttribute('data-syntax-dark', 'atelier-dark');
  await expect.poll(codeFont).toBe('');
});
