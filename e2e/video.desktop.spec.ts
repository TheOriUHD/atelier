import { readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { VIDEO_SETTINGS, call, fakeVideoJobs, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

const generate = (input: Record<string, unknown>) => call('GenerateVideo', input);
const newest = (page: Page) => page.getByRole('figure').last();
const player = (page: Page) => newest(page).locator('video');

/** A picture of the window for a person to look at, when ATELIER_E2E_SHOTS says where; the window stays hidden. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.ATELIER_E2E_SHOTS;
  if (folder) await page.screenshot({ path: join(folder, `${name}.png`) });
}

/** The id the model got for the video it just made, as the scripted reply repeats it. */
async function lastVideoId(page: Page): Promise<string> {
  const reply = await page.getByText(/^Tool result: Generated a video/).last().innerText();
  return /vid_[0-9a-f]{8}/.exec(reply)![0];
}

test('desktop Code: Ask shows what will be made, the clip plays through the app’s own scheme in ranges, SaveVideo writes it and Rewind takes it back', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(VIDEO_SETTINGS);
  const repo = await tempRepo();
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
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    // Ask mode: the card says what will be made, and the frame waits quietly for the answer.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(generate({ prompt: 'A slow drive along the coast at dusk', aspect_ratio: '16:9', seconds: 5 }));
    await box.press('Enter');
    const ask = page.getByRole('region', { name: /Allow Atelier to make a video/ });
    await expect(ask).toContainText('A slow drive along the coast at dusk');
    await expect(newest(page).getByRole('status').first()).toHaveText('Waiting for your answer');
    await shot(page, 'desktop-video-ask');
    await ask.getByRole('button', { name: 'Allow once' }).click();

    await expect(newest(page).getByRole('status').first()).toHaveText(/^(Waiting in line|Making a 5 s video)$/, { timeout: 15_000 });
    await shot(page, 'desktop-video-running');
    await expect(player(page)).toBeVisible({ timeout: 40_000 });
    await expect.poll(() => player(page).evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(640);
    await shot(page, 'desktop-video-done');
    expect((await fakeVideoJobs()).at(-1)).toMatchObject({ model: 'fake/dusk', duration: 5, aspectRatio: '16:9' });

    // The clip comes through the app's own scheme, which answers ranges: a player seeks with them.
    const src = await player(page).evaluate((el: HTMLVideoElement) => el.currentSrc.replace(/#.*$/, ''));
    expect(src).toMatch(/^atelier-blob:\/\/[0-9a-f]{64}\/?$/);
    const probe = await page.evaluate(async (url) => {
      const ask = async (range?: string) => {
        const res = await fetch(url, range ? { headers: { range } } : {});
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, type: res.headers.get('content-type'), range: res.headers.get('content-range'), accept: res.headers.get('accept-ranges'), size: bytes.length, first: Array.from(bytes.slice(0, 4)) };
      };
      return { whole: await ask(), start: await ask('bytes=0-99'), middle: await ask('bytes=1000-1099') };
    }, src);
    expect(probe.whole).toMatchObject({ status: 200, type: 'video/webm', accept: 'bytes', first: [0x1a, 0x45, 0xdf, 0xa3] });
    expect(probe.start).toMatchObject({ status: 206, range: `bytes 0-99/${probe.whole.size}`, size: 100 });
    expect(probe.middle).toMatchObject({ status: 206, range: `bytes 1000-1099/${probe.whole.size}`, size: 100 });
    const sought = await player(page).evaluate((el: HTMLVideoElement) => new Promise<number>((resolve) => { el.addEventListener('seeked', () => resolve(el.currentTime), { once: true }); el.currentTime = 1.5; }));
    expect(sought).toBeCloseTo(1.5, 1);

    // What it cost: the service said, so it is not an estimate.
    await newest(page).locator('.group\\/video').hover();
    await newest(page).getByRole('button', { name: 'Open larger' }).click();
    const viewer = page.getByRole('dialog', { name: 'Video' });
    await viewer.getByRole('button', { name: 'Details' }).click();
    const details = viewer.getByRole('complementary', { name: 'Details' });
    await expect(details).toContainText('$0.25');
    await expect(details).not.toContainText('estimated');
    await shot(page, 'desktop-video-viewer');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);

    // The first frame is taken from a second player on the same scheme (a canvas needs the file to allow it) and attached.
    await newest(page).locator('.group\\/video').hover();
    await newest(page).getByRole('button', { name: 'Use first frame as reference' }).click();
    await expect(page.getByRole('button', { name: 'Open first-frame.png' })).toBeVisible({ timeout: 15_000 });
    await shot(page, 'desktop-video-frame-attached');
    await page.getByRole('button', { name: 'Open first-frame.png' }).hover();
    await page.getByRole('button', { name: 'Remove first-frame.png' }).click();

    const id = await lastVideoId(page);
    // A name that doesn't match what the file is: refused, with what it is, and nothing is written.
    await box.fill(call('SaveVideo', { video: id, file_path: join(repo, 'public', 'intro.mp4') }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save public\/intro\.mp4\?/i }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/This video is a WebM: save it with a \.webm name/)).toBeVisible({ timeout: 15_000 });
    expect(await stat(join(repo, 'public', 'intro.mp4')).then(() => true, () => false)).toBe(false);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

    const path = join(repo, 'public', 'intro.webm');
    await box.fill(call('SaveVideo', { video: id, file_path: path }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save public\/intro\.webm\?/i }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => stat(path).then((s) => s.size).catch(() => 0)).toBeGreaterThan(10_000);
    expect([...(await readFile(path)).subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    // A line with a film mark, not a picture of it.
    await expect(page.getByRole('button', { name: /^Saved intro\.webm/ })).toBeVisible();
    await shot(page, 'desktop-video-saved');

    // Undone by Rewind like any file edit, with the clip itself still higher up.
    await expect(page.getByRole('button', { name: 'Rewind to here' }).last()).toBeEnabled();
    await page.getByRole('button', { name: 'Rewind to here' }).last().click();
    const rewind = page.getByRole('dialog', { name: 'Rewind' });
    await rewind.getByRole('button', { name: 'Restore code and conversation' }).click();
    await expect(rewind).toBeHidden();
    await expect.poll(() => stat(path).then(() => true).catch(() => false)).toBe(false);
    await expect(player(page)).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop Cowork: a clip shows in its frame, and a saved one is among the Output files', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(VIDEO_SETTINGS);
  const folder = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, folder);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Cowork', exact: true }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(folder) })).toBeVisible();

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(generate({ prompt: 'A short intro clip for the quarterly report' }));
    await box.press('Enter');
    await page.getByRole('region', { name: /Allow Atelier to make a video/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(player(page)).toBeVisible({ timeout: 40_000 });
    expect((await newest(page).locator('.group\\/video').boundingBox())!.width).toBeGreaterThan(400);

    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const id = await lastVideoId(page);
    await box.fill(call('SaveVideo', { video: id, file_path: join(folder, 'intro.webm') }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save intro\.webm\?/i }).getByRole('button', { name: 'Allow once' }).click();
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    await expect(panel.getByRole('region', { name: 'Output files' }).getByRole('button', { name: /^intro\.webm/ })).toBeVisible();
    await shot(page, 'desktop-video-cowork-output');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
