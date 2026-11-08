/**
 * The terminal app on this computer, end to end, in a real pseudo-terminal: the setup wizard (a name, the fake Ollama
 * as the provider, a model, the mode), the folder question, a message and its reply, a tool call that needs approval,
 * and the next start going straight to the session. Needs the bundle (`pnpm --filter @atelier/cli build`) and the
 * runner (`pnpm runner:build -host`); skipped without them. SHOW_SCREENS=1 prints the screens along the way.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BUNDLE, canRun, cliCommand, ended, openScreen, removeAll, type Screen } from './harness.ts';

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
  await ended(ollama);
  if (home) {
    // The background service of this test's folder.
    try {
      execFileSync(process.execPath, [BUNDLE, 'daemon', 'stop', '--force'], { env: env(), timeout: 10_000 });
    } catch {
      // Not running.
    }
    await removeAll(home);
  }
});

/** The terminal app's saved settings. */
const saved = (): { fullscreen?: boolean } => {
  try {
    return JSON.parse(readFileSync(join(home, '.atelier', 'cli', 'config.json'), 'utf8')) as { fullscreen?: boolean };
  } catch {
    return {};
  }
};
const env = () => ({ ...process.env, ATELIER_NO_BROWSER: '1', HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, '.atelier', 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '', NO_UPDATE_CHECK: '1' });

it.skipIf(!canRun())('sets up on this computer, asks about the folder, and answers', { timeout: 180_000 }, async () => {
  const s = await openScreen({ cwd: project, env: env(), command: cliCommand() });
  try {
    // The first start after a build fills Node's compile cache: on a cold machine that takes a while.
    await s.waitFor('Where should Atelier run?', 60_000);
    // The network search is done (a server it finds goes in at the top of the list).
    await s.waitFor(/Found (one server|\d+ servers) on your network|No server found|reach your local network/, 30_000);
    show('where', s);
    await s.select(/^Only this computer/);
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
    await s.waitFor('Which model, and how much should it ask?', 30_000);
    show('model', s);
    await s.type('fake-chat');
    await s.waitFor('/ fake-chat');
    await s.press('enter');
    await s.waitFor('All set');
    show('done', s);
    await s.press('enter');
    await s.waitFor('Work in', 30_000);
    show('trust', s);
    await s.press('enter');
    // Asked once: the fullscreen view. In it, the footer is the screen's last line from the start.
    await s.waitFor('Try the fullscreen view?', 30_000);
    show('fullscreen?', s);
    await s.press('enter');
    await s.waitFor('Ask about shader', 30_000);
    show('session', s);
    const screen = s.text().split('\n');
    expect(screen).toHaveLength(40);
    expect(screen.at(-1)).toContain('⏵⏵');
    expect(screen.slice(0, 10).join('\n')).toContain('Atelier');
    expect(saved().fullscreen).toBe(true);
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
    // /fullscreen switches to the classic view: the same session goes on.
    await s.type('/fullscreen');
    await s.press('enter');
    await s.waitFor(() => saved().fullscreen === false, 30_000);
    // The classic view prints into the terminal below the shell's line, the conversation included.
    await s.waitFor(() => s.text().includes('exec "') && s.text().includes('hello there') && s.text().includes('⏵⏵'), 30_000);
    show('classic again', s);
    await s.press('ctrlD');
  } finally {
    await s.close();
  }
  // The next start goes straight to the session screen, and -c picks the session up.
  const again = await openScreen({ cwd: project, env: env(), command: cliCommand('-c') });
  try {
    await again.waitFor('hello there', 30_000);
    show('continued', again);
  } finally {
    await again.close();
  }
  expect(existsSync(join(home, '.atelier', 'cli', 'data', 'atelier.db'))).toBe(true);
});
