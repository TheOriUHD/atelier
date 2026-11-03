import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { call, fakeImageJobs, settled } from './fixtures.ts';

/**
 * "Change an area" (brush a mask, say what to change) and generated images inside artifacts and visuals. The model is
 * the scripted fake, so what is checked is what Atelier sends it and what the sandbox is given.
 */
const FOLDER = process.env.ATELIER_E2E_SHOTS ?? '';

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
/** Opens the newest artifact from its card (the text "Open", where a picture's own button is "Open image"). */
async function openArtifact(page: Page) {
  await page.getByText('Open', { exact: true }).last().click();
  await expect(page.getByRole('complementary', { name: 'Artifact' }).or(page.getByRole('region', { name: 'Artifact' }))).toBeVisible();
}
const newest = (page: Page) => page.getByRole('figure').last();

/** Makes an image and returns its id, as the model is told it. */
async function made(page: Page, prompt = 'A pale sky over the harbour'): Promise<string> {
  await send(page, call('GenerateImage', { prompt }));
  await expect(newest(page).getByRole('button', { name: /^Open image/ })).toBeVisible({ timeout: 30_000 });
  await idle(page);
  const reply = await page.getByText(/^Tool result: Generated an image/).last().innerText();
  return /img_[0-9a-f]{8}/.exec(reply)![0];
}

/** The blob address of the next file the app uploads, read off the socket: the mask's id is built from it. */
function watchUploads(page: Page): { masks: string[] } {
  const seen = { masks: [] as string[] };
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const text = String(payload);
      if (!text.includes('area-mask.png')) return;
      const blob = /"blob":"([0-9a-f]{64})"/.exec(text)?.[1];
      if (blob) seen.masks.push(`img_${blob.slice(0, 8)}`);
    }),
  );
  return seen;
}

async function openEditor(page: Page) {
  const figure = newest(page);
  await figure.getByRole('button', { name: /^Open image/ }).hover();
  await figure.getByRole('button', { name: 'Change an area' }).click();
  const editor = page.getByRole('dialog', { name: 'Change an area' });
  await expect(editor).toBeVisible();
  const canvas = editor.locator('canvas');
  await expect(canvas).toBeVisible();
  return { editor, canvas };
}

async function brush(page: Page, canvas: ReturnType<typeof page.locator>) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.up();
}

test('brushing part of an image and saying what to change sends the mask with the message', async ({ page }) => {
  const uploads = watchUploads(page);
  await page.goto('/');
  const id = await made(page);

  const { editor, canvas } = await openEditor(page);
  // The mask is made at the picture's real size, not the size it is shown at.
  const [width, height] = await canvas.evaluate((el: HTMLCanvasElement) => [el.width, el.height]);
  expect(width).toBeGreaterThanOrEqual(256);
  expect(width / height).toBeCloseTo(1, 1);
  const generate = editor.getByRole('button', { name: 'Generate' });
  await expect(generate).toBeDisabled();
  await brush(page, canvas);
  await editor.getByRole('textbox', { name: 'What the marked area should become' }).fill('Make the sky purple');
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(editor).toHaveCount(0);

  // The message shows their words and the picture they marked, not the note the model got.
  await expect(page.getByText('Make the sky purple').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'The image, with the area to change marked' })).toBeVisible();
  await idle(page);
  expect(uploads.masks).toHaveLength(1);

  // The model is told the mask's id, and passes it on: the server gets an edit with a mask.
  await send(page, call('GenerateImage', { prompt: 'A purple sky over the harbour', reference_images: [id], mask: uploads.masks[0] }));
  await expect.poll(async () => (await fakeImageJobs()).at(-1)).toMatchObject({ api: 'edits', prompt: 'A purple sky over the harbour', inputs: 1, mask: true });
  await expect(page.getByRole('figure')).toHaveCount(2, { timeout: 30_000 });
});

