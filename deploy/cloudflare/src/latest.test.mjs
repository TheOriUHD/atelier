import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, latestPackages, versionOfFile } from './latest.js';

test('reads the version from a package name', () => {
  assert.equal(versionOfFile('Atelier-Setup-0.1.0.exe'), '0.1.0');
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
