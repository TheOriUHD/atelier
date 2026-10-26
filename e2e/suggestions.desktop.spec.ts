import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop Code: after a reply the box suggests the next message, and Tab puts it in', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({ 'README.md': '# Demo\n' });
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('fix the typo');
    await box.press('Enter');
    await expect(page.getByText('You said: fix the typo')).toBeVisible();
    await expect(box).toHaveAttribute('placeholder', 'commit it');
    await box.press('Tab');
    await expect(box).toHaveValue('commit it');
    // Emptied again, it is offered again; sending a message drops it until the next reply brings one.
    await box.fill('');
    await expect(box).toHaveAttribute('placeholder', 'commit it');
    await box.fill('and the other typo');
    await box.press('Enter');
    await expect(box).not.toHaveAttribute('placeholder', 'commit it');
    await expect(page.getByText('You said: and the other typo')).toBeVisible();
    await expect(box).toHaveAttribute('placeholder', 'commit it', { timeout: 30_000 });
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
