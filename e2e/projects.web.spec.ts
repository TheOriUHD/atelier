import { expect, test } from '@playwright/test';
import { tinyPdf } from './fixtures.ts';

test('a project keeps instructions and files, and its chats are listed in it', async ({ page }) => {
  await page.goto('/#/projects');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByPlaceholder('Name your project').fill('Launch plan');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Launch plan');

  const files = page.getByRole('region', { name: 'Files' });
  await page.getByRole('complementary', { name: 'Project knowledge' }).locator('input[type=file]').setInputFiles({ name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('# Brief\nShip on Friday.\n') });
  await expect(files.getByText('brief.md')).toBeVisible();
  // Only documents whose text could be read reach the model: this one needs pdf.js, which must work bundled.
  await page.getByRole('complementary', { name: 'Project knowledge' }).locator('input[type=file]').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
  await expect(files.getByText('notes.pdf')).toBeVisible();

  await page.getByRole('button', { name: 'Add instructions' }).click();
  await page.getByRole('textbox', { name: 'Instructions' }).fill('Answer like a launch manager.');
  await page.getByRole('button', { name: 'Save' }).click();

  // The fake model answers "context?" with the instructions and documents it received in the system prompt.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('context?');
  await box.press('Enter');
  await expect(page.getByText('Instructions: Answer like a launch manager.. Documents: brief.md, notes.pdf.')).toBeVisible();

  await page.goto('/#/projects');
  await page.getByText('Launch plan').click();
  await expect(page.getByRole('list', { name: 'Chats in this project' }).getByRole('link')).toHaveCount(1);
});
