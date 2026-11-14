import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

const scroller = (page: Page) => page.locator('[id^="code-transcript-"] .overflow-y-auto').first();

/** How far from the bottom the transcript is scrolled, in pixels. */
const fromBottom = (page: Page) => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** The first turn that starts in the window, and how far its top is from the window's. */
const topTurn = (page: Page) =>
  scroller(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const rows = [...(el.querySelector('[data-transcript-turns]')?.children ?? [])];
    const index = rows.findIndex((row) => row.getBoundingClientRect().top >= top);
    return { index, offset: Math.round(rows[index]!.getBoundingClientRect().top - top), text: rows[index]!.textContent?.slice(0, 40) };
  });

const switchView = async (page: Page, name: 'Normal' | 'Thinking' | 'Verbose') => {
  await page.getByRole('button', { name: /^Transcript view:/ }).click();
  await page.getByRole('menuitemradio', { name }).click();
  await page.waitForTimeout(300);
};

/** Switching Normal, Thinking and Verbose draws the whole transcript again; the reader stays where they were. */
test('desktop Code: switching the transcript view keeps the place, at the bottom and scrolled up', async () => {
  test.setTimeout(150_000);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the notes`).join('\n');
  const repo = await tempRepo({ 'README.md': '# Demo\n', 'notes.txt': `${lines}\n` });
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    // A transcript long enough to scroll, with reads whose cards open in the Verbose view.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    for (let i = 1; i <= 8; i++) {
      await box.fill([`Turn ${i}: ${'a long question about the notes, '.repeat(12)}`, call('Read', { file_path: join(repo, 'notes.txt') })].join('\n'));
      await sendWhenIdle(page);
      await expect(page.getByText(/^Tool result:/).nth(i - 1)).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

    // At the bottom: still at the bottom in every view.
    await expect.poll(() => fromBottom(page)).toBeLessThan(32);
    const before = await scroller(page).evaluate((el) => el.scrollHeight);
    await switchView(page, 'Verbose');
    expect(await scroller(page).evaluate((el) => el.scrollHeight)).not.toBe(before);
    await expect.poll(() => fromBottom(page)).toBeLessThan(32);
    await switchView(page, 'Thinking');
    await expect.poll(() => fromBottom(page)).toBeLessThan(32);

    // Scrolled up: the first turn that starts in the window stays at the same height.
    await switchView(page, 'Verbose');
    await scroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight / 3 }));
    await page.waitForTimeout(300);
    const place = await topTurn(page);
    expect(place.index).toBeGreaterThan(0);
    await switchView(page, 'Normal');
    // The same turn, at the same height (the turn above it may shrink into view: that is fine).
    const after = await scroller(page).evaluate((el, index) => {
      const row = el.querySelector('[data-transcript-turns]')!.children[index]!;
      return { offset: Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top), text: row.textContent?.slice(0, 40) };
    }, place.index);
    expect(after.text).toBe(place.text);
    expect(Math.abs(after.offset - place.offset)).toBeLessThanOrEqual(2);
    // And the window didn't jump to the bottom on the way.
    expect(await fromBottom(page)).toBeGreaterThan(100);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
