import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { AUDIO_SETTINGS, fakeAudioRequests, tempConfigDir } from './fixtures.ts';

/** A picture of the window for a person to look at, when ATELIER_E2E_SHOTS says where; the window stays hidden. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.ATELIER_E2E_SHOTS;
  if (folder) await page.screenshot({ path: join(folder, `${name}.png`) });
}

test('desktop: the microphone dictates into the message box live, the words stay, Enter sends them, and Settings shows the service', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir(AUDIO_SETTINGS);
  // Chromium's made-up microphone beeps every second (a recording passed with --use-file-for-fake-audio-capture comes
  // through Electron as silence).
  const app = await launchDesktop(configDir, {}, ['--use-fake-device-for-media-stream']);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('Note:');

    // The fake sound server's LocalAI preset hears speech (whisper-1): a phrase at a time, and while it is said.
    await page.getByRole('button', { name: 'Dictate', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Listening' })).toBeVisible();
    await expect(page.locator('[data-dictation] .italic')).toHaveText('Testing dictation in Atelier.', { timeout: 20_000 });
    await expect(box).toHaveValue(/^Note: Testing dictation in Atelier\./);
    await shot(page, 'dictation-listening');

    await page.getByRole('button', { name: 'Stop dictation' }).click();
    await expect(box).toHaveValue(/^Note: Testing dictation in Atelier\.( Testing dictation in Atelier\.)*$/);
    await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Listening' })).toHaveCount(0);
    const heard = (await fakeAudioRequests()).filter((r) => r.route === 'transcription');
    expect(heard.length).toBeGreaterThan(0);
    expect(heard[0]).toMatchObject({ model: 'whisper-1', language: null });
    // 16 kHz mono 16-bit, a second or more at a time: about 32 KB a second.
    expect(Math.min(...heard.map((r) => r.bytes!))).toBeGreaterThan(16_000);

    // The arrow beside the microphone: the microphone, the language (searchable) and Hold to record.
    await page.getByRole('button', { name: 'Dictation settings' }).click();
    const menu = page.getByRole('menu');
    // The system's own first (Chromium names it), then every input.
    await expect(menu.getByRole('menuitemradio').first()).toBeChecked();
    await expect(menu.getByRole('menuitemradio', { name: 'Fake Audio Input 1' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Hold to record' })).toBeChecked();
    await menu.getByRole('menuitem', { name: /Language/ }).hover();
    await page.getByRole('textbox', { name: 'Search languages' }).fill('germ');
    await shot(page, 'dictation-menu');
    await page.getByRole('menuitemradio', { name: 'German' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Dictated again, Enter sends the message with the words.
    await box.fill('');
    await page.getByRole('button', { name: 'Dictate', exact: true }).click();
    await expect(page.locator('[data-dictation] .italic')).toHaveText('Testing dictation in Atelier.', { timeout: 20_000 });
    // The language picked in the menu goes with it.
    expect((await fakeAudioRequests()).at(-1)).toMatchObject({ route: 'transcription', language: 'de' });
    await box.press('Enter');
    await expect(page.getByText(/^Testing dictation in Atelier\./).first()).toBeVisible({ timeout: 20_000 });
    await expect(box).toHaveValue('');

    // Settings › General › Dictation names the service, the language and "Hold to record".
    await page.getByRole('button', { name: /Tester/ }).first().click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('heading', { name: 'Dictation' })).toBeVisible();
    await expect(settings.getByText('Speech-to-text service', { exact: true })).toBeVisible();
    await expect(settings.getByRole('combobox', { name: 'Speech-to-text service' })).toContainText('whisper-1 · Fake Audio');
    await expect(settings.getByRole('switch', { name: 'Hold to record' })).toBeChecked();
  } finally {
    await app.close();
  }
});
