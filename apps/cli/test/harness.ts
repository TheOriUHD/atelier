/**
 * Drives the built terminal app in a real pseudo-terminal (the runner's PTY: ConPTY on Windows) and reads its screen
 * through a headless xterm.js, so tests type keys and look at what a person would see.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import { hostRunnerBinary, RunnerClient } from '../../../packages/core/src/workspaces/runner-client.ts';

export const RUNNER_DIR = join(import.meta.dirname, '../../../runner/bin');
export const BUNDLE = join(import.meta.dirname, '../dist/atelier.mjs');
export const canRun = () => existsSync(hostRunnerBinary(RUNNER_DIR)) && existsSync(BUNDLE);

/** The line that starts the built app in the test's shell (sh, or cmd.exe on Windows). */
export const cliCommand = (args = '') => (process.platform === 'win32' ? `"${process.execPath}" "${BUNDLE}" ${args}` : `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(BUNDLE)} ${args}`).trim();

/** Ends a child process and waits until it is gone (Windows keeps its files locked until then). */
export async function ended(child: import('node:child_process').ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
}

/** Removes a test's folder; Windows may hold files a moment after their process ended. */
export const removeAll = (dir: string) => import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

export const KEYS = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  shiftTab: '\x1b[Z',
  backspace: '\x7f',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlO: '\x0f',
  altEnter: '\x1b\r',
} as const;

export interface Screen {
  /** What is on the screen now, line by line, trailing blanks trimmed. */
  text(): string;
  /** Everything printed so far, scrollback included. */
  all(): string;
  type(text: string): Promise<void>;
  press(key: keyof typeof KEYS, times?: number): Promise<void>;
  waitFor(match: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Moves a choice list's cursor (›) down to the row matching `row`. */
  select(row: RegExp, max?: number): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openScreen(options: { cwd: string; env: NodeJS.ProcessEnv; command: string; cols?: number; rows?: number }): Promise<Screen> {
  const cols = options.cols ?? 110;
  const rows = options.rows ?? 40;
  const runner = await RunnerClient.spawn({ binaryPath: hostRunnerBinary(RUNNER_DIR), roots: [options.cwd], env: { ...options.env, TERM: 'xterm-256color' } });
  const term = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const { ptyId } = await runner.call('pty.open', { cwd: options.cwd, cols, rows, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' });
  runner.on('pty.data', (n) => n.ptyId === ptyId && term.write(Buffer.from(n.b64, 'base64')));
  // Answers the terminal's own questions (the background colour) the way a dark terminal would.
  term.onData((reply) => void runner.call('pty.write', { ptyId, data: reply }).catch(() => undefined));
  const lines = (from: number, to: number) => {
    const out: string[] = [];
    const buffer = term.buffer.active;
    for (let i = from; i < to; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').replace(/\n+$/, '');
  };
  const screen: Screen = {
    text: () => lines(term.buffer.active.viewportY, term.buffer.active.viewportY + rows),
    all: () => lines(0, term.buffer.active.length),
    type: async (text) => {
      await runner.call('pty.write', { ptyId, data: text });
      await sleep(60);
    },
    press: async (key, times = 1) => {
      for (let i = 0; i < times; i++) {
        await runner.call('pty.write', { ptyId, data: KEYS[key] });
        await sleep(80);
      }
    },
    waitFor: async (match, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = screen.all();
        if (typeof match === 'string' ? text.includes(match) : match.test(text)) return text;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(match)}. The screen:\n${screen.text()}`);
        await sleep(100);
      }
    },
    select: async (row, max = 30) => {
      for (let i = 0; i < max; i++) {
        const current = screen.text().split('\n').find((l) => l.includes('› '));
        const label = current?.slice(current.indexOf('› ') + 2).split(/\s{2,}|│/)[0]!.replace(/^\d+\.\s*/, '').trim();
        if (label !== undefined && row.test(label)) return;
        await screen.press('down');
      }
      throw new Error(`No row matching ${String(row)}. The screen:\n${screen.text()}`);
    },
    close: async () => {
      await runner.call('pty.close', { ptyId }).catch(() => undefined);
      await runner.call('shutdown', {}).catch(() => undefined);
      term.dispose();
    },
  };
  await sleep(300);
  await screen.type(`${options.command}\r`);
  return screen;
}
