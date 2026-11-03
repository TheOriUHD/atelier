import { expect, test, type Locator, type Page } from '@playwright/test';
import { call, fakeVideoJobs, settled } from './fixtures.ts';

/**
 * Video generation in the browser, against the scripted fake video service (e2e/fake-video.mjs): the frame, the status
 * line, the player, byte ranges, stopping, failures, the Images page, Settings and Usage. The clip is a real WebM.
 */
async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

const generate = (input: Record<string, unknown>) => call('GenerateVideo', input);
const newest = (page: Page) => page.getByRole('figure').last();
const frame = (figure: Locator) => figure.locator('.group\\/video');
const player = (figure: Locator) => figure.locator('video');
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 40_000 });

/** A new chat on the fake model with the full prompt, whose GenerateVideo takes `resolution` and `audio`. */
async function onFullModel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'fake-chat:8b' }).click();
  await page.getByRole('menuitemradio', { name: /^fake-eyes:8b/ }).click();
  await page.keyboard.press('Escape');
}

test('the frame has the clip’s shape from the first moment, and the player lands in it, playing nothing until asked', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'An unhurried drive along the coast at dusk', aspect_ratio: '16:9', seconds: 5 }));
  const figure = newest(page);
  const status = figure.getByRole('status').first();
  // Waiting in the service's queue, then making it: one line says which.
  await expect(status).toHaveText(/^(Waiting in line|Loading the model|Making a 5 s video)$/, { timeout: 10_000 });
  await expect(player(figure)).toHaveCount(0);
  await expect.poll(async () => { const box = (await frame(figure).boundingBox())!; return (box.width / box.height).toFixed(2); }).toBe('1.78');
  await settled(frame(figure));
  const running = (await frame(figure).boundingBox())!;
  expect(running.width).toBeGreaterThan(500);

  await expect(player(figure)).toBeVisible({ timeout: 40_000 });
  const done = (await frame(figure).boundingBox())!;
  expect(done.width).toBeCloseTo(running.width, 0);
  expect(done.height).toBeCloseTo(running.height, 0);
  expect(done.x).toBeCloseTo(running.x, 0);

  // A real clip: the browser read its size and length from the file, which only works if the bytes arrive as a video.
  await expect.poll(() => player(figure).evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(640);
  expect(await player(figure).evaluate((el: HTMLVideoElement) => Math.round(el.duration))).toBe(3);
  expect(await player(figure).evaluate((el: HTMLVideoElement) => ({ controls: el.controls, loop: el.loop, muted: el.muted, inline: el.hasAttribute('playsinline') }))).toEqual({ controls: true, loop: true, muted: true, inline: true });
  await idle(page);
  await expect(figure.getByRole('button', { name: /^Show the prompt/ })).toHaveText(/An unhurried drive along the coast/);

  // It was made at the length asked for, and told nothing about sound, which this model does not make.
  const [job] = (await fakeVideoJobs()).slice(-1);
  expect(job).toMatchObject({ model: 'fake/dusk', duration: 5, aspectRatio: '16:9', audio: null, frames: [] });
  expect(job!.polls).toBeGreaterThan(1);
  expect(job!.downloaded).toBe(1);

  // After a reload it is simply there, in the same shape.
  await page.reload();
  await expect(player(newest(page))).toBeVisible();
  expect((await frame(newest(page)).boundingBox())!.width).toBe(done.width);
});

