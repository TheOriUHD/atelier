import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

test('desktop: Copy diagnostics puts a redacted report with the app log on the clipboard', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.evaluate(() => (location.hash = '#/?settings=system'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(settings.getByRole('button', { name: 'Copied' })).toBeVisible();

    if (process.env.ATELIER_SHOTS_DIR) {
      await mkdir(process.env.ATELIER_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.ATELIER_SHOTS_DIR, 'system-diagnostics.png') });
    }

    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    if (process.env.ATELIER_SHOTS_DIR) await writeFile(join(process.env.ATELIER_SHOTS_DIR, 'diagnostics-sample.txt'), text);
    expect(text).toContain('Atelier diagnostics');
    expect(text).toContain('Mode: desktop app, running on this computer');
    expect(text).toMatch(/Electron \d+\.\d+/);
    expect(text).toMatch(/Main log \(last \d+ lines\):/);
    // The main log starts with a line about this very run.
    expect(text).toMatch(/start \d+\.\d+\.\d+ on (darwin|win32|linux) /);
    expect(text).toContain('Providers: 1 (ollama)');
    // Nothing that identifies this computer or its folders.
    for (const mine of [userInfo().username, homedir(), configDir]) expect(text).not.toContain(mine);
    expect(text).not.toMatch(/https?:\/\/(?!server)/);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
