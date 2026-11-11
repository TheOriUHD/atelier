#!/usr/bin/env -S npx tsx
/**
 * Records the Atelier CLI clip for What's New (packages/ui/src/features/whats-new/media): a real session of the built
 * terminal app in a real pseudo-terminal (the runner's PTY), against the scripted demo model, on throwaway data. The
 * terminal's output is kept with its timing, then played back in xterm.js frame by frame (so the clip is smooth whatever
 * the machine) and encoded as a silent MP4 with a poster frame. Nothing touches ~/.atelier or the installed app.
 *
 *   pnpm --filter @atelier/cli build && npx tsx apps/cli/scripts/record-clip.ts [outDir]
 *
 * Needs the runner (`pnpm runner:build -host`), ffmpeg, and Playwright's Chromium.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import xterm from '@xterm/headless';
import { BUNDLE, canRun, cliCommand, ended, KEYS, openScreen, RUNNER_DIR } from '../test/harness.ts';
import { hostRunnerBinary, RunnerClient } from '../../../packages/core/src/workspaces/runner-client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(process.argv[2] ?? join(root, 'packages/ui/src/features/whats-new/media'));
const PORT = 11640;
/** The clip's terminal: few enough columns that its text stays readable at the dialog's width. */
const COLS = 74;
const ROWS = 22;
const FPS = 30;
/** Pauses longer than this (the model thinking, a slow start) are shortened in the clip. */
const MAX_GAP = 1.6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!canRun()) throw new Error('Build the terminal app (pnpm --filter @atelier/cli build) and the runner (pnpm runner:build -host) first.');

// A repository named "timeline" with a small HTTP handler, as on the website's screenshots.
// The real path (macOS's /var is /private/var): the model's paths must be the workspace's, or they read as outside it.
const home = await realpath(await mkdtemp(join(tmpdir(), 'atelier-clip-')));
const repo = join(home, 'timeline');
await mkdir(join(repo, 'src'), { recursive: true });
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
await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'timeline', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Sam Taylor');
git('config', 'user.email', 'sam@example.invalid');
git('add', '.');
git('commit', '-qm', 'Initial commit');

const model = spawn(process.execPath, [join(root, 'apps/site/shots/demo-model.mjs'), String(PORT), repo, join(home, 'work')], { stdio: 'ignore', env: { ...process.env, DEMO_PACE: '30', DEMO_STEP_MS: '900' } });
await sleep(600);
const env = { ...process.env, ATELIER_NO_BROWSER: '1', HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, '.atelier', 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '', NO_UPDATE_CHECK: '1', COLORTERM: 'truecolor' };

