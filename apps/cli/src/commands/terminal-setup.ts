/**
 * Shift+Enter for a new line. Terminals that speak the kitty keyboard protocol (Ghostty, kitty, WezTerm, foot, recent
 * iTerm2) send it as it is; VS Code's terminal (and Cursor's) and Windows Terminal need a key binding that sends
 * Alt+Enter instead, which this adds. Alt+Enter and Ctrl+J work everywhere without any of it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function terminalName(env: NodeJS.ProcessEnv = process.env): { label: string; shiftEnter: 'native' | 'setup' | 'none' } {
  const program = env.TERM_PROGRAM ?? '';
  if (program === 'vscode') return { label: env.CURSOR_TRACE_ID ? 'Cursor' : 'VS Code', shiftEnter: 'setup' };
  if (env.WT_SESSION) return { label: 'Windows Terminal', shiftEnter: 'setup' };
  if (program === 'ghostty' || program === 'WezTerm' || /kitty|foot/.test(env.TERM ?? '')) return { label: program || 'your terminal', shiftEnter: 'native' };
  if (program === 'iTerm.app') return { label: 'iTerm2', shiftEnter: 'native' };
  if (program === 'Apple_Terminal') return { label: 'Terminal', shiftEnter: 'none' };
  return { label: program || 'your terminal', shiftEnter: 'none' };
}

/** JSON with comments (VS Code's and Windows Terminal's settings files). */
const stripComments = (text: string) => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1');

function vscodeFile(env: NodeJS.ProcessEnv): string {
  const product = env.CURSOR_TRACE_ID ? 'Cursor' : 'Code';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', product, 'User', 'keybindings.json');
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), product, 'User', 'keybindings.json');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), product, 'User', 'keybindings.json');
}

/** Adds the binding; says what it did (or what to do by hand). */
export async function setupTerminal(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const t = terminalName(env);
  if (t.shiftEnter === 'native') return `${t.label} sends Shift+Enter as it is: nothing to set up.`;
  if (t.label === 'VS Code' || t.label === 'Cursor') {
    const file = vscodeFile(env);
    const text = await readFile(file, 'utf8').catch(() => '[]');
    let list: unknown[];
    try {
      list = JSON.parse(stripComments(text) || '[]') as unknown[];
    } catch {
      return `Couldn’t read ${file}. Add this to it: {"key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": {"text": "\\u001b\\r"}, "when": "terminalFocus"}`;
    }
    if (list.some((b) => JSON.stringify(b).includes('"shift+enter"') && JSON.stringify(b).includes('terminal.sendSequence'))) return `${t.label} already has a Shift+Enter binding for the terminal.`;
    list.push({ key: 'shift+enter', command: 'workbench.action.terminal.sendSequence', args: { text: '\u001b\r' }, when: 'terminalFocus' });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(list, null, 2)}\n`);
    return `Added Shift+Enter to ${t.label}’s key bindings (${file}).`;
  }
  if (t.label === 'Windows Terminal') {
    const file = join(env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (!text) return 'Couldn’t find Windows Terminal’s settings. Add an action that sends "\\u001b\\r" on shift+enter.';
    const settings = JSON.parse(stripComments(text)) as { actions?: unknown[] };
    settings.actions ??= [];
    if (JSON.stringify(settings.actions).includes('shift+enter')) return 'Windows Terminal already has a Shift+Enter action.';
    settings.actions.push({ command: { action: 'sendInput', input: '\u001b\r' }, keys: 'shift+enter' });
    await writeFile(file, `${JSON.stringify(settings, null, 4)}\n`);
    return 'Added Shift+Enter to Windows Terminal’s actions.';
  }
  return `${t.label} can’t tell Shift+Enter from Enter. Use Alt+Enter (Option+Enter with “Use Option as Meta key”) or Ctrl+J for a new line.`;
}
