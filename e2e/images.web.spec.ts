import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { call, fakeImageJobs, scriptProgress, settled } from './fixtures.ts';

/** A solid PNG of `width`×`height`, so the lightbox has an aspect ratio to keep. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

test('an attached image opens bigger in the lightbox, fitted to the window, and Escape closes it', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png(1600, 400) });
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Look at this');
  await box.press('Enter');
  await expect(page.getByText(/You said: .*Look at this/).first()).toBeVisible();

  const attachment = page.getByRole('button', { name: 'Attachment' });
  await expect(attachment).toHaveCSS('cursor', 'zoom-in');
  await attachment.click();
  const lightbox = page.getByRole('dialog', { name: 'Image' });
  const image = lightbox.locator('img');
  await expect(image).toBeVisible();
  const viewport = page.viewportSize()!;
  const shown = (await image.boundingBox())!;
  expect(shown.width).toBeLessThanOrEqual(viewport.width * 0.9 + 1);
  expect(shown.width / shown.height).toBeCloseTo(4, 1);
  await expect(lightbox.getByRole('button', { name: 'Next image' })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

const generate = (input: Record<string, unknown>) => call('GenerateImage', input);

/** The conversation's newest generated image, or the frame it is being made in. */
const newest = (page: Page) => page.getByRole('figure').last();
const openButton = (figure: Locator) => figure.getByRole('button', { name: /^Open image/ });
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

/** A new chat on the fake model with the full prompt, whose GenerateImage takes `count`. */
async function onFullModel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'fake-chat:8b' }).click();
  await page.getByRole('menuitemradio', { name: /^fake-eyes:8b/ }).click();
  await page.keyboard.press('Escape');
}

/** One RPC call with the page's own sign-in, for what has no screen yet. */
function rpc<T>(page: Page, method: string, params: unknown): Promise<T> {
  return page.evaluate(
    ({ method, params }) =>
      new Promise<T>((resolve, reject) => {
        const url = new URL('api/ws', document.baseURI);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url);
        socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
        socket.onmessage = (e: MessageEvent<string>) => {
          const message = JSON.parse(e.data) as { id?: number; result?: T; error?: { message: string } };
          if (message.id !== 1) return;
          socket.close();
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result!);
        };
      }),
    { method, params },
  );
}

test('the frame has the image’s shape before the image, and the image lands in it, big', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'An unhurried poster for a summer party on the shore', aspect_ratio: '3:2' }));

  const figure = newest(page);
  const frameBox = async () => (await figure.locator('.group\\/image').boundingBox())!;
  await expect(figure.getByRole('status').first()).toHaveText('Making the image', { timeout: 10_000 });
  await expect(openButton(figure)).toHaveCount(0);
  // The backend settled on 1536×1024 from the first moment, not a square that changes later.
  await expect.poll(async () => { const { width, height } = await frameBox(); return (width / height).toFixed(2); }).toBe('1.50');
  await settled(figure.locator('.group\\/image'));
  const running = await frameBox();
  expect(running.width).toBeGreaterThan(700);

  // The picture forms inside the frame, blurred, before there is an image.
  const preview = figure.locator('img[src^="data:"]').first();
  await expect(preview).toBeVisible({ timeout: 10_000 });
  expect(await preview.evaluate((el) => getComputedStyle(el.parentElement!).filter)).toMatch(/blur/);

  // It arrives in the same place: nothing moves.
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  const done = await frameBox();
  expect({ width: done.width, height: done.height }).toEqual({ width: running.width, height: running.height });
  expect(done.x).toBe(running.x);
  await expect.poll(() => figure.locator('img[data-loaded]').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1536);

  // The preview makes way once the image has taken over, and the prompt stands where the status stood.
  await expect(figure.locator('img[src^="data:"]')).toHaveCount(0);
  await expect(figure.getByRole('button', { name: /^Show the prompt/ })).toHaveText(/An unhurried poster/);
  await idle(page);

  // A reply follows, with its actions, and after a reload the image is simply there.
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).last()).toBeAttached();
  await page.reload();
  await expect(openButton(newest(page))).toBeVisible();
  const again = await newest(page).locator('.group\\/image').boundingBox();
  expect(again?.width).toBe(done.width);
});

