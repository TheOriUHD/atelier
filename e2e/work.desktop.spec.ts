import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { chatInFolder, launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop: a chat working in a folder shows its steps, comes back live after a reload, and ends with its files', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir();
  const folder = await tempRepo({ 'notes.txt': 'Q3 revenue grew 12%.\n' });
  const app = await launchDesktop(configDir);
  try {
    // The native folder dialog can't be driven from a test, and Finder shouldn't open: record what would be revealed.
    await app.evaluate(({ dialog, shell }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      const revealed: string[] = [];
      (globalThis as { revealed?: string[] }).revealed = revealed;
      shell.showItemInFolder = (p: string) => void revealed.push(p);
    }, folder);
    const page = await app.firstWindow();
    await setUpLocal(page);

    // Chat and Cowork are one: there is no Cowork page, and a chat is given the folder from + › Add folder.
    await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Cowork', exact: true })).toHaveCount(0);
    await chatInFolder(page, folder);

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    const steps = (writing: 'in_progress' | 'completed') => ({
      todos: [
        { content: 'Read the notes', status: 'completed' },
        { content: 'Write the report', status: writing, activeForm: 'Writing the report' },
      ],
    });
    await box.fill(
      [
        call('TodoWrite', steps('in_progress')),
        call('Bash', { command: 'sleep 4; echo counted', description: 'Count the numbers' }),
        call('Write', { file_path: join(folder, 'report.md'), content: '# Q3 report\n\nRevenue grew **12%**.\n' }),
        call('Write', { file_path: join(folder, 'memo.docx'), content: 'memo' }),
        call('TodoWrite', steps('completed')),
      ].join('\n'),
    );
    await box.press('Enter');

    // The task's steps sit beside the transcript as it runs; its tool calls stay on one line each.
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    const progress = panel.getByRole('region', { name: 'Progress' });
    await expect(progress.getByRole('listitem')).toHaveText(['Read the notes', 'Writing the report']);
    await expect(progress.getByRole('heading')).toHaveText('Progress1 of 2');

    // The command is approved; reloading the window while the task waits on the next card comes back to it live.
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByRole('region', { name: 'Write report.md?' })).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(progress.getByRole('listitem')).toHaveText(['Read the notes', 'Writing the report']);
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    // Both files are approved, then the steps are all done.
    await page.getByRole('region', { name: 'Write report.md?' }).getByRole('button', { name: 'Allow once' }).click();
    await page.getByRole('region', { name: 'Write memo.docx?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(progress.getByRole('heading')).toHaveText('Progress2 of 2');
    await expect(page.getByText(/^Tool result:/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    expect(await readFile(join(folder, 'report.md'), 'utf8')).toContain('Revenue grew');

    // The files show beside the steps and, as cards, at the end of the finished task.
    const where = `in ${basename(folder)}`;
    await expect(panel.getByRole('region', { name: 'Output files' }).getByRole('button')).toHaveText([`report.md${where}`, `memo.docx${where}`]);
    const cards = page.getByRole('region', { name: 'Files from this task' }).getByRole('button');
    await expect(cards).toHaveText([/^report\.md.*Open$/, /^memo\.docx.*Show in (Finder|folder)$/]);

    // Markdown opens rendered in the preview panel.
    await cards.first().click();
    const preview = page.getByRole('complementary', { name: 'File preview' });
    await expect(preview.getByRole('heading', { name: 'Q3 report' })).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('12%');
    await preview.getByRole('button', { name: 'Close preview' }).click();
    await expect(preview).toBeHidden();

    // A document without a preview is shown in its folder.
    await cards.nth(1).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { revealed?: string[] }).revealed)).toEqual([join(folder, 'memo.docx')]);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