try {
  // 1. The setup, off the record: this computer, a name, the demo model, Accept edits, the folder, the fullscreen view.
  const setup = await openScreen({ cwd: repo, env, command: cliCommand(), cols: COLS, rows: 40 });
  try {
    await setup.waitFor('Where should Atelier run?', 60_000);
    await setup.waitFor(/Found (one server|\d+ servers) on your network|No server found|reach your local network/, 30_000);
    await setup.select(/^Only this computer/);
    await setup.press('enter');
    await setup.waitFor('What should Atelier call you?', 30_000);
    await setup.type('Sam');
    await setup.press('enter');
    await setup.waitFor('Add Ollama', 30_000);
    await setup.select(/^Add Ollama$/);
    await setup.press('enter');
    await setup.waitFor('The address it listens at');
    await setup.type('\x15');
    await setup.type(`http://127.0.0.1:${PORT}`);
    await setup.press('enter');
    await setup.waitFor(/Added Ollama with \d+ models?/, 30_000);
    await setup.press('enter');
    await setup.waitFor('Which model, and how much should it ask?', 30_000);
    // The chosen mode reads ‹ Accept edits ›.
    for (let i = 0; i < 5 && !/‹ Accept edits ›/.test(setup.text()); i++) {
      await setup.press('right');
      await sleep(200);
    }
    await setup.press('enter');
    await setup.waitFor('All set', 30_000);
    if (!/Accept edits/.test(setup.text())) throw new Error(`The mode isn't Accept edits:\n${setup.text()}`);
    await setup.press('enter');
    await setup.waitFor('Work in', 30_000);
    await setup.press('enter');
    await setup.waitFor('Try the fullscreen view?', 30_000);
    await setup.press('enter');
    await setup.waitFor('⏵⏵', 30_000);
    await setup.press('ctrlD');
    await sleep(800);
  } finally {
    await setup.close();
  }

  // 2. The session, recorded: what the terminal printed and when.
  const runner = await RunnerClient.spawn({ binaryPath: hostRunnerBinary(RUNNER_DIR), roots: [repo], env: { ...env, TERM: 'xterm-256color' } });
  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  const { ptyId } = await runner.call('pty.open', { cwd: repo, cols: COLS, rows: ROWS, shell: '/bin/sh' });
  const events: [number, string][] = [];
  let started = 0;
  runner.on('pty.data', (n) => {
    if (n.ptyId !== ptyId) return;
    if (started) events.push([(performance.now() - started) / 1000, n.b64]);
    term.write(Buffer.from(n.b64, 'base64'));
  });
  term.onData((reply) => void runner.call('pty.write', { ptyId, data: reply }).catch(() => undefined));
  const screen = () => {
    const b = term.buffer.active;
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
  };
  const until = async (match: RegExp, timeout = 60_000) => {
    const deadline = Date.now() + timeout;
    while (!match.test(screen())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${match}:\n${screen()}`);
      await sleep(50);
    }
  };
  const write = (data: string) => runner.call('pty.write', { ptyId, data });
  await sleep(300);
  // The shell's own prompt stays out of the clip: the screen is cleared before the app starts.
  await write(`clear; ${cliCommand()}\r`);
  await sleep(150);
  started = performance.now();
  await until(/⏵⏵/);
  await sleep(1400);
  // Typed like a person, a key at a time.
  for (const ch of 'add uptime to /health, with a test') {
    await write(ch);
    await sleep(55 + ((ch.charCodeAt(0) * 7) % 40));
  }
  await sleep(500);
  await write(KEYS.enter);
  // Running the tests asks first in Accept edits: allowed once.
  await until(/Run this command\?/);
  await sleep(1600);
  await write(KEYS.enter);
  await until(/◉ .+ for \d+s · done \d/, 90_000);
  await sleep(2800);
  const end = (performance.now() - started) / 1000;
  await write(KEYS.ctrlD);
  await sleep(500);
  await runner.call('pty.close', { ptyId }).catch(() => undefined);
  await runner.call('shutdown', {}).catch(() => undefined);
  term.dispose();

  // Long pauses shortened: the clip keeps its rhythm without the waits.
  let shift = 0;
  let last = 0;
  const timeline = events.map(([t, b64]) => {
    const gap = t - last;
    if (gap > MAX_GAP) shift += gap - MAX_GAP;
    last = t;
    return [t - shift, b64] as const;
  });
  const duration = Math.min(end - shift, (timeline.at(-1)?.[0] ?? 0) + 2.8);

  // 3. Played back in xterm.js, a frame at a time, in a terminal window on the app's dark background.
  const frames = await mkdtemp(join(tmpdir(), 'atelier-clip-frames-'));
  const xtermDir = join(root, 'packages/ui/node_modules/@xterm/xterm');
  const font = pathToFileURL(join(root, 'apps/site/public/fonts/jetbrains-mono-latin-wght-normal.woff2')).href;
  const page = join(frames, 'player.html');
  await writeFile(
    page,
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(join(xtermDir, 'css/xterm.css')).href}">
<style>
  @font-face { font-family: 'JetBrains Mono'; src: url('${font}') format('woff2'); font-weight: 100 800; }
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; background: radial-gradient(120% 90% at 50% 0%, #2a2522 0%, #151515 62%); }
  .win { position: absolute; left: 36px; top: 30px; width: 1208px; height: 740px; border-radius: 14px; background: #1A1A19; box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 24px 60px rgba(0,0,0,0.55); overflow: hidden; }
  .bar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; margin-right: 52px; font: 500 13px/1 'JetBrains Mono', monospace; color: #9C9A94; }
  #t { position: absolute; left: 22px; top: 52px; right: 22px; bottom: 14px; }
  .xterm .xterm-viewport { background: transparent !important; overflow: hidden !important; }
</style></head><body>
<div class="win"><div class="bar"><span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span><span class="title">~/timeline — atelier</span></div><div id="t"></div></div>
<script src="${pathToFileURL(join(xtermDir, 'lib/xterm.js')).href}"></script>
<script>
  window.ready = (async () => {
    await document.fonts.load("26px 'JetBrains Mono'");
    const box = document.getElementById('t');
    // The largest font at which ${COLS} columns and ${ROWS} rows fit the window.
    let size = 30;
    const probe = document.createElement('span');
    probe.style.font = size + "px 'JetBrains Mono'";
    probe.textContent = 'M'.repeat(100);
    document.body.appendChild(probe);
    const advance = probe.getBoundingClientRect().width / 100 / size;
    probe.remove();
    size = Math.floor(Math.min(box.clientWidth / (${COLS} * advance), box.clientHeight / (${ROWS} * 1.18)) * 10) / 10;
    const term = new Terminal({ cols: ${COLS}, rows: ${ROWS}, fontFamily: "'JetBrains Mono', monospace", fontSize: size, lineHeight: 1.15, cursorBlink: false, allowTransparency: true,
      theme: { background: '#1A1A19', foreground: '#F0EFEC', cursor: '#F0EFEC', selectionBackground: '#C6613F55' } });
    term.open(box);
    // xterm.js rounds its cells to whole pixels: smaller until every row and column is inside the window.
    const screen = () => box.querySelector('.xterm-screen').getBoundingClientRect();
    await new Promise((r) => requestAnimationFrame(r));
    while ((screen().height > box.clientHeight || screen().width > box.clientWidth) && term.options.fontSize > 10) {
      term.options.fontSize = term.options.fontSize - 0.5;
      await new Promise((r) => requestAnimationFrame(r));
    }
    // The window wraps the terminal snugly, in the middle of the frame.
    const win = document.querySelector('.win');
    const w = Math.ceil(screen().width) + 44;
    const h = Math.ceil(screen().height) + 52 + 18;
    Object.assign(win.style, { width: w + 'px', height: h + 'px', left: Math.round((1280 - w) / 2) + 'px', top: Math.round((800 - h) / 2) + 'px' });
    Object.assign(box.style, { right: 'auto', bottom: 'auto', width: Math.ceil(screen().width) + 'px', height: Math.ceil(screen().height) + 'px' });
    window.feed = (b64) => new Promise((done) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), done));
    window.paint = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })();
</script></body></html>`,
  );
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await tab.goto(pathToFileURL(page).href);
    await tab.evaluate(() => (globalThis as unknown as { ready: Promise<void> }).ready);
    let next = 0;
    const count = Math.ceil(duration * FPS);
    for (let frame = 0; frame < count; frame++) {
      const at = frame / FPS;
      while (next < timeline.length && timeline[next]![0] <= at) {
        const b64 = timeline[next]![1];
        await tab.evaluate((data) => (globalThis as unknown as { feed(b: string): Promise<void> }).feed(data), b64);
        next++;
      }
      await tab.evaluate(() => (globalThis as unknown as { paint(): Promise<void> }).paint());
      await tab.screenshot({ path: join(frames, `${String(frame).padStart(5, '0')}.png`) });
    }
    console.log(`${count} frames, ${duration.toFixed(1)} s`);
    await mkdir(out, { recursive: true });
    const clip = join(out, 'atelier-cli.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip]);
    // The poster: the finished turn, the last frame.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(frames, `${String(count - 1).padStart(5, '0')}.png`), '-q:v', '4', join(out, 'atelier-cli.jpg')]);
    const size = (await readFile(clip)).length;
    console.log(`wrote ${clip} (${(size / 1024).toFixed(0)} KB) and its poster`);
  } finally {
    await browser.close();
    await rm(frames, { recursive: true, force: true });
  }
} finally {
  try {
    execFileSync(process.execPath, [BUNDLE, 'daemon', 'stop', '--force'], { env, timeout: 10_000, stdio: 'ignore' });
  } catch {
    // Not running.
  }
  await ended(model);
  await rm(home, { recursive: true, force: true });
}
