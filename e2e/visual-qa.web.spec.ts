import { expect, test } from '@playwright/test';

test('inline visuals use Atelier typography and theme without resetting interactions', async ({ page }) => {
  await page.goto('/');
  const html = '<button id="count" onclick="this.textContent=\'Clicked\'">Try it</button>';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`call inline_visual ${JSON.stringify({ title: 'Typography check', description: 'A theme-aware interactive button.', html })}`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  const visual = page.getByRole('region', { name: 'Typography check', exact: true });
  const frame = visual.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: 'Try it' })).toBeVisible();
  const typography = await frame.locator('body').evaluate(async () => {
    await document.fonts.load('400 14px "Inter Variable"');
    return { loaded: [...document.fonts].some((font) => font.family.includes('Inter') && font.status === 'loaded'), family: getComputedStyle(document.body).fontFamily, background: getComputedStyle(document.body).backgroundColor };
  });
  expect(typography.loaded).toBe(true);
  expect(typography.family).toContain('Inter Variable');
  expect(typography.background).toBe('rgba(0, 0, 0, 0)');
  await frame.getByRole('button', { name: 'Try it' }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  await expect(frame.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible();
  await visual.screenshot({ path: 'test-results/inline-visual-dark.png' });
});
