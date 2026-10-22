import { expect, test } from '@playwright/test';

test('temporary provider errors show a thinking retry, survive reconnect and recover without a settings error', async ({ page }) => {
  await page.goto('/');
  const text = `reconnect-probe ${Date.now()}`;
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Connection interrupted. Retry 1 of 10' })).toBeVisible();
  await expect(page.getByText('Fix in Settings', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Connection interrupted. Retry 1 of 10' })).toBeVisible();
  await expect(page.getByText(`You said: ${text}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});
