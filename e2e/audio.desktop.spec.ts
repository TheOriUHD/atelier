import { readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chatInFolder, launchDesktop, setUpLocal } from './desktop-app.ts';
import { AUDIO_SETTINGS, call, fakeAudioRequests, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

const generate = (input: Record<string, unknown>) => call('GenerateAudio', input);
const newest = (page: Page) => page.getByRole('figure').last();
const card = (page: Page) => newest(page).locator('.group\\/audio');
const audioOf = (page: Page) => newest(page).locator('audio');

/** A picture of the window for a person to look at, when ATELIER_E2E_SHOTS says where; the window stays hidden. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.ATELIER_E2E_SHOTS;
  if (folder) await page.screenshot({ path: join(folder, `${name}.png`) });
}

/** The id the model got for the sound it just made, as the scripted reply repeats it. */
async function lastSoundId(page: Page): Promise<string> {
  const reply = await page.getByText(/^Tool result: Generated (speech|music|a sound effect)/).last().innerText();
  return /aud_[0-9a-f]{8}/.exec(reply)![0];
}

async function openFolder(page: Page, folder: string) {
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(folder) })).toBeVisible();
}

test('desktop Code: Ask shows the words, the sound plays through the app’s own scheme in ranges, SaveAudio writes it and Rewind takes it back', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(AUDIO_SETTINGS);
  const repo = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await openFolder(page, repo);

    // Ask mode: the card says it will make speech and shows the words, and the sound's card waits quietly.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(generate({ kind: 'speech', text: 'Welcome to the release notes for this week.', voice: 'af_sky' }));
    await box.press('Enter');
    const ask = page.getByRole('region', { name: /Allow Atelier to make speech/ });
    await expect(ask).toContainText('Welcome to the release notes for this week.');
    await expect(ask).toContainText('In the voice af_sky');
    await expect(newest(page).getByRole('status').first()).toHaveText('Waiting for your answer');
    await shot(page, 'desktop-audio-ask');
    await ask.getByRole('button', { name: 'Allow once' }).click();

    await expect(card(page)).toBeVisible({ timeout: 30_000 });
    await expect(card(page).getByText('Speech · af_sky')).toBeVisible();
    await expect.poll(() => audioOf(page).evaluate((el: HTMLAudioElement) => Math.round(el.duration))).toBe(6);
    expect((await fakeAudioRequests()).at(-1)).toMatchObject({ route: 'speech', model: 'fake-kokoro', voice: 'af_sky' });

    // Through the app's own scheme, which answers ranges.
    const src = await audioOf(page).evaluate((el: HTMLAudioElement) => el.currentSrc);
    expect(src).toMatch(/^atelier-blob:\/\/[0-9a-f]{64}\/?$/);
    const probe = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { range: 'bytes=0-99' } });
      return { status: res.status, type: res.headers.get('content-type'), size: (await res.arrayBuffer()).byteLength };
    }, src);
    expect(probe).toEqual({ status: 206, type: 'audio/mpeg', size: 100 });

    // It plays, and the waveform was decoded from the file through the same scheme.
    await card(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => audioOf(page).evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0.3);
    await card(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(async () => new Set(await card(page).locator('[role=slider] span.bg-line-stronger').evaluateAll((bars) => bars.map((b) => (b as HTMLElement).style.height))).size).toBeGreaterThan(5);
    await shot(page, 'desktop-audio-done');

    const id = await lastSoundId(page);
    // A name that doesn't match what the file is: refused, with what it is, and nothing is written.
    await box.fill(call('SaveAudio', { audio: id, file_path: join(repo, 'public', 'welcome.wav') }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save public\/welcome\.wav\?/i }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/This sound is an MP3 file: save it with a \.mp3 name/)).toBeVisible({ timeout: 15_000 });
    expect(await stat(join(repo, 'public', 'welcome.wav')).then(() => true, () => false)).toBe(false);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

    const path = join(repo, 'public', 'welcome.mp3');
    await box.fill(call('SaveAudio', { audio: id, file_path: path }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save public\/welcome\.mp3\?/i }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => stat(path).then((s) => s.size).catch(() => 0)).toBeGreaterThan(10_000);
    expect([...(await readFile(path)).subarray(0, 3)]).toEqual([0x49, 0x44, 0x33]);
    await expect(page.getByRole('button', { name: /^Saved welcome\.mp3/ })).toBeVisible();
    await shot(page, 'desktop-audio-saved');

    // Undone by Rewind like any file edit, with the sound itself still higher up.
    await page.getByRole('button', { name: 'Rewind to here' }).last().click();
    const rewind = page.getByRole('dialog', { name: 'Rewind' });
    await rewind.getByRole('button', { name: 'Restore code and conversation' }).click();
    await expect(rewind).toBeHidden();
    await expect.poll(() => stat(path).then(() => true).catch(() => false)).toBe(false);
    await expect(card(page)).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop, a chat in a folder: music shows in its card, and a saved one is among the Output files', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(AUDIO_SETTINGS);
  const folder = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, folder);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await chatInFolder(page, folder);

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(generate({ kind: 'music', prompt: 'A short upbeat jingle for the quarterly report', seconds: 15 }));
    await box.press('Enter');
    await page.getByRole('region', { name: /Allow Atelier to make music/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(card(page)).toBeVisible({ timeout: 30_000 });
    await expect(card(page).getByText('Music', { exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const id = await lastSoundId(page);
    await box.fill(call('SaveAudio', { audio: id, file_path: join(folder, 'jingle.mp3') }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save jingle\.mp3\?/i }).getByRole('button', { name: 'Allow once' }).click();
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    await expect(panel.getByRole('region', { name: 'Output files' }).getByRole('button', { name: /^jingle\.mp3/ })).toBeVisible();
    await shot(page, 'desktop-audio-cowork-output');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
