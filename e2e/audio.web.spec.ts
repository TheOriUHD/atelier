import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { call, fakeAudioRequests } from './fixtures.ts';

/**
 * Sound generation in the browser, against the scripted fake sound server (e2e/fake-audio.mjs): the card while it is
 * made, the player and its waveform, playing and seeking, byte ranges, failures, the library and Settings. The sounds
 * are real MP3s.
 */
async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

const generate = (input: Record<string, unknown>) => call('GenerateAudio', input);
const newest = (page: Page) => page.getByRole('figure').last();
const card = (figure: Locator) => figure.locator('.group\\/audio');
const audioOf = (figure: Locator) => figure.locator('audio');
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 40_000 });

test('speech holds its place while it is made, then plays in the voice asked for and seeks by keyboard', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ kind: 'speech', text: 'An unhurried welcome to the harbour tour.', voice: 'bm_george' }));
  const figure = newest(page);
  await expect(figure.getByText('Making the speech')).toBeVisible({ timeout: 10_000 });
  await expect(audioOf(figure)).toHaveCount(0);

  await expect(card(figure)).toBeVisible({ timeout: 30_000 });
  await expect(card(figure).getByText('Speech · bm_george')).toBeVisible();
  // A real MP3: the browser read its length from the file.
  await expect.poll(() => audioOf(figure).evaluate((el: HTMLAudioElement) => Math.round(el.duration))).toBe(6);
  await expect(card(figure).getByText('0:00 / 0:06')).toBeVisible();
  expect(await audioOf(figure).evaluate((el: HTMLAudioElement) => ({ paused: el.paused, autoplay: el.autoplay }))).toEqual({ paused: true, autoplay: false });
  await idle(page);
  await expect(figure.getByRole('button', { name: /^Show the prompt/ })).toHaveText(/An unhurried welcome to the harbour tour/);

  // It went to the speech model, in that voice, as an MP3.
  expect((await fakeAudioRequests()).at(-1)).toMatchObject({ route: 'speech', model: 'fake-kokoro', voice: 'bm_george', format: 'mp3' });

  // The waveform was read from the file: bars of different heights.
  await expect.poll(async () => new Set(await card(figure).locator('[role=slider] span.bg-line-stronger').evaluateAll((bars) => bars.map((b) => (b as HTMLElement).style.height))).size).toBeGreaterThan(5);

  // Play, and it plays; the slider follows.
  await card(figure).getByRole('button', { name: 'Play', exact: true }).click();
  await expect(card(figure).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => audioOf(figure).evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0.3);
  await card(figure).getByRole('button', { name: 'Pause', exact: true }).click();
  expect(await audioOf(figure).evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

  const slider = card(figure).getByRole('slider', { name: 'Position' });
  await slider.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => audioOf(figure).evaluate((el: HTMLAudioElement) => Math.round(el.currentTime))).toBe(5);
  await expect(slider).toHaveAttribute('aria-valuetext', '0:05 of 0:06');

  // Faster speech, for those who like it.
  await card(figure).getByRole('button', { name: 'Playback speed, 1×' }).click();
  expect(await audioOf(figure).evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.25);

  // After a reload it is simply there.
  await page.reload();
  await expect(card(newest(page)).getByText('Speech · bm_george')).toBeVisible();
});

test('the server serves a sound inline and in ranges, with the headers that keep a file from being a page', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ kind: 'speech', text: 'A short line to fetch in pieces.' }));
  const figure = newest(page);
  await expect(card(figure)).toBeVisible({ timeout: 30_000 });
  const src = await audioOf(figure).evaluate((el: HTMLAudioElement) => el.currentSrc || el.src);
  expect(src).toMatch(/\/api\/blobs\/[0-9a-f]{64}$/);
  const probe = await page.evaluate(async (url) => {
    const whole = await fetch(url, { cache: 'no-store' });
    const part = await fetch(url, { cache: 'no-store', headers: { range: 'bytes=0-99' } });
    return { type: whole.headers.get('content-type'), disposition: whole.headers.get('content-disposition'), csp: whole.headers.get('content-security-policy'), nosniff: whole.headers.get('x-content-type-options'), status: part.status, length: (await part.arrayBuffer()).byteLength };
  }, src);
  expect(probe).toEqual({ type: 'audio/mpeg', disposition: 'inline', csp: "default-src 'none'; sandbox", nosniff: 'nosniff', status: 206, length: 100 });
});

