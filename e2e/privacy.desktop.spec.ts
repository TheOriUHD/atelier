import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

test('desktop: Privacy › Export saves the zip where the person chooses', async () => {
  const configDir = await tempConfigDir();
  const target = join(configDir, 'export.zip');
  const app = await launchDesktop(configDir);
  try {
    // The native Save dialog can't be driven from a test: it answers with a path, and remembers the suggested name.
    await app.evaluate(({ dialog }, path) => {
      const g = globalThis as { suggested?: string };
      dialog.showSaveDialog = (async (_win: unknown, options: { defaultPath?: string }) => {
        g.suggested = options.defaultPath;
        return { canceled: false, filePath: path };
      }) as unknown as typeof dialog.showSaveDialog;
    }, target);
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('something to export');
    await box.press('Enter');
    await expect(page.getByText('You said: something to export')).toBeVisible();

    await page.evaluate(() => (location.hash = '#/?settings=privacy'));
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Export' }).click();
    await expect.poll(() => readFile(target).then((b) => b.subarray(0, 2).toString(), () => '')).toBe('PK');
    expect(await app.evaluate(() => (globalThis as { suggested?: string }).suggested)).toMatch(/atelier-export-\d{4}-\d{2}-\d{2}\.zip$/);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
