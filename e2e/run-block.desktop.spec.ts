import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop Code: a shell code block runs in the terminal from its Play button, opening the pane', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo();
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
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('shellblock please');
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
    // The pane isn't open yet: the button opens it, and the block runs in its shell.
    await expect(page.getByRole('region', { name: 'Terminal', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Run in terminal' }).click();
    const terminal = page.getByRole('region', { name: 'Terminal', exact: true }).getByRole('group', { name: 'Terminal' });
    await expect(terminal.locator('.xterm-rows')).toContainText('from-the-block', { timeout: 30_000 });
  } finally {
    await app.close();
  }
});
