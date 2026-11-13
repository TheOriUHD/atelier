import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir } from './fixtures.ts';

/** Chat and Cowork are one: one kind of conversation that works as a task when it needs to. */
test('desktop, one kind of conversation: a quick question stays a chat; a task writes its file in the chat’s sandbox and shows it', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir({ permissions: { defaultMode: 'auto' } });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);
    // No Cowork of its own: Chat and Code.
    await expect(page.getByRole('link', { name: 'Customize' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cowork', exact: true })).toHaveCount(0);

    // A quick question: a chat as ever, nothing beside it.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('what is a shader?');
    await box.press('Enter');
    await expect(page.getByText('You said: what is a shader?')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('complementary', { name: 'Task progress' })).toHaveCount(0);
    // Its permission chip, as every conversation now has: no Plan, which a chat has no plan to approve for.
    const chip = page.getByRole('button', { name: 'Permission mode: Auto mode' });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(4);
    await expect(page.getByRole('menuitemradio', { name: /^Plan mode/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A task: the same conversation writes a file, in its own sandbox; the file shows beside it and under the reply.
    await box.fill(call('Write', { file_path: 'notes.md', content: '# Waves\n\nSlower, calmer.\n' }));
    await sendWhenIdle(page);
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('notes.md')).toBeVisible();
    // No folder chip: the sandbox isn't one of the person's folders.
    await expect(page.getByRole('button', { name: /^Folder:/ })).toHaveCount(0);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

    // The search palette finds the conversation by what was said in it.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByPlaceholder('Search chats and actions').fill('shader');
    await expect(page.getByRole('group', { name: 'Chats' }).getByRole('option')).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    // An old Cowork link opens the conversation.
    const id = page.url().split('/chat/')[1]!;
    await page.evaluate((sessionId) => void (location.hash = `#/work/${sessionId}`), id);
    await expect(page).toHaveURL(new RegExp(`#/chat/${id}`));
    await page.evaluate(() => void (location.hash = '#/work'));
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    expect(page.url()).not.toContain('/work');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

/** A chat can use the computer as Cowork could: no folder, no sandbox needed. */
test('desktop: a chat uses the computer once it is turned on', async () => {
  test.setTimeout(120_000);
  // The full tier: the fake model counts as compact, which leaves out the app list tools.
  const configDir = await tempConfigDir({ models: { overrides: { 'fake/fake-chat:8b': { promptTier: 'full' } } } });
  const log = join(configDir, 'computer.log');
  const app = await launchDesktop(configDir, { ATELIER_COMPUTER_HELPER: resolve('e2e/fake-computer.mjs'), FAKE_COMPUTER_LOG: log });
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.evaluate(() => (location.hash = '#/?settings=computer'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('switch', { name: 'Enable computer use' }).click();
    await settings.getByRole('button', { name: 'Close' }).click();

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    // The person names TextEdit, so it needs no card.
    await box.fill([call('ComputerAccess', { apps: ['TextEdit'], reason: 'Read the open note.' }), call('Screenshot', { app: 'TextEdit' })].join('\n'));
    await sendWhenIdle(page);
    await expect(page.getByRole('button', { name: 'Screenshot image 1 of 1' })).toBeVisible({ timeout: 30_000 });
    const entries = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; app?: string });
    expect(entries.find((e) => e.method === 'window.capture')).toMatchObject({ app: 'com.apple.TextEdit' });
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
