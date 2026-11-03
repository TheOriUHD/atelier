import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.ATELIER_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test('the Activity page shows who changed what on this server, filters it and exports it', async ({ page }) => {
  // Admin changes made through the same app, so they land in the log.
  await page.goto('/#/?settings=server');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: /Sign-up/ }).click();
  await page.getByRole('option', { name: 'Open, with approval' }).click();
  await settings.getByRole('combobox', { name: /Sign-up/ }).click();
  await page.getByRole('option', { name: 'Invite only' }).click();

  await page.goto('/#/?settings=activity');
  const activity = page.getByRole('dialog', { name: 'Settings' });
  const table = activity.getByRole('table', { name: 'Activity' });
  await expect(table.getByText(/Changed server\.signup: open → invite/)).toBeVisible();
  await expect(table.getByText(/Changed server\.signup: invite → open/)).toBeVisible();
  // The sign-in that opened this session.
  await expect(table.getByText('tester signed in').first()).toBeVisible();
  await expect(table.getByText('tester').first()).toBeVisible();
  await shot(page, 'activity-wide');

  // Details open under the row.
  await table.getByText(/open → invite/).click();
  await expect(activity.getByText('server.signup', { exact: true }).first()).toBeVisible();

  // Filter by type.
  await activity.getByRole('combobox', { name: 'Type of activity' }).click();
  await page.getByRole('option', { name: 'Sign-ins' }).click();
  await expect(table.getByText(/Changed server\.signup/)).toHaveCount(0);
  await expect(table.getByText('tester signed in').first()).toBeVisible();

  // Export what the filters match.
  const download = page.waitForEvent('download');
  await activity.getByRole('button', { name: 'Export JSON' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^atelier-activity-\d{4}-\d{2}-\d{2}\.json$/);
});

test('the Activity page fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/?settings=activity');
  const list = page.getByRole('list', { name: 'Activity' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await shot(page, 'activity-phone');
  // No sideways scrolling anywhere on the page.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Nothing in the dialog reaches past the screen's right edge (the visually hidden inputs are 1px and don't count).
  const beyond = await page.getByRole('dialog', { name: 'Settings' }).evaluate((d) =>
    [...d.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 2 && box.right > window.innerWidth + 1;
    }).map((el) => `${el.tagName}.${el.className}`),
  );
  expect(beyond).toEqual([]);
});

test('the Activity page in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/?settings=activity');
  await expect(page.getByRole('table', { name: 'Activity' })).toBeVisible();
  await shot(page, 'activity-dark');
});
