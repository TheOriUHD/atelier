import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changelogSection,
  checkRelease,
  compareVersions,
  cutChangelog,
  duration,
  expectedFiles,
  hasReleaseNotes,
  imageNames,
  parseNotarizationStatus,
  parseUpdateFile,
  parseVersion,
  readAppVersion,
  releaseNotes,
  renderInstaller,
  readPackageVersion,
  repoFromRemote,
  setAppVersion,
  setPackageVersion,
} from './lib.mjs';

describe('versions', () => {
  it('reads a version or a tag, and says which channel it belongs to', () => {
    expect(parseVersion('0.1.11')).toEqual({ version: '0.1.11', tag: 'v0.1.11', prerelease: false, channel: 'stable' });
    expect(parseVersion('v0.3.0-beta.1')).toEqual({ version: '0.3.0-beta.1', tag: 'v0.3.0-beta.1', prerelease: true, channel: 'beta' });
    for (const bad of ['', '1.2', 'latest', '0.1.x', 'v1.2.3.4']) expect(() => parseVersion(bad)).toThrow(/is not a version/);
  });

  it('orders versions, with a release after its own prereleases', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.1.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.10')).toBe(-1);
    expect(compareVersions('0.3.0-beta.1', '0.3.0-alpha.9')).toBe(1);
  });

  it('changes the version where the app and the packages read it, and nowhere else', () => {
    const app = "export const APP = {\n  name: 'Atelier',\n  version: '0.1.9',\n  changelog: 'https://example.com/0.1.9',\n};\n";
    expect(readAppVersion(app)).toBe('0.1.9');
    expect(setAppVersion(app, '0.1.10')).toBe(app.replace("version: '0.1.9'", "version: '0.1.10'"));
    expect(() => setAppVersion('nothing here', '1.0.0')).toThrow(/Can't find/);
    const pkg = '{\n  "name": "@atelier/desktop",\n  "version": "0.2.1-dev",\n  "dependencies": { "x": "1.0.0" }\n}\n';
    expect(readPackageVersion(pkg)).toBe('0.2.1-dev');
    expect(setPackageVersion(pkg, '0.1.10')).toBe(pkg.replace('0.2.1-dev', '0.1.10'));
  });

  it('wants the version in the What’s new notes', () => {
    expect(hasReleaseNotes("{ version: '0.1.10', intro: 'x' }", '0.1.10')).toBe(true);
    expect(hasReleaseNotes("{ version: '0.1.9', intro: 'x' }", '0.1.10')).toBe(false);
  });
});

describe('the changelog', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n- **New thing.** It works.\n- Another.\n\n## [0.1.9] — 2026-10-19\n\n- Old.\n';

  it('cuts the unreleased section into a dated version with a new empty one above it', () => {
    const cut = cutChangelog(log, '0.1.10', '2026-10-21');
    expect(cut).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.1.10] — 2026-10-21\n\n- **New thing.** It works.\n- Another.\n\n## [0.1.9] — 2026-10-19\n\n- Old.\n');
    expect(changelogSection(cut, '0.1.10')).toBe('- **New thing.** It works.\n- Another.');
    expect(changelogSection(cut, 'Unreleased')).toBe('');
    expect(changelogSection(cut, '0.0.1')).toBeNull();
  });

  it("gives a release its section and a prerelease the changes still waiting, which it doesn't cut", () => {
    const cut = cutChangelog(log, '0.1.10', '2026-10-21');
    expect(releaseNotes(cut, '0.1.10')).toBe('- **New thing.** It works.\n- Another.');
    expect(releaseNotes(log, '0.1.10-beta.1')).toBe('A prerelease of the next version. The changes since the last release:\n\n- **New thing.** It works.\n- Another.');
    expect(releaseNotes(log, '0.1.10')).toBe('');
  });

  it('refuses an empty, missing or already cut section', () => {
    expect(() => cutChangelog('## [Unreleased]\n\n## [0.1.9] — x\n- a\n', '0.1.10', 'd')).toThrow(/nothing to release/);
    expect(() => cutChangelog('# Changelog\n\n## [0.1.9] — x\n- a\n', '0.1.10', 'd')).toThrow(/no "## \[Unreleased\]"/);
    expect(() => cutChangelog(log, '0.1.9', 'd')).toThrow(/already has a section/);
  });
});

describe('update files', () => {
  const yml = ['version: 0.1.10', 'files:', '  - url: Atelier-0.1.10-mac.zip', '    sha512: AAA=', '    size: 12', '  - url: Atelier-0.1.10.dmg', '    sha512: BBB=', '    size: 34', 'path: Atelier-0.1.10-mac.zip', 'sha512: AAA=', "releaseDate: '2026-10-21T04:34:46.821Z'", ''].join('\n');

  it('reads the version and each file of electron-builder’s update file', () => {
    expect(parseUpdateFile(yml)).toEqual({
      version: '0.1.10',
      files: [
        { url: 'Atelier-0.1.10-mac.zip', sha512: 'AAA=', size: 12 },
        { url: 'Atelier-0.1.10.dmg', sha512: 'BBB=', size: 34 },
      ],
    });
    expect(() => parseUpdateFile('hello')).toThrow(/Not an update file/);
  });

  it('lists what a release has per platform', () => {
    const files = expectedFiles('0.1.10');
    expect(files.linux).toContain('Atelier-0.1.10-amd64.deb');
    expect(files.windows).toEqual(['Atelier-Setup-0.1.10.exe', 'Atelier-Setup-0.1.10.exe.blockmap', 'latest.yml']);
    expect(files.mac).toContain('Atelier-0.1.10-arm64.dmg.blockmap');
    expect(files.mac).toContain('latest-mac.yml');
  });
});

