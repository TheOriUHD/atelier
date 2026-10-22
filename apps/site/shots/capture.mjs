#!/usr/bin/env node
/**
 * Captures the website's app screenshots from the real app: dark theme, 1360x850 CSS pixels rendered at 3x, so
 * each master is 4080x2550 (above 4K UHD) and stays sharp on any display. Everything runs on throwaway data (a temp config dir,
 * a temp repository, a scripted model from demo-model.mjs); nothing touches ~/.atelier or the installed app's profile.
 *
 *   node apps/site/shots/capture.mjs [outDir]
 *
 * Uses the installed app (/Applications/Atelier.app) or ATELIER_E2E_APP, else the built one (apps/desktop/dist).
 * Needs `webp` (cwebp) and ImageMagick for the final conversion; see convert.sh.
 */
/* global document, HTMLElement, location -- used inside page.evaluate callbacks, which run in the app's window */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'atelier-shots'));
const PORT = 11590;
const WIDTH = 1360;
const HEIGHT = 850;
const SCALE = 3;

await mkdir(out, { recursive: true });

// A repository named "timeline" with a small HTTP handler to work on.
const parent = await realpath(await mkdtemp(join(tmpdir(), 'atelier-shots-')));
const repo = join(parent, 'timeline');
await mkdir(join(repo, 'src'), { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo });
await writeFile(
  join(repo, 'src/server.js'),
  `import { createServer } from 'node:http';

export function handler(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404).end();
}

export const start = (port = 3000) => createServer(handler).listen(port);
`,
);
await writeFile(
  join(repo, 'package.json'),
  JSON.stringify({ name: 'timeline', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
);
await writeFile(join(repo, 'README.md'), '# timeline\n\nA tiny service that serves a health check.\n');
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Sam Taylor');
git('config', 'user.email', 'sam@example.invalid');
git('config', 'core.autocrlf', 'false');
git('add', '.');
git('commit', '-qm', 'Initial commit');

// A plain folder for the Cowork task: some notes and a revenue table to work from.
const work = join(parent, 'q3-planning');
await mkdir(work, { recursive: true });
await writeFile(
  join(work, 'notes.md'),
  '# Q3 planning notes\n\n- Two enterprise accounts churned in September over pricing.\n- Support backlog is down by a third.\n- Hire two engineers for the mobile launch.\n- Three new enterprise contracts closed in EMEA.\n',
);
await writeFile(join(work, 'revenue.csv'), 'region,q2,q3\nAmericas,4.2,4.6\nEMEA,2.6,3.1\nAPAC,1.7,1.8\n');

const model = spawn(process.execPath, [join(here, 'demo-model.mjs'), String(PORT), repo, work], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));

const configDir = await mkdtemp(join(tmpdir(), 'atelier-shots-config-'));
await writeFile(
  join(configDir, 'settings.json'),
  JSON.stringify(
    {
      profile: { name: 'Sam Taylor' },
      providers: [{ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: `http://127.0.0.1:${PORT}` }],
      permissions: { defaultMode: 'acceptEdits' },
      appearance: { theme: 'dark' },
    },
    null,
    2,
  ),
);

const installed = '/Applications/Atelier.app/Contents/MacOS/Atelier';
const packaged = process.env.ATELIER_E2E_APP ?? (existsSync(installed) ? installed : undefined);
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged } : {}),
  args: [
    ...(packaged ? [] : [join(root, 'apps/desktop/dist/main.mjs')]),
    `--user-data-dir=${join(configDir, 'chromium')}`,
    '--use-mock-keychain',
  ],
  env: { ...process.env, ATELIER_UPDATE_FEED: 'off', ATELIER_CONFIG_DIR: configDir, ATELIER_HIDE_WINDOW: '1' },
});

/**
 * One frame straight from the browser at the emulated density (SCALE x, set once below): text is re-rendered sharp,
 * not an enlarged bitmap, whatever the screen of the machine running this is. `clip` is in CSS pixels.
 */
