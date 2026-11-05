import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
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
    // The header's folder and the sidebar's group follow it, though the folder was new to the window's list of folders.
    await expect(page.getByRole('main').getByText(basename(second), { exact: true })).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
    await expect(sidebar.getByRole('region', { name: basename(second) }).getByRole('link', { name: 'Scripted demo chat' })).toBeVisible();
    await expect(sidebar.getByText('Ungrouped')).toHaveCount(0);
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

/** Opens `path` from the composer's folder chip (named `chip` there now) and trusts it. */
async function openFolder(app: ElectronApplication, page: Page, path: string, chip: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByRole('button', { name: chip, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(path) })).toBeVisible();
}

test('desktop Code: the person moves the session from the header, and Rewind restores each file in its own folder', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const first = await tempRepo({ 'notes.md': 'first\n' });
  const second = await tempRepo({ 'notes.md': 'second\n' });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    // Both are the person's folders; the session starts in the first.
    await openFolder(app, page, second, 'No folder');
    await openFolder(app, page, first, basename(second));
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    const edit = (old: string) => call('Edit', { file_path: 'notes.md', old_string: old, new_string: `${old}, edited` });
    await box.fill(edit('first'));
    await box.press('Enter');
    await page.getByRole('region', { name: 'Allow Atelier to edit notes.md?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => readFile(join(first, 'notes.md'), 'utf8')).toBe('first, edited\n');
    await expect(page.getByText(/^Tool result: Edited notes\.md/)).toBeVisible();

    // The header's folder is a menu of the person's other folders here.
    await page.getByRole('button', { name: `Folder: ${basename(first)}` }).click();
    await page.getByRole('menuitem', { name: basename(second) }).click();
    await expect(page.getByText(`Moved to ${basename(second)}`)).toBeVisible();
    await expect(page.getByText(`Moved from ${basename(first)} to ${basename(second)}`)).toBeVisible();
    await expect(page.getByRole('button', { name: `Folder: ${basename(second)}` })).toBeVisible();

    // The same relative path is now the other folder's file.
    await box.fill(edit('second'));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Allow Atelier to edit notes.md?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => readFile(join(second, 'notes.md'), 'utf8')).toBe('second, edited\n');
    expect(await readFile(join(first, 'notes.md'), 'utf8')).toBe('first, edited\n');

    // Back to before the first edit: each file is restored where it is, the first folder's too.
    await page.getByRole('button', { name: 'Rewind to here' }).first().click();
    await page.getByRole('dialog', { name: 'Rewind' }).getByRole('button', { name: 'Restore code', exact: true }).click();
    await expect(page.getByText('Restored 2 files')).toBeVisible();
    expect(await readFile(join(first, 'notes.md'), 'utf8')).toBe('first\n');
    expect(await readFile(join(second, 'notes.md'), 'utf8')).toBe('second\n');
  } finally {
    await app.close();
  }
});
