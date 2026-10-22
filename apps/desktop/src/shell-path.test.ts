import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginShellPath, mergePaths } from './shell-path.ts';

// A login shell is a POSIX thing (a script run by /bin/sh); Windows has no such PATH to read.
describe.skipIf(process.platform === 'win32')('login shell PATH', () => {
  it('reads PATH from the login shell, skipping what its startup files print', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-shell-'));
    // A shell whose startup prints a greeting and adds to PATH, then runs the command it was given (`-ilc <command>`).
    const shell = join(dir, 'shell');
    writeFileSync(shell, '#!/bin/sh\necho "Welcome back"\nPATH=/from/rc/bin:/usr/bin:/bin\neval "$2"\n');
    chmodSync(shell, 0o755);
    try {
      expect(await loginShellPath({ SHELL: shell, PATH: '/usr/bin:/bin' }, 'linux')).toBe('/from/rc/bin:/usr/bin:/bin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up on Windows and on shells that fail', async () => {
    expect(await loginShellPath({}, 'win32')).toBeUndefined();
    expect(await loginShellPath({ SHELL: '/nonexistent/shell' }, 'linux')).toBeUndefined();
  });

  it('puts the shell’s entries first without repeating any', () => {
    expect(mergePaths('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin')).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(mergePaths(undefined, '/usr/bin')).toBe('/usr/bin');
    expect(mergePaths(undefined, undefined)).toBeUndefined();
  });
});
