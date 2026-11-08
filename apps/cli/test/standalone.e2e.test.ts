/**
 * The terminal app on this computer, end to end, in a real pseudo-terminal: the setup wizard (a name, the fake Ollama
 * as the provider, a model, the mode), the folder question, a message and its reply, a tool call that needs approval,
 * and the next start going straight to the session. Needs the bundle (`pnpm --filter @atelier/cli build`) and the
 * runner (`pnpm runner:build -host`); skipped without them. SHOW_SCREENS=1 prints the screens along the way.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BUNDLE, canRun, openScreen, type Screen } from './harness.ts';

const show = (title: string, s: Screen) => process.env.SHOW_SCREENS && console.log(`\n===== ${title} =====\n${s.text()}\n`);
let home: string;
let project: string;
let ollama: ChildProcess;
const port = 11600 + Math.floor(Math.random() * 300);

beforeAll(async () => {
  if (!canRun()) return;
  home = await mkdtemp(join(tmpdir(), 'atelier-cli-e2e-'));
  project = join(home, 'shader');
  await mkdir(project);
  await writeFile(join(project, 'water.fsh'), 'float t = frameTimeCounter * 2.0;\n');
  execFileSync('git', ['init', '-q'], { cwd: project });
  ollama = spawn(process.execPath, [join(import.meta.dirname, '../../../e2e/fake-ollama.mjs'), String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(async () => {
  ollama?.kill();
  if (home) {
    // The background service of this test's folder.
    try {
      execFileSync(process.execPath, [BUNDLE, 'daemon', 'stop', '--force'], { env: env(), timeout: 10_000 });
    } catch {
      // Not running.
    }
    await rm(home, { recursive: true, force: true });
  }
});

const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, '.atelier', 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '', NO_UPDATE_CHECK: '1' });

it.skipIf(!canRun())('sets up on this computer, asks about the folder, and answers', { timeout: 180_000 }, async () => {
  const s = await openScreen({ cwd: project, env: env(), command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(BUNDLE)}` });
  try {
    await s.waitFor('press enter to begin');
    show('splash', s);
    await s.press('enter');
    await s.waitFor('How should it look?');
    show('look', s);
    await s.press('enter');
    await s.waitFor('Where should Atelier run?');
    show('where', s);
    await s.press('down');
    await s.press('enter');
    await s.waitFor('What should Atelier call you?', 30_000);
    await s.type('Ada');
    await s.press('enter');
    await s.waitFor('Add Ollama', 30_000);
    show('providers', s);
    await s.select(/^Add Ollama$/);
    await s.press('enter');
    await s.waitFor('The address it listens at');
    await s.type('\x15'); // Ctrl+U: clear the suggested address
    await s.type(`http://127.0.0.1:${port}`);
    await s.press('enter');
    await s.waitFor(/Added Ollama with \d+ models/, 30_000);
    show('providers added', s);
    await s.press('enter');
    await s.waitFor('Which model should new sessions use?', 30_000);
    show('model', s);
    await s.select(/^Fake Chat|fake-chat/i);
    await s.press('enter');
    await s.waitFor('How much should it ask?');
    await s.press('enter');
    await s.waitFor('Your terminal');
    await s.press('enter');
    await s.waitFor('All set');
    show('done', s);
    await s.press('enter');
    await s.waitFor('Work in', 30_000);
    show('trust', s);
    await s.press('enter');
    await s.waitFor('Ask about shader', 30_000);
    show('session', s);
    await s.type('hello there');
    await s.press('enter');
    await s.waitFor(/hello there/i);
    await s.waitFor(/◆/, 30_000);
    show('reply', s);
    // A scripted Write: it asks (Ask mode), then writes once allowed.
    await s.press('shiftTab');
    await s.waitFor('⏵⏵ Ask');
    await s.type(`call Write {"file_path": "${join(project, 'notes.md').replace(/\\/g, '\\\\')}", "content": "waves: slower\\n"}`);
    await s.press('enter');
    await s.waitFor(/Create .*notes\.md\?/, 30_000);
    show('permission', s);
    await s.press('enter');
    await s.waitFor(/Created .*notes\.md/, 30_000);
    show('written', s);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('waves: slower\n');
    await s.press('ctrlD');
  } finally {
    await s.close();
  }
  // The next start goes straight to the session screen, and -c picks the session up.
  const again = await openScreen({ cwd: project, env: env(), command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(BUNDLE)} -c` });
  try {
    await again.waitFor('hello there', 30_000);
    show('continued', again);
  } finally {
    await again.close();
  }
  expect(existsSync(join(home, '.atelier', 'cli', 'data', 'atelier.db'))).toBe(true);
});
