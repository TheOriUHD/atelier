import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Runs deploy/cloudflare/publish.mjs for real, with a stand-in for `npx wrangler` that only writes down what it was asked,
 * and a bucket name that is not the project's (so the script never asks the network what is there). Nothing is uploaded.
 */
const SCRIPT = resolve(import.meta.dirname, '../cloudflare/publish.mjs');
let work: string;
let calls: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'publish-test-'));
  calls = join(work, 'calls.log');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  // npx --yes wrangler@4 r2 object put <bucket>/<channel>/<key> --file <path> --remote
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  const key = execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519'], { encoding: 'utf8' });
  writeFileSync(join(work, 'key.pem'), key);
  const files = join(work, 'files');
  mkdirSync(files);
  for (const name of ['Atelier-1.0.0-mac.zip', 'Atelier-1.0.0.dmg', 'Atelier-1.0.0.dmg.blockmap', 'Atelier-Setup-1.0.0-x64.exe', 'Atelier-Setup-1.0.0-arm64.exe', 'latest.yml', 'latest-mac.yml']) writeFileSync(join(files, name), `bytes of ${name}`);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function publish(...flags: string[]) {
  const r = spawnSync('node', [SCRIPT, join(work, 'files'), 'stable', ...flags], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, ATELIER_UPDATE_KEY: join(work, 'key.pem'), ATELIER_RELEASES_BUCKET: 'test-bucket', ATELIER_RELEASE_FEED: '', ATELIER_PUBLISH_JOBS: '' },
  });
  const puts = readFileSync(calls, 'utf8')
    .split('\n')
    .filter((l) => l.includes('object put'))
    .map((l) => /test-bucket\/stable\/(\S+)/.exec(l)![1]!);
  return { status: r.status, out: r.stdout + r.stderr, puts, all: readFileSync(calls, 'utf8') };
}

describe('publish.mjs', () => {
  it('checks the login first, sends signatures with the packages, leaves the disk image to GitHub and the update files last', () => {
    const r = publish();
    expect(r.status, r.out).toBe(0);
    expect(r.all.split('\n')[0]).toContain('r2 bucket info test-bucket');
    expect(r.puts).toEqual(expect.arrayContaining(['Atelier-1.0.0-mac.zip', 'Atelier-1.0.0-mac.zip.sig', 'Atelier-Setup-1.0.0-x64.exe.sig', 'Atelier-Setup-1.0.0-arm64.exe', 'Atelier-1.0.0.dmg.sig']));
    expect(r.puts).not.toContain('Atelier-1.0.0.dmg');
    expect(r.puts).not.toContain('Atelier-1.0.0.dmg.blockmap');
    expect(r.puts.slice(-2).sort()).toEqual(['latest-mac.yml', 'latest.yml']);
    // The signature goes after its package.
    expect(r.puts.indexOf('Atelier-1.0.0-mac.zip')).toBeLessThan(r.puts.indexOf('Atelier-1.0.0-mac.zip.sig'));
  });

  it('with --packages-only sends no update file, so nothing points at the packages yet', () => {
    const r = publish('--packages-only');
    expect(r.status, r.out).toBe(0);
    expect(r.puts.some((p) => p.startsWith('latest'))).toBe(false);
    expect(r.puts).toContain('Atelier-Setup-1.0.0-x64.exe');
  });

  it('with --disk-images sends the disk image too', () => {
    const r = publish('--disk-images');
    expect(r.puts).toEqual(expect.arrayContaining(['Atelier-1.0.0.dmg', 'Atelier-1.0.0.dmg.blockmap']));
  });

  it('refuses a folder with no update file', () => {
    rmSync(join(work, 'files/latest.yml'));
    rmSync(join(work, 'files/latest-mac.yml'));
    const r = spawnSync('node', [SCRIPT, join(work, 'files'), 'stable'], { encoding: 'utf8', env: { ...process.env, ATELIER_UPDATE_KEY: join(work, 'key.pem') } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no latest\*\.yml/);
  });
});
