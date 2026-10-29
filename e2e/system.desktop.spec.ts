import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

test('desktop: Settings › System shows the version and turns launch at login on and off', async () => {
  const configDir = await tempConfigDir();
  // Linux keeps the setting as an XDG autostart entry: put it in the throwaway dir.
  const app = await launchDesktop(configDir, { XDG_CONFIG_HOME: join(configDir, 'xdg') });
  try {
    // A real login item would start this Electron at every login: the stub keeps the setting in memory.
    await app.evaluate(({ app }) => {
      const g = globalThis as { openAtLogin?: boolean };
      g.openAtLogin = false;
      app.setLoginItemSettings = ((settings: { openAtLogin?: boolean }) => void (g.openAtLogin = !!settings.openAtLogin)) as typeof app.setLoginItemSettings;
      app.getLoginItemSettings = (() => ({ openAtLogin: g.openAtLogin })) as unknown as typeof app.getLoginItemSettings;
    });
    const openAtLogin = async () =>
      process.platform === 'linux'
        ? readFile(join(configDir, 'xdg', 'autostart', 'dev.atelier.app.desktop'), 'utf8').then(
            (entry) => entry.includes('Exec='),
            () => false,
          )
        : app.evaluate(() => (globalThis as { openAtLogin?: boolean }).openAtLogin);
    const version = await app.evaluate(({ app }) => app.getVersion());
    const page = await app.firstWindow();
    await setUpLocal(page);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    await page.evaluate(() => (location.hash = '#/?settings=system'));
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('button', { name: 'System' })).toHaveAttribute('aria-current', 'page');
    await expect(dialog.locator('[data-setting-row="system.version"]')).toContainText(version);
    await expect(dialog.locator('[data-setting-row="system.version"]')).toContainText('© 2026 TheOriUHD');
    // The test builds run with the update feed off (desktop-app.ts), and "Run on this computer" has no server to ask.
    await expect(dialog.getByText('This copy has no update source, so it can’t check for new versions. Get them from the Releases page.')).toBeVisible();

    const toggle = dialog.getByRole('switch', { name: 'Launch at login' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await openAtLogin()).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await openAtLogin()).toBe(false);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
