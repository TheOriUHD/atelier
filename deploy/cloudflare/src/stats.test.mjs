import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeCtx, fakeD1 } from '../../admin/test/fakes.mjs';
import worker from './index.js';
import { classify, createCounter, fromStart, packageOf } from './stats.js';

const UA_UPDATER = 'electron-builder';
const UA_APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Atelier/0.8.2 Chrome/146.0.0.0 Electron/44.7.1 Safari/537.36';
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

test('reads the version and platform from every package name', () => {
  const cases = {
    'Atelier-Setup-0.8.2-x64.exe': ['0.8.2', 'windows-x64'],
    'Atelier-Setup-0.8.2-arm64.exe': ['0.8.2', 'windows-arm64'],
    'Atelier-Setup-0.3.1.exe': ['0.3.1', 'windows'],
    'Atelier-Setup-0.9.0-beta.1-x64.exe': ['0.9.0-beta.1', 'windows-x64'],
    'Atelier-0.8.2-arm64.dmg': ['0.8.2', 'mac-arm64'],
    'Atelier-0.8.2.dmg': ['0.8.2', 'mac-x64'],
    'Atelier-0.9.0-beta.1-arm64.dmg': ['0.9.0-beta.1', 'mac-arm64'],
    'Atelier-0.8.2-arm64-mac.zip': ['0.8.2', 'mac-arm64'],
    'Atelier-0.8.2-mac.zip': ['0.8.2', 'mac-x64'],
    'Atelier-0.8.2.AppImage': ['0.8.2', 'linux-x64'],
    'Atelier-0.8.2-arm64.AppImage': ['0.8.2', 'linux-arm64'],
    'Atelier-0.8.2-amd64.deb': ['0.8.2', 'linux-x64'],
    'Atelier-0.8.2-arm64.deb': ['0.8.2', 'linux-arm64'],
    'Atelier-0.8.2-x86_64.rpm': ['0.8.2', 'linux-x64'],
    'Atelier-0.8.2.aarch64.rpm': ['0.8.2', 'linux-arm64'],
    'atelier-cli-0.8.2-darwin-arm64.tar.gz': ['0.8.2', 'cli-mac-arm64'],
    'atelier-cli-0.8.2-linux-x64.tar.gz': ['0.8.2', 'cli-linux-x64'],
    'atelier-cli-0.8.2-windows-x64.zip': ['0.8.2', 'cli-windows-x64'],
  };
  for (const [name, [version, platform]] of Object.entries(cases))
    assert.deepEqual(packageOf(name), { version, platform }, name);
  for (const name of [
    'latest.yml',
    'Atelier-0.8.2.dmg.sig',
    'evil.exe',
    'Atelier-x.dmg',
    'Atelier-0.8.2.dmg.blockmap',
    'atelier-cli.json',
  ])
    assert.equal(packageOf(name), null, name);
});

test('counts a GET from the first byte only', () => {
  const req = (method, range) => new Request('https://u.example/stable/x', { method, headers: range ? { range } : {} });
  assert.equal(fromStart(req('GET')), true);
  assert.equal(fromStart(req('GET', 'bytes=0-')), true);
  assert.equal(fromStart(req('GET', 'bytes=0-1023')), true);
  assert.equal(fromStart(req('GET', 'bytes=0-10, 20-30')), true);
  assert.equal(fromStart(req('GET', 'bytes=1024-')), false);
  assert.equal(fromStart(req('GET', 'bytes=-500')), false);
  assert.equal(fromStart(req('GET', 'garbage')), false);
  assert.equal(fromStart(req('HEAD')), false);
});

const ask = (path, { ua = UA_BROWSER, method = 'GET', range, country = 'DE' } = {}) => {
  const request = new Request(`https://updates.example.com${path}`, {
    method,
    headers: { 'user-agent': ua, ...(range ? { range } : {}) },
  });
  Object.defineProperty(request, 'cf', { value: country ? { country } : undefined });
  return request;
};
const ok = new Response('x');

