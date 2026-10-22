import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo, verboseTranscript } from './fixtures.ts';

test('desktop Code: the agent asks to move the session to another folder and the conversation goes on there', async () => {
  test.setTimeout(120_000);
  // The full tier: compact-tier models (what the fake model counts as) aren't offered this tool.
  const configDir = await tempConfigDir({ models: { overrides: { 'fake/fake-chat:8b': { promptTier: 'full' } } } });
  const first = await tempRepo({ 'README.md': '# First\n' });
  const second = await tempRepo({ 'README.md': '# Second\n', 'AGENTS.md': 'Use tabs, never spaces.\n' });
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, first);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(first) })).toBeVisible();

    // The agent names a folder; the person is asked, never the model's word alone.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('ChangeDirectory', { path: second, reason: 'The task belongs in the second repository.' }));
    await box.press('Enter');
    const card = page.getByRole('region', { name: 'Work in another folder?' });
    await expect(card).toContainText('The task belongs in the second repository.');
    await expect(card.getByRole('textbox', { name: 'Folder' })).toHaveValue(second);
    await card.getByRole('button', { name: 'Move here' }).click();

    // The same conversation, now in the other folder: the header shows it and the tool's result says what it holds.
    await expect(page.getByText(/^Tool result: The session now works in/)).toBeVisible();
    await expect(page.getByRole('main').getByText(basename(second), { exact: false }).first()).toBeVisible();
    // What the result holds, in full in the verbose view: the new folder's own instructions.
    await verboseTranscript(page);
    await expect(page.getByText(/Use tabs, never spaces/)).toBeVisible();

    // Its tools run in the new folder.
    await box.fill(call('Bash', { command: 'pwd', description: 'Where am I' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    // Git Bash on Windows writes `C:\Users/me/x` for its working directory: either separator will do.
    const pattern = second.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
    await expect(page.getByText(new RegExp(`^Tool result: ${pattern}`))).toBeVisible();
  } finally {
    await app.close();
  }
});
