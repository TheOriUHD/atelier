import { readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo, verboseTranscript } from './fixtures.ts';

test('desktop Code: a folder, approvals, live command output, a question, plan approval and the terminal', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    // The native folder dialog can't be driven from a test: it answers with the repository.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);

    // A fresh Code home: this computer, no folder yet and no stats.
    await page.getByRole('radio', { name: 'Code' }).click();
    await expect(page.getByRole('button', { name: 'Environment: Local' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your Code stats' })).toContainText(/Sessions\s*0/);
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    // A Write asks first; once approved the file is on disk and in the Diff tab.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    const hello = join(repo, 'hello.txt');
    await box.fill(call('Write', { file_path: hello, content: 'Hello from Atelier\n' }));
    await box.press('Enter');
    await page.getByRole('region', { name: 'Write hello.txt?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: Created/)).toBeVisible();
    expect(await readFile(hello, 'utf8')).toBe('Hello from Atelier\n');
    await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('region', { name: basename(repo) })).toBeVisible();
    await page.getByRole('button', { name: '1 changed' }).click();
    await expect(page.getByRole('button', { name: 'Diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const diff = page.getByRole('region', { name: 'Diff', exact: true });
    await expect(diff.getByRole('region', { name: 'hello.txt' })).toContainText('Hello from Atelier');

    // A command streams its output into its card while it runs (each call keeps its card in the Verbose view).
    await verboseTranscript(page);
    await box.fill(call('Bash', { command: 'echo tick-1; sleep 3; echo tick-2', description: 'Count with a pause' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    const output = page.getByRole('group', { name: 'Command' }).getByLabel('Output');
    await expect(output).toHaveText('tick-1');
    await expect(output).toHaveText(/tick-1\s+tick-2/);
    await expect(page.getByText('Exit code 0', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Tool result: tick-1/)).toBeVisible();

    // AskUser: pick an option and submit.
    await box.fill(
      call('AskUser', {
        questions: [
          {
            question: 'Which color should the button be?',
            header: 'Color',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'Warm' },
              { label: 'Blue', description: 'Cool' },
            ],
          },
        ],
      }),
    );
    await sendWhenIdle(page);
    const question = page.getByRole('region', { name: 'A question for you' });
    await question.getByText('Blue', { exact: true }).click();
    await expect(question.getByRole('radio', { name: /Blue/ })).toBeChecked();
    await question.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/= "Blue"/).first()).toBeVisible();

    // Shift+Tab cycles the permission mode; approving a plan switches it to the chosen mode.
    await box.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Permission mode: Accept edits' })).toBeVisible();
    await box.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Permission mode: Plan mode' })).toBeVisible();
    await box.fill(call('ExitPlanMode', { plan: '## Plan\n1. Add a greeting to the README' }));
    await sendWhenIdle(page);
    // The proposal is at the message box and the plan itself opens in the Plan pane.
    const plan = page.getByRole('region', { name: 'Atelier proposed a plan' });
    await expect(page.getByText('Needs your input')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Plan', exact: true })).toContainText('Add a greeting to the README');
    await plan.getByRole('button', { name: 'Other ways to accept' }).click();
    await page.getByRole('menuitem', { name: /Accept and auto-accept edits/ }).click();
    await expect(page.getByRole('button', { name: 'Permission mode: Accept edits' })).toBeVisible();
    await expect(page.getByText(/^Tool result: The person approved the plan/)).toBeVisible();

    // The terminal runs a shell in the workspace.
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Terminal', exact: true }).getByRole('group', { name: 'Terminal' });
    await expect(terminal.locator('.xterm-rows')).toHaveText(/\S/);
    await terminal.click();
    await page.keyboard.type('echo "atelier-$((6*7))"');
    await page.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('atelier-42');

    // Back on the Code home, the session shows in the stats card, and the folder stays chosen.
    await page.evaluate(() => (location.hash = '#/code'));
    const stats = page.getByRole('region', { name: 'Your Code stats' });
    await expect(stats.getByRole('definition').first()).toHaveText('1');
    await expect(stats.getByRole('group', { name: 'Activity in the last 26 weeks' })).toBeVisible();
    await expect(page.getByRole('button', { name: basename(repo), exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('desktop Code: with no folder each session works in a new scratch folder of its own; the context ring opens on the home', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();

    // Before any session, the ring opens on an empty window of the model's size and the person's usage.
    await page.getByRole('button', { name: 'Context window: 0% used' }).click();
    const popover = page.getByRole('dialog', { name: 'Context window' });
    await expect(popover).toContainText(/Context window0 \/ [\d.]+[kM]? \(0%\)/);
    const usage = popover.getByRole('region', { name: 'Your usage' });
    await expect(usage).toContainText('Today0 tokens');
    await expect(usage).toContainText('Last 7 days0 tokens');
    await usage.getByRole('button', { name: 'Open Usage in Settings' }).click();
    await expect(popover).toBeHidden();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByText('No usage in the last 30 days.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    // Nothing chosen yet: no folder, offered first, above Open folder….
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: /^No folder/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitem', { name: 'Open folder…' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The session's tools run in a new, empty folder under the data folder.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('Bash', { command: 'pwd; ls -A | wc -l; echo hello > note.txt', description: 'Look around' }));
    await box.press('Enter');
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: (\/|[A-Za-z]:).*scratch-/)).toBeVisible();
    await verboseTranscript(page);
    const scratch = await realpath(join(configDir, 'data', 'scratch-workspaces'));
    const [user] = await readdir(scratch);
    const [first] = await readdir(join(scratch, user!));
    expect(first).toMatch(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    // Git Bash on Windows writes `C:\Users/me/x` for its working directory: either separator will do.
    const folder = join(scratch, user!, first!).split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
    await expect(page.getByRole('group', { name: 'Command' }).getByLabel('Output')).toHaveText(new RegExp(`^${folder}\\s+0\\s*$`));
    expect(await readFile(join(scratch, user!, first!, 'note.txt'), 'utf8')).toBe('hello\n');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Files', exact: true }).getByRole('button', { name: 'note.txt' })).toBeVisible();

    // The sidebar keeps sessions without a folder in one group; its + starts another, in a folder of its own.
    const group = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('region', { name: 'No folder' });
    await expect(group.getByRole('link')).toHaveCount(1);
    await group.getByRole('button', { name: 'New session with no folder' }).click();
    await expect(page.getByRole('button', { name: 'No folder', exact: true })).toBeVisible();
    await box.fill(call('Bash', { command: 'pwd', description: 'Where am I' }));
    await box.press('Enter');
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: (\/|[A-Za-z]:).*scratch-/)).toBeVisible();
    const folders = await readdir(join(scratch, user!));
    expect(folders).toHaveLength(2);
    const second = folders.find((f) => f !== first)!;
    await expect(group.getByRole('link')).toHaveCount(2);

    // /clear goes on in the same scratch folder, so what the session made there stays at hand.
    await box.fill('/clear');
    await box.press('Enter');
    await expect(page.getByRole('button', { name: second, exact: true })).toBeVisible();
    await box.fill(call('Bash', { command: 'pwd', description: 'Still here?' }));
    await box.press('Enter');
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await verboseTranscript(page);
    await expect(page.getByRole('group', { name: 'Command' }).getByLabel('Output')).toHaveText(
      new RegExp(`^${join(scratch, user!, second).split(/[\\/]/).map(escapeRegExp).join('[\\\\/]')}$`),
    );
    expect(await readdir(join(scratch, user!))).toHaveLength(2);
    await expect(group.getByRole('link')).toHaveCount(3);

    // Deleting a session leaves its folder on disk, and the home stays on no folder.
    await page.locator('header button[aria-haspopup="menu"]').first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog', { name: 'Delete session?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(group.getByRole('link')).toHaveCount(2);
    expect(await readdir(join(scratch, user!))).toHaveLength(2);
    await expect(page.getByRole('button', { name: 'No folder', exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
