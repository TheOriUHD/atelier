import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

/** Loops may repeat every second here; everyone else gets a minute at least (test-only, docs/ARCHITECTURE.md §8). */
const FAST_LOOPS = { ATELIER_LOOP_MIN_INTERVAL_MS: '1000' };

async function openFolder(page: Page, repo: string) {
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  // A folder is asked about once: trust it to work in it.
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();
}

test('desktop Code: a background sub-agent works while the turn ends, then its end wakes the session; /loop sends until stopped', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo();
  const app = await launchDesktop(configDir, FAST_LOOPS);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);
    await openFolder(page, repo);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const pane = page.getByRole('region', { name: 'Background tasks', exact: true });

    // The Agent call returns at once and the parent's turn ends while the sub-agent ("long": about 8s) still works.
    await composer.fill(call('Agent', { description: 'Survey the repo', prompt: 'Give a long overview of the repository.', subagent_type: 'general-purpose', run_in_background: true }));
    await composer.press('Enter');
    await expect(page.getByText(/^Tool result: The sub-agent "Survey the repo" is now working in the background/)).toBeVisible();
    const card = page.getByRole('button', { name: /^Survey the repo\s*Background/ });
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: '1 running task' }).click();
    const running = pane.getByRole('region', { name: 'Running' });
    await expect(running.getByRole('listitem')).toHaveText([/Survey the repo\s*Agent·Background·\d+s/]);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();

    // When it ends, its report reaches the idle session as one row, and the model carries on by itself.
    const notice = page.getByText(/^Background agent finished ·/);
    await expect(notice).toHaveText('Background agent finished · Survey the repo', { timeout: 30_000 });
    await expect(page.getByText(/^Heard back from Survey the repo: A long answer, streamed a little/)).toBeVisible();
    await expect(card).toContainText('Done');
    await expect(running).toBeHidden();
    await pane.getByRole('button', { name: 'Finished 1' }).click();
    await expect(pane.getByRole('listitem')).toHaveText([/Survey the repo\s*Agent·Background·Done/]);

    // `/loop 1s …` (1s is allowed here) sends now and again once the session is idle, each send marked as the loop's.
    await composer.fill('/loop 1s check the build');
    await sendWhenIdle(page);
    await expect(page.getByText(/^Loop started: every 1s/)).toBeVisible();
    await expect(page.getByLabel('Sent by a loop, run 1')).toBeVisible();
    await expect(page.getByLabel('Sent by a loop, run 2')).toBeVisible({ timeout: 15_000 });
    await expect(running.getByRole('listitem')).toHaveText([/check the build\s*Loop·\d+s\s*Every 1s · \d+ runs · next/]);

    // Stopping it in Background tasks ends it: no more sends.
    await pane.getByRole('button', { name: 'Stop check the build' }).click();
    await expect(running).toBeHidden();
    const sent = await page.getByLabel(/^Sent by a loop, run \d+$/).count();
    await page.waitForTimeout(3000);
    expect(await page.getByLabel(/^Sent by a loop, run \d+$/).count()).toBe(sent);
    // Finished is still open from before; the newest first.
    await expect(pane.getByRole('button', { name: 'Finished 2' })).toHaveAttribute('aria-expanded', 'true');
    await expect(pane.getByRole('listitem').first()).toHaveText(/check the build\s*Loop·Stopped·\d+s\s*Every 1s · \d+ runs/);

    // `/loop` alone opens the list; `/loop stop` says when there is nothing to stop.
    await composer.fill('/loop stop');
    await composer.press('Enter');
    await expect(page.getByText('This session has no loops running.')).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