test('one line says exactly what is going on, from the queue to the last step, with a thin bar', async ({ page }) => {
  await scriptProgress(page, [
    { phase: 'queued', ahead: 2 },
    { phase: 'freeing' },
    { phase: 'loading' },
    { phase: 'generating', step: 12, steps: 28, etaMs: 20_000 },
    { phase: 'generating', step: 27, steps: 28, etaMs: 1_000 },
  ]);
  await page.goto('/');
  await send(page, generate({ prompt: 'A view that takes forever', aspect_ratio: '3:2' }));
  const figure = newest(page);
  const status = figure.getByRole('status').first();
  await expect(status).toHaveText('2 ahead of you', { timeout: 10_000 });
  await expect(figure.getByRole('progressbar')).toHaveCount(0);
  await expect(status).toHaveText('Freeing the GPU', { timeout: 10_000 });
  await expect(status).toHaveText('Loading the model', { timeout: 10_000 });
  await expect(status).toHaveText('Step 12 of 28 · about 20 s', { timeout: 10_000 });
  const bar = figure.getByRole('progressbar', { name: 'Making the image' });
  await expect(bar).toHaveAttribute('aria-valuenow', '43');
  const height = (await bar.boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(2);
  await expect(status).toHaveText('Step 27 of 28 · about 1 s', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(figure.getByText('Stopped before it finished.')).toBeVisible();
});

test('progress survives a reload: the frame comes back with its shape while the run goes on', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'An unhurried panorama of the coast at low tide', aspect_ratio: '3:2' }));
  const figure = newest(page);
  await expect(figure.locator('img[src^="data:"]').first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(figure.getByRole('status').first()).toHaveText('Making the image');
  await expect.poll(async () => { const box = (await figure.locator('.group\\/image').boundingBox())!; return (box.width / box.height).toFixed(2); }).toBe('1.50');
  await expect(figure.locator('img[src^="data:"]').first()).toBeVisible();
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
});

test('the lightbox zooms and pans, and shows what is known about the image', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A view of a bridge over a calm river', aspect_ratio: '3:2' }));
  const figure = newest(page);
  await openButton(figure).click();

  const lightbox = page.getByRole('dialog', { name: 'Image' });
  const image = lightbox.locator('img');
  await expect(image).toBeVisible();
  const scale = () => image.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  expect(await scale()).toBe(1);

  // The wheel zooms in, around the pointer.
  const box = (await image.boundingBox())!;
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4);
  await page.mouse.wheel(0, -300);
  await expect.poll(scale).toBeGreaterThan(1.5);
  await expect(lightbox.getByRole('status')).toHaveText(/^\d+%$/);

  // A drag moves it, and it stops at the edges.
  const zoomed = (await image.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())!.x).not.toBe(zoomed.x);

  // 0 fits it again; a double-click goes to actual pixels and back.
  await page.keyboard.press('0');
  await expect.poll(scale).toBe(1);
  await expect(lightbox.getByRole('status')).toHaveText('Fit');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(scale).toBeGreaterThan(1.5);
  await expect(lightbox.getByRole('status')).toHaveText('100%');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(scale).toBe(1);

  // The keys, and the buttons for those without a wheel.
  await page.keyboard.press('+');
  await expect.poll(scale).toBeCloseTo(1.5);
  await page.keyboard.press('-');
  await expect.poll(scale).toBe(1);
  await lightbox.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(scale).toBeCloseTo(1.5);
  await lightbox.getByRole('button', { name: 'Fit to window' }).click();
  await expect.poll(scale).toBe(1);

  // A click on the image while it is there doesn't close the lightbox; beside it does.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(lightbox).toBeVisible();

  await lightbox.getByRole('button', { name: 'Details' }).click();
  const details = lightbox.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('gpt-image-fake');
  await expect(details).toContainText('1536 × 1024');
  await expect(details).toContainText('A view of a bridge over a calm river');
  // The panel keeps clear of the image.
  const panel = (await details.boundingBox())!;
  await expect.poll(async () => { const shown = (await image.boundingBox())!; return shown.x + shown.width; }).toBeLessThanOrEqual(panel.x);

  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // Details from the image itself opens straight on the panel.
  await openButton(figure).hover();
  await figure.getByRole('button', { name: 'Details' }).click();
  await expect(details).toBeVisible();
});

