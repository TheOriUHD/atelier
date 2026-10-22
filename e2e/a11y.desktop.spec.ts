import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo, verboseTranscript } from './fixtures.ts';

/** Serious and critical WCAG 2 A/AA problems on the screen, as "rule: target" lines. */
async function problems(page: Page): Promise<string[]> {
  // Contrast is measured at rest: a fade in progress (a dialog opening, actions shown on hover) would count as faint text.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));
  // Legacy mode runs in this page: Electron can't open the extra page axe otherwise uses for frames.
  const { violations } = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test('desktop: a Code session, its prompts and panes have no serious accessibility problems', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
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
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();
    const found: Record<string, string[]> = {};
    const check = async (name: string) => {
      const list = await problems(page);
      if (list.length) found[name] = list;
    };
    await check('code home');

    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('Write', { file_path: join(repo, 'notes.md'), content: '# Notes\n\nFirst line.\n' }));
    await box.press('Enter');
    const prompt = page.getByRole('region', { name: 'Write notes.md?' });
    await expect(prompt).toBeVisible();
    await check('permission prompt');
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: Created/)).toBeVisible();

    await check('compact transcript');
    await verboseTranscript(page);
    await box.fill(call('Bash', { command: 'echo done', description: 'Say done' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText('Exit code 0', { exact: true })).toBeVisible();
    await check('session with tool cards');
    await page.evaluate(() => (location.hash = '#/code'));
    await expect(page.getByRole('region', { name: 'Your Code stats' })).toBeVisible();
    await check('code home with stats');
    await page.getByRole('button', { name: 'Environment: Local' }).click();
    await page.getByRole('menuitem', { name: 'SSH' }).click();
    await check('environment menu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.goBack();

    // The panes, tiled: Files, then Diff under it, then Plan and Background tasks in a column of their own.
    for (const pane of ['Files', 'Diff']) {
      await page.getByRole('button', { name: pane, exact: true }).click();
      await expect(page.getByRole('region', { name: pane, exact: true })).toBeVisible();
      await check(`${pane} pane`);
    }
    for (const pane of ['Plan', 'Background tasks']) {
      await page.getByRole('main').getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: new RegExp(`^${pane}`) }).click();
      await expect(page.getByRole('region', { name: pane, exact: true })).toBeVisible();
      await check(`${pane} pane`);
    }
    await page.getByRole('main').getByRole('button', { name: 'More', exact: true }).click();
    // Checked once the menu has faded in: half-faded text reads as low contrast.
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1');
    await check('More menu');
    await page.keyboard.press('Escape');
    // Tabs: an open file, two terminals, a browser tab.
    const files = page.getByRole('region', { name: 'Files', exact: true });
    await files.getByRole('button', { name: 'notes.md' }).click();
    await expect(files.getByRole('group', { name: 'Open files' }).getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('region', { name: 'Terminal', exact: true }).getByRole('button', { name: 'New terminal' }).click();
    await expect(page.getByRole('group', { name: 'Terminals' }).getByRole('button', { name: 'Terminal 2', exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible();
    await check('pane tabs');

    // The desktop-only Settings page (the web spec scans the others).
    await page.evaluate(() => (location.hash = '#/?settings=system'));
    await expect(page.getByRole('switch', { name: 'Launch at login' })).toBeEnabled();
    await check('settings system');
    expect(found).toEqual({});
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
