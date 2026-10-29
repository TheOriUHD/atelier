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

test('desktop: computer use is turned on in Settings, the person allows apps, and Background works in their window without taking the mouse', async () => {
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
        call('Screenshot', { app: 'TextEdit' }),
        call('ComputerAction', { actions: [{ action: 'left_click', coordinate: [100, 100], summary: 'Clicks into the document' }, { action: 'type', text: 'hello', replace: true }] }),
      ].join('\n'),
    );
    await box.press('Enter');

    // Terminal is denied: it isn't asked about. Browsers start with full use like other apps; the card says how
    // Background works.
    const access = page.getByRole('region', { name: 'Let Atelier use 2 apps?' });
    await expect(access).toContainText('Write the notes into a document.');
    await expect(access).toContainText('in the background, one at a time, without your mouse and keyboard');
    await expect(access.getByRole('list', { name: 'Apps' })).not.toContainText('Terminal');
    await expect(access.getByRole('combobox', { name: 'What Atelier may do in Safari' })).toContainText('Full use');
    await expect(access.getByRole('combobox', { name: 'What Atelier may do in TextEdit' })).toContainText('Full use');
    await access.getByRole('button', { name: 'Allow for this session' }).click();

    // Ask mode asks for clicking and typing like any action, each step spelled out. Background never takes over: the
    // click and the typing go into TextEdit's window, the mouse and keyboard stay the person's.
    const prompt = page.getByRole('region', { name: 'Allow Atelier to use your computer?' });
    await expect(prompt.getByRole('list', { name: 'Steps' })).toContainText('Clicks into the document');
    await expect(prompt.getByRole('list', { name: 'Steps' })).toContainText('Type “hello”, replacing what the field holds');
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: 1\. Clicks into the document: done/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Let Atelier take over your mouse and keyboard?' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Screenshot image 1 of 1' })).toBeVisible();
    const entries = await helperLog(log);
    expect(entries.find((e) => e.method === 'window.capture')).toMatchObject({ app: 'com.apple.TextEdit' });
    // The click lands in the window: image pixels map onto its rect (800×600 at 100,50, shown at full size).
    expect(entries.find((e) => e.method === 'bg.click')).toMatchObject({ window: 'w:com.apple.TextEdit', x: 200, y: 150, button: 'left', count: 1 });
    expect(entries.find((e) => e.method === 'bg.key')).toMatchObject({ keys: process.platform === 'darwin' ? ['cmd', 'a'] : ['ctrl', 'a'] });
    expect(entries.find((e) => e.method === 'bg.type')).toMatchObject({ text: 'hello' });
    for (const method of ['control.begin', 'mouse.click', 'key.type', 'apps.hide']) expect(entries.map((e) => e.method), method).not.toContain(method);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('desktop: in Full control the assistant takes the computer as it is, without cards, hiding nothing, until Esc is held', async () => {
  test.setTimeout(120_000);
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
    await page.evaluate(() => (location.hash = '#/?settings=system'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('switch', { name: 'Enable computer use' }).click();
    await settings.getByRole('radio', { name: 'Full control' }).click();
    await expect(settings.getByRole('radio', { name: 'Full control' })).toHaveAttribute('aria-checked', 'true');
    await settings.getByRole('button', { name: 'Close' }).click();

    await openFolder(page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(
      [
        call('OpenApp', { app: 'Safari' }),
        call('Screenshot', {}),
        call('ComputerAction', { actions: [{ action: 'left_click', coordinate: [100, 100] }, { action: 'type', text: 'amazon.de' }] }),
      ].join('\n'),
    );
    await box.press('Enter');
    // Ask mode asks for opening the app and for acting, as for any action; Full control itself asks nothing.
    await page.getByRole('region', { name: 'Allow Atelier to open Safari?' }).getByRole('button', { name: 'Allow once' }).click();
    const prompt = page.getByRole('region', { name: 'Allow Atelier to use your computer?' });
    await expect(prompt).toBeVisible();
    // It keeps the computer while the prompt is up: no popping in and out.
    expect((await helperLog(log)).map((e) => e.method)).not.toContain('control.end');
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: 1\. left_click: done/)).toBeVisible();
    await expect(page.getByRole('region', { name: /^Let Atelier/ })).toHaveCount(0);
    const entries = await helperLog(log);
    expect(entries.filter((e) => e.method === 'control.begin')).toHaveLength(1);
    // Opened in front, under control; nothing hidden; the screenshot shows the screen but for the denied apps.
    expect(entries.find((e) => e.method === 'apps.open')).toMatchObject({ id: 'com.apple.Safari', activate: true });
    expect(entries.some((e) => e.method === 'apps.hide')).toBe(false);
    const shot = entries.find((e) => e.method === 'capture.display');
    expect(shot).toMatchObject({ apps: null });
    // Each system's own password managers start on the denied list.
    expect(shot?.exclude).toContain(process.platform === 'win32' ? '1password.exe' : 'com.1password.1password');
    expect(entries.find((e) => e.method === 'key.type')).toMatchObject({ text: 'amazon.de' });
    // Done: the turn ends, the computer goes back and Atelier comes to the front.
    await expect.poll(async () => (await helperLog(log)).map((e) => e.method)).toEqual(expect.arrayContaining(['control.end', 'apps.activate']));

    // Holding Esc stops it while it works: the run ends and nothing more reaches the computer.
    await box.fill(call('ComputerAction', { actions: [{ action: 'wait', duration: 8 }, { action: 'left_click', coordinate: [200, 200] }] }));
    await sendWhenIdle(page);
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(async () => (await helperLog(log)).filter((e) => e.method === 'control.begin').length).toBe(2);
    await writeFile(`${log}.esc`, '');
    // The reply goes on without the computer: the agent hears it was taken back, and the turn ends on its own.
    await expect(page.getByText(/^Tool result: [\s\S]*The person took the computer back \(held Esc\)/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 15_000 });
    const after = await helperLog(log);
    expect(after.filter((e) => e.method === 'control.end').length).toBe(2);
    expect(after.filter((e) => e.method === 'mouse.click').length).toBe(1);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
