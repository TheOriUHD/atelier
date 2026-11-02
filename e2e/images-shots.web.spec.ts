import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { call, scriptProgress } from './fixtures.ts';

/**
 * Screenshots of generated images for a person to look at, light and dark, desktop and phone width, in the folder
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

for (const theme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`shots: ${theme}, ${size}`, async ({ page }) => {
      test.skip(!process.env.ATELIER_E2E_SHOTS, 'Only when asked for: ATELIER_E2E_SHOTS=<folder>');
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize(viewport);
      const shot = (name: string) => shoot(page, `${name}-${theme}-${size}`);

      // The first stages for their status lines, then what the server really reports.
      await scriptProgress(page, [{ phase: 'queued', ahead: 2 }, { phase: 'loading' }, { phase: 'generating', step: 3, steps: 28, etaMs: 44_000 }, { phase: 'generating', step: 12, steps: 28, etaMs: 20_000 }, { phase: 'generating', step: 24, steps: 28, etaMs: 6_000 }]);
      await page.goto('/');
      // The model with the full prompt, whose GenerateImage takes `count`.
      await page.getByRole('button', { name: 'fake-chat:8b' }).click();
      await page.getByRole('menuitemradio', { name: /^fake-eyes:8b/ }).click();
      await page.keyboard.press('Escape');
      await send(page, call('GenerateImage', { prompt: 'An unhurried poster for a summer party on the shore, warm light, printed in three colours', aspect_ratio: '3:2' }));
      const frame = page.getByRole('figure').last();
      await expect(frame.getByText('2 ahead of you')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('1-queued');
      await expect(frame.getByText(/^Step 3 of 28/)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('2-forming-early');
      await expect(frame.getByText(/^Step 12 of 28/)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('3-forming-middle');
      await expect(frame.getByText(/^Step 24 of 28/)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('3-forming-late');

      const image = frame.getByRole('button', { name: /^Open image/ });
      await expect(image).toBeVisible({ timeout: 30_000 });
      await expect(frame.locator('[data-loaded]')).toBeVisible();
      await page.waitForTimeout(800);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      await shot('4-done-one');
      await image.hover();
      await page.waitForTimeout(350);
      await shot('5-done-hover');

      await image.click();
      const lightbox = page.getByRole('dialog', { name: 'Image' });
      await expect(lightbox.locator('img')).toBeVisible();
      await page.waitForTimeout(350);
      await lightbox.getByRole('button', { name: 'Details' }).click();
      await page.waitForTimeout(350);
      await shot('6-lightbox-details');
      await page.keyboard.press('Escape');
      await expect(lightbox).toHaveCount(0);

      const layouts = [
        { name: 'two', count: 2, aspect_ratio: '1:1', prompt: 'Two versions of the same hills' },
        { name: 'three', count: 3, aspect_ratio: '1:1', prompt: 'Three versions of the same hills' },
        { name: 'three-wide', count: 3, aspect_ratio: '3:2', prompt: 'Three wide views of the same hills' },
        { name: 'four', count: 4, aspect_ratio: '1:1', prompt: 'Four square studies of the same hills' },
        { name: 'four-tall', count: 4, aspect_ratio: '2:3', prompt: 'Four small studies of the same hills, tall format' },
      ];
      for (const [i, { name, ...input }] of layouts.entries()) {
        await send(page, call('GenerateImage', input));
        await expect(page.getByRole('figure')).toHaveCount(i + 2);
        const figure = page.getByRole('figure').last();
        await expect(figure.getByRole('button', { name: /^Open image/ })).toHaveCount(input.count, { timeout: 30_000 });
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
        await figure.scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        await figure.screenshot({ path: join(FOLDER, `7${'abcde'[i]}-done-${name}-${theme}-${size}.png`) });
      }

      await send(page, call('GenerateImage', { prompt: 'Something forbidden, in the style of a passport photo' }));
      await expect(page.getByText(/refused this/).last()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      await page.waitForTimeout(300);
      await shot('8-refused');
    });
  }
}
