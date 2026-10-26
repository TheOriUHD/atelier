import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

/** What reached the pretend computer (e2e/fake-computer.mjs), in order. */
const helperLog = async (log: string): Promise<{ method: string; [key: string]: unknown }[]> =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string });

async function openFolder(page: Page, folder: string): Promise<void> {
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(folder) })).toBeVisible();
}

test('desktop: computer use is turned on in Settings, the person allows apps and full control, and holding Esc takes it back', async () => {
  test.setTimeout(150_000);
  // The full tier: the fake model counts as compact, which leaves out the app list tools.
  const configDir = await tempConfigDir({ models: { overrides: { 'fake/fake-chat:8b': { promptTier: 'full' } } } });
  const repo = await tempRepo();
  const log = join(configDir, 'computer.log');
  const app = await launchDesktop(configDir, { ATELIER_COMPUTER_HELPER: resolve('e2e/fake-computer.mjs'), FAKE_COMPUTER_LOG: log });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    // Off until the person turns it on; password managers start on the denied list.
    await page.evaluate(() => (location.hash = '#/?settings=system'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const enable = settings.getByRole('switch', { name: 'Enable computer use' });
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');
    const denied = settings.locator('[data-setting-row="system.computerDenied"]');
    await expect(denied).toContainText('1Password');
    // Denying another app: picked from the installed ones.
    await denied.getByRole('button', { name: 'Add app' }).click();
    const picker = page.getByRole('dialog', { name: 'Deny an app' });
    await picker.getByRole('textbox', { name: 'Search apps' }).fill('Term');
    await picker.getByRole('button', { name: 'Terminal' }).click();
    await expect(denied).toContainText('Terminal');
    await expect(settings.getByRole('radio', { name: 'Background' })).toHaveAttribute('aria-checked', 'true');
    if (process.platform === 'darwin') await expect(settings.locator('[data-setting-row="system.computerScreen"]')).toContainText('Granted');
    await settings.getByRole('button', { name: 'Close' }).click();

    await openFolder(page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(
      [
        call('ComputerAccess', { apps: ['TextEdit', 'Safari', 'Terminal'], reason: 'Write the notes into a document.' }),
        call('Screenshot', {}),
        call('ComputerAction', { actions: [{ action: 'left_click', coordinate: [100, 100], summary: 'Clicks into the document' }, { action: 'type', text: 'hello' }] }),
      ].join('\n'),
    );
    await box.press('Enter');

    // Terminal is denied: it isn't asked about. Safari, a browser, is offered to look at only.
    const access = page.getByRole('region', { name: 'Let Atelier use 2 apps?' });
    await expect(access).toContainText('Write the notes into a document.');
    await expect(access.getByRole('list', { name: 'Apps' })).not.toContainText('Terminal');
    await expect(access.getByRole('combobox', { name: 'What Atelier may do in Safari' })).toContainText('See only');
    await expect(access.getByRole('combobox', { name: 'What Atelier may do in TextEdit' })).toContainText('Full use');
    await access.getByRole('button', { name: 'Allow for this session' }).click();

    // The screenshot shows the allowed apps only. Then, in background mode, taking the mouse and keyboard asks first.
    const control = page.getByRole('region', { name: 'Let Atelier take over your mouse and keyboard?' });
    await expect(control).toContainText('Clicks into the document');
    await expect(control).toContainText('TextEdit, Safari');
    await expect(page.getByRole('button', { name: 'Screenshot image 1 of 1' })).toBeVisible();
    const shot = (await helperLog(log)).find((e) => e.method === 'capture.display');
    expect(shot?.apps).toEqual(['com.apple.TextEdit', 'com.apple.Safari']);
    expect((await helperLog(log)).some((e) => e.method === 'control.begin')).toBe(false);
    await control.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText(/^Tool result: 1\. Clicks into the document: done/)).toBeVisible();
    await expect.poll(async () => (await helperLog(log)).map((e) => e.method)).toEqual(expect.arrayContaining(['control.begin', 'mouse.click', 'key.type', 'control.end']));
    const typed = (await helperLog(log)).find((e) => e.method === 'key.type');
    expect(typed?.text).toBe('hello');
    // The turn is over: the mouse and keyboard went back.
    const methods = (await helperLog(log)).map((e) => e.method);
    expect(methods.lastIndexOf('control.end')).toBeGreaterThan(methods.lastIndexOf('key.type'));

    // Holding Esc stops it while it works: the run ends and nothing more reaches the computer.
    await box.fill(call('ComputerAction', { actions: [{ action: 'wait', duration: 8 }, { action: 'left_click', coordinate: [200, 200] }] }));
    await sendWhenIdle(page);
    await expect.poll(async () => (await helperLog(log)).filter((e) => e.method === 'control.begin').length).toBe(2);
    await writeFile(`${log}.esc`, '');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 15_000 });
    const after = await helperLog(log);
    expect(after.filter((e) => e.method === 'control.end').length).toBe(2);
    expect(after.filter((e) => e.method === 'mouse.click').length).toBe(1);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
