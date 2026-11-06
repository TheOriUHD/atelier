import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { call } from './fixtures.ts';

/**
 * Screenshots of generated sounds for a person to look at, light and dark, desktop and phone width, in the folder
 * ATELIER_E2E_SHOTS names. Nothing here checks how they look, so the suite leaves them out otherwise.
 */
const FOLDER = process.env.ATELIER_E2E_SHOTS ?? '';
const SIZES = { desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 844 } };

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

async function shoot(page: Page, name: string) {
  await mkdir(FOLDER, { recursive: true });
  await page.screenshot({ path: join(FOLDER, `${name}.png`) });
}

const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

for (const theme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`sound shots: ${theme}, ${size}`, async ({ page }) => {
      test.skip(!process.env.ATELIER_E2E_SHOTS, 'Only when asked for: ATELIER_E2E_SHOTS=<folder>');
      test.setTimeout(180_000);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize(viewport);
      const shot = (name: string) => shoot(page, `${name}-${theme}-${size}`);

      await page.goto('/');
      await send(page, call('GenerateAudio', { kind: 'speech', text: 'An unhurried welcome aboard: our tour of the old harbour starts in five minutes.', voice: 'bm_george' }));
      const figure = page.getByRole('figure').last();
      await expect(figure.getByText('Making the speech')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(700);
      await shot('1-running');

      const card = figure.locator('.group\\/audio');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await idle(page);
      await expect.poll(async () => new Set(await card.locator('[role=slider] span.bg-line-stronger').evaluateAll((bars) => bars.map((b) => (b as HTMLElement).style.height))).size).toBeGreaterThan(5);
      await page.waitForTimeout(800);
      await shot('2-speech');

      await card.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForTimeout(2_200);
      await card.getByRole('button', { name: 'Pause', exact: true }).click();
      await card.locator('[role=slider]').hover({ position: { x: 120, y: 12 } });
      await page.waitForTimeout(300);
      await shot('3-speech-played');

      await send(page, call('GenerateAudio', { kind: 'music', prompt: 'A calm lofi beat with soft piano and vinyl crackle, for studying', seconds: 30, instrumental: true }));
      await expect(page.getByRole('figure').last().locator('.group\\/audio')).toBeVisible({ timeout: 30_000 });
      await idle(page);
      await page.waitForTimeout(1_000);
      await shot('4-music');

      await page.getByRole('figure').last().getByRole('button', { name: 'Details' }).click();
      await page.waitForTimeout(400);
      await shot('5-details');
      await page.keyboard.press('Escape');

      await page.goto('/#/images');
      await expect(page.getByRole('radio', { name: 'Sounds' })).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      await shot('6-library');

      await page.goto('/#/?settings=image-providers');
      await expect(page.getByRole('row', { name: /fake-kokoro/ })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('row', { name: /fake-kokoro/ }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shot('7-settings-models');
    });
  }
}
