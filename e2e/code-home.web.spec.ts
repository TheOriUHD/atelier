import { expect, test, type Locator } from '@playwright/test';

test('the Code home in the browser offers codespaces and other computers, not this one or SSH hosts', async ({ page }) => {
  await page.goto('/#/code');
  await expect(page.getByRole('heading', { name: 'What’s up next, Tester?' })).toBeVisible();
  // No Code session yet: the stats card counts zero, and there is no folder to work in.
  await expect(page.getByRole('region', { name: 'Your Code stats' })).toContainText(/Sessions\s*0/);
  await expect(page.getByRole('button', { name: 'Select folder…' })).toBeVisible();
  // Controls and labels show the arrow, not the I-beam; only the text field does.
  const cursor = (l: Locator) => l.evaluate((el) => getComputedStyle(el).cursor);
  expect(await cursor(page.getByRole('radio', { name: '30d' }))).toBe('default');
  expect(await cursor(page.getByRole('region', { name: 'Your Code stats' }))).toBe('default');
  expect(await cursor(page.getByRole('textbox', { name: 'Message' }))).toBe('text');

  await page.getByRole('button', { name: 'Environment: Cloud' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Cloud', 'Remote Control']);
  await expect(menu.getByRole('menuitemradio', { name: 'Local' })).toHaveCount(0);

  await menu.getByRole('menuitem', { name: 'Remote Control' }).click();
  await expect(page.getByRole('menuitem', { name: /^No other computers/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await menu.getByRole('menuitem', { name: 'Cloud' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open a repository…' })).toBeVisible();
});
