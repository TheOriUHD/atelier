import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchDesktop, PASSWORD, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';
import { connectDesktop, signedInClient, startServer, stopServer } from './server-mode.ts';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Long enough that the change at line 300 starts out of view. */
const FILE = `${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;

async function openFolder(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'No folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();
}

test('desktop Code: a card says where an edit lands, takes a reason with a refusal and opens the whole file', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({ 'big.py': FILE });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await openFolder(app, page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    const edit = call('Edit', { file_path: 'big.py', old_string: 'line 300\nline 301', new_string: 'LINE 300\nLINE 300b\nline 301' });

    // The real line of the change, on both sides once they differ.
    await box.fill(edit);
    await box.press('Enter');
    const card = page.getByRole('region', { name: 'Allow Atelier to edit big.py?' });
    await expect(card.locator('[data-kind="remove"]')).toContainText('300');
    await expect(card.locator('[data-kind="add"]').first()).toContainText('300');
    await expect(card.locator('[data-kind="context"]')).toContainText('301');
    await expect(card.locator('[data-kind="context"]')).toContainText('302');

    // R, type, Enter: the reason reaches the model as the person's words, and the turn goes on.
    await page.keyboard.press('r');
    const reason = card.getByRole('textbox', { name: 'Why not' });
    await expect(reason).toBeFocused();
    await reason.fill('use a constant instead');
    await reason.press('Enter');
    await expect(page.getByText(/Tool result: Error: The person declined and said: use a constant instead/)).toBeVisible();
    expect(await readFile(join(repo, 'big.py'), 'utf8')).toBe(FILE);

    // A plain Deny is still one key, and the model still hears it.
    await box.fill(edit);
    await sendWhenIdle(page);
    await expect(card).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.getByText(/Tool result: Error: The person declined this action\./)).toBeVisible();

    // The whole file, at the change.
    await box.fill(edit);
    await sendWhenIdle(page);
    await card.getByRole('button', { name: 'Show the whole file' }).click();
    const view = page.getByRole('dialog', { name: 'Allow Atelier to edit big.py?' });
    await expect(view.locator('[data-kind="context"]').first()).toContainText('line 1');
    await expect(view.locator('[data-kind="context"]').last()).toContainText('line 400');
    await expect(view.locator('[data-kind="remove"]')).toContainText('line 300');
    await expect(view.locator('[data-kind="remove"]')).toBeInViewport();
    await expect(view.getByRole('group', { name: 'The file with the change' })).toBeFocused();

    // Esc leaves the view and refuses nothing; the card is still asking.
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
    await expect(card).toBeVisible();
    expect(await readFile(join(repo, 'big.py'), 'utf8')).toBe(FILE);

    // And the approval works from in there, by keyboard.
    await page.keyboard.press('f');
    await expect(view.locator('[data-kind="remove"]')).toBeInViewport();
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(view).toBeHidden();
    await expect(card).toBeHidden();
    await expect.poll(() => readFile(join(repo, 'big.py'), 'utf8')).toContain('LINE 300\nLINE 300b\nline 301');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop Code: the view shows a new file as new, and what a Write changes in an existing one', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({ 'old.txt': 'keep\nchange me\nkeep too\n' });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await openFolder(app, page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });

    await box.fill(call('Write', { file_path: 'brand-new.txt', content: 'first\nsecond\n' }));
    await box.press('Enter');
    const card = page.getByRole('region', { name: 'Allow Atelier to write brand-new.txt?' });
    await card.getByRole('button', { name: 'Show the whole file' }).click();
    const view = page.getByRole('dialog', { name: 'Allow Atelier to write brand-new.txt?' });
    await expect(view).toContainText('A new file.');
    await expect(view.locator('[data-kind="add"]')).toHaveCount(2);
    await page.keyboard.press('1');
    await expect(view).toBeHidden();
    await expect(page.getByText(/Tool result: Error: The person declined this action\./)).toBeVisible();

    await box.fill(call('Write', { file_path: 'old.txt', content: 'keep\nchanged\nkeep too\n' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Allow Atelier to write old.txt?' }).getByRole('button', { name: 'Show the whole file' }).click();
    const whole = page.getByRole('dialog', { name: 'Allow Atelier to write old.txt?' });
    await expect(whole.locator('[data-kind="remove"]')).toContainText('change me');
    await expect(whole.locator('[data-kind="add"]')).toContainText('changed');
    await expect(whole.locator('[data-kind="context"]')).toHaveCount(2);
    // The menu of an action opens above the view, where the click lands on it.
    await whole.getByRole('button', { name: 'Where to always allow' }).click();
    await page.getByRole('menuitem', { name: 'Allow for this session' }).click();
    await expect.poll(() => readFile(join(repo, 'old.txt'), 'utf8')).toBe('keep\nchanged\nkeep too\n');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('desktop Code: Explain each change is off until turned on, then edits say why on the card', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const repo = await tempRepo({ 'a.txt': 'one\n' });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await openFolder(app, page, repo);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    const edit = call('Edit', { file_path: 'a.txt', old_string: 'one', new_string: 'two', reason: 'The count was off by one.' });

    // Off: the field isn't in the tool's schema at all, so a call that sends it is refused and nothing asks.
    await box.fill(edit);
    await box.press('Enter');
    await expect(page.getByText(/Tool result: Error: Invalid input for Edit/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Allow Atelier to edit a.txt?' })).toHaveCount(0);

    await page.evaluate(() => void (window.location.hash = '#/?settings=code'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('switch', { name: 'Explain each change' }).click();
    await expect(settings.getByRole('switch', { name: 'Explain each change' })).toBeChecked();
    await settings.getByRole('button', { name: 'Close' }).click();

    // The session that was running keeps its tools; a new one has the field.
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: `New session in ${basename(repo)}` }).click();
    await box.fill(edit);
    await sendWhenIdle(page);
    const card = page.getByRole('region', { name: 'Allow Atelier to edit a.txt?' });
    await expect(card).toContainText('The count was off by one.');
    await card.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => readFile(join(repo, 'a.txt'), 'utf8')).toBe('two\n');
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('server mode: a folder lent by a desktop gives the card its line and its file, and a reason reaches the model', async () => {
  test.setTimeout(120_000);
  const dataDir = await tempConfigDir();
  const configDir = await tempConfigDir();
  const server = await startServer(dataDir);
  const work = await realpath(await mkdtemp(join(tmpdir(), 'atelier-device-work-')));
  execFileSync('git', ['init', '-q', work]);
  await writeFile(join(work, 'lent.py'), 'a\nb\nc\n');
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(configDir);
    await connectDesktop(await app.firstWindow());
    await writeFile(join(configDir, 'chromium', 'trusted-folders.json'), JSON.stringify([work]));
    const { id: deviceId } = JSON.parse(await readFile(join(configDir, 'chromium', 'device.json'), 'utf8')) as { id: string };
    const rpc = await signedInClient('admin', PASSWORD);
    await rpc.call('devices.register', { id: deviceId, name: 'E2E', platform: 'macOS' });
    await expect.poll(async () => (await rpc.call('account.devices', {})).find((d) => d.id === deviceId)?.online).toBe(true);
    const ws = await rpc.call('workspaces.addLocal', { path: work });

    const session = await rpc.call('sessions.create', { mode: 'code', workspaceId: ws.id, permissionMode: 'default' });
    await rpc.call('sessions.subscribe', { id: session.id });
    await rpc.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: call('Edit', { file_path: 'lent.py', old_string: 'b', new_string: 'B' }) }] });

    const asking = async () => (await rpc.call('sessions.subscribe', { id: session.id })).pending;
    await expect.poll(asking, { timeout: 20_000 }).not.toBeNull();
    const pending = (await asking())!;
    expect(pending.payload).toMatchObject({ toolName: 'Edit', position: { line: 2, matches: 1 } });

    const preview = await rpc.call('chat.changePreview', { sessionId: session.id, interactionId: pending.id });
    expect(preview.state).toBe('ready');
    expect(preview.rows.map((r) => [r.kind, r.text])).toEqual([
      ['context', 'a'],
      ['remove', 'b'],
      ['add', 'B'],
      ['context', 'c'],
    ]);

    await rpc.call('chat.respond', { sessionId: session.id, interactionId: pending.id, answer: { behavior: 'deny', message: 'leave b alone' } });
    await expect
      .poll(async () => JSON.stringify((await rpc.call('sessions.subscribe', { id: session.id })).messages), { timeout: 20_000 })
      .toContain('Tool result: Error: The person declined and said: leave b alone');
    expect(await readFile(join(work, 'lent.py'), 'utf8')).toBe('a\nb\nc\n');
    await expect(rpc.call('chat.changePreview', { sessionId: session.id, interactionId: pending.id })).rejects.toThrow(/already answered/);
  } finally {
    await app?.close();
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
