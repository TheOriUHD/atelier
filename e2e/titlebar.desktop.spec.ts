import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

// Windows and Linux draw the window's own buttons in a strip at the top; buttons beside them must share its centre line.
test('desktop: the temporary-chat button lines up with the window buttons', async () => {
  test.skip(process.platform === 'darwin', 'macOS has no window-controls strip');
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page, 'Ada');
    const ghost = page.getByRole('button', { name: 'Temporary chat' });
    await expect(ghost).toBeVisible();
    const strip = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.height = 'env(titlebar-area-height, 0px)';
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    });
    expect(strip).toBeGreaterThan(0);
    const box = (await ghost.boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - strip / 2)).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
