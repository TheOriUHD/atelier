import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './index.js';

/** A bucket with a few objects, the way R2 hands them out. */
function bucket(objects) {
  return {
    async get(key) {
      const body = objects[key];
      if (body === undefined) return null;
      return { size: body.length, body, httpEtag: '"x"', range: undefined, writeHttpMetadata() {} };
    },
    async list() {
      return { objects: [] };
    },
  };
}

/** Gives objects their body as text too, the way R2 does. */
const withText = (objects) => ({
  async get(key, options) {
    const object = await bucket(objects).get(key, options);
    return object && { ...object, text: async () => objects[key] };
  },
});

const env = {
  RELEASES: bucket({
    'setup/install.sh': '#!/bin/sh\necho hi\n',
    'setup/0.2.2/atelier-setup-linux-amd64': 'binary',
    'stable/latest.yml': 'version: 0.2.2\n',
  }),
};
const get = (path) => worker.fetch(new Request(`https://updates.example.com${path}`), env);

test('serves the installer script as a shell script that is not cached for long', async () => {
  const res = await get('/install');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/x-shellscript/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(await res.text(), '#!/bin/sh\necho hi\n');
});

test("serves a version's binary, and only files with the installer's own names", async () => {
  assert.equal((await get('/setup/0.2.2/atelier-setup-linux-amd64')).status, 200);
  for (const bad of ['/setup/0.2.2/atelier-setup-windows-amd64', '/setup/0.2.2/install.sh', '/setup/0.2.2/../install.sh', '/setup/../x/atelier-setup-linux-amd64', '/setup/0.2.2', '/setup/0.2.2/atelier-setup-linux-amd64/extra', '/install/extra']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
});

test('still serves the update feed and refuses other methods', async () => {
  assert.equal(await (await get('/stable/latest.yml')).text(), 'version: 0.2.2\n');
  const post = await worker.fetch(new Request('https://updates.example.com/install', { method: 'POST' }), env);
  assert.equal(post.status, 405);
});

test('sends a macOS disk image that is not in the bucket to the GitHub release, and 404s other missing files', async () => {
  const res = await get('/stable/Atelier-0.3.2-arm64.dmg');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://github.com/TheOriUHD/atelier/releases/download/v0.3.2/Atelier-0.3.2-arm64.dmg');
  assert.equal((await worker.fetch(new Request('https://updates.example.com/beta/Atelier-0.3.2-beta.1.dmg', { method: 'HEAD' }), { ...env, GITHUB_REPO: 'Other/repo' })).headers.get('location'), 'https://github.com/Other/repo/releases/download/v0.3.2-beta.1/Atelier-0.3.2-beta.1.dmg');
  assert.equal((await get('/stable/Atelier-0.3.2.zip')).status, 404);
  assert.equal((await get('/stable/evil.dmg')).status, 404);
  // A disk image that is in the bucket (older releases) is served from it.
  const stored = { RELEASES: bucket({ 'stable/Atelier-0.3.1.dmg': 'disk image' }) };
  const there = await worker.fetch(new Request('https://updates.example.com/stable/Atelier-0.3.1.dmg'), stored);
  assert.equal(there.status, 200);
  assert.equal(await there.text(), 'disk image');
});

test('the download page offers what the update files announce, with the disk images they list', async () => {
  const feed = (v) => `version: ${v}\nfiles:\n  - url: Atelier-Setup-${v}-x64.exe\n    sha512: A=\n    size: 1\n  - url: Atelier-Setup-${v}-arm64.exe\n    sha512: B=\n    size: 1\npath: x\n`;
  const mac = (v) => `version: ${v}\nfiles:\n  - url: Atelier-${v}-mac.zip\n    sha512: A=\n    size: 1\n  - url: Atelier-${v}.dmg\n    sha512: B=\n    size: 1\n  - url: Atelier-${v}-arm64.dmg\n    sha512: C=\n    size: 1\npath: x\n`;
  const page = async (objects) => (await worker.fetch(new Request('https://updates.example.com/'), { RELEASES: withText(objects) })).text();
  const html = await page({
    'stable/latest.yml': feed('0.3.2'),
    'stable/latest-mac.yml': mac('0.3.2'),
    // Uploaded, but no update file points at it yet.
    'stable/Atelier-0.3.3-x64.deb': 'x',
  });
  assert.match(html, /href="\/stable\/Atelier-Setup-0\.3\.2-x64\.exe"/);
  assert.match(html, /href="\/stable\/Atelier-Setup-0\.3\.2-arm64\.exe"/);
  assert.match(html, /href="\/stable\/Atelier-0\.3\.2-arm64\.dmg"/);
  assert.match(html, /href="\/stable\/Atelier-0\.3\.2\.dmg"/);
  assert.doesNotMatch(html, /0\.3\.3/);
  assert.match(html, /Nothing published yet/);
});
