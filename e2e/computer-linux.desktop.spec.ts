import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, tempConfigDir, tempRepo } from './fixtures.ts';

/**
 * Computer use on Linux with the real helper (native/computer-linux) against the X server this run has: another Electron
 * window plays the app, and Atelier's own app clicks and types into it through the helper. Skipped elsewhere, and where
 * the helper isn't built (`pnpm computer:build`) or there is no X display.
 */
const helper = resolve('native/bin', `atelier-computer-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
test.skip(process.platform !== 'linux' || !existsSync(helper) || !process.env.DISPLAY, 'needs Linux, the built helper and an X display');

/** One answer of the helper to a probe: the parts the spec reads. */
interface ProbeAnswer {
  id: number;
  result: { app: { name: string } | null; apps: { id: string }[] };
}

/** Asks the helper something from outside Atelier, like a second program on this screen would. */
async function probe(dataDirs: string, requests: { method: string; params: unknown }[]): Promise<ProbeAnswer[]> {
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, XDG_DATA_DIRS: dataDirs } });
  const lines: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const all = [{ method: 'initialize', params: { protocolVersion: 1, client: { name: 'probe', version: '0' } } }, ...requests];
  all.forEach((r, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: r.method, params: r.params })}\n`));
  await expect.poll(() => lines.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(all.length);
  child.kill();
  return lines.map((l) => JSON.parse(l) as ProbeAnswer).sort((a, b) => a.id - b.id).slice(1);
}

async function openFolder(page: Page, folder: string): Promise<void> {
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(folder) })).toBeVisible();
}

/** The pretend app: a window over the whole screen with one text field. */
async function launchTarget(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['e2e/computer-linux-target.mjs', '--no-sandbox'], env: { ...process.env } as Record<string, string> });
  const page = await app.firstWindow();
  await expect(page.locator('#field')).toBeVisible();
  return { app, page };
}

test('desktop on Linux: Full control clicks and types into another app through the real helper, and the screenshot shows it', async () => {
  test.setTimeout(150_000);
  const configDir = await tempConfigDir({ models: { overrides: { 'fake/fake-chat:8b': { promptTier: 'full' } } } });
  const repo = await tempRepo();
  let target: Awaited<ReturnType<typeof launchTarget>> | undefined;
  // The pretend app is an Electron window, whose class is plain "electron" (a development build of Atelier itself, which
  // is never used): a desktop entry names it an app of its own, as an installed app's entry would.
  const entries = join(configDir, 'desktop-entries');
  await mkdir(join(entries, 'applications'), { recursive: true });
  await writeFile(join(entries, 'applications', 'atelier-e2e-target.desktop'), '[Desktop Entry]\nType=Application\nName=E2E Target\nExec=true\nStartupWMClass=electron\n');
  // No ATELIER_COMPUTER_HELPER: main starts the helper it finds in native/bin, as a release does.
  const app = await launchDesktop(configDir, { XDG_DATA_DIRS: `${entries}:/usr/local/share:/usr/share` });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    // Started after Atelier's window, so that it is above it where there is no window manager to stack them (a run that
    // shows Atelier's window, as the release's does): the click would land in Atelier's, which is never used.
    target = await launchTarget();

    // Settings: this system has no Background mode, says why, and starts with the Linux password managers denied.
    await page.evaluate(() => (location.hash = '#/?settings=computer'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('switch', { name: 'Enable computer use' }).click();
    await expect(settings.getByRole('radio', { name: 'Ask per app' })).toHaveAttribute('aria-checked', 'true');
    await expect(settings.getByRole('radio', { name: 'Background' })).toHaveCount(0);
    await expect(settings.locator('[data-setting-row="system.computerMode"]')).toContainText('X11 only takes input through the real mouse and keyboard');
    await expect(settings.locator('[data-setting-row="system.computerDenied"]')).toContainText('KeePassXC');
    await expect(settings.getByText(/can’t tell a password field/)).toBeVisible();
    await settings.getByRole('radio', { name: 'Full control' }).click();
    await expect(settings.getByRole('radio', { name: 'Full control' })).toHaveAttribute('aria-checked', 'true');
    await settings.getByRole('button', { name: 'Close' }).click();

    await openFolder(page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(
      [
        call('Screenshot', {}),
        call('ComputerAction', { actions: [{ action: 'left_click', coordinate: [100, 100], summary: 'Clicks into the field' }, { action: 'type', text: 'Hello, Linux! ü€' }, { action: 'key', text: 'ctrl+a' }, { action: 'wait', duration: 6 }, { action: 'screenshot' }] }),
      ].join('\n'),
    );
    await box.press('Enter');
    // Asks like for any action; Full control itself asks nothing.
    const prompt = page.getByRole('region', { name: 'Allow Atelier to use your computer?' });
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await target.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setAlwaysOnTop(true);
      win.moveTop();
    });
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    // While it has the computer, Atelier's frame is on screen along the edges and takes no clicks: a click at the very
    // corner reaches the app under it, and the frame doesn't count as an app of its own.
    await expect(target.page.locator('#field')).toHaveValue('Hello, Linux! ü€');
    const [corner, apps] = await probe(`${entries}:/usr/local/share:/usr/share`, [
      { method: 'inspect.point', params: { x: 1, y: 1 } },
      { method: 'apps.list', params: { installed: false } },
    ]);
    expect(corner!.result.app?.name).toBe('E2E Target');
    // The frame and the pill are windows of no app anyone could switch to (they stay out of the task list). This probe is not
    // Atelier's own helper, so it sees Atelier's windows as the Electron windows they are, as the pretend app's entry says.
    expect(apps!.result.apps.map((a) => a.id)).toEqual(['atelier-e2e-target']);
    await expect(page.getByText(/^Tool result: 1\. Clicks into the field: done/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Screenshot image/ }).first()).toBeVisible();

    // The text arrived in the other app, typed key by key, with the characters the keyboard layout lacks.
    await expect(target.page.locator('#field')).toHaveValue('Hello, Linux! ü€');
  } finally {
    await app.close();
    await target?.app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