test('what the service made of the prompt shows under the image, and in the details', async ({ page }) => {
  await page.goto('/');
  // This model answers in one piece, which is where the service says how it reworded the prompt.
  await send(page, generate({ prompt: 'A reworded view of a bridge', model: 'stable-diffusion-fake' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  await expect(figure.getByText(/in the evening light/)).toHaveCount(0);
  await figure.getByRole('button', { name: /^Show the prompt/ }).click();
  await expect(figure.getByText('A reworded view of a bridge', { exact: true })).toBeVisible();
  await expect(figure.getByText(/Reworded by the service: .*in the evening light/)).toBeVisible();
  await figure.getByRole('button', { name: 'Hide the prompt' }).click();
  await expect(figure.getByText(/in the evening light/)).toHaveCount(0);
  await openButton(figure).click();
  await page.getByRole('button', { name: 'Details' }).last().click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('in the evening light');
});

test('download saves the image under a name from its prompt', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A chart-free picture of a red kite on a windy day!' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  await openButton(figure).hover();
  const [download] = await Promise.all([page.waitForEvent('download'), figure.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^a-chart-free-picture-of-a-red-kite-on-a-[0-9a-f]{6}\.png$/);
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
});

test('copy puts a PNG on the clipboard, and is gone where the browser can’t', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await send(page, generate({ prompt: 'A small boat on a still lake' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  await openButton(figure).hover();
  await figure.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(figure.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(async () => (await navigator.clipboard.read())[0]?.types)).toContain('image/png');

  // As on a server reached over plain http, where the Clipboard API doesn't exist.
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await page.reload();
  await expect(openButton(newest(page))).toBeVisible();
  await openButton(newest(page)).hover();
  await expect(newest(page).getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(newest(page).getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
});

test('four images share the column in a grid, and step through in the lightbox', async ({ page }) => {
  await onFullModel(page);
  await send(page, generate({ prompt: 'Four studies of the same hills', aspect_ratio: '1:1', count: 4 }));
  const figure = newest(page);
  // All four frames stand from the start.
  await expect(figure.locator('.group\\/image')).toHaveCount(4);
  await expect(openButton(figure)).toHaveCount(4, { timeout: 30_000 });
  const boxes = await Promise.all((await openButton(figure).all()).map(async (b) => (await b.boundingBox())!));
  expect(boxes[0]!.y).toBe(boxes[1]!.y);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
  expect(boxes[0]!.width).toBeCloseTo(boxes[3]!.width, 0);
  expect(boxes[0]!.width / boxes[0]!.height).toBeCloseTo(1, 1);

  await openButton(figure).nth(1).click();
  const lightbox = page.getByRole('dialog', { name: 'Image' });
  await expect(lightbox.getByText('2 of 4')).toBeVisible();
  // The keys work once focus has moved into the lightbox.
  await expect.poll(() => lightbox.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(lightbox.getByText('3 of 4')).toBeVisible();
});

test('never taller than the window allows: a portrait image keeps its proportions', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A tall portrait of a lighthouse keeper', aspect_ratio: '2:3' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  const frame = (await figure.locator('.group\\/image').boundingBox())!;
  expect(frame.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.72 + 1);
  expect(frame.width / frame.height).toBeCloseTo(2 / 3, 1);
});

test('stop mid-run says so, keeps the preview and stops the server', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A view that takes forever to finish', aspect_ratio: '3:2' }));
  const figure = newest(page);
  await expect(figure.locator('img[src^="data:"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(figure.getByText('Stopped before it finished.')).toBeVisible();
  await expect(figure.locator('img[src^="data:"]').first()).toBeVisible();
  await expect(openButton(figure)).toHaveCount(0);
  await expect.poll(async () => (await fakeImageJobs()).findLast((j) => j.prompt.includes('forever'))?.stopped).toBe(true);
});

test('stopped before any preview, the words take the frame’s place', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A view that takes forever', aspect_ratio: '3:2' }));
  const figure = newest(page);
  await expect(figure.getByRole('status').first()).toHaveText('Making the image', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(figure.getByText('Stopped before it finished.')).toBeVisible();
  await expect(figure.locator('.group\\/image')).toHaveCount(0);
});

test('a refusal says so plainly, without the words meant for the model', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'Something forbidden' }));
  const figure = newest(page);
  await expect(figure.getByText(/^Fake Images refused this:.*content policy/)).toBeVisible({ timeout: 15_000 });
  await expect(figure.getByText(/That is final/)).toHaveCount(0);
  await expect(figure.locator('.group\\/image')).toHaveCount(0);
  await expect(figure.getByRole('button', { name: /^Show the prompt/ })).toHaveText('Something forbidden');
  await idle(page);
});

test('a broken server is reported, with no settings link for what isn’t a setup problem', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A broken thing' }));
  const figure = newest(page);
  await expect(figure.getByText(/The server fell over/)).toBeVisible({ timeout: 15_000 });
  await expect(figure.getByRole('button', { name: 'Fix in Settings' })).toHaveCount(0);
});

test('an image is edited by its id, and the model sends it to the server as the reference', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A pale sky over the harbour' }));
  await expect(openButton(newest(page))).toBeVisible({ timeout: 30_000 });
  await idle(page);
  const reply = await page.getByText(/^Tool result: Generated an image/).last().innerText();
  const id = /img_[0-9a-f]{8}/.exec(reply)![0];

  await send(page, generate({ prompt: 'Make the sky darker', reference_images: [id] }));
  await expect(page.getByRole('figure')).toHaveCount(2, { timeout: 10_000 });
  await expect(openButton(newest(page))).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await fakeImageJobs()).at(-1)).toMatchObject({ api: 'edits', prompt: 'Make the sky darker', inputs: 1 });
  expect((await fakeImageJobs()).at(-1)!.inputBytes).toBeGreaterThan(1000);

  // An id from nowhere comes back as a quiet message listing what there is.
  await idle(page);
  await send(page, generate({ prompt: 'Change it again', reference_images: ['img_00000000'] }));
  await expect(newest(page).getByText(/no image img_00000000 in this conversation/)).toBeVisible({ timeout: 15_000 });
});

