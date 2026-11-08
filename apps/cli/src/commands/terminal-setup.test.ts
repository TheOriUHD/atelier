import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setupTerminal, terminalName } from './terminal-setup.ts';

let dir = '';
afterEach(async () => dir && (await rm(dir, { recursive: true, force: true })));

it('knows which terminals send Shift+Enter', () => {
  expect(terminalName({ TERM_PROGRAM: 'ghostty' }).shiftEnter).toBe('native');
  expect(terminalName({ TERM_PROGRAM: 'vscode' })).toEqual({ label: 'VS Code', shiftEnter: 'setup' });
  expect(terminalName({ TERM_PROGRAM: 'Apple_Terminal' }).shiftEnter).toBe('none');
});

it.skipIf(process.platform === 'win32')('adds Shift+Enter to VS Code once, keeping what is there', async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-vscode-'));
  const env = { TERM_PROGRAM: 'vscode', HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), APPDATA: dir };
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    const said = await setupTerminal(env);
    expect(said).toContain('Added Shift+Enter');
    expect(await setupTerminal(env)).toContain('already has');
    const file = process.platform === 'darwin' ? join(dir, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json') : join(dir, '.config', 'Code', 'User', 'keybindings.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ key: 'shift+enter', command: 'workbench.action.terminal.sendSequence', args: { text: '\u001b\r' }, when: 'terminalFocus' }]);
  } finally {
    process.env.HOME = prev;
  }
});
