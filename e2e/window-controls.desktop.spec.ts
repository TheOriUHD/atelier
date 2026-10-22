import { rm } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { settled, tempConfigDir } from './fixtures.ts';

/**
 * Windows and Linux draw the window buttons over the top-right corner and the page learns how wide that corner is
 * (`--at-window-controls`, from env(titlebar-area-*)). Elsewhere there is no such corner, so make one up: the layout
 * under test is the same CSS either way.
 */
async function windowControlsWidth(page: Page): Promise<{ width: number; real: boolean }> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.paddingRight = 'var(--at-window-controls)';
    document.body.append(probe);
    const width = parseFloat(getComputedStyle(probe).paddingRight);
    probe.remove();
    if (width > 0) return { width, real: true };
    document.documentElement.style.setProperty('--at-window-controls', '138px');
    return { width: 138, real: false };
  });
}

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width;
}

test('desktop: controls docked to the right of the top strip keep clear of the window buttons', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    const { width: corner, real } = await windowControlsWidth(page);
    // On Windows the window really has that corner: the page must be told how wide it is, or nothing below is meaningful.
    if (process.platform === 'win32') expect(real).toBe(true);
    const limit = () => page.evaluate(() => window.innerWidth).then((width) => width - corner);

    // Code: the pane buttons (Diff, Terminal, Browser, Files, More) end left of the corner.
    await page.getByRole('radio', { name: 'Code' }).click();
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('hello');
    await box.press('Enter');
    await expect(page.getByText('You said: hello')).toBeVisible();
    const strip = page.getByRole('banner').first().or(page.locator('header').first());
    const buttons = strip.getByRole('button');
    await expect(buttons.last()).toBeVisible();
    const lastButton = await rightEdge(buttons.last());
    expect(lastButton).toBeLessThanOrEqual(await limit());
    // ...and still sit close to it, not pushed somewhere else.
    expect(lastButton).toBeGreaterThan((await limit()) - 80);

    // Chat: an artifact's panel puts its Close button in that same corner.
    await page.getByRole('radio', { name: 'Chat' }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await box.fill('make an artifact');
    await box.press('Enter');
    await page.getByRole('button', { name: /Click counter/ }).click();
    const panel = page.getByRole('complementary', { name: 'Artifact' });
    await expect(panel).toBeVisible();
    // The panel slides in; measure it once it has stopped.
    await settled(panel);
    expect(await rightEdge(panel.getByRole('button', { name: 'Close', exact: true }))).toBeLessThanOrEqual(await limit());
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