test('use as reference puts the image in the message box, once', async ({ page }) => {
  await page.goto('/');
  await send(page, generate({ prompt: 'A lamp on a wooden table' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await openButton(figure).hover();
  await figure.getByRole('button', { name: 'Use as reference' }).click();
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(box).toBeFocused();
  const tile = page.getByRole('button', { name: 'Open Image.png' });
  await expect(tile).toHaveCount(1);
  await openButton(figure).hover();
  await figure.getByRole('button', { name: 'Use as reference' }).click();
  await expect(tile).toHaveCount(1);

  // From the lightbox too; it closes, and the person's next move is in the message box.
  await tile.hover();
  await page.getByRole('button', { name: 'Remove Image.png' }).click();
  await expect(tile).toHaveCount(0);
  await openButton(figure).click();
  await page.getByRole('dialog', { name: 'Image' }).getByRole('button', { name: 'Use as reference' }).click();
  await expect(page.getByRole('dialog', { name: 'Image' })).toHaveCount(0);
  await expect(tile).toHaveCount(1);
  await expect(box).toBeFocused();

  await box.fill('Look at this one');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Attachment' })).toBeVisible();
});

test('a temporary chat’s image stays out of the person’s images, an ordinary chat’s doesn’t', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Temporary chat' }).click();
  await send(page, generate({ prompt: 'quokka in a temporary chat' }));
  await expect(openButton(newest(page))).toBeVisible({ timeout: 30_000 });

  await page.goto('/');
  await page.reload();
  await send(page, generate({ prompt: 'quokka in an ordinary chat' }));
  await expect(openButton(newest(page))).toBeVisible({ timeout: 30_000 });

  const { items } = await rpc<{ items: { prompt: string }[] }>(page, 'generatedImages.list', { query: 'quokka' });
  expect(items.map((i) => i.prompt)).toEqual(['quokka in an ordinary chat']);
});

test('reduced motion: no sheen moves across the frame, and the status still says what is going on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await send(page, generate({ prompt: 'An unhurried study of still water' }));
  const figure = newest(page);
  await expect(figure.getByRole('status').first()).toHaveText('Making the image', { timeout: 10_000 });
  const sheen = figure.locator('.at-image-sheen');
  await expect(sheen).toBeAttached();
  expect(await sheen.evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('no serious accessibility problems while an image is made, once it is there, or in the lightbox', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = async () => {
    const { violations } = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
  };
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await send(page, generate({ prompt: 'An unhurried study of still water', aspect_ratio: '3:2' }));
    const figure = newest(page);
    await expect(figure.locator('img[src^="data:"]').first()).toBeVisible({ timeout: 10_000 });
    expect(await problems()).toEqual([]);
    await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
    await idle(page);
    await figure.getByRole('button', { name: /^Show the prompt/ }).click();
    expect(await problems()).toEqual([]);
    await openButton(figure).click();
    await page.getByRole('dialog', { name: 'Image' }).getByRole('button', { name: 'Details' }).click();
    await page.getByRole('complementary', { name: 'Details' }).waitFor();
    const { violations } = await new AxeBuilder({ page }).include('[role=dialog]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
    await page.keyboard.press('Escape');
  }
});

test('on a phone the actions are there without hovering, and the image fills the width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await send(page, generate({ prompt: 'A kite above the dunes', aspect_ratio: '3:2' }));
  const figure = newest(page);
  await expect(openButton(figure)).toBeVisible({ timeout: 30_000 });
  await expect(figure.getByRole('button', { name: 'Download' })).toBeVisible();
  const opacity = await figure.getByRole('button', { name: 'Download' }).evaluate((el) => getComputedStyle(el.parentElement!.parentElement!.closest('.absolute') ?? el).opacity);
  expect(opacity).toBe('1');
  const frame = (await figure.locator('.group\\/image').boundingBox())!;
  expect(frame.width).toBeGreaterThan(340);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test.describe('with fingers', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('two fingers pinch the image in the lightbox, and a double tap zooms it', async ({ page }) => {
    await page.goto('/');
    await send(page, generate({ prompt: 'A lighthouse seen from the water' }));
    await expect(openButton(newest(page))).toBeVisible({ timeout: 30_000 });
    await idle(page);
    await openButton(newest(page)).tap();
    const image = page.getByRole('dialog', { name: 'Image' }).locator('img');
    await expect(image).toBeVisible();
    const scale = () => image.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: { id: number; x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [{ id: 0, x: 150, y: 420 }, { id: 1, x: 240, y: 420 }]);
    await touch('touchMove', [{ id: 0, x: 90, y: 420 }, { id: 1, x: 300, y: 420 }]);
    await expect.poll(scale).toBeGreaterThan(2);
    await touch('touchEnd', []);
    await expect.poll(scale).toBeGreaterThan(2);

    // Back out with fingers, then a double tap.
    await touch('touchStart', [{ id: 0, x: 90, y: 420 }, { id: 1, x: 300, y: 420 }]);
    await touch('touchMove', [{ id: 0, x: 190, y: 420 }, { id: 1, x: 200, y: 420 }]);
    await touch('touchEnd', []);
    await expect.poll(scale).toBe(1);
    await page.touchscreen.tap(195, 420);
    await page.touchscreen.tap(195, 420);
    await expect.poll(scale).toBeGreaterThan(1);
  });
});

test('on a phone a grid’s images fold their actions into one button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await onFullModel(page);
  await send(page, generate({ prompt: 'Four studies of the same dunes', aspect_ratio: '1:1', count: 4 }));
  const figure = newest(page);
  await expect(openButton(figure)).toHaveCount(4, { timeout: 30_000 });
  await expect(figure.getByRole('button', { name: 'Download' })).toHaveCount(0);
  await figure.getByRole('button', { name: 'Image actions' }).nth(2).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^four-studies-of-the-same-dunes-/);
});
