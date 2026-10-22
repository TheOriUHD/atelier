import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

/** A file in another folder, outside the session's own: the runner refuses it unless the call was allowed first. */
test('desktop Code: a file outside the folder is read after the person allows it, and without asking in Auto mode', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo();
  const elsewhere = await mkdtemp(join(tmpdir(), 'atelier-e2e-elsewhere-'));
  await writeFile(join(elsewhere, 'notes.txt'), 'outside-contents\n');
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

    // Ask mode: the person is asked, and after Allow once the file is read.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('Read', { file_path: join(elsewhere, 'notes.txt') }));
    await box.press('Enter');
    await page.getByRole('region', { name: 'Allow Atelier to use Read?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/Tool result:.*outside-contents/)).toBeVisible();

    // Auto mode: no question at all.
    for (let i = 0; i < 4 && (await page.getByRole('button', { name: 'Permission mode: Auto' }).count()) === 0; i++) await box.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Permission mode: Auto' })).toBeVisible();
    await writeFile(join(elsewhere, 'more.txt'), 'second-contents\n');
    await box.fill(call('Read', { file_path: join(elsewhere, 'more.txt') }));
    await sendWhenIdle(page);
    await expect(page.getByText(/Tool result:.*second-contents/)).toBeVisible();
    await expect(page.getByRole('region', { name: /Allow Atelier/ })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
