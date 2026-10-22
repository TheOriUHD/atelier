import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const SETTINGS = ['general', 'account', 'privacy', 'usage', 'code', 'folders', 'cloud', 'skills', 'providers', 'models', 'capabilities', 'admin-code', 'connectors', 'plugins', 'secrets', 'users', 'server', 'developer'];

/** What scrolls sideways: the page, or any box other than a table or code block (those may, in their own box). */
async function sideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > innerWidth) found.push(`page: ${root.scrollWidth}px`);
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollWidth <= el.clientWidth + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowX)) continue;
      if (el.matches('pre, [role=table]') || el.querySelector(':scope > table')) continue;
      found.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}: ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    return found;
  });
}

/** The message box sits at the bottom of the screen, entirely on it. */
async function expectComposerPinned(page: Page): Promise<void> {
  const box = await page.getByRole('textbox', { name: 'Message' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(box!.y).toBeGreaterThan(844 - 160);
}

test('home, a chat, projects, Artifacts, Customize and the Code and Cowork homes fit a phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The sidebar is a closed drawer: the page has the full width.
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeHidden();
  expect(await sideways(page)).toEqual([]);
  await expectComposerPinned(page);

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Show me some markdown');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('table')).toBeVisible();
  expect(await sideways(page)).toEqual([]);
  await expectComposerPinned(page);
  // Message actions show without hovering.
  await expect(page.getByRole('button', { name: 'Edit' }).locator('..')).toHaveCSS('opacity', '1');

  for (const path of ['/#/projects', '/#/artifacts', '/#/customize', '/#/customize?tab=connectors', '/#/customize?tab=plugins', '/#/code', '/#/work']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await sideways(page), path).toEqual([]);
  }
  await expectComposerPinned(page);
});

test('the sidebar drawer opens, navigates and closes', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Open sidebar' });
  const drawer = page.getByRole('dialog', { name: 'Sidebar' });

  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role=dialog]')?.getAttribute('aria-label'))).toBe('Sidebar');
  await drawer.getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/#\/projects/);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await toggle.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();

  // A tap beside the drawer closes it; switching modes keeps it open on that mode's sessions.
  await toggle.click();
  await drawer.getByRole('radio', { name: 'Code' }).click();
  await expect(page).toHaveURL(/#\/code/);
  await expect(drawer).toBeVisible();
  await page.mouse.click(370, 400);
  await expect(drawer).toBeHidden();
});

test('Settings goes from its list to a page and back, and every page fits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('button', { name: 'Tester' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const list = dialog.getByRole('navigation', { name: 'Settings pages' });
  await expect(list).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  expect(new URL(page.url().replace('#/', '')).searchParams.get('settings')).toBe('');

  await list.getByRole('button', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/settings=privacy/);
  await expect(dialog.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
  await expect(list).toBeHidden();
  const back = dialog.getByRole('button', { name: 'Settings', exact: true });
  await expect(back).toBeFocused();

  await back.click();
  await expect(list).toBeVisible();
  await expect(list.getByRole('button', { name: 'Privacy' })).toBeFocused();
  expect(new URL(page.url().replace('#/', '')).searchParams.get('settings')).toBe('');
  // Back went back in the history: one more step closes Settings.
  await page.goBack();
  await expect(dialog).toBeHidden();

  // A deep link opens the page itself; back from there shows the list.
  for (const id of SETTINGS) {
    await page.goto(`/#/?settings=${id}`);
    await expect(dialog.getByRole('heading', { level: 1 })).not.toHaveText('Settings');
    await dialog.getByRole('heading', { level: 2 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    expect(await sideways(page), id).toEqual([]);
  }
  await back.click();
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
