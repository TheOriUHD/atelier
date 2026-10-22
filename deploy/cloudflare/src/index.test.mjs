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
