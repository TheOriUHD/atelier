import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, tempConfigDir, tempRepo } from './fixtures.ts';

/** The output tokens the Code status line shows ("↓ 1.2k tokens"). */
async function outputTokens(status: Locator): Promise<number> {
  const [, value = '0', k] = /↓ ([\d.]+)(k?) tokens/.exec((await status.textContent()) ?? '') ?? [];
  return Number(value) * (k ? 1000 : 1);
}

test('desktop Code: live output tokens, auto-compaction on a small window and the context popover; Chat has no /compact', async () => {
  test.setTimeout(240_000);
  // Code sessions use the fake model with an 8k window.
  const configDir = await tempConfigDir({ models: { defaults: { code: 'fake/fake-tiny:1b' } } });
  const log = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}: compiling module ${i % 97}, 3 warnings`).join('\n');
  const repo = await tempRepo({ 'README.md': '# Demo\n', 'build.log': log });
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });

    // Chat compacts on its own: its `/` menu has no /compact.
    await box.fill('Hello');
    await box.press('Enter');
    await expect(page.getByText('You said: Hello', { exact: true })).toBeVisible();
    await box.fill('/');
    const commands = page.getByRole('listbox', { name: 'Commands' });
    await expect(commands.getByRole('option').first()).toBeVisible();
    await expect(commands.getByRole('option', { name: /^\/compact/ })).toHaveCount(0);
    await box.fill('');

    // Code: the output tokens of a streaming reply tick up while it streams.
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();
    await box.fill('Give me a long answer');
    await box.press('Enter');
    const status = page.getByRole('status').filter({ hasText: 'tokens' });
    await expect(status).toContainText('Writing…');
    const early = await outputTokens(status);
    await expect.poll(() => outputTokens(status)).toBeGreaterThan(early + 50);
    await expect(status).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/^A long answer, streamed a little at a time\./)).toBeVisible();

    // The context popover: what fills the window, the session's usage, and Compact session.
    await page.getByRole('button', { name: /^Context window: \d+% used$/ }).click();
    const popover = page.getByRole('dialog', { name: 'Context window' });
    // The breakdown is tucked away until the arrow opens it.
    await expect(popover.getByRole('table')).toHaveCount(0);
    await popover.getByRole('button', { name: 'Show the breakdown' }).click();
    const table = popover.getByRole('table', { name: 'Context window by category' });
    for (const category of ['Messages', 'MCP tools', 'System tools', 'Skills', 'System prompt', 'Autocompact buffer', 'Free space']) {
      await expect(table.getByRole('rowheader', { name: category })).toBeVisible();
    }
    await expect(popover).toContainText(/[\d.]+k? until auto-compact/);
    await expect(popover.getByRole('region', { name: 'Session usage' })).toContainText(/Tokens out[\d.]+k?/);
    await popover.getByRole('button', { name: 'Compact session' }).click();
    await expect(page.getByRole('button', { name: /^Compacted session/ })).toBeVisible();

    // A new session: eight reads of a long log overflow the 8k window several times; it compacts on the way and finishes.
    await page.evaluate(() => (location.hash = '#/code'));
    await box.fill(Array.from({ length: 8 }, () => call('Read', { file_path: join(repo, 'build.log') })).join('\n'));
    await box.press('Enter');
    await expect(page.getByText(/^Tool result: /)).toBeVisible({ timeout: 120_000 });
    expect(await page.getByRole('button', { name: /^Compacted session/ }).count()).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(/could not be summarized/)).toHaveCount(0);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
