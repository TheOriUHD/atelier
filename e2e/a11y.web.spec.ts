import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Serious and critical WCAG 2 A/AA problems on a screen, as "rule: target" lines. */
async function problems(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

const SETTINGS = ['general', 'account', 'privacy', 'usage', 'code', 'folders', 'cloud', 'skills', 'providers', 'models', 'capabilities', 'admin-code', 'connectors', 'plugins', 'secrets', 'users', 'server', 'developer'];

// Phones get the sidebar as a drawer and Settings as a list of pages (e2e/mobile.web.spec.ts).
for (const [scheme, phone] of [['light', false], ['dark', false], ['light', true], ['dark', true]] as const) {
  test(`main screens have no serious accessibility problems (${scheme}${phone ? ', phone' : ''})`, async ({ page }) => {
    test.setTimeout(120_000);
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const found: Record<string, string[]> = {};
    const check = async (name: string) => {
      await page.waitForTimeout(200);
      const list = await problems(page);
      if (list.length) found[name] = list;
    };

    await page.goto('/');
    await page.getByRole('textbox', { name: 'Message' }).waitFor();
    await check('home');
    await page.getByRole('button', { name: 'Add files and more' }).click();
    await page.getByRole('menu').waitFor();
    await check('+ menu');
    await page.keyboard.press('Escape');
    if (phone) {
      await page.getByRole('button', { name: 'Open sidebar' }).click();
      await page.getByRole('dialog', { name: 'Sidebar' }).waitFor();
      await check('drawer');
      await page.keyboard.press('Escape');
    }

    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('Show me some markdown');
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });
    await check('chat');

    for (const path of ['/#/projects', '/#/artifacts', '/#/customize', '/#/customize?tab=connectors', '/#/customize?tab=plugins', '/#/code', '/#/work']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await check(path);
    }
    // The effort popover, on Code's home with a model that has levels.
    await page.goto('/#/code');
    await page.getByRole('button', { name: 'fake-chat:8b' }).click();
    await page.getByRole('menuitemradio', { name: /^fake-think:14b/ }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Effort: Medium' }).click();
    await page.getByRole('slider', { name: 'Effort' }).waitFor();
    await check('effort popover');
    await page.keyboard.press('Escape');
    if (phone) {
      await page.goto('/#/?settings=');
      await page.getByRole('navigation', { name: 'Settings pages' }).waitFor();
      await check('settings list');
    }
    for (const id of SETTINGS) {
      await page.goto(`/#/?settings=${id}`);
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('heading').first().waitFor();
      await check(`settings ${id}`);
    }
    expect(found).toEqual({});
  });
}