test('tells downloads by people from the app updating itself', () => {
  const target = (file) => ({ channel: 'stable', file });
  assert.equal(classify(ask('/', { ua: UA_BROWSER }), ok, target('Atelier-Setup-0.8.2-x64.exe')).kind, 'download');
  assert.equal(classify(ask('/', { ua: UA_UPDATER }), ok, target('Atelier-Setup-0.8.2-x64.exe')).kind, 'update');
  // The release's own check of what it published counts as nothing.
  assert.equal(classify(ask('/', { ua: 'atelier-release-check' }), ok, target('Atelier-Setup-0.8.2-x64.exe')), null);
  assert.equal(
    classify(ask('/', { ua: 'curl/8.7.1' }), ok, target('atelier-cli-0.8.2-linux-x64.tar.gz')).kind,
    'download',
  );
  // The Mac app fetches its update zip itself, with Electron's user agent; its disk image download is a download.
  assert.equal(classify(ask('/', { ua: UA_APP }), ok, target('Atelier-0.8.2-arm64-mac.zip')).kind, 'update');
  assert.equal(classify(ask('/', { ua: UA_APP }), ok, target('Atelier-0.8.2-arm64.dmg')).kind, 'download');
  assert.equal(
    classify(ask('/', { ua: UA_UPDATER }), ok, target('Atelier-Setup-0.8.2-x64.exe.blockmap')).kind,
    'update-blockmap',
  );
  const row = classify(ask('/', { country: 'FR' }), ok, target('Atelier-0.8.2-arm64.dmg'));
  assert.deepEqual(row, {
    table: 'downloads',
    channel: 'stable',
    file: 'Atelier-0.8.2-arm64.dmg',
    version: '0.8.2',
    platform: 'mac-arm64',
    kind: 'download',
    country: 'FR',
  });
  assert.equal(classify(ask('/', { country: null }), ok, target('Atelier-0.8.2.dmg')).country, 'XX');
  // The disk image's redirect to GitHub is a download; other redirects, misses and partial answers aren't.
  assert.equal(
    classify(
      ask('/'),
      new Response(null, { status: 302, headers: { location: 'https://github.com/' } }),
      target('Atelier-0.8.2.dmg'),
    ).kind,
    'download',
  );
  assert.equal(classify(ask('/'), new Response('no', { status: 404 }), target('Atelier-0.8.2.dmg')), null);
  assert.equal(
    classify(ask('/', { range: 'bytes=500-' }), new Response('x', { status: 206 }), target('Atelier-0.8.2.dmg')),
    null,
  );
  assert.equal(classify(ask('/', { method: 'HEAD' }), ok, target('Atelier-0.8.2.dmg')), null);
  assert.equal(classify(ask('/'), ok, target('Atelier-0.8.2.dmg.sig')), null);
});

test('counts install scripts, server setup binaries and update checks, with no version for a check', () => {
  assert.deepEqual(classify(ask('/install', { ua: 'curl/8.7.1' }), ok, { script: 'server', file: 'install' }), {
    table: 'downloads',
    channel: '',
    file: 'install',
    version: '',
    platform: 'server',
    kind: 'install-script',
    country: 'DE',
  });
  assert.equal(classify(ask('/cli.ps1'), ok, { script: 'cli-windows', file: 'cli.ps1' }).platform, 'cli-windows');
  assert.deepEqual(
    classify(ask('/setup/0.8.2/atelier-setup-linux-arm64'), ok, {
      setup: true,
      version: '0.8.2',
      file: 'atelier-setup-linux-arm64',
    }),
    {
      table: 'downloads',
      channel: '',
      file: 'atelier-setup-linux-arm64',
      version: '0.8.2',
      platform: 'server-linux-arm64',
      kind: 'server-setup',
      country: 'DE',
    },
  );
  for (const [file, platform] of [
    ['latest.yml', 'windows'],
    ['latest-mac.yml', 'mac'],
    ['latest-linux.yml', 'linux-x64'],
    ['latest-linux-arm64.yml', 'linux-arm64'],
    ['atelier-cli.json', 'cli'],
  ]) {
    assert.deepEqual(classify(ask(`/beta/${file}`, { ua: UA_UPDATER }), ok, { channel: 'beta', file }), {
      table: 'update_checks',
      channel: 'beta',
      platform,
      version: 'unknown',
    });
  }
  // Even a user agent that names a version doesn't make one up for a check.
  assert.equal(
    classify(ask('/stable/latest-mac.yml', { ua: UA_APP }), ok, { channel: 'stable', file: 'latest-mac.yml' }).version,
    'unknown',
  );
});

/** A clock and a sleep the test moves by hand. */
function clock() {
  let t = Date.parse('2026-11-14T10:00:00Z');
  const sleepers = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => sleepers.push({ at: t + ms, resolve })),
    advance(ms) {
      t += ms;
      for (const s of sleepers.splice(0)) {
        if (s.at <= t) s.resolve();
        else sleepers.push(s);
      }
    },
  };
}

test('adds update checks up in memory and writes them after 25 checks or 20 seconds', async () => {
  const db = fakeD1();
  const c = clock();
  const counter = createCounter({ now: c.now, sleep: c.sleep });
  const env = { STATS: db };
  const ctx = fakeCtx();
  const check = (file = 'latest.yml', channel = 'stable') =>
    counter.record(ask(`/${channel}/${file}`, { ua: UA_UPDATER }), ok, env, ctx, { channel, file });
  const rows = () =>
    db.sqlite
      .prepare('SELECT day, channel, platform, version, count FROM update_checks ORDER BY platform')
      .all()
      .map((r) => ({ ...r }));
  for (let i = 0; i < 10; i++) check();
  check('latest-mac.yml');
  await Promise.resolve();
  assert.deepEqual(rows(), []);
  // 20 seconds later the timer writes them, in one batch.
  c.advance(20_000);
  await ctx.settle();
  assert.deepEqual(rows(), [
    { day: '2026-11-14', channel: 'stable', platform: 'mac', version: 'unknown', count: 1 },
    { day: '2026-11-14', channel: 'stable', platform: 'windows', version: 'unknown', count: 10 },
  ]);
  // The 25th waiting check writes at once, without waiting for the timer.
  for (let i = 0; i < 25; i++) check();
  await new Promise((r) => setImmediate(r));
  assert.equal(rows().find((r) => r.platform === 'windows').count, 35);
  assert.equal(counter.pending().size, 0);
  c.advance(20_000);
  await ctx.settle();
});

