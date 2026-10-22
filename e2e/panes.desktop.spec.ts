import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, settled, tempConfigDir, tempRepo } from './fixtures.ts';

/** Where an element is once panes have finished fading in (a new pane starts slightly scaled down). */
async function box(locator: Locator) {
  await locator.page().evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));
  return (await locator.boundingBox())!;
}
const near = (a: number, b: number, within = 2) => expect(Math.abs(a - b)).toBeLessThanOrEqual(within);

/** A page for the Browser pane, served by the test. */
async function devServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Atelier test page</title><h1>Hello from the dev server</h1><a href="/next" target="_blank">Next</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

async function openFolder(page: Page, repo: string) {
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  // A folder is asked about once: trust it to work in it.
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();
}

test('desktop Code panes: toggles, tiling, splitters, maximize, files from the transcript, the browser and background tasks', async () => {
  test.setTimeout(180_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({ 'README.md': '# Demo\n', 'src/app.ts': 'export const answer = 42;\n' });
  const server = await devServer();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);
    await openFolder(page, repo);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Look at `src/app.ts` please');
    await composer.press('Enter');
    await expect(page.getByText('You said: Look at')).toBeVisible();

    const toggle = (name: string) => page.getByRole('main').getByRole('button', { name, exact: true });
    const pane = (name: string) => page.getByRole('region', { name, exact: true });
    const transcript = page.locator('[id^="code-transcript"]');
    const fullWidth = (await box(transcript)).width;

    // One pane: a column of its own, the transcript narrower.
    await toggle('Terminal').click();
    await expect(toggle('Terminal')).toHaveAttribute('aria-pressed', 'true');
    const terminal = pane('Terminal');
    await expect(terminal.getByRole('group', { name: 'Terminal' }).locator('.xterm-rows')).toHaveText(/\S/);
    const one = await box(terminal);
    expect((await box(transcript)).width).toBeLessThan(fullWidth - 300);

    // Two: stacked in that column, half each.
    await toggle('Diff').click();
    const diff = pane('Diff');
    await expect(diff.getByText('No changes to show')).toBeVisible();
    const [top, bottom] = [await box(terminal), await box(diff)];
    near(top.x, one.x);
    near(bottom.x, one.x);
    near(top.height, bottom.height);
    expect(bottom.y).toBeGreaterThan(top.y + top.height);

    // Three: a new column to the right.
    await toggle('Files').click();
    const files = pane('Files');
    await expect(files.getByText('Open files appear here')).toBeVisible();
    const right = await box(files);
    const left = await box(terminal);
    // The dock grew to make room: the transcript is narrower still.
    expect((await box(transcript)).width).toBeLessThan(fullWidth - 600);
    expect(right.x).toBeGreaterThan(left.x + left.width);
    near(right.y, left.y);
    near(right.height, bottom.y + bottom.height - top.y);

    // Four: stacked under it.
    await toggle('Browser').click();
    const browser = pane('Browser');
    near((await box(browser)).x, right.x);
    expect((await box(browser)).y).toBeGreaterThan(right.y);

    // The line between the columns resizes them, with the pointer and the keyboard; a double-click evens them out.
    const columns = page.getByRole('separator', { name: 'Resize columns' });
    const line = await box(columns);
    await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + line.width / 2 - 30, line.y + line.height / 2, { steps: 5 });
    await page.mouse.up();
    near((await box(files)).width, right.width + 30, 2);
    // No column gets narrower than 320px.
    await page.mouse.move(line.x - 30 + line.width / 2, line.y + line.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x - 300, line.y + line.height / 2, { steps: 5 });
    await page.mouse.up();
    near((await box(terminal)).width, 320, 1);
    const before = Number(await columns.getAttribute('aria-valuenow'));
    await columns.focus();
    await page.keyboard.press('ArrowRight');
    expect(Number(await columns.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    await columns.dblclick();
    near((await box(files)).width, (await box(terminal)).width, 2);

    // Fullscreen fills the session (the transcript too, never the sidebar) with one pane and restores it.
    await diff.getByRole('button', { name: 'Fullscreen Diff' }).click();
    const dock = await box(page.locator('#pane-diff').locator('..'));
    near((await box(diff)).width, dock.width);
    near((await box(diff)).height, dock.height);
    await expect(terminal).toBeHidden();
    await expect(page.locator('[id^="code-transcript"]')).toHaveCSS('width', '0px');
    await diff.getByRole('button', { name: 'Exit fullscreen: Diff' }).click();
    await expect(terminal).toBeVisible();

    // Closing a pane gives its room to the rest of its column; focus goes back to its toggle.
    await terminal.getByRole('button', { name: 'Close Terminal' }).click();
    await expect(terminal).toHaveCount(0);
    await expect(toggle('Terminal')).toBeFocused();
    await expect(toggle('Terminal')).toHaveAttribute('aria-pressed', 'false');
    near((await box(diff)).y, right.y);
    near((await box(diff)).height, right.height);

    // A file path in the conversation opens in Files.
    await page.getByRole('button', { name: 'src/app.ts', exact: true }).click();
    await expect(files.getByRole('group', { name: 'Open files' }).getByRole('button', { name: 'app.ts', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(files.getByRole('region', { name: 'src/app.ts' })).toContainText('export const answer = 42;');
    // The filter finds names, and `?` searches inside files.
    const filter = files.getByRole('textbox', { name: 'Filter files' });
    await filter.fill('READ');
    await expect(files.getByRole('list', { name: 'Matching files' }).getByRole('button')).toHaveText(['README.md']);
    await filter.fill('?answer');
    await files.getByRole('group', { name: 'Search results' }).getByRole('button', { name: /export const answer/ }).click();
    await filter.fill('');
    await expect(files.getByRole('button', { name: 'README.md' })).toBeVisible();

    // The browser shows a local page, and a link that opens a window opens a tab.
    const address = browser.getByRole('textbox', { name: 'Address' });
    await address.fill(`localhost:${server.port}`);
    await address.press('Enter');
    const browserTabs = browser.getByRole('group', { name: 'Browser tabs' });
    await expect(browserTabs.getByRole('button', { name: 'Atelier test page', exact: true })).toBeVisible();
    await expect(address).toHaveValue(`http://localhost:${server.port}/`);
    const url = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === 'webview')?.getURL());
    expect(url).toBe(`http://localhost:${server.port}/`);
    // A link that opens a new window opens a tab in the pane instead.
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === 'webview')!.executeJavaScript("document.querySelector('a').click()", true));
    await expect(browserTabs.getByRole('button', { name: 'Atelier test page', exact: true })).toHaveCount(2);
    await expect(browserTabs.locator('[aria-current="true"]')).toHaveText('Atelier test page');
    await expect(address).toHaveValue(`http://localhost:${server.port}/next`);
    await browser.getByRole('button', { name: 'Close Atelier test page' }).click();
    await expect(browserTabs.getByRole('button', { name: 'Atelier test page', exact: true })).toHaveCount(1);

    // The layout is kept for the session.
    await page.reload();
    await expect(pane('Files')).toBeVisible();
    await expect(pane('Diff')).toBeVisible();
    await expect(pane('Browser')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Terminal' })).toHaveCount(0);

    // A phone-sized window: one pane at a time, as a sheet filling the session; a toggle brings another to the front.
    // (Wider but still small sessions, such as half of a split view, tile one squeezed column instead.)
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(pane('Browser')).toBeVisible();
    await expect(pane('Files')).toBeHidden();
    await expect(pane('Diff')).toBeHidden();
    near((await box(pane('Browser'))).width, (await box(transcript)).width, 2);
    await toggle('Diff').click();
    await expect(pane('Diff')).toBeVisible();
    await expect(pane('Browser')).toBeHidden();
    await expect(toggle('Browser')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(pane('Files')).toBeVisible();
    await expect(pane('Browser')).toBeVisible();

    // A command started in the background and a sub-agent show under Running in Background tasks (More).
    await composer.fill(call('Bash', { command: 'echo started-in-background; sleep 60', description: 'Serve forever', run_in_background: true }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: /Allow Atelier to run/ }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/^Tool result: Started in the background/)).toBeVisible();
    await expect(page.getByRole('button', { name: '1 background command running' })).toBeVisible();
    await toggle('More').click();
    const item = page.getByRole('menuitem', { name: /Background tasks/ });
    await expect(item).toContainText('1');
    await expect(page.getByRole('menuitemcheckbox', { name: /Keep computer awake/ })).toHaveAttribute('aria-checked', 'false');
    await item.click();
    const tasks = pane('Background tasks');
    const running = tasks.getByRole('region', { name: 'Running' });
    await expect(running.getByRole('listitem')).toHaveText([/Serve forever\s*Bash·\d+s/]);

    const survey = [call('Read', { file_path: join(repo, 'README.md') }), call('Bash', { command: 'sleep 60', description: 'Wait a while' })].join('\n');
    await composer.fill(call('Agent', { description: 'Survey the repo', prompt: survey, subagent_type: 'general-purpose' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Allow sub-agent “Survey the repo” to run this command?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(running.getByRole('listitem')).toHaveCount(2);
    await expect(running.getByRole('listitem').nth(1)).toContainText(/Survey the repo\s*Agent·\d+s.*2 tool uses · Running a command/);
    await expect(page.getByRole('button', { name: '2 running tasks' })).toBeVisible();

    // A sub-agent's transcript, and a command's output, open in the pane.
    await tasks.getByRole('button', { name: 'View transcript: Survey the repo' }).click();
    await expect(tasks.getByRole('heading', { name: 'Survey the repo' })).toBeVisible();
    await expect(tasks.getByText(/^Model /)).toBeVisible();
    await expect(tasks.getByRole('region', { name: 'Steps' }).getByRole('button', { name: /^Read README\.md, ran a command/ })).toBeVisible();
    await tasks.getByRole('button', { name: 'Back to background tasks' }).click();
    await tasks.getByRole('button', { name: 'View output: Serve forever' }).click();
    await expect(tasks.getByLabel('Output')).toContainText('started-in-background');
    await tasks.getByRole('button', { name: 'Back to background tasks' }).click();

    // Stop ends both; they move to Finished, which the trash button clears.
    await tasks.getByRole('button', { name: 'Stop Survey the repo' }).click();
    await tasks.getByRole('button', { name: 'Stop Serve forever' }).click();
    await expect(running).toBeHidden();
    await expect(page.getByText(/^Tool result: Error: The sub-agent was stopped/)).toBeVisible();
    await tasks.getByRole('button', { name: 'Finished 2' }).click();
    await expect(tasks.getByRole('listitem')).toHaveText([/Survey the repo\s*Agent·Stopped/, /Serve forever\s*Bash·Stopped/]);
    await tasks.getByRole('button', { name: 'Clear finished tasks' }).click();
    await expect(tasks.getByText(/Commands started in the background, sub-agents and loops show here/)).toBeVisible();
  } finally {
    await app.close();
    server.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop Code: a page the model wrote opens in the Artifact pane, stays closed until the next one, and its card brings it back', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await expect(page.getByRole('button', { name: 'No folder', exact: true })).toBeVisible();

    // As with "create a simple landing page": the model writes the page, then shows that file.
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const landing = '<!doctype html><html><body><h1>Landing page</h1><button onclick="this.textContent=\'Signed up\'">Sign up</button></body></html>';
    await composer.fill([call('Write', { file_path: 'index.html', content: landing }), call('artifact', { file_path: 'index.html' })].join('\n'));
    await composer.press('Enter');
    await page.getByRole('region', { name: 'Write index.html?' }).getByRole('button', { name: 'Allow once' }).click();

    // No approval for showing it: the pane opens beside the transcript with the preview, in the artifact sandbox.
    const pane = page.getByRole('region', { name: 'Artifact', exact: true });
    await expect(pane.getByRole('heading', { name: 'index.html' })).toBeVisible();
    await expect(page.getByText(/^Tool result: Showing index\.html beside the conversation \(version 1\)/)).toBeVisible();
    await expect(pane.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
    await settled(pane.locator('iframe[title="Artifact preview"]'));
    const preview = pane.frameLocator('iframe[title="Artifact preview"]');
    await expect(preview.getByRole('heading', { name: 'Landing page' })).toBeVisible();
    await preview.getByRole('button', { name: 'Sign up' }).click();
    await expect(preview.getByRole('button', { name: 'Signed up' })).toBeVisible();
    await pane.getByRole('radio', { name: 'Code' }).click();
    await expect(pane.getByText('Landing page', { exact: false })).toBeVisible();

    // Closed, it stays closed while nothing new is shown; the transcript's card opens it again.
    await pane.getByRole('button', { name: 'Close Artifact' }).click();
    await expect(pane).toBeHidden();
    await composer.fill('anything else?');
    await sendWhenIdle(page);
    await expect(page.getByText('You said: anything else?')).toBeVisible();
    await expect(pane).toBeHidden();
    await page.getByRole('button', { name: /index\.html.*Open/ }).click();
    await expect(pane.getByRole('heading', { name: 'index.html' })).toBeVisible();
    await page.getByRole('button', { name: /index\.html.*Hide/ }).click();
    await expect(pane).toBeHidden();

    // The next change opens it by itself, at the new version.
    await composer.fill([call('Edit', { file_path: 'index.html', old_string: 'Landing page', new_string: 'Landing page, take two' }), call('artifact', { file_path: 'index.html' })].join('\n'));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Edit index.html?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(pane.getByText('v2/2')).toBeVisible();
    await pane.getByRole('radio', { name: 'Preview' }).click();
    await expect(pane.frameLocator('iframe[title="Artifact preview"]').getByRole('heading', { name: 'Landing page, take two' })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
