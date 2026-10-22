import { expect, test } from '@playwright/test';

test('server account remote control defaults on and persists its opt-out', async ({ page }) => {
  await page.goto('/#/?settings=account');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const remote = settings.getByRole('switch', { name: 'Remote control', exact: true });
  await expect(remote).toBeChecked();
  await remote.click();
  await expect(remote).not.toBeChecked();
  await page.reload();
  await expect(remote).not.toBeChecked();
  await remote.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tracker-account-controls.png' });
  await remote.click();
  await expect(remote).toBeChecked();
});
