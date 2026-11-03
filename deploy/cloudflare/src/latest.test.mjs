import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcedFiles, compareVersions, diskImageUrl, latestPackages, versionOfFile } from './latest.js';

test('reads the version from a package name', () => {
  assert.equal(versionOfFile('Atelier-Setup-0.1.0.exe'), '0.1.0');
  assert.equal(versionOfFile('Atelier-Setup-0.3.2-x64.exe'), '0.3.2');
  assert.equal(versionOfFile('Atelier-0.2.0-arm64.dmg'), '0.2.0');
  assert.equal(versionOfFile('Atelier-0.3.0-beta.1.dmg'), '0.3.0-beta.1');
  assert.equal(versionOfFile('Atelier-0.1.0-amd64.deb'), '0.1.0');
  assert.equal(versionOfFile('latest.yml'), null);
});

test('orders versions, releases above their prereleases', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.3.0-beta.2') > 0);
  assert.ok(compareVersions('0.3.0-beta.2', '0.3.0-beta.1') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('picks the newest package of each kind', () => {
  const found = latestPackages([
    'latest.yml',
    'Atelier-Setup-0.1.0.exe',
    'Atelier-Setup-0.2.0.exe',
    'Atelier-0.2.0-arm64.dmg',
    'Atelier-0.2.0.dmg',
    'Atelier-0.2.0-amd64.deb',
    'Atelier-0.2.0.AppImage',
    'Atelier-0.2.0-arm64.AppImage',
    'Atelier-0.2.0-arm64-mac.zip',
  ]);
  assert.deepEqual(
    found.map((f) => [f.id, f.name]),
    [
      ['windows', 'Atelier-Setup-0.2.0.exe'],
      ['mac-arm64', 'Atelier-0.2.0-arm64.dmg'],
      ['mac-x64', 'Atelier-0.2.0.dmg'],
      ['linux-deb-x64', 'Atelier-0.2.0-amd64.deb'],
      ['linux-appimage-x64', 'Atelier-0.2.0.AppImage'],
      ['linux-appimage-arm64', 'Atelier-0.2.0-arm64.AppImage'],
    ],
  );
});

test('offers an installer per Windows architecture, and the combined one only while nothing newer replaces it', () => {
  const ids = (names) => latestPackages(names).map((f) => [f.id, f.name]);
  assert.deepEqual(ids(['Atelier-Setup-0.3.1.exe', 'Atelier-Setup-0.3.2-x64.exe', 'Atelier-Setup-0.3.2-arm64.exe']), [
    ['windows-x64', 'Atelier-Setup-0.3.2-x64.exe'],
    ['windows-arm64', 'Atelier-Setup-0.3.2-arm64.exe'],
  ]);
  // Before the first split release is announced, the one installer is still what there is.
  assert.deepEqual(ids(['Atelier-Setup-0.3.1.exe']), [['windows', 'Atelier-Setup-0.3.1.exe']]);
  assert.deepEqual(ids(['Atelier-Setup-0.3.1.exe', 'Atelier-Setup-0.3.2-x64.exe']), [['windows-x64', 'Atelier-Setup-0.3.2-x64.exe']]);
  assert.deepEqual(ids(['Atelier-Setup-0.3.0-beta.1.exe']), [['windows', 'Atelier-Setup-0.3.0-beta.1.exe']]);
});

test('reads the files an update file announces, nothing else', () => {
  const yml = `version: 0.3.2
files:
  - url: Atelier-Setup-0.3.2-x64.exe
    sha512: AAA=
    size: 1
  - url: 'Atelier-Setup-0.3.2-arm64.exe'
    sha512: BBB=
    size: 2
path: Atelier-Setup-0.3.2-x64.exe
sha512: AAA=
releaseDate: '2026-11-02T15:46:37.375Z'
`;
  assert.deepEqual(announcedFiles([yml, '']), ['Atelier-Setup-0.3.2-x64.exe', 'Atelier-Setup-0.3.2-arm64.exe']);
  assert.deepEqual(announcedFiles([]), []);
});

test('sends a missing macOS disk image to the same file on the GitHub release', () => {
  assert.equal(diskImageUrl('stable/Atelier-0.3.2.dmg', 'Owner/repo'), 'https://github.com/Owner/repo/releases/download/v0.3.2/Atelier-0.3.2.dmg');
  assert.equal(diskImageUrl('stable/Atelier-0.3.2-arm64.dmg', 'Owner/repo'), 'https://github.com/Owner/repo/releases/download/v0.3.2/Atelier-0.3.2-arm64.dmg');
  assert.equal(diskImageUrl('beta/Atelier-0.3.2-beta.1.dmg', 'Owner/repo'), 'https://github.com/Owner/repo/releases/download/v0.3.2-beta.1/Atelier-0.3.2-beta.1.dmg');
  // Only disk images with the app's own names, only in a channel: nothing else becomes a redirect.
  for (const key of ['stable/Atelier-0.3.2.zip', 'stable/latest.yml', 'stable/evil.dmg', 'stable/Atelier-0.3.2.dmg/extra', 'other/Atelier-0.3.2.dmg', 'stable/Atelier-%2e%2e.dmg', 'stable/Atelier-x.dmg']) {
    assert.equal(diskImageUrl(key, 'Owner/repo'), null, key);
  }
});