test('the server serves the clip in ranges, so it seeks, and with the headers that keep a file from being a page', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A short clip of waves, to seek in', aspect_ratio: '16:9' }));
  const figure = newest(page);
  await expect(player(figure)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => player(figure).evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
  const src = await player(figure).evaluate((el: HTMLVideoElement) => el.currentSrc);
  // The address carries `#t=0.001` so the first frame shows before anything plays.
  expect(src).toMatch(/\/api\/blobs\/[0-9a-f]{64}#t=0\.001$/);

  const probe = await page.evaluate(async (url) => {
    const ask = async (range?: string) => {
      // No cache: the player has the whole file already, and the cache would answer a range itself.
      const res = await fetch(url, { cache: 'no-store', ...(range ? { headers: { range } } : {}) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get('content-type'), range: res.headers.get('content-range'), length: res.headers.get('content-length'), accept: res.headers.get('accept-ranges'), nosniff: res.headers.get('x-content-type-options'), csp: res.headers.get('content-security-policy'), disposition: res.headers.get('content-disposition'), size: bytes.length, first: Array.from(bytes.slice(0, 4)) };
    };
    return { whole: await ask(), start: await ask('bytes=0-99'), middle: await ask('bytes=1000-1099'), tail: await ask('bytes=-50'), past: await ask('bytes=99999999-') };
  }, src.replace(/#.*$/, ''));
  expect(probe.whole).toMatchObject({ status: 200, type: 'video/webm', accept: 'bytes', nosniff: 'nosniff', csp: "default-src 'none'; sandbox", disposition: 'inline' });
  // The EBML magic every WebM starts with.
  expect(probe.whole.first).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  const size = probe.whole.size;
  expect(probe.start).toMatchObject({ status: 206, range: `bytes 0-99/${size}`, size: 100, type: 'video/webm' });
  expect(probe.middle).toMatchObject({ status: 206, range: `bytes 1000-1099/${size}`, size: 100 });
  expect(probe.tail).toMatchObject({ status: 206, range: `bytes ${size - 50}-${size - 1}/${size}`, size: 50 });
  expect(probe.past).toMatchObject({ status: 416, range: `bytes */${size}` });

  // And the player really seeks in it.
  const sought = await player(figure).evaluate(
    (el: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        el.addEventListener('seeked', () => resolve(el.currentTime), { once: true });
        el.currentTime = 1.5;
      }),
  );
  expect(sought).toBeCloseTo(1.5, 1);
});

test('a clip plays when asked, and stops at the end of the loop only when paused', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A clip that plays', aspect_ratio: '16:9' }));
  const figure = newest(page);
  await expect(player(figure)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  // Reload so it counts as an old message: it waits to be played.
  await page.reload();
  const clip = player(newest(page));
  await expect(clip).toBeVisible();
  expect(await clip.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await clip.evaluate((el: HTMLVideoElement) => el.play());
  await expect.poll(() => clip.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.3);
  await clip.evaluate((el: HTMLVideoElement) => el.pause());
  expect(await clip.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
});

test('the first frame goes into the message box as a reference picture', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A clip to take a frame from', aspect_ratio: '16:9' }));
  const figure = newest(page);
  await expect(player(figure)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await frame(figure).hover();
  await figure.getByRole('button', { name: 'Use first frame as reference' }).click();
  await expect(page.getByRole('button', { name: 'Open first-frame.png' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
});

test('a clip opens larger in a viewer with its details, plays there, and Escape closes it', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A clip for the viewer', aspect_ratio: '16:9', seconds: 8 }));
  const figure = newest(page);
  await expect(player(figure)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await frame(figure).hover();
  await figure.getByRole('button', { name: 'Open larger' }).click();
  const viewer = page.getByRole('dialog', { name: 'Video' });
  await expect(viewer.locator('video')).toBeVisible();
  const shown = (await viewer.locator('video').boundingBox())!;
  const window = page.viewportSize()!;
  expect(shown.width).toBeLessThanOrEqual(window.width);
  expect(shown.width / shown.height).toBeCloseTo(16 / 9, 1);
  await viewer.getByRole('button', { name: 'Details' }).click();
  const details = viewer.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Fake Dusk');
  await expect(details).toContainText('0:03');
  await expect(details).toContainText('640 × 360');
  await expect(details).toContainText('$0.25');
  await expect(details).toContainText('A clip for the viewer');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('stopping mid-run says so and stops asking the service', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A clip that takes forever to finish', aspect_ratio: '16:9' }));
  const figure = newest(page);
  await expect(figure.getByRole('status').first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await fakeVideoJobs()).at(-1)?.polls ?? 0, { timeout: 15_000 }).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(figure.getByText('Stopped before it finished.')).toBeVisible();
  const polls = (await fakeVideoJobs()).at(-1)!.polls;
  await page.waitForTimeout(4_000);
  expect((await fakeVideoJobs()).at(-1)!.polls).toBe(polls);
});

test('a refusal is final and said in plain words, with no retry in the message', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'Something forbidden, as a short clip' }));
  const figure = newest(page);
  await expect(figure.getByText(/refused this/)).toBeVisible({ timeout: 20_000 });
  await expect(figure.getByText('That is final')).toHaveCount(0);
  await idle(page);
  expect((await fakeVideoJobs()).filter((j) => /forbidden/.test(j.prompt))).toHaveLength(0);
});

test('failures say what happened: a job that fails, a download that is not a video, a server error', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A faulty clip' }));
  await expect(newest(page).getByText('Fake Video: The provider could not finish this clip.')).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await send(page, generate({ prompt: 'A garbage clip' }));
  await expect(newest(page).getByText(/isn't an MP4 or WebM/)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await send(page, generate({ prompt: 'A broken clip' }));
  await expect(newest(page).getByText(/trouble|failed|error/i)).toBeVisible({ timeout: 30_000 });
});

test('a call that asks for more than the model gives is fitted to it, and the model is told', async ({ page }) => {
  await onFullModel(page);
  await send(page, generate({ prompt: 'A clip of nine seconds in high resolution', seconds: 9, resolution: '4k', aspect_ratio: '9:16', seed: 11, audio: true }));
  const figure = newest(page);
  await expect(player(figure)).toBeVisible({ timeout: 30_000 });
  // The nearest length it makes, a resolution it has, sound left out because it makes none.
  const job = (await fakeVideoJobs()).at(-1)!;
  expect(job).toMatchObject({ duration: 8, resolution: '720p', aspectRatio: '9:16', seed: 11 });
  expect(job.audio).toBeNull();
  await expect.poll(async () => { const box = (await frame(figure).boundingBox())!; return (box.width / box.height).toFixed(2); }).toBe('1.78');
});

test('a picture from the conversation becomes the first frame, sent to a model that takes one', async ({ page }) => {
  await page.goto('/');
  await send(page, call('GenerateImage', { prompt: 'A pale sky over the harbour' }));
  await expect(page.getByRole('figure').last().getByRole('button', { name: /^Open image/ })).toBeVisible({ timeout: 30_000 });
  await idle(page);
  const id = /img_[0-9a-f]{8}/.exec(await page.getByText(/^Tool result: Generated an image/).last().innerText())![0];

  await send(page, generate({ prompt: 'Let the clouds drift', first_frame: id, model: 'fake-video/fake/animator' }));
  await expect(player(newest(page))).toBeVisible({ timeout: 30_000 });
  expect((await fakeVideoJobs()).at(-1)).toMatchObject({ model: 'fake/animator', frames: ['first_frame'] });

  // A frame that isn't a picture of this conversation is said plainly, and nothing is sent.
  await idle(page);
  const before = (await fakeVideoJobs()).length;
  await send(page, generate({ prompt: 'From nowhere', first_frame: 'img_00000000' }));
  await expect(newest(page).getByText(/There's no image img_00000000 in this conversation/)).toBeVisible({ timeout: 15_000 });
  expect((await fakeVideoJobs()).length).toBe(before);
});

test.describe('beside the pictures', () => {
  test('the Images page shows the clips with a play mark, filters by kind, and plays one in the viewer', async ({ page }) => {
    await page.goto('/#/images');
    await expect(page.getByRole('radio', { name: 'Videos' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Play video/ }).first()).toBeVisible();
    await page.getByRole('radio', { name: 'Videos' }).click();
    await expect(page.getByRole('button', { name: /^Play video/ }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Images' }).getByRole('img')).toHaveCount(0);
    const tile = page.getByRole('button', { name: /^Play video: A clip for the viewer/ });
    await expect(tile).toContainText('0:03');
    await tile.click();
    const viewer = page.getByRole('dialog', { name: 'Video' });
    await expect(viewer.locator('video')).toBeVisible();
    await expect.poll(() => viewer.locator('video').evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(640);
    await expect(viewer.getByRole('complementary', { name: 'Details' })).toContainText('Fake Dusk');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await page.getByRole('radio', { name: 'Images' }).click();
    await expect(page.getByRole('button', { name: /^Play video/ })).toHaveCount(0);
  });

  test('Settings lists the video models as video, with a default of their own and limits', async ({ page }) => {
    await page.goto('/#/?settings=image-providers');
    const row = page.getByRole('row', { name: /Fake Dusk/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    for (const text of ['Video', '3–8 s', 'Starts from a picture']) await expect(row.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Fake Animator/ }).getByText('Sound', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Default video model for everyone' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Videos per turn' })).toHaveAttribute('placeholder', '2');
    await expect(page.getByRole('switch', { name: 'Let models make videos' })).toBeChecked();
  });

  test('Usage counts the videos and their seconds apart from tokens', async ({ page }) => {
    await page.goto('/#/?settings=usage');
    const table = page.getByRole('table', { name: 'Videos' });
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(table.getByRole('row', { name: /Fake Dusk/ })).toContainText('$');
  });
});
