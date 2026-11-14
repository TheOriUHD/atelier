import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fakeCtx, fakeD1, fakeR2 } from '../test/fakes.mjs';
import { dayOf } from '../../reports/src/policy.js';
import { DAY_MS, newestVersion } from './api.js';
import { daily } from './cron.js';
import worker from './index.js';

// The API tests sign in the local-development way (DEV_NO_ACCESS on localhost); access.test.mjs covers Access itself.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function admin() {
  const env = { DB: fakeD1(), REPORTS: fakeR2(), DEV_NO_ACCESS: '1' };
  const call = async (path, { method = 'GET', body, headers } = {}) => {
    const init = {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-atelier-admin': '1', 'content-type': 'application/json' }),
        ...headers,
      },
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await worker.fetch(new Request(`http://localhost:8788${path}`, init), env, fakeCtx());
    const type = res.headers.get('content-type') ?? '';
    return { res, status: res.status, body: type.startsWith('application/json') ? await res.json() : null };
  };
  /** A report as the collector keeps it: a row, report.json, and the files asked for. */
  const add = async (over = {}, { chat = false, shots = 0 } = {}) => {
    const row = {
      id: `I-${String(add.n++).padStart(6, '0')}`,
      kind: 'issue',
      title: 'Chat stops after the first reply',
      description: 'The composer stays disabled after the first answer.',
      contact: null,
      status: 'new',
      labels: '[]',
      note: '',
      app_version: '0.8.2',
      surface: 'desktop',
      mode: 'desktop-local',
      os: 'darwin',
      os_name: 'macOS 26.1',
      arch: 'arm64',
      has_diagnostics: 1,
      has_chat: chat ? 1 : 0,
      screenshots: shots,
      bytes: 100,
      content_hash: `hash-${add.n}`,
      scrubbed: 0,
      received_at: Date.now() - add.n * 60_000,
      updated_at: Date.now(),
      seen_at: null,
      ...over,
    };
    const columns = Object.keys(row);
    env.DB.sqlite
      .prepare(`INSERT INTO reports (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(row));
    env.DB.sqlite.prepare("UPDATE collector_state SET value = value + ? WHERE key = 'stored_bytes'").run(row.bytes);
    await env.REPORTS.put(`reports/${row.id}/report.json`, JSON.stringify({ v: 1, kind: row.kind, title: row.title }), {
      httpMetadata: { contentType: 'application/json' },
    });
    if (chat)
      await env.REPORTS.put(`reports/${row.id}/chat.json`, JSON.stringify({ messages: [] }), {
        httpMetadata: { contentType: 'application/json' },
      });
    for (let i = 0; i < shots; i++)
      await env.REPORTS.put(`reports/${row.id}/shot${i}.png`, PNG, { httpMetadata: { contentType: 'image/png' } });
    return row;
  };
  add.n = 1;
  return { env, call, add };
}

test('refuses changes that did not come from the panel (CSRF)', async () => {
  const a = admin();
  const { id } = await a.add();
  const cases = [
    ['PATCH', `/api/reports/${id}`, { 'content-type': 'application/json' }],
    ['PATCH', `/api/reports/${id}`, { 'x-atelier-admin': '1', 'content-type': 'text/plain' }],
    ['PATCH', `/api/reports/${id}`, { 'x-atelier-admin': '1', 'content-type': 'application/x-www-form-urlencoded' }],
    ['DELETE', `/api/reports/${id}`, { 'x-atelier-admin': 'yes', 'content-type': 'application/json' }],
    ['POST', '/api/reports/bulk', { 'x-atelier-admin': '1', 'content-type': 'multipart/form-data; boundary=x' }],
  ];
  for (const [method, path, headers] of cases) {
    const res = await worker.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        body: '{"status":"fixed","ids":["' + id + '"],"action":"delete"}',
      }),
      a.env,
      fakeCtx(),
    );
    assert.equal(res.status, 403, `${method} ${JSON.stringify(headers)}`);
  }
  const row = a.env.DB.sqlite.prepare('SELECT status FROM reports WHERE id = ?').get(id);
  assert.equal(row.status, 'new');
  assert.equal((await a.call(`/api/reports/${id}`, { method: 'PATCH', body: { status: 'fixed' } })).status, 200);
});

test('lists an inbox per kind, newest first, with filters, search and pages', async () => {
  const a = admin();
  await a.add({ title: 'Windows installer warns', os: 'win32', os_name: 'Windows 11 Pro', app_version: '0.8.1' });
  await a.add({ title: 'Search finds nothing in 100%_ of cases', status: 'fixed' });
  await a.add({ title: 'Images fail to load', seen_at: Date.now() });
  await a.add({ kind: 'feature', id: 'F-000001', title: 'Pin chats to the top', os: null });
  const issues = await a.call('/api/reports?kind=issue');
  assert.equal(issues.status, 200);
  assert.deepEqual(
    issues.body.rows.map((r) => r.title),
    ['Windows installer warns', 'Search finds nothing in 100%_ of cases', 'Images fail to load'],
  );
  assert.equal(issues.body.total, 3);
  assert.deepEqual(issues.body.statuses, ['new', 'triaged', 'in-progress', 'fixed', 'wont-fix', 'duplicate']);
  assert.deepEqual(
    issues.body.facets.versions.map((v) => v.value),
    ['0.8.2', '0.8.1'],
  );
  assert.equal(issues.body.facets.unseen, 2);
  const first = issues.body.rows[0];
  assert.equal(first.version, '0.8.1');
  assert.equal(first.osName, 'Windows 11 Pro');
  assert.equal(first.hasDiagnostics, true);
  assert.equal('description' in first, false);
  const titles = async (query) => (await a.call(`/api/reports?kind=issue&${query}`)).body.rows.map((r) => r.title);
  assert.deepEqual(await titles('status=open'), ['Windows installer warns', 'Images fail to load']);
  assert.deepEqual(await titles('status=fixed'), ['Search finds nothing in 100%_ of cases']);
  assert.deepEqual(await titles('status=unseen'), [
    'Windows installer warns',
    'Search finds nothing in 100%_ of cases',
  ]);
  assert.deepEqual(await titles('version=0.8.1'), ['Windows installer warns']);
  assert.deepEqual(await titles('os=win32'), ['Windows installer warns']);
  // `%` and `_` are searched for as themselves; the description and the id are searched too.
  assert.deepEqual(await titles(`q=${encodeURIComponent('100%_')}`), ['Search finds nothing in 100%_ of cases']);
  assert.deepEqual(await titles('q=%25'), ['Search finds nothing in 100%_ of cases']);
  assert.equal((await titles('q=composer')).length, 3);
  assert.deepEqual(await titles(`q=${issues.body.rows[2].id}`), ['Images fail to load']);
  const page1 = await a.call('/api/reports?kind=issue&limit=2');
  assert.equal(page1.body.rows.length, 2);
  assert.ok(page1.body.next);
  const page2 = await a.call(`/api/reports?kind=issue&limit=2&before=${page1.body.next}`);
  assert.deepEqual(
    page2.body.rows.map((r) => r.title),
    ['Images fail to load'],
  );
  assert.equal(page2.body.next, null);
  assert.deepEqual(
    (await a.call('/api/reports?kind=feature')).body.rows.map((r) => r.id),
    ['F-000001'],
  );
  assert.equal((await a.call('/api/reports?kind=feature&os=none')).body.rows.length, 1);
  assert.equal((await a.call('/api/reports?kind=bogus')).status, 400);
});

test('shows a report with its files, its chat and its pictures, safely', async () => {
  const a = admin();
  const { id } = await a.add({ contact: 'me@example.com', note: 'private' }, { chat: true, shots: 2 });
  await a.env.REPORTS.put(`reports/${id}/shot2.png`, '<svg onload="alert(1)"/>', {
    httpMetadata: { contentType: 'image/svg+xml' },
  });
  const detail = await a.call(`/api/reports/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.row.contact, 'me@example.com');
  assert.equal(detail.body.row.note, 'private');
  assert.equal(detail.body.report.title, 'Chat stops after the first reply');
  assert.deepEqual(
    detail.body.files.map((f) => f.name),
    ['shot0.png', 'shot1.png', 'shot2.png'],
  );
  assert.equal((await a.call(`/api/reports/${id}/chat`)).body.messages.length, 0);
  const picture = await a.call(`/api/reports/${id}/files/shot0.png`);
  assert.equal(picture.status, 200);
  assert.equal(picture.res.headers.get('content-type'), 'image/png');
  assert.equal(picture.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(picture.res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.deepEqual(new Uint8Array(await picture.res.arrayBuffer()), PNG);
  // Stored as something other than a picture: not served.
  assert.equal((await a.call(`/api/reports/${id}/files/shot2.png`)).status, 404);
  for (const name of ['report.json', 'chat.json', '..%2Freport.json', 'shot0.svg', 'shot9.png'])
    assert.equal((await a.call(`/api/reports/${id}/files/${name}`)).status, 404, name);
  assert.equal((await a.call('/api/reports/I-NOPE00')).status, 404);
  assert.equal((await a.call('/api/reports/I-ZZZZZZ')).status, 404);
  const { id: bare } = await a.add();
  assert.equal((await a.call(`/api/reports/${bare}/chat`)).status, 404);
});

test('changes status, labels and the note, and marks reports seen', async () => {
  const a = admin();
  const row = await a.add({ updated_at: 1 });
  const seen = await a.call(`/api/reports/${row.id}`, { method: 'PATCH', body: { seen: true } });
  assert.ok(seen.body.row.seenAt > 0);
  assert.equal(seen.body.row.updatedAt, 1);
  const changed = await a.call(`/api/reports/${row.id}`, {
    method: 'PATCH',
    body: { status: 'triaged', labels: [' crash ', 'Crash', 'windows  installer'], note: 'Ask for the log.' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.row.status, 'triaged');
  assert.deepEqual(changed.body.row.labels, ['crash', 'windows installer']);
  assert.equal(changed.body.row.note, 'Ask for the log.');
  assert.ok(changed.body.row.updatedAt > 1);
  assert.equal(changed.body.row.seenAt, seen.body.row.seenAt);
  for (const body of [
    { status: 'planned' },
    { status: 'bogus' },
    { labels: 'crash' },
    { labels: ['x'.repeat(41)] },
    { labels: new Array(21).fill('a').map((x, i) => x + i) },
    { note: 5 },
    { seen: 'yes' },
    {},
    [],
  ]) {
    assert.equal((await a.call(`/api/reports/${row.id}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await a.call(`/api/reports/${row.id}`, { method: 'PATCH', body: '{bad' })).status, 400);
  const feature = await a.add({ kind: 'feature', id: 'F-000009' });
  assert.equal(
    (await a.call(`/api/reports/${feature.id}`, { method: 'PATCH', body: { status: 'planned' } })).status,
    200,
  );
  assert.equal(
    (await a.call(`/api/reports/${feature.id}`, { method: 'PATCH', body: { status: 'fixed' } })).status,
    400,
  );
  assert.equal(
    (await a.call(`/api/reports/${row.id}`, { method: 'PATCH', body: { seen: false } })).body.row.seenAt,
    null,
  );
});

test('deletes a report with its files and gives its bytes back', async () => {
  const a = admin();
  const keep = await a.add({ bytes: 50 });
  const gone = await a.add({ bytes: 300 }, { chat: true, shots: 2 });
  const res = await a.call(`/api/reports/${gone.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.deepEqual([...a.env.REPORTS.objects.keys()], [`reports/${keep.id}/report.json`]);
  assert.equal(a.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  assert.equal(a.env.DB.sqlite.prepare("SELECT value FROM collector_state WHERE key = 'stored_bytes'").get().value, 50);
  assert.equal((await a.call(`/api/reports/${gone.id}`, { method: 'DELETE' })).status, 404);
});

test('changes or deletes many at once, a status only where the kind has it', async () => {
  const a = admin();
  const issues = [await a.add(), await a.add(), await a.add()];
  const feature = await a.add({ kind: 'feature', id: 'F-000007' });
  const ids = [...issues.map((r) => r.id), feature.id];
  const fixed = await a.call('/api/reports/bulk', { method: 'POST', body: { ids, action: 'status', status: 'fixed' } });
  assert.deepEqual(fixed.body, { updated: 3 });
  const dup = await a.call('/api/reports/bulk', {
    method: 'POST',
    body: { ids, action: 'status', status: 'duplicate' },
  });
  assert.deepEqual(dup.body, { updated: 4 });
  for (const body of [
    { ids, action: 'status', status: 'nope' },
    { ids: ['../x'], action: 'delete' },
    { ids: [], action: 'delete' },
    { ids, action: 'explode' },
  ]) {
    assert.equal((await a.call('/api/reports/bulk', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
  const many = [];
  for (let i = 0; i < 120; i++) many.push((await a.add()).id);
  assert.deepEqual(
    (
      await a.call('/api/reports/bulk', {
        method: 'POST',
        body: { ids: [...many, ...many], action: 'status', status: 'triaged' },
      })
    ).body,
    { updated: 120 },
  );
  const deleted = await a.call('/api/reports/bulk', {
    method: 'POST',
    body: { ids: [...ids, ...many], action: 'delete' },
  });
  assert.deepEqual(deleted.body, { deleted: 124 });
  assert.equal(a.env.REPORTS.objects.size, 0);
  assert.equal(a.env.DB.sqlite.prepare("SELECT value FROM collector_state WHERE key = 'stored_bytes'").get().value, 0);
});

test("tells the collector's limits", async () => {
  const a = admin();
  const day = dayOf(Date.now());
  a.env.DB.sqlite.prepare('INSERT INTO report_days (day, count) VALUES (?, 250)').run(day);
  a.env.DB.sqlite
    .prepare('INSERT INTO report_quota (key, day, count) VALUES (?, ?, ?), (?, ?, ?)')
    .run('a', day, 3, 'b', day, 9);
  await a.add({ bytes: 1234 });
  const { body } = await a.call('/api/limits');
  assert.equal(body.today, 250);
  assert.equal(body.bits, 20);
  assert.equal(body.perDay, 1500);
  assert.equal(body.storedBytes, 1234);
  assert.equal(body.storageBytes, 8_000_000_000);
  assert.equal(body.addressesToday, 2);
  assert.equal(body.busiestAddressToday, 9);
  assert.equal(body.todayByKind.issue, 1);
  assert.deepEqual(body.bitsSteps.at(-1), { below: null, bits: 22 });
});

function stats(env) {
  const day = (n) => dayOf(Date.now() - n * DAY_MS);
  const insert = env.DB.sqlite.prepare(
    'INSERT INTO downloads (day, channel, file, version, platform, kind, country, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(day(0), 'stable', 'Atelier-0.8.2-arm64.dmg', '0.8.2', 'mac-arm64', 'download', 'DE', 5);
  insert.run(day(0), 'stable', 'Atelier-Setup-0.8.2-x64.exe', '0.8.2', 'windows-x64', 'download', 'US', 3);
  insert.run(day(0), 'stable', 'Atelier-Setup-0.8.2-x64.exe', '0.8.2', 'windows-x64', 'update', 'US', 40);
  insert.run(day(3), 'stable', 'Atelier-0.8.1-arm64.dmg', '0.8.1', 'mac-arm64', 'download', 'FR', 7);
  insert.run(day(10), 'stable', 'Atelier-0.8.0-arm64.dmg', '0.8.0', 'mac-arm64', 'download', 'DE', 11);
  insert.run(day(40), 'stable', 'Atelier-0.7.0-arm64.dmg', '0.7.0', 'mac-arm64', 'download', 'DE', 100);
  insert.run(day(1), 'beta', 'Atelier-0.9.0-beta.1-arm64.dmg', '0.9.0-beta.1', 'mac-arm64', 'download', 'DE', 1);
  insert.run(day(0), '', 'install', '', 'server', 'install-script', 'NL', 2);
  const checks = env.DB.sqlite.prepare(
    'INSERT INTO update_checks (day, channel, platform, version, count) VALUES (?, ?, ?, ?, ?)',
  );
  checks.run(day(0), 'stable', 'mac', 'unknown', 288);
  checks.run(day(0), 'stable', 'windows', 'unknown', 100);
  checks.run(day(1), 'stable', 'mac', 'unknown', 500);
  const gh = env.DB.sqlite.prepare('INSERT INTO github_snapshots (day, tag, asset, downloads) VALUES (?, ?, ?, ?)');
  gh.run(day(2), 'v0.8.1', 'Atelier-0.8.1.dmg', 100);
  gh.run(day(1), 'v0.8.1', 'Atelier-0.8.1.dmg', 110);
  gh.run(day(0), 'v0.8.1', 'Atelier-0.8.1.dmg', 115);
  gh.run(day(0), 'v0.8.2', 'Atelier-0.8.2.dmg', 20);
  return day;
}

test('sums up downloads, update checks and reports for the overview', async () => {
  const a = admin();
  const day = stats(a.env);
  await a.add({ status: 'new' });
  await a.add({ status: 'fixed', seen_at: 1 });
  await a.add({ kind: 'feature', id: 'F-000001' });
  const { body } = await a.call('/api/overview?days=30');
  assert.equal(body.downloads.today, 8);
  assert.equal(body.downloads.d7, 16);
  assert.equal(body.downloads.prev7, 11);
  assert.equal(body.downloads.d30, 27);
  assert.equal(body.downloads.kinds.update.d7, 40);
  assert.equal(body.downloads.kinds['install-script'].d7, 2);
  assert.deepEqual(
    body.versions.map((v) => v.version),
    ['0.9.0-beta.1', '0.8.2', '0.8.1', '0.8.0'],
  );
  // The newest release, not the beta; its share of the week's package downloads and updates.
  assert.equal(body.latest.version, '0.8.2');
  assert.equal(body.latest.updates, 40);
  assert.equal(body.latest.share7, 48 / 56);
  assert.equal(body.checks.today, 388);
  assert.equal(body.reports.issue.new, 1);
  assert.equal(body.reports.issue.unseen, 1);
  assert.equal(body.reports.feature.total, 1);
  assert.equal(body.reports.daily.find((d) => d.kind === 'issue').day, day(0));
  assert.equal(body.collector.perDay, 1500);
});

test('breaks downloads down by day, platform, kind, version and country, with GitHub per day', async () => {
  const a = admin();
  const day = stats(a.env);
  const { body } = await a.call('/api/downloads?days=7');
  assert.equal(body.from, day(6));
  assert.ok(body.daily.every((r) => r.day >= day(6)));
  assert.deepEqual(body.countries, [
    { country: 'FR', count: 7 },
    { country: 'DE', count: 6 },
    { country: 'US', count: 3 },
  ]);
  assert.ok(body.versions.some((v) => v.version === '0.8.2' && v.kind === 'update' && v.count === 40));
  assert.equal(body.files[0].file, 'Atelier-Setup-0.8.2-x64.exe');
  assert.equal(body.checks.length, 3);
  assert.equal(body.github.day, day(0));
  assert.equal(body.github.total, 135);
  assert.deepEqual(
    body.github.daily.map((d) => [d.day, d.total, d.delta]),
    [
      [day(2), 100, null],
      [day(1), 110, 10],
      [day(0), 135, 25],
    ],
  );
  assert.deepEqual(
    body.github.tags.map((t) => [t.tag, t.downloads, t.delta]),
    [
      ['v0.8.2', 20, 20],
      ['v0.8.1', 115, 15],
    ],
  );
});

test('the daily cron reads GitHub, deletes old reports and quota rows, and recounts the bytes', async () => {
  const a = admin();
  const old = await a.add({ received_at: Date.now() - 400 * DAY_MS, bytes: 70 }, { shots: 1 });
  const recent = await a.add({ bytes: 30 });
  a.env.DB.sqlite.prepare("UPDATE collector_state SET value = 999 WHERE key = 'stored_bytes'").run();
  const day = dayOf(Date.now());
  a.env.DB.sqlite
    .prepare('INSERT INTO report_quota (key, day, count) VALUES (?, ?, 1), (?, ?, 1)')
    .run('old', dayOf(Date.now() - 3 * DAY_MS), 'today', day);
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), headers: init.headers });
    const page = Number(new URL(url).searchParams.get('page'));
    const release = (n) => ({
      tag_name: `v0.${n}.0`,
      assets: [
        { name: `Atelier-0.${n}.0.dmg`, download_count: n * 10 },
        { name: `Atelier-Setup-0.${n}.0-x64.exe`, download_count: n },
      ],
    });
    return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => release(i + 1)) : [release(101)]);
  };
  const result = await daily(a.env);
  assert.deepEqual(result, {
    github: { assets: 202 },
    reports: { deleted: 1 },
    quota: { deleted: 1 },
    bytes: { ok: true },
  });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].url, 'https://api.github.com/repos/TheOriUHD/atelier/releases?per_page=100&page=1');
  assert.equal(asked[0].headers['user-agent'], 'atelier-admin');
  assert.equal(
    a.env.DB.sqlite
      .prepare('SELECT downloads FROM github_snapshots WHERE tag = ? AND asset = ?')
      .get('v0.101.0', 'Atelier-0.101.0.dmg').downloads,
    1010,
  );
  assert.deepEqual(
    a.env.DB.sqlite
      .prepare('SELECT id FROM reports')
      .all()
      .map((r) => r.id),
    [recent.id],
  );
  assert.equal(
    [...a.env.REPORTS.objects.keys()].some((k) => k.includes(old.id)),
    false,
  );
  assert.deepEqual(
    a.env.DB.sqlite
      .prepare('SELECT key FROM report_quota')
      .all()
      .map((r) => r.key),
    ['today'],
  );
  assert.equal(a.env.DB.sqlite.prepare("SELECT value FROM collector_state WHERE key = 'stored_bytes'").get().value, 30);
  // Run again the same day: the snapshot is replaced, not doubled. A GitHub outage doesn't stop the other jobs.
  globalThis.fetch = async () => new Response('down', { status: 502 });
  const again = await daily(a.env);
  assert.match(again.github.error, /502/);
  assert.deepEqual(again.bytes, { ok: true });
  assert.equal(a.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM github_snapshots').get().n, 202);
});

test('the scheduled handler hands the jobs to waitUntil', async () => {
  const a = admin();
  globalThis.fetch = async () => Response.json([]);
  const ctx = fakeCtx();
  await worker.scheduled({ cron: '17 3 * * *' }, a.env, ctx);
  assert.equal(ctx.pending.length, 1);
  await ctx.settle();
});

test('picks the newest release over a prerelease', () => {
  assert.equal(newestVersion(['0.8.1', '0.9.0-beta.2', '0.8.2', 'unknown', '']), '0.8.2');
  assert.equal(newestVersion(['0.9.0-beta.1', '0.9.0-beta.2']), '0.9.0-beta.2');
  assert.equal(newestVersion([]), null);
});
