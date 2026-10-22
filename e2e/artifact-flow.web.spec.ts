import { expect, test } from '@playwright/test';
import { settled } from './fixtures.ts';

test('an artifact created in chat opens in the panel and runs in the sandbox', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('make an artifact');
  await box.press('Enter');

  await expect(page.getByText('Click counter')).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  const panel = page.getByRole('complementary', { name: 'Artifact' }).or(page.getByRole('region', { name: 'Artifact' }));
  await expect(panel).toBeVisible();

  // The preview stays hidden behind a skeleton until the runtime reports it rendered.
  await expect(page.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
  // Clicks inside a frame are only checked for stability within the frame: wait until the sliding panel settles.
  await settled(page.locator('iframe[title="Artifact preview"]'));
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await frame.getByRole('button', { name: 'Clicked 0 times' }).click();
  await expect(frame.getByRole('button', { name: 'Clicked 1 times' })).toBeVisible();
});
