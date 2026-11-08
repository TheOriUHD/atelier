import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRelease, CLI_TARGETS, cliPackage, expectedFiles, isPackage, renderCliInstaller } from './lib.mjs';
import { planUploads } from '../cloudflare/upload.mjs';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('the terminal app in a release', () => {
  it('is six signed packages and a manifest that goes up after them', () => {
    const files = expectedFiles('0.6.0').cli;
    expect(files).toContain('atelier-cli-0.6.0-darwin-arm64.tar.gz');
    expect(files).toContain('atelier-cli-0.6.0-windows-x64.zip');
    expect(files.at(-1)).toBe('atelier-cli.json');
    expect(files.filter(isPackage)).toHaveLength(6);
    const plan = planUploads(files);
    expect(plan.first.map((f) => f.name)).toHaveLength(6);
    expect(plan.last.map((f) => f.name)).toEqual(['atelier-cli.json']);
  });

  it('checks the manifest against the packages', () => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-cli-release-'));
    const files = {};
    for (const key of CLI_TARGETS) {
      const file = cliPackage('0.6.0', key);
      writeFileSync(join(dir, file), `package ${key}`);
      files[key] = { file, sha512: createHash('sha512').update(`package ${key}`).digest('base64'), size: `package ${key}`.length };
    }
    writeFileSync(join(dir, 'atelier-cli.json'), JSON.stringify({ version: '0.6.0', files }));
    expect(checkRelease(dir, '0.6.0', ['cli'])).toEqual([]);
    writeFileSync(join(dir, cliPackage('0.6.0', 'linux-x64')), 'something else');
    expect(checkRelease(dir, '0.6.0', ['cli'])).toEqual([`${cliPackage('0.6.0', 'linux-x64')} does not match atelier-cli.json`]);
    expect(checkRelease(dir, '0.6.1', ['cli'])).toContain('atelier-cli.json says version 0.6.0, not 0.6.1');
  });

  it('writes the version, channel and checksums into both install scripts, which still parse', () => {
    const sums = Object.fromEntries(CLI_TARGETS.map((key) => [cliPackage('0.6.0', key), 'a'.repeat(64)]));
    const sh = renderCliInstaller(readFileSync(join(import.meta.dirname, 'cli-install.sh.tmpl'), 'utf8'), '0.6.0', 'stable', sums);
    expect(sh).toContain('VERSION="0.6.0"');
    expect(sh).toContain('CHANNEL="stable"');
    expect(sh).toContain(`${'a'.repeat(64)}  atelier-cli-0.6.0-linux-arm64.tar.gz`);
    dir = mkdtempSync(join(tmpdir(), 'atelier-cli-install-'));
    writeFileSync(join(dir, 'install.sh'), sh);
    if (process.platform !== 'win32') execFileSync('sh', ['-n', join(dir, 'install.sh')]);
    const ps = renderCliInstaller(readFileSync(join(import.meta.dirname, 'cli-install.ps1.tmpl'), 'utf8'), '0.6.0-beta.1', 'beta', sums);
    expect(ps).toContain("$Version = '0.6.0-beta.1'");
    expect(ps).toContain(`${'a'.repeat(64)}  atelier-cli-0.6.0-windows-arm64.zip`);
    expect(() => renderCliInstaller(sh, '0.6.0', 'stable', { 'evil.sh': 'a'.repeat(64) })).toThrow(/Unexpected/);
    expect(() => renderCliInstaller('@VERSION@ @SUMS@', '0.6.0', 'stable', sums)).toThrow(/@CHANNEL@/);
  });
});
