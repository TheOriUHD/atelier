import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir } from './fixtures.ts';

/** Chat and Cowork in one (capabilities.unifiedChat, being built): one kind of conversation that works as a task. */
test('desktop, Chat and Cowork in one: a quick question stays a chat; a task writes its file in the chat’s sandbox and shows it', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir({ capabilities: { unifiedChat: true }, permissions: { defaultMode: 'auto' } });
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
    // Its permission chip, as every conversation now has.
    await expect(page.getByRole('button', { name: /Auto/ }).first()).toBeVisible();

    // A task: the same conversation writes a file, in its own sandbox; the file shows beside it and under the reply.
    await box.fill(call('Write', { file_path: 'notes.md', content: '# Waves\n\nSlower, calmer.\n' }));
    await sendWhenIdle(page);
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('notes.md')).toBeVisible();
    // No folder chip: the sandbox isn't one of the person's folders.
    await expect(page.getByRole('button', { name: /^Folder:/ })).toHaveCount(0);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

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