const shot = async (page, cdp, name, clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT }) => {
  // Park the pointer on empty header space (no hover states) and let the last transitions and streamed pixels settle.
  await page.mouse.move(700, 24);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(800);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  });
  await writeFile(join(out, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('captured', name);
};

try {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repo);
  const page = await app.firstWindow();
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [WIDTH, HEIGHT],
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });

  // First run: the built-in backend, and a name (this computer has one user, so there is no account or password).
  await page.getByRole('button', { name: 'Run on this computer' }).click();
  await page.getByRole('textbox').fill('Sam Taylor');
  await page.getByRole('button', { name: 'Continue' }).click();

  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  // A reply is over when the Stop button is gone and its footer (model and speed) is showing.
  const idle = async () => {
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText(/tok\/s/).last()).toBeVisible({ timeout: 60_000 });
  };
  const ask = async (text) => {
    await message.fill(text);
    await message.press('Enter');
    await page.waitForTimeout(400);
    await idle();
  };
  const newChat = async () => {
    await page.getByRole('radio', { name: 'Chat' }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
  };

  // Earlier conversations, oldest first, so the sidebar reads like a week of use.
  await expect(message).toBeVisible({ timeout: 30_000 });
  await ask('How should I rate limit a public API?');
  await newChat();
  await ask('What is a sensible way to validate email addresses?');
  await newChat();
  await ask('How do I schedule a nightly backup with cron?');
  await newChat();
  await ask('What is the difference between a B-tree and an LSM-tree index?');
  await shot(page, cdp, 'chat');

  await newChat();
  await ask('Make me a small page that shows a warm color palette');
  // The artifact card is one button (the chat title above it is another with the same words); opening it shows the page beside the conversation.
  const card = page.getByRole('button', { name: /Warm studio palette/ }).filter({ hasText: 'HTML' });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByText('Preview', { exact: true })).toBeVisible();
  // The page is drawn in a sandboxed frame: wait until its text is on screen.
  await expect
    .poll(
      async () => {
        for (const frame of page.frames())
          if (
            await frame
              .getByText('Click a swatch')
              .isVisible()
              .catch(() => false)
          )
            return true;
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await shot(page, cdp, 'artifact');

  // Cowork: a task in a plain folder, finished, with the steps beside it and the file it made.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, work);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (location.hash = '#/work'));
  await expect(page.getByRole('heading', { name: /^What should we get done/ })).toBeVisible();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: 'q3-planning', exact: true })).toBeVisible();
  await message.fill("Summarize this quarter's notes into a one-page brief for the team.");
  await message.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Task progress' });
  await expect(panel.getByRole('region', { name: 'Progress' }).getByRole('heading')).toHaveText('Progress3 of 3', {
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Files from this task' })).toBeVisible();
  await shot(page, cdp, 'cowork');

  // Settings: the provider list, cropped to the part with something in it.
  await page.evaluate(() => (location.hash = '#/?settings=providers'));
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('button', { name: 'Add provider' })).toBeVisible();
  await expect(dialog.getByText(/1 model/)).toBeVisible();
  const box = await dialog.boundingBox();
  await shot(page, cdp, 'providers', { x: box.x + 192, y: box.y + 46, width: box.width - 192, height: 330 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Code: a session in the "timeline" folder that edits a file, writes a test and runs it, then the diff beside it.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repo);
  await page.getByRole('radio', { name: 'Code' }).click();
  // The picker remembers the Cowork folder, or shows "No folder" on a first visit.
  await page.getByRole('button', { name: /^(No folder|q3-planning)$/ }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: 'timeline', exact: true })).toBeVisible();
  await message.fill('Add an uptime field to the /health response and cover it with a test.');
  await message.press('Enter');
  // Accept edits lets the edits through; the test run asks first.
  await page
    .getByRole('region', { name: /to run/ })
    .getByRole('button', { name: 'Allow once' })
    .click({ timeout: 60_000 });
  await expect(page.getByText(/1 test, 0 failures/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  // Open the summary of what it did, so the tool cards show, then the diff beside it.
  await page
    .getByRole('button', { name: /^Read server\.js, edited server\.js/ })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page.getByRole('button', { name: '2 changed' }).click();
  await expect(page.getByRole('region', { name: 'Diff', exact: true })).toContainText('uptime');
  await shot(page, cdp, 'code');

  // Approvals: close the diff, ask for a commit and stop at the prompt it raises (a command asks even in Accept edits).
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await message.fill('Looks good. Commit this.');
  await message.press('Enter');
  const prompt = page.getByRole('region', { name: /Allow Atelier to run/ });
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await shot(page, cdp, 'permission');
  await prompt.getByRole('button', { name: 'Allow once' }).click();
} catch (error) {
  console.error(String(error?.message ?? error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  model.kill();
  await rm(configDir, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
}