describe('checking a folder of built files', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const sha = (data: string) => createHash('sha512').update(data).digest('base64');

  /** A complete Windows release: the installer, its block map and an update file that describes them. */
  function windowsFolder(version: string, content = 'installer bytes') {
    const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `Atelier-Setup-${version}.exe`), content);
    writeFileSync(join(dir, `Atelier-Setup-${version}.exe.blockmap`), 'map');
    writeFileSync(join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: Atelier-Setup-${version}.exe\n    sha512: ${sha('installer bytes')}\n    size: ${content.length}\npath: x\n`);
    return dir;
  }

  it('accepts a folder whose update file matches its packages', () => {
    expect(checkRelease(windowsFolder('0.1.10'), '0.1.10', ['windows'])).toEqual([]);
  });

  it('names every problem: a missing file, another version, a changed package', () => {
    expect(checkRelease(windowsFolder('0.1.10'), '0.1.10', ['windows', 'linux']).filter((p) => p.startsWith('linux'))).toHaveLength(6);
    expect(checkRelease(windowsFolder('0.1.9'), '0.1.10', ['windows']).join('\n')).toMatch(/Atelier-Setup-0\.1\.10\.exe is missing/);
    const tampered = windowsFolder('0.1.10', 'different bytes!');
    expect(checkRelease(tampered, '0.1.10', ['windows'])).toEqual(['Atelier-Setup-0.1.10.exe does not match the sha512 in latest.yml']);
    const wrongVersion = windowsFolder('0.1.10');
    writeFileSync(join(wrongVersion, 'latest.yml'), readYml(wrongVersion).replace('version: 0.1.10', 'version: 0.1.9'));
    expect(checkRelease(wrongVersion, '0.1.10', ['windows'])).toEqual(['latest.yml says version 0.1.9, not 0.1.10']);
  });

  function readYml(dir: string) {
    return readFileSync(join(dir, 'latest.yml'), 'utf8');
  }
});

describe('smaller helpers', () => {
  it('finds the repository in a remote, and names the server images in lower case', () => {
    expect(repoFromRemote('https://github.com/TheOriUHD/atelier.git')).toBe('TheOriUHD/atelier');
    expect(repoFromRemote('git@github.com:TheOriUHD/atelier.git\n')).toBe('TheOriUHD/atelier');
    expect(() => repoFromRemote('https://example.com/x/y.git')).toThrow(/not a GitHub/);
    expect(imageNames('TheOriUHD/atelier', 'v0.1.11', false)).toEqual({
      base: 'ghcr.io/theoriuhd/atelier',
      main: ['ghcr.io/theoriuhd/atelier:v0.1.11', 'ghcr.io/theoriuhd/atelier:latest'],
      sandbox: ['ghcr.io/theoriuhd/atelier-sandbox:v0.1.11', 'ghcr.io/theoriuhd/atelier-sandbox:latest'],
      updater: ['ghcr.io/theoriuhd/atelier-updater:v0.1.11', 'ghcr.io/theoriuhd/atelier-updater:latest'],
    });
    // A prerelease never takes over `latest`.
    expect(imageNames('A/b', 'v1.0.0-beta.1', true).main).toEqual(['ghcr.io/a/atelier:v1.0.0-beta.1']);
  });

  it('says how long something took, and reads Apple’s answers', () => {
    expect([4_000, 65_000, 3_700_000].map(duration)).toEqual(['4s', '1m 05s', '1h 01m']);
    expect(parseNotarizationStatus('  arm64: Accepted  (29fee00c, sent 2026-10-21)\n  x64: In Progress  (bd59, sent x)\n')).toEqual({ arm64: 'Accepted', x64: 'In Progress' });
  });
});

describe('the one-line installer', () => {
  const template = '#!/bin/sh\nVERSION="@VERSION@"\nSUMS="@SUMS@"\n';
  const sha = (c: string) => c.repeat(64);

  it('names the version and lists the checksums, sorted, one per line', () => {
    const out = renderInstaller(template, '0.2.2', { 'atelier-setup-linux-arm64': sha('b'), 'atelier-setup-linux-amd64': sha('a') });
    expect(out).toBe(`#!/bin/sh\nVERSION="0.2.2"\nSUMS="\n${sha('a')}  atelier-setup-linux-amd64\n${sha('b')}  atelier-setup-linux-arm64\n"\n`);
  });

  it('refuses anything that could put more than a name and a hash into the script', () => {
    expect(() => renderInstaller(template, '0.2.2', {})).toThrow(/at least one binary/);
    expect(() => renderInstaller(template, '0.2.2', { 'atelier-setup-linux-amd64': 'abc' })).toThrow(/valid sha256/);
    expect(() => renderInstaller(template, '0.2.2', { 'evil; rm -rf /': sha('a') })).toThrow(/Unexpected installer file/);
    expect(() => renderInstaller(template, '0.2.2"; rm -rf /; "', { 'atelier-setup-linux-amd64': sha('a') })).toThrow(/cannot be a version/);
    expect(() => renderInstaller('no markers', '0.2.2', { 'atelier-setup-linux-amd64': sha('a') })).toThrow(/lacks/);
  });
});