test('keeps checks for the next write when the database fails, and never lets counting break an answer', async () => {
  const db = fakeD1();
  let failing = true;
  const flaky = {
    prepare: (sql) => db.prepare(sql),
    batch: (s) => (failing ? Promise.reject(new Error('D1 down')) : db.batch(s)),
  };
  const c = clock();
  const counter = createCounter({ flushEvery: 2, now: c.now, sleep: c.sleep });
  const ctx = fakeCtx();
  for (let i = 0; i < 2; i++)
    counter.record(ask('/stable/latest.yml'), ok, { STATS: flaky }, ctx, { channel: 'stable', file: 'latest.yml' });
  await new Promise((r) => setImmediate(r));
  assert.equal([...counter.pending().values()][0], 2);
  failing = false;
  c.advance(20_000);
  await ctx.settle();
  assert.equal(db.sqlite.prepare('SELECT count FROM update_checks').get().count, 2);
  // A binding that throws, or none at all: nothing happens.
  const broken = {
    prepare() {
      throw new Error('boom');
    },
    batch() {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() =>
    counter.record(ask('/stable/Atelier-0.8.2.dmg'), ok, { STATS: broken }, ctx, {
      channel: 'stable',
      file: 'Atelier-0.8.2.dmg',
    }),
  );
  assert.doesNotThrow(() =>
    counter.record(ask('/stable/Atelier-0.8.2.dmg'), ok, {}, undefined, {
      channel: 'stable',
      file: 'Atelier-0.8.2.dmg',
    }),
  );
});

/** The feed with a bucket and the counts' database. */
function feed(objects) {
  const bucket = {
    async get(key, options) {
      const body = objects[key];
      if (body === undefined) return null;
      const range = options?.range?.get?.('range');
      return {
        size: body.length,
        body,
        httpEtag: '"x"',
        range: range ? { offset: 0, length: body.length } : undefined,
        writeHttpMetadata() {},
        text: async () => body,
      };
    },
  };
  const STATS = fakeD1();
  return { env: { RELEASES: bucket, STATS }, STATS };
}

test('the Worker counts what it served, after answering, and nothing about who asked', async () => {
  const { env, STATS } = feed({
    'stable/Atelier-Setup-0.8.2-x64.exe': 'exe',
    'setup/install.sh': '#!/bin/sh',
    'stable/latest.yml': 'version: 0.8.2\n',
  });
  const ctx = fakeCtx();
  const get = (path, opts) => worker.fetch(ask(path, opts), env, ctx);
  assert.equal((await get('/stable/Atelier-Setup-0.8.2-x64.exe')).status, 200);
  assert.equal((await get('/stable/Atelier-Setup-0.8.2-x64.exe', { ua: UA_UPDATER })).status, 200);
  assert.equal((await get('/stable/Atelier-Setup-0.8.2-x64.exe', { ua: UA_UPDATER, range: 'bytes=0-' })).status, 206);
  assert.equal((await get('/stable/Atelier-Setup-0.8.2-x64.exe', { method: 'HEAD' })).status, 200);
  assert.equal((await get('/stable/Atelier-0.8.2-arm64.dmg', { country: 'JP' })).status, 302);
  assert.equal((await get('/stable/Atelier-0.8.3.exe')).status, 404);
  assert.equal((await get('/install', { ua: 'curl/8.7.1' })).status, 200);
  assert.equal((await get('/')).status, 200);
  await ctx.settle();
  const rows = STATS.sqlite
    .prepare('SELECT file, kind, country, count FROM downloads ORDER BY file, kind')
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { file: 'Atelier-0.8.2-arm64.dmg', kind: 'download', country: 'JP', count: 1 },
    { file: 'Atelier-Setup-0.8.2-x64.exe', kind: 'download', country: 'DE', count: 1 },
    { file: 'Atelier-Setup-0.8.2-x64.exe', kind: 'update', country: 'DE', count: 2 },
    { file: 'install', kind: 'install-script', country: 'DE', count: 1 },
  ]);
  const everything = JSON.stringify(STATS.dump());
  for (const leak of ['electron-builder', 'curl', 'Mozilla', 'updates.example.com'])
    assert.ok(!everything.includes(leak), leak);
});

test('the Worker serves the same without the counts database, or with a broken one', async () => {
  const objects = { 'stable/Atelier-0.8.2.dmg': 'disk image' };
  const { env } = feed(objects);
  const plain = await worker.fetch(ask('/stable/Atelier-0.8.2.dmg'), { RELEASES: env.RELEASES });
  assert.equal(await plain.text(), 'disk image');
  const broken = {
    prepare() {
      throw new Error('boom');
    },
  };
  const res = await worker.fetch(
    ask('/stable/Atelier-0.8.2.dmg'),
    { RELEASES: env.RELEASES, STATS: broken },
    fakeCtx(),
  );
  assert.equal(await res.text(), 'disk image');
});
