import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop Code: a custom /command, an @ mention, Reject, stage and commit, and Rewind', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({
    'README.md': '# Demo\n',
    '.atelier/commands/greet.md': '---\ndescription: Greet someone by name\nargument-hint: <name>\n---\nGreet $ARGUMENTS and mention pineapples.\n',
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
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

    // `/` lists the project's command; picking it leaves room for its argument, and the backend expands it.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    // The desktop backend also lists the machine's own skills (~/.claude/skills), so only the first option is known.
    await box.fill('/gree');
    await expect(page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first()).toHaveText('/greet<name>Greet someone by name');
    await box.press('Enter');
    await expect(box).toHaveValue('/greet ');
    await box.pressSequentially('Ada');
    await box.press('Enter');
    await expect(page.getByText(/^You said: \/greet Ada[\s\S]*Greet Ada and mention pineapples\./)).toBeVisible();

    // `@` finds workspace files and inserts the path.
    await box.fill('Summarize @READ');
    await expect(page.getByRole('listbox', { name: 'Files' }).getByRole('option')).toHaveText(['README.md']);
    await box.press('Enter');
    await expect(box).toHaveValue('Summarize @README.md ');
    await sendWhenIdle(page);
    await expect(page.getByText('You said: Summarize @README.md', { exact: true })).toBeVisible();

    // A Write, then Reject of its hunk in the Diff tab puts the file back.
    const readme = join(repo, 'README.md');
    await box.fill(call('Write', { file_path: readme, content: '# Demo\n\nRewritten by the agent\n' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Write README.md?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => readFile(readme, 'utf8')).toContain('Rewritten by the agent');
    await page.getByRole('button', { name: '1 changed' }).click();
    const pane = page.getByRole('region', { name: 'Diff', exact: true });
    const readmeCard = pane.getByRole('region', { name: 'README.md' });
    await expect(readmeCard).toContainText('Rewritten by the agent');
    await readmeCard.getByRole('button', { name: 'Reject' }).click();
    await expect(pane.getByText('No changes to show')).toBeVisible();
    expect(await readFile(readme, 'utf8')).toBe('# Demo\n');

    // Stage the new file and commit it.
    const notes = join(repo, 'notes.md');
    await box.fill(call('Write', { file_path: notes, content: 'Notes\n' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Write notes.md?' }).getByRole('button', { name: 'Allow once' }).click();
    const commit = pane.getByRole('button', { name: 'Commit' });
    await pane.getByRole('checkbox', { name: 'Stage notes.md' }).click();
    await expect(pane.getByRole('checkbox', { name: 'Stage notes.md' })).toBeChecked();
    await pane.getByRole('textbox', { name: 'Commit message' }).fill('Add notes');
    await commit.click();
    await expect(pane.getByText('No changes to show')).toBeVisible();
    expect(git('log', '-1', '--format=%s %an')).toBe('Add notes Atelier E2E\n');
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('notes.md\n');

    // Rewind to before an edit restores the file and the conversation; the message comes back to the composer.
    const edit = call('Write', { file_path: notes, content: 'Notes, edited\n' });
    await box.fill(edit);
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Write notes.md?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => readFile(notes, 'utf8')).toBe('Notes, edited\n');
    await expect(page.getByText(/^Tool result: /)).toHaveCount(3);

    await box.fill('/rewind');
    await box.press('Enter');
    const rewind = page.getByRole('dialog', { name: 'Rewind' });
    await expect(rewind).toContainText('Changes made by Bash commands aren’t tracked');
    await expect(rewind.getByRole('radio')).toHaveCount(3);
    await rewind.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Rewind to here' }).last().click();
    await expect(rewind.getByRole('radio', { name: /notes, edited/i })).toBeChecked();
    await rewind.getByRole('button', { name: 'Restore code and conversation' }).click();
    await expect(rewind).toBeHidden();
    expect(await readFile(notes, 'utf8')).toBe('Notes\n');
    await expect(box).toHaveValue(edit);
    await expect(page.getByText(/^Tool result: /)).toHaveCount(2);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