test('an area can be marked with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await made(page, 'A kite over the dunes');
  const { editor } = await openEditor(page);
  const surface = editor.getByRole('application');
  await surface.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(editor.getByRole('status')).toContainText('Painted');
  await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await editor.getByRole('textbox', { name: 'What the marked area should become' }).fill('A red kite');
  await expect(editor.getByRole('button', { name: 'Generate' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('undo and clear take the paint back, and generating needs something painted', async ({ page }) => {
  await page.goto('/');
  await made(page, 'A lamp on a wooden table');
  const { editor, canvas } = await openEditor(page);
  await editor.getByRole('textbox', { name: 'What the marked area should become' }).fill('A blue lamp');
  const generate = editor.getByRole('button', { name: 'Generate' });
  await expect(generate).toBeDisabled();
  await brush(page, canvas);
  await expect(generate).toBeEnabled();
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(generate).toBeDisabled();
  await brush(page, canvas);
  await editor.getByRole('button', { name: 'Clear' }).click();
  await expect(generate).toBeDisabled();
});

test('an artifact shows a generated image by its id; an id from elsewhere shows a placeholder', async ({ page }) => {
  await page.goto('/');
  const id = await made(page, 'A red kite over a hill');
  const html = `<!doctype html><body style="margin:0"><img id="mine" alt="Kite" src="atelier-image:${id}" width="200"><img id="theirs" alt="Missing" src="atelier-image:img_00000000" width="200"></body>`;
  await send(page, call('artifact', { command: 'create', identifier: 'poster', type: 'html', title: 'Kite poster', content: html }));
  await idle(page);
  await openArtifact(page);
  await expect(page.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
  await settled(page.locator('iframe[title="Artifact preview"]'));
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  // A picture is only "loaded" if the sandbox could really draw it under its own CSP.
  await expect.poll(() => frame.locator('#mine').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(256);
  expect(await frame.locator('#mine').evaluate((img: HTMLImageElement) => img.src.startsWith('data:image/'))).toBe(true);
  expect(await frame.locator('#theirs').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  // The sandbox still has no network: an image from the app's own blob address is blocked.
  const blocked = await frame.locator('body').evaluate(
    (body) =>
      new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(false);
        probe.onerror = () => resolve(true);
        probe.src = '/api/blobs/' + 'a'.repeat(64);
        body.append(probe);
      }),
  );
  expect(blocked).toBe(true);
});

test('an inline visual shows a generated image by its id too', async ({ page }) => {
  await page.goto('/');
  const id = await made(page, 'A teapot on a shelf');
  const html = `<figure style="margin:0"><img id="pic" alt="Teapot" src="atelier-image:${id}" width="160"></figure>`;
  await send(page, call('inline_visual', { title: 'Teapot card', description: 'The teapot picture.', html }));
  const frame = page.getByRole('region', { name: 'Teapot card', exact: true }).frameLocator('iframe');
  await expect.poll(() => frame.locator('#pic').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(256);
});

for (const theme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 844 } })) {
    test(`shots: brush mode and an artifact with an image, ${theme}, ${size}`, async ({ page }) => {
      test.skip(!FOLDER, 'Only when asked for: ATELIER_E2E_SHOTS=<folder>');
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize(viewport);
      await mkdir(FOLDER, { recursive: true });
      await page.goto('/');
      const id = await made(page, 'A lighthouse on a rocky coast at sunset');
      const { editor, canvas } = await openEditor(page);
      await brush(page, canvas);
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
      await editor.getByRole('textbox', { name: 'What the marked area should become' }).fill('A flock of birds');
      await page.screenshot({ path: join(FOLDER, `brush-${theme}-${size}.png`) });
      await page.keyboard.press('Escape');

      const html = `<!doctype html><body style="margin:0;font-family:sans-serif;padding:20px"><h1 style="margin:0 0 12px">Lighthouse poster</h1><img alt="Lighthouse" src="atelier-image:${id}" style="width:100%;max-width:420px;border-radius:12px"><p>Made here, shown inside the sandbox.</p></body>`;
      await send(page, call('artifact', { command: 'create', identifier: 'poster', type: 'html', title: 'Lighthouse poster', content: html }));
      await idle(page);
      await openArtifact(page);
      await expect(page.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
      await settled(page.locator('iframe[title="Artifact preview"]'));
      await expect.poll(() => page.frameLocator('iframe[title="Artifact preview"]').locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(256);
      await page.screenshot({ path: join(FOLDER, `artifact-image-${theme}-${size}.png`) });
    });
  }
}
