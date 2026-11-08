/**
 * The terminal's own features, by escape sequence: the window title, a notification, a link, the clipboard, whether
 * the window has focus, and what colour its background is. Each is harmless where a terminal doesn't know it.
 */
import { execFile, spawn } from 'node:child_process';

const ESC = '\x1b';
const BEL = '\x07';

// eslint-disable-next-line no-control-regex -- a title may not carry control characters.
export const setTitle = (title: string) => (process.stdout.isTTY ? process.stdout.write(`${ESC}]0;${title.replace(/[\x00-\x1f]/g, ' ')}${BEL}`) : true);

/** A desktop notification where the terminal shows them (iTerm2, Ghostty, WezTerm, kitty, Windows Terminal), else the bell. */
export function notify(title: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!process.stdout.isTTY) return;
  // eslint-disable-next-line no-control-regex -- nor may a notification.
  const clean = (s: string) => s.replace(/[\x00-\x1f;]/g, ' ').slice(0, 200);
  const program = env.TERM_PROGRAM ?? '';
  if (/kitty/.test(env.TERM ?? '')) process.stdout.write(`${ESC}]99;i=1:d=0;${clean(title)}${ESC}\\${ESC}]99;i=1:d=1:p=body;${clean(body)}${ESC}\\`);
  else if (program === 'iTerm.app' || program === 'WezTerm' || program === 'ghostty' || env.WT_SESSION) process.stdout.write(`${ESC}]9;${clean(title)}: ${clean(body)}${BEL}`);
  else if (/rxvt|foot|konsole/.test(env.TERM ?? '') || env.KONSOLE_VERSION) process.stdout.write(`${ESC}]777;notify;${clean(title)};${clean(body)}${BEL}`);
  else process.stdout.write(BEL);
}

/** Whether the terminal makes OSC 8 links clickable. */
export const linksWork = (env: NodeJS.ProcessEnv = process.env) => !!(env.WT_SESSION || /^(iTerm\.app|WezTerm|vscode|ghostty|Hyper|Tabby)$/.test(env.TERM_PROGRAM ?? '') || /kitty|foot|alacritty/.test(env.TERM ?? '') || env.VTE_VERSION);

/** A clickable link (OSC 8) where the terminal knows them; the text alone elsewhere. */
export function link(url: string, text = url, env: NodeJS.ProcessEnv = process.env): string {
  return linksWork(env) ? `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}` : text;
}

/** Copies text with OSC 52 (works over SSH too); the system's copy command as well where there is one. */
export function copy(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}]52;c;${Buffer.from(text).toString('base64')}${BEL}`);
  const command = process.platform === 'darwin' ? ['pbcopy', []] : process.platform === 'win32' ? ['clip', []] : process.env.WAYLAND_DISPLAY ? ['wl-copy', []] : ['xclip', ['-selection', 'clipboard']];
  try {
    const child = spawn(command[0] as string, command[1] as string[], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => undefined);
    child.stdin.end(text);
  } catch {
    // No clipboard program: OSC 52 is all.
  }
}

/** Opens a link in the browser (not over SSH, where there's none to open it in). */
export function openUrl(url: string): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.ATELIER_NO_BROWSER) return false;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const FOCUS_ON = `${ESC}[?1004h`;
export const FOCUS_OFF = `${ESC}[?1004l`;
export const CLEAR_ALL = `${ESC}[2J${ESC}[3J${ESC}[H`;

/**
 * The background colour, by asking the terminal (OSC 11) before Ink takes the input; `COLORFGBG` otherwise. Dark when
 * nothing says.
 */
export async function backgroundShade(timeoutMs = 120): Promise<'dark' | 'light'> {
  const fromEnv = /;(\d+)$/.exec(process.env.COLORFGBG ?? '');
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.platform === 'win32') return fromEnv && Number(fromEnv[1]) >= 7 && Number(fromEnv[1]) !== 8 ? 'light' : 'dark';
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let data = '';
    const done = (shade: 'dark' | 'light') => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(shade);
    };
    const onData = (chunk: Buffer) => {
      data += chunk.toString('latin1');
      const m = /\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(data);
      if (!m) return;
      const level = (h: string) => parseInt(h.slice(0, 2), 16);
      const luminance = 0.2126 * level(m[1]!) + 0.7152 * level(m[2]!) + 0.0722 * level(m[3]!);
      done(luminance > 140 ? 'light' : 'dark');
    };
    const timer = setTimeout(() => done(fromEnv && Number(fromEnv[1]) >= 7 && Number(fromEnv[1]) !== 8 ? 'light' : 'dark'), timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    process.stdout.write(`${ESC}]11;?${BEL}`);
  });
}

/** An image on the clipboard, saved to `file` as PNG; false when there is none (or no way to read it here). */
export function clipboardImage(file: string): Promise<boolean> {
  const script: [string, string[]] | null =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `set f to (open for access POSIX file "${file}" with write permission)`, '-e', 'try', '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'end try', '-e', 'close access f']]
      : process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${file.replace(/'/g, "''")}', [Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`]]
        : process.env.WAYLAND_DISPLAY
          ? ['sh', ['-c', `wl-paste --type image/png > '${file.replace(/'/g, "'\\''")}'`]]
          : ['sh', ['-c', `xclip -selection clipboard -t image/png -o > '${file.replace(/'/g, "'\\''")}'`]];
  if (!script) return Promise.resolve(false);
  return new Promise((resolve) =>
    execFile(script[0], script[1], { timeout: 5000 }, async (error) => {
      if (error) return resolve(false);
      const { stat } = await import('node:fs/promises');
      resolve(((await stat(file).catch(() => null))?.size ?? 0) > 0);
    }),
  );
}
