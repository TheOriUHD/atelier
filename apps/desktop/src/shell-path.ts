/**
 * Apps opened from the Dock or a file manager start with a minimal PATH (`/usr/bin:/bin:…`), so programs
 * installed with Homebrew, nvm and the like — `npx` for connectors, `gh` for pull requests, a newer `git` —
 * aren't found. The login shell's PATH is read once at launch and put first, as a terminal would have it.
 */
import { execFile } from 'node:child_process';

const MARKER = '__ATELIER_PATH__';
const TIMEOUT_MS = 5_000;

/** The login shell's PATH, or undefined on Windows or when the shell doesn't answer in time. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform === 'win32') return Promise.resolve(undefined);
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return new Promise((resolve) => {
    // Interactive, so rc files that set PATH (nvm, Homebrew's shellenv) run; the markers skip anything they print.
    execFile(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], { timeout: TIMEOUT_MS, env }, (_error, stdout) => {
      resolve(new RegExp(`${MARKER}(.*?)${MARKER}`, 's').exec(String(stdout))?.[1] || undefined);
    });
  });
}

/** `first`'s entries, then those of `rest` it lacks. */
export function mergePaths(first: string | undefined, rest: string | undefined): string | undefined {
  const entries = [...(first ?? '').split(':'), ...(rest ?? '').split(':')].filter(Boolean);
  return entries.length ? [...new Set(entries)].join(':') : undefined;
}
