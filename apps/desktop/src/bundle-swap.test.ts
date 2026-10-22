import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWAP_SCRIPT, targetOf } from './bundle-swap.ts';

// macOS only: the app swaps its own bundle with a shell script (bundle-swap.ts), which Windows never does.
describe.skipIf(process.platform === 'win32')('where the app can replace itself', () => {
  const yes = () => true;
  it('is its own bundle, when that and its folder can be written', () => {
    expect(targetOf('/Applications/Atelier.app/Contents/MacOS/Atelier', yes)).toEqual({ bundle: '/Applications/Atelier.app' });
    expect(targetOf('/Applications/Atelier.app/Contents/MacOS/Atelier', (p) => p !== '/Applications')).toMatchObject({ reason: expect.stringContaining('cannot replace itself') });
  });

  it('is nowhere for a quarantined copy, a disk image or something that is not a bundle', () => {
    expect(targetOf('/private/var/folders/x/AppTranslocation/ABC/d/Atelier.app/Contents/MacOS/Atelier', yes)).toMatchObject({ reason: expect.stringContaining('Applications') });
    expect(targetOf('/Volumes/Atelier/Atelier.app/Contents/MacOS/Atelier', yes)).toMatchObject({ reason: expect.stringContaining('disk image') });
    expect(targetOf('/usr/local/bin/atelier', yes)).toMatchObject({ reason: expect.stringContaining('not an app bundle') });
  });
});

describe.skipIf(process.platform === 'win32')('the swap script', () => {
  const sh = (args: string[]) => spawnSync('/bin/sh', ['-c', SWAP_SCRIPT, 'atelier-update', ...args], { encoding: 'utf8' });
  function folders() {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-swap-'));
    for (const [name, text] of [['Atelier.app', 'old'], ['new/Atelier.app', 'new']] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'version'), text);
    }
    return { dir, old: join(dir, 'Atelier.app'), staged: join(dir, 'new', 'Atelier.app') };
  }

  it('puts the new bundle where the old one was and leaves nothing behind', () => {
    const { dir, old, staged } = folders();
    // pid 2147483646 does not exist, so "the app has quit" at once.
    expect(sh(['2147483646', old, staged, '0']).status).toBe(0);
    expect(readFileSync(join(old, 'version'), 'utf8')).toBe('new');
    expect(existsSync(`${old}.previous`)).toBe(false);
    expect(existsSync(staged)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the old bundle when the new one is missing', () => {
    const { dir, old } = folders();
    expect(sh(['2147483646', old, join(dir, 'gone', 'Atelier.app'), '0']).status).toBe(0);
    expect(readFileSync(join(old, 'version'), 'utf8')).toBe('old');
    rmSync(dir, { recursive: true, force: true });
  });
});
