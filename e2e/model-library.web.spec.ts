import { expect, test } from '@playwright/test';

test('model library separates enabled models from the searchable catalog', async ({ page }) => {
  await page.goto('/#/?settings=models');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: 'Your models', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
  await settings.getByRole('button', { name: 'Browse catalog', exact: true }).first().click();
  await expect(settings.getByText(/This library is shared/).first()).toBeVisible();
  const search = settings.getByPlaceholder('Search models by name or id…').first();
  await search.fill('no-such-model-unique');
  await expect(settings.getByText('No matching models.').first()).toBeVisible();
  await search.fill('');
  await page.screenshot({ path: 'test-results/model-library.png' });
});
