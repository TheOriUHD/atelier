import { readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chatInFolder, launchDesktop, setUpLocal } from './desktop-app.ts';
import { IMAGE_SETTINGS, call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

const generate = (input: Record<string, unknown>) => call('GenerateImage', input);
const newest = (page: Page) => page.getByRole('figure').last();
const openButton = (page: Page) => newest(page).getByRole('button', { name: /^Open image/ });

/** A picture of the window for a person to look at, when ATELIER_E2E_SHOTS says where; the window stays hidden. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.ATELIER_E2E_SHOTS;
  if (folder) await page.screenshot({ path: join(folder, `${name}.png`) });
}

/** The id the model got for the image it just made, as the scripted reply repeats it. */
async function lastImageId(page: Page): Promise<string> {
  const reply = await page.getByText(/^Tool result: Generated an image/).last().innerText();
  return /img_[0-9a-f]{8}/.exec(reply)![0];
}

test('desktop Code: Ask shows what will be made, the image lands big, SaveImage writes it and Rewind takes it back', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(IMAGE_SETTINGS);
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
    await box.fill(generate({ prompt: 'A poster for the summer party', aspect_ratio: '3:2' }));
    await box.press('Enter');
    const ask = page.getByRole('region', { name: 'Allow Atelier to make an image?' });
    await expect(ask).toContainText('A poster for the summer party');
    await expect(newest(page).getByRole('status').first()).toHaveText('Waiting for your answer');
    await shot(page, 'desktop-code-ask');
    await ask.getByRole('button', { name: 'Allow once' }).click();

    await expect(openButton(page)).toBeVisible({ timeout: 30_000 });
    await shot(page, 'desktop-code-done');
    // In the transcript itself, big, not in a tool's summary line.
    const frame = (await newest(page).locator('.group\\/image').boundingBox())!;
    expect(frame.width).toBeGreaterThan(400);
    expect(frame.width / frame.height).toBeCloseTo(1.5, 1);
    await expect(page.getByText(/^Tool result: Generated an image/)).toBeVisible();

    // The file comes through the app's own scheme, as an image and to a fetch, which is how Copy reads it. The clipboard
    // itself wants a focused window, and these windows stay hidden.
    const file = await newest(page).locator('img[data-loaded]').evaluate(async (img: HTMLImageElement) => ({ width: img.naturalWidth, bytes: (await (await fetch(img.src)).blob()).size }));
    expect(file.width).toBe(1536);
    expect(file.bytes).toBeGreaterThan(1000);

    // What it cost, from the price set for this model: an estimate, and it says so.
    await openButton(page).hover();
    await newest(page).getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('complementary', { name: 'Details' });
    await expect(details).toContainText('$0.04 estimated');
    await expect(details).toContainText('gpt-image-fake');
    await shot(page, 'desktop-code-details');
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);

    const id = await lastImageId(page);
    const path = join(repo, 'public', 'hero.png');
    await box.fill(call('SaveImage', { image: id, file_path: path }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save public\/hero\.png\?/i }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => stat(path).then((s) => s.size).catch(() => 0)).toBeGreaterThan(1000);
    expect((await readFile(path)).subarray(1, 4).toString()).toBe('PNG');

    // The save is a compact line with a thumbnail of what was saved.
    await expect(page.getByRole('button', { name: /^Saved hero\.png/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Images looked at' }).getByRole('button', { name: /^Saved image/ })).toBeVisible();
    await shot(page, 'desktop-code-saved');

    // Undone by Rewind like any file edit.
    await expect(page.getByRole('button', { name: 'Rewind to here' }).last()).toBeEnabled();
    await page.getByRole('button', { name: 'Rewind to here' }).last().click();
    const rewind = page.getByRole('dialog', { name: 'Rewind' });
    await rewind.getByRole('button', { name: 'Restore code and conversation' }).click();
    await expect(rewind).toBeHidden();
    await expect.poll(() => stat(path).then(() => true).catch(() => false)).toBe(false);

    // The image itself is still there, higher up.
    await expect(openButton(page)).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop, a chat in a folder: an image shows big, and a saved one is among the Output files', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir(IMAGE_SETTINGS);
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
    await box.fill(generate({ prompt: 'A cover for the quarterly report' }));
    await box.press('Enter');
    await page.getByRole('region', { name: 'Allow Atelier to make an image?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(openButton(page)).toBeVisible({ timeout: 30_000 });
    expect((await newest(page).locator('.group\\/image').boundingBox())!.width).toBeGreaterThan(400);

    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const id = await lastImageId(page);
    await box.fill(call('SaveImage', { image: id, file_path: join(folder, 'cover.png') }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /save cover\.png\?/i }).getByRole('button', { name: 'Allow once' }).click();
    const panel = page.getByRole('complementary', { name: 'Task progress' });
    await expect(panel.getByRole('region', { name: 'Output files' }).getByRole('button', { name: /^cover\.png/ })).toBeVisible();
    await shot(page, 'desktop-cowork-output');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