test('music goes to the music model at the length asked for, and has no speed button', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ kind: 'music', prompt: 'A calm lofi beat for studying', seconds: 20, instrumental: true }));
  const figure = newest(page);
  await expect(card(figure)).toBeVisible({ timeout: 30_000 });
  await expect(card(figure).getByText('Music', { exact: true })).toBeVisible();
  await expect.poll(() => audioOf(figure).evaluate((el: HTMLAudioElement) => Math.round(el.duration))).toBe(12);
  await expect(card(figure).getByRole('button', { name: /Playback speed/ })).toHaveCount(0);
  expect((await fakeAudioRequests()).at(-1)).toMatchObject({ route: 'sound', model: 'fake-ace-step', text: 'A calm lofi beat for studying', seconds: 20, instrumental: true });
  // The details say what it was asked to be.
  await idle(page);
  await card(figure).getByRole('button', { name: 'Details' }).click();
  const details = page.getByRole('dialog', { name: 'Music' });
  await expect(details).toContainText('fake-ace-step');
  await expect(details).toContainText('A calm lofi beat for studying');
  await page.keyboard.press('Escape');
});

test('a refusal is final and said in plain words; a server error and a file that is not a sound say what happened', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ kind: 'speech', text: 'Something forbidden to say.' }));
  await expect(newest(page).getByText(/refused this/)).toBeVisible({ timeout: 20_000 });
  await expect(newest(page).getByText('That is final')).toHaveCount(0);
  await idle(page);
  await send(page, generate({ kind: 'speech', text: 'A garbage answer.' }));
  await expect(newest(page).getByText(/isn't a sound file/)).toBeVisible({ timeout: 20_000 });
  await idle(page);
  await send(page, generate({ kind: 'speech', text: 'A broken server.' }));
  await expect(newest(page).getByText(/trouble|failed|error/i)).toBeVisible({ timeout: 20_000 });
});

test('a kind no model makes is said, and nothing is sent', async ({ page }) => {
  await page.goto('/');
  const before = (await fakeAudioRequests()).length;
  await send(page, generate({ kind: 'speech', text: 'x'.repeat(10), model: 'fake-audio/fake-ace-step' }));
  await expect(newest(page).getByText(/There's no speech model "fake-audio\/fake-ace-step"/)).toBeVisible({ timeout: 15_000 });
  expect((await fakeAudioRequests()).length).toBe(before);
});

test('no serious accessibility problems while a sound is made or once it is there, in light and dark', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = async () => {
    const { violations } = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
  };
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await send(page, generate({ kind: 'speech', text: 'An unhurried line read slowly.' }));
    const figure = newest(page);
    await expect(figure.getByText('Making the speech')).toBeVisible({ timeout: 10_000 });
    expect(await problems()).toEqual([]);
    await expect(card(figure)).toBeVisible({ timeout: 30_000 });
    await idle(page);
    expect(await problems()).toEqual([]);
  }
});

test.describe('in the library and Settings', () => {
  test('the Images page lists the sounds, filters to them, and plays one in its viewer', async ({ page }) => {
    await page.goto('/#/images');
    await expect(page.getByRole('radio', { name: 'Sounds' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio', { name: 'Sounds' }).click();
    const tile = page.getByRole('button', { name: /^Play (speech|music|sound effect):/ }).first();
    await expect(tile).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open image/ })).toHaveCount(0);
    await tile.click();
    const viewer = page.getByRole('dialog');
    await expect(viewer.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Download' }).first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('Settings › Media lists the sound models with what they make, and makes a test sound', async ({ page }) => {
    await page.goto('/#/?settings=image-providers');
    const kokoro = page.getByRole('row', { name: /fake-kokoro/ });
    await expect(kokoro).toBeVisible({ timeout: 15_000 });
    await expect(kokoro.getByText('Speech', { exact: true })).toBeVisible();
    await expect(kokoro.getByText('3 voices')).toBeVisible();
    await expect(page.getByRole('row', { name: /fake-ace-step/ }).getByText('Lyrics')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Let models make sounds' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Sounds per turn' })).toHaveAttribute('placeholder', '6');

    await page.getByRole('button', { name: 'Fake Audio options' }).click();
    await page.getByRole('menuitem', { name: /Edit/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await dialog.getByRole('button', { name: 'Make a test sound' }).click();
    await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 20_000 });
  });
});
