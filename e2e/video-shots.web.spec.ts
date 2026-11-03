import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { call } from './fixtures.ts';

/**
 * Screenshots of generated videos for a person to look at, light and dark, desktop and phone width, in the folder
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

/** Every progress update of a running call says it is this far along, so the bar and the line can be looked at while it waits. */
async function holdAt(page: Page, stage: Record<string, unknown>) {
  await page.routeWebSocket(/\/api\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { params?: { event?: { type?: string; progress?: Record<string, unknown> } } };
      const event = parsed.params?.event;
      if (event?.type === 'tool_progress' && event.progress && event.progress.phase !== 'finishing') {
        event.progress = { ...event.progress, ...stage };
        return ws.send(JSON.stringify(parsed));
      }
      ws.send(message);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`shots: ${theme}, ${size}`, async ({ page }) => {
      test.skip(!process.env.ATELIER_E2E_SHOTS, 'Only when asked for: ATELIER_E2E_SHOTS=<folder>');
      test.setTimeout(180_000);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize(viewport);
      const shot = (name: string) => shoot(page, `${name}-${theme}-${size}`);

      await holdAt(page, { phase: 'generating', fraction: 0.42, etaMs: 95_000 });
      await page.goto('/');
      await send(page, call('GenerateVideo', { prompt: 'An unhurried drive along the coast at dusk, warm light on the water', aspect_ratio: '16:9', seconds: 5 }));
      const figure = page.getByRole('figure').last();
      await expect(figure.getByText('42% · about 2 min')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('1-running');

      const player = figure.locator('video');
      await expect(player).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      await page.waitForTimeout(1_000);
      await shot('2-done');
      await figure.locator('.group\\/video').hover();
      await page.waitForTimeout(350);
      await shot('3-done-hover');

      await figure.getByRole('button', { name: 'Open larger' }).click();
      const viewer = page.getByRole('dialog', { name: 'Video' });
      await expect(viewer.locator('video')).toBeVisible();
      await page.waitForTimeout(500);
      await viewer.getByRole('button', { name: 'Details' }).click();
      await page.waitForTimeout(400);
      await shot('4-viewer-details');
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);

      await page.unroute(/\/api\/ws$/);
      await page.goto('/#/images');
      await expect(page.getByRole('button', { name: /^Play video/ }).first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1_200);
      await shot('5-gallery');

      await page.goto('/#/?settings=image-providers');
      await expect(page.getByRole('row', { name: /Fake Dusk/ })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('row', { name: /Fake Dusk/ }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shot('6-settings-models');

      await page.goto('/');
      await send(page, call('GenerateVideo', { prompt: 'Something forbidden, as a short clip' }));
      await expect(page.getByText(/refused this/).last()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      await page.waitForTimeout(300);
      await shot('7-refused');
    });
  }
}
