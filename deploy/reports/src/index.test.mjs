import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { fakeD1, fakeLimiter, fakeR2 } from '../../admin/test/fakes.mjs';
import {
  contentHashInput,
  leadingZeroBits,
  POW_HEADERS,
  powInput,
  REPORT_ID,
  REPORT_LIMITS,
} from '../../../packages/protocol/src/reports.ts';
import worker, { imageTypeOf, makeChallenge } from './index.js';
import { dayOf, POLICY } from './policy.js';

const SECRET = 'test-secret-that-is-long-enough';
const IP = '203.0.113.7';
const sha = (data) => createHash('sha256').update(data).digest('hex');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(7)]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(40).fill(3)]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let serial = 0;
/** A report that passes every check, with `over` merged in. */
function envelope(over = {}) {
  return {
    v: 1,
    kind: 'issue',
    title: 'Chat stops after the first reply',
    description: `After the first reply the composer stays disabled and nothing else happens (${++serial}).`,
    app: { version: '0.8.2', surface: 'desktop', mode: 'desktop-local', channel: 'stable' },
    diagnostics: { collectedAt: 1, client: { os: { platform: 'darwin', name: 'macOS 26.1', arch: 'arm64' } } },
    attachments: { chat: false, screenshots: [] },
    createdAt: Date.now(),
    ...over,
  };
}
const shotInfo = (name, bytes, mime = 'image/png') => ({ name, mime, width: 4, height: 4, bytes: bytes.byteLength });
const chatOf = (text = 'Hello there') => ({
  session: { mode: 'code', title: 'A session', status: 'idle', createdAt: 1, updatedAt: 2 },
  coverage: { total: 1, included: 1, omitted: [], shortened: 0 },
  messages: [{ index: 0, role: 'user', kind: 'text', createdAt: 1, parts: [{ type: 'text', text }] }],
});

function collector(extra = {}) {
  const env = { DB: fakeD1(), REPORTS: fakeR2(), CHALLENGE_SECRET: SECRET, ...extra };
  const call = (path, init = {}, ip = IP) =>
    worker.fetch(
      new Request(`https://reports.example.com${path}`, {
        ...init,
        headers: { 'cf-connecting-ip': ip, ...init.headers },
      }),
      env,
    );
  return { env, call };
}

/** The nonce the app would find. */
function solve(challenge, bits, contentHash) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    if (
      leadingZeroBits(
        createHash('sha256')
          .update(powInput(challenge, contentHash, nonce))
          .digest(),
      ) >= bits
    )
      return nonce;
  }
}

/** The parts as the app sends them: Blobs with a type and a file name, in order. */
function partsOf({ report, chat, shots = [] }) {
  const enc = new TextEncoder();
  return [
    {
      name: 'report',
      type: 'application/json',
      bytes: typeof report === 'string' ? enc.encode(report) : enc.encode(JSON.stringify(report)),
    },
    ...(chat === undefined
      ? []
      : [
          {
            name: 'chat',
            type: 'application/json',
            bytes: typeof chat === 'string' ? enc.encode(chat) : enc.encode(JSON.stringify(chat)),
          },
        ]),
    ...shots.map((s) => ({ name: s.name, type: s.type ?? 'image/png', bytes: s.bytes })),
  ];
}

/**
 * Posts a report the way packages/core/src/reports/submit.ts does. `bits` mints a challenge here (the test knows the
 * secret) so tests don't wait for 18 bits of work; `challenge` uses a given one.
 */
async function send(
  c,
  { report = envelope(), chat, shots, parts: given, bits = 2, challenge, nonce, ip = IP, headers = {} } = {},
) {
  const parts = given ?? partsOf({ report, chat, shots });
  const contentHash = sha(contentHashInput(parts.map((p) => ({ name: p.name, sha256: sha(p.bytes) }))));
  const ch = challenge ?? (await makeChallenge(SECRET, bits));
  const form = new FormData();
  for (const p of parts) form.append(p.name, new Blob([p.bytes], { type: p.type }), `${p.name}.bin`);
  const res = await c.call(
    '/v1/reports',
    {
      method: 'POST',
      body: form,
      headers: {
        [POW_HEADERS.challenge]: ch.challenge,
        [POW_HEADERS.nonce]: nonce ?? solve(ch.challenge, ch.bits, contentHash),
        ...headers,
      },
    },
    ip,
  );
  return { res, body: await res.json(), contentHash, challenge: ch };
}

const rows = (c) => c.env.DB.sqlite.prepare('SELECT * FROM reports').all();

test('says what it is, refuses other paths and methods, and sends no CORS headers', async () => {
  const c = collector();
  const home = await c.call('/');
  assert.equal(await home.text(), 'Atelier report collector\n');
  assert.equal((await c.call('/v1/nothing', { method: 'POST' })).status, 404);
  assert.equal((await c.call('/v1/reports')).status, 405);
  assert.equal((await c.call('/v1/challenge')).status, 405);
  const challenge = await c.call('/v1/challenge', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(challenge.headers.get('access-control-allow-origin'), null);
  const options = await c.call('/v1/reports', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(options.status, 405);
  assert.equal(options.headers.get('access-control-allow-origin'), null);
});

test('takes nothing without its secret', async () => {
  const c = collector({ CHALLENGE_SECRET: undefined });
  assert.equal((await c.call('/v1/challenge', { method: 'POST' })).status, 503);
  assert.equal((await c.call('/v1/reports', { method: 'POST' })).status, 503);
});

test('signs challenges that last ten minutes, harder as the day fills up', async () => {
  const c = collector();
  const first = await (await c.call('/v1/challenge', { method: 'POST' })).json();
  assert.equal(first.bits, 18);
  assert.ok(Math.abs(first.expiresAt - (Date.now() + 10 * 60_000)) < 5000);
  const [expiresAt, bits, random, mac] = first.challenge.split('.');
  assert.equal(Number(expiresAt), first.expiresAt);
  assert.equal(Number(bits), 18);
  assert.match(random, /^[0-9a-f]{32}$/);
  assert.equal(mac, createHmac('sha256', SECRET).update(`${expiresAt}.${bits}.${random}`).digest('hex'));
  for (const [count, expected] of [
    [199, 18],
    [200, 20],
    [799, 20],
    [800, 22],
  ]) {
    c.env.DB.sqlite
      .prepare('INSERT OR REPLACE INTO report_days (day, count) VALUES (?, ?)')
      .run(dayOf(Date.now()), count);
    assert.equal(
      (await (await c.call('/v1/challenge', { method: 'POST' })).json()).bits,
      expected,
      `${count} reports today`,
    );
  }
});

test('keeps a report whose proof is right, end to end with a real challenge', async () => {
  const c = collector();
  const challenge = await (await c.call('/v1/challenge', { method: 'POST' })).json();
  const report = envelope({
    contact: '  someone@example.com ',
    attachments: { chat: true, screenshots: [shotInfo('shot0', PNG), shotInfo('shot1', WEBP, 'image/webp')] },
  });
  const { res, body, contentHash } = await send(c, {
    report,
    chat: chatOf(),
    shots: [
      { name: 'shot0', bytes: PNG },
      { name: 'shot1', bytes: WEBP, type: 'image/webp' },
    ],
    challenge,
  });
  assert.equal(res.status, 201);
  assert.match(body.id, REPORT_ID);
  assert.ok(body.id.startsWith('I-'));
  assert.ok(Math.abs(body.receivedAt - Date.now()) < 5000);
  const keys = [...c.env.REPORTS.objects.keys()].sort();
  assert.deepEqual(keys, [
    `reports/${body.id}/chat.json`,
    `reports/${body.id}/report.json`,
    `reports/${body.id}/shot0.png`,
    `reports/${body.id}/shot1.webp`,
  ]);
  assert.equal(c.env.REPORTS.objects.get(`reports/${body.id}/shot1.webp`).httpMetadata.contentType, 'image/webp');
  const [row] = rows(c);
  assert.equal(row.id, body.id);
  assert.equal(row.kind, 'issue');
  assert.equal(row.status, 'new');
  assert.equal(row.labels, '[]');
  assert.equal(row.contact, 'someone@example.com');
  assert.equal(row.app_version, '0.8.2');
  assert.equal(row.surface, 'desktop');
  assert.equal(row.mode, 'desktop-local');
  assert.equal(row.os, 'darwin');
  assert.equal(row.os_name, 'macOS 26.1');
  assert.equal(row.arch, 'arm64');
  assert.equal(row.has_diagnostics, 1);
  assert.equal(row.has_chat, 1);
  assert.equal(row.screenshots, 2);
  assert.equal(row.content_hash, contentHash);
  assert.equal(row.seen_at, null);
  const stored = [...c.env.REPORTS.objects.values()].reduce((n, o) => n + o.bytes.byteLength, 0);
  assert.equal(row.bytes, stored);
  assert.equal(
    c.env.DB.sqlite.prepare("SELECT value FROM collector_state WHERE key = 'stored_bytes'").get().value,
    stored,
  );
  assert.equal(c.env.DB.sqlite.prepare('SELECT count FROM report_days').get().count, 1);
});

test('gives feature requests an F- id', async () => {
  const c = collector();
  const { res, body } = await send(c, {
    report: envelope({ kind: 'feature', diagnostics: undefined, title: 'Pin chats to the top of the list' }),
  });
  assert.equal(res.status, 201);
  assert.match(body.id, /^F-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(rows(c)[0].has_diagnostics, 0);
  assert.equal(rows(c)[0].os, null);
});

test('refuses a wrong proof: a nonce that does not do the work, or one for other parts', async () => {
  const c = collector();
  const report = envelope();
  const parts = partsOf({ report });
  const contentHash = sha(contentHashInput(parts.map((p) => ({ name: p.name, sha256: sha(p.bytes) }))));
  const ch = await makeChallenge(SECRET, 12);
  let bad = 0;
  while (
    leadingZeroBits(
      createHash('sha256')
        .update(powInput(ch.challenge, contentHash, String(bad)))
        .digest(),
    ) >= 12
  )
    bad++;
  const wrong = await send(c, { parts, challenge: ch, nonce: String(bad) });
  assert.equal(wrong.res.status, 403);
  assert.match(wrong.body.error, /proof of work/);
  // The nonce of one report doesn't carry another.
  const other = partsOf({ report: envelope() });
  const swapped = await send(c, { parts: other, challenge: ch, nonce: solve(ch.challenge, 12, contentHash) });
  assert.equal(swapped.res.status, 403);
  // Nor without the headers.
  const form = new FormData();
  form.append('report', new Blob([parts[0].bytes], { type: 'application/json' }), 'report.json');
  assert.equal((await c.call('/v1/reports', { method: 'POST', body: form })).status, 403);
  assert.equal((await send(c, { parts, challenge: ch, nonce: 'not a nonce!' })).res.status, 403);
  assert.equal(rows(c).length, 0);
});

test("refuses challenges it didn't sign, changed ones and expired ones", async () => {
  const c = collector();
  const mine = await makeChallenge(SECRET, 8);
  const [expiresAt, , random, mac] = mine.challenge.split('.');
  const easier = { challenge: `${expiresAt}.0.${random}.${mac}`, bits: 0 };
  assert.match((await send(c, { challenge: easier })).body.error, /isn't one this collector made/);
  const foreign = await (async () => {
    const head = `${Date.now() + 60_000}.0.${'a'.repeat(32)}`;
    return { challenge: `${head}.${createHmac('sha256', 'another-secret').update(head).digest('hex')}`, bits: 0 };
  })();
  assert.equal((await send(c, { challenge: foreign })).res.status, 403);
  const expired = await makeChallenge(SECRET, 2, Date.now() - 11 * 60_000);
  const late = await send(c, { challenge: expired });
  assert.equal(late.res.status, 403);
  assert.match(late.body.error, /expired/);
  assert.equal((await send(c, { challenge: { challenge: 'garbage', bits: 0 } })).res.status, 403);
});

test('refuses a body that says it is too big before reading it, and one that is, while reading', async () => {
  const c = collector();
  const ch = await makeChallenge(SECRET, 1);
  let pulled = false;
  const untouched = new ReadableStream(
    {
      pull() {
        pulled = true;
        throw new Error('read');
      },
    },
    { highWaterMark: 0 },
  );
  const big = {
    method: 'POST',
    url: 'https://reports.example.com/v1/reports',
    headers: new Headers({
      'content-length': String(REPORT_LIMITS.bodyBytes + 1),
      'content-type': 'multipart/form-data; boundary=x',
      'cf-connecting-ip': IP,
      [POW_HEADERS.challenge]: ch.challenge,
      [POW_HEADERS.nonce]: '0',
    }),
    body: untouched,
  };
  const refused = await worker.fetch(big, c.env);
  assert.equal(refused.status, 413);
  assert.equal(pulled, false);
  // No length given (chunked): cut off past the limit.
  let sent = 0;
  const endless = new ReadableStream({
    pull(controller) {
      sent += 1_000_000;
      controller.enqueue(new Uint8Array(1_000_000));
    },
  });
  const chunked = {
    ...big,
    headers: new Headers({
      'content-type': 'multipart/form-data; boundary=x',
      'cf-connecting-ip': IP,
      [POW_HEADERS.challenge]: ch.challenge,
      [POW_HEADERS.nonce]: '0',
    }),
    body: endless,
  };
  assert.equal((await worker.fetch(chunked, c.env)).status, 413);
  assert.ok(sent <= REPORT_LIMITS.bodyBytes + 2_000_000);
});

test('caps each part', async () => {
  const c = collector();
  const huge = envelope({ description: `${'A useful sentence about the problem. '.repeat(30_000)}` });
  const tooBig = await send(c, {
    report: { ...huge, description: huge.description.slice(0, 19_000) },
    parts: [{ name: 'report', type: 'application/json', bytes: new Uint8Array(REPORT_LIMITS.reportBytes + 1) }],
  });
  assert.equal(tooBig.res.status, 413);
  assert.match(tooBig.body.error, /report part/);
  const shot = new Uint8Array(REPORT_LIMITS.screenshotBytes + 1);
  shot.set(PNG);
  const bigShot = await send(c, {
    report: envelope({ attachments: { chat: false, screenshots: [shotInfo('shot0', shot)] } }),
    shots: [{ name: 'shot0', bytes: shot }],
  });
  assert.equal(bigShot.res.status, 413);
  assert.match(bigShot.body.error, /shot0 is too big/);
  const chat = await send(c, {
    parts: [
      ...partsOf({ report: envelope({ attachments: { chat: true, screenshots: [] } }) }),
      { name: 'chat', type: 'application/json', bytes: new Uint8Array(REPORT_LIMITS.chatBytes + 1) },
    ],
  });
  assert.equal(chat.res.status, 413);
});

test('limits reports per address and minute, by address', async () => {
  const c = collector({ REPORT_LIMITER: fakeLimiter(4), CHALLENGE_LIMITER: fakeLimiter(12) });
  for (let i = 0; i < 4; i++) assert.equal((await send(c)).res.status, 201);
  const fifth = await send(c);
  assert.equal(fifth.res.status, 429);
  assert.equal(fifth.body.retryAfter, 60);
  assert.equal(fifth.res.headers.get('retry-after'), '60');
  assert.equal((await send(c, { ip: '198.51.100.9' })).res.status, 201);
  for (let i = 0; i < 12; i++) assert.equal((await c.call('/v1/challenge', { method: 'POST' })).status, 200);
  assert.equal((await c.call('/v1/challenge', { method: 'POST' })).status, 429);
  assert.deepEqual([...c.env.REPORT_LIMITER.seen.keys()], [IP, '198.51.100.9']);
});

test('keeps 20 reports per address and day', async () => {
  const c = collector();
  for (let i = 0; i < POLICY.perAddressPerDay; i++) assert.equal((await send(c)).res.status, 201, `report ${i + 1}`);
  const over = await send(c);
  assert.equal(over.res.status, 429);
  assert.match(over.body.error, /20 reports today/);
  assert.ok(over.body.retryAfter > 0 && over.body.retryAfter <= 86_400);
  assert.equal((await send(c, { ip: '198.51.100.9' })).res.status, 201);
  // A refused report doesn't count, and one refused for its content doesn't use up the quota.
  const quota = c.env.DB.sqlite.prepare('SELECT count FROM report_quota ORDER BY count DESC').all();
  assert.deepEqual(
    quota.map((q) => q.count),
    [20, 1],
  );
});

test('stops at the daily cap and when storage is full', async () => {
  const c = collector();
  c.env.DB.sqlite.prepare('INSERT INTO report_days (day, count) VALUES (?, ?)').run(dayOf(Date.now()), POLICY.perDay);
  const capped = await send(c);
  assert.equal(capped.res.status, 503);
  assert.match(capped.body.error, /today/);
  c.env.DB.sqlite.prepare('DELETE FROM report_days').run();
  c.env.DB.sqlite
    .prepare("UPDATE collector_state SET value = ? WHERE key = 'stored_bytes'")
    .run(POLICY.storageBytes - 100);
  const full = await send(c);
  assert.equal(full.res.status, 503);
  assert.equal(full.body.error, 'The collector is full.');
  assert.equal(rows(c).length, 0);
  assert.equal(c.env.REPORTS.objects.size, 0);
});

test('checks the report against the protocol and the text rule', async () => {
  const c = collector();
  const cases = [
    [
      { parts: [{ name: 'report', type: 'application/json', bytes: new TextEncoder().encode('{not json') }] },
      /isn't valid JSON/,
    ],
    [{ report: envelope({ v: 2 }) }, /at v\b/],
    [{ report: envelope({ app: { version: '0.8.2', surface: 'phone', mode: 'web' } }) }, /at app\.surface/],
    [{ report: envelope({ title: 'Chat AAAAAAAAAAA broken' }) }, /repeated characters/],
    [{ report: envelope({ title: 'Bug' }) }, /a few words long/],
    [{ report: envelope({ description: 'it is broken now' }) }, /Say a little more/],
    [{ report: envelope({ description: 'broken broken broken broken broken broken broken please' }) }, /own words/],
  ];
  for (const [input, error] of cases) {
    const { res, body } = await send(c, input);
    assert.equal(res.status, 400, String(error));
    assert.match(body.error, error);
  }
  assert.equal(rows(c).length, 0);
});

test('checks that the attachments are the parts that came', async () => {
  const c = collector();
  const cases = [
    [{ report: envelope({ attachments: { chat: true, screenshots: [] } }) }, /a chat is attached, but there is none/],
    [{ report: envelope(), chat: chatOf() }, /A chat came/],
    [
      { report: envelope({ attachments: { chat: true, screenshots: [] } }), chat: '{"session":' },
      /chat part isn't valid JSON/,
    ],
    [
      { report: envelope({ attachments: { chat: true, screenshots: [] } }), chat: { messages: [] } },
      /chat isn't in a form/,
    ],
    [{ report: envelope({ attachments: { chat: false, screenshots: [shotInfo('shot0', PNG)] } }) }, /shot0 is missing/],
    [{ report: envelope(), shots: [{ name: 'shot0', bytes: PNG }] }, /doesn't list \(shot0\)/],
    [
      {
        report: envelope({
          attachments: { chat: false, screenshots: [shotInfo('shot0', PNG), shotInfo('shot0', PNG)] },
        }),
        shots: [{ name: 'shot0', bytes: PNG }],
      },
      /twice/,
    ],
  ];
  for (const [input, error] of cases) {
    const { res, body } = await send(c, input);
    assert.equal(res.status, 400, String(error));
    assert.match(body.error, error);
  }
});

test('checks the order and names of the parts', async () => {
  const c = collector();
  const report = partsOf({ report: envelope({ attachments: { chat: true, screenshots: [] } }), chat: chatOf() });
  const reversed = await send(c, { parts: [report[1], report[0]] });
  assert.equal(reversed.res.status, 400);
  assert.match(reversed.body.error, /must come first/);
  const odd = await send(c, { parts: [report[0], { name: 'extra', type: 'text/plain', bytes: new Uint8Array(1) }] });
  assert.match(odd.body.error, /doesn't take \("extra"\)/);
  const late = await send(c, {
    report: envelope({ attachments: { chat: true, screenshots: [shotInfo('shot0', PNG)] } }),
    parts: [report[0], { name: 'shot0', type: 'image/png', bytes: PNG }, report[1]],
  });
  assert.match(late.body.error, /right after the report/);
  const notForm = await c.call('/v1/reports', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(notForm.status, 400);
});

test('takes PNG, JPEG and WebP by their first bytes, never SVG or a picture under the wrong type', async () => {
  assert.equal(imageTypeOf(PNG), 'image/png');
  assert.equal(imageTypeOf(WEBP), 'image/webp');
  assert.equal(imageTypeOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageTypeOf(SVG), null);
  assert.equal(imageTypeOf(new Uint8Array(0)), null);
  const c = collector();
  const svg = await send(c, {
    report: envelope({ attachments: { chat: false, screenshots: [{ ...shotInfo('shot0', SVG), mime: 'image/png' }] } }),
    shots: [{ name: 'shot0', bytes: SVG }],
  });
  assert.equal(svg.res.status, 400);
  assert.match(svg.body.error, /isn't a WebP, JPEG or PNG/);
  const svgType = await send(c, {
    report: envelope({
      attachments: { chat: false, screenshots: [{ ...shotInfo('shot0', SVG), mime: 'image/svg+xml' }] },
    }),
    shots: [{ name: 'shot0', bytes: SVG, type: 'image/svg+xml' }],
  });
  assert.equal(svgType.res.status, 400);
  const mislabelled = await send(c, {
    report: envelope({ attachments: { chat: false, screenshots: [shotInfo('shot0', PNG, 'image/webp')] } }),
    shots: [{ name: 'shot0', bytes: PNG, type: 'image/webp' }],
  });
  assert.match(mislabelled.body.error, /isn't the picture the report describes/);
  const wrongPartType = await send(c, {
    report: envelope({ attachments: { chat: false, screenshots: [shotInfo('shot0', PNG)] } }),
    shots: [{ name: 'shot0', bytes: PNG, type: 'image/jpeg' }],
  });
  assert.equal(wrongPartType.res.status, 400);
  const wrongSize = await send(c, {
    report: envelope({ attachments: { chat: false, screenshots: [{ ...shotInfo('shot0', PNG), bytes: 3 }] } }),
    shots: [{ name: 'shot0', bytes: PNG }],
  });
  assert.equal(wrongSize.res.status, 400);
  assert.equal(rows(c).length, 0);
});

test('answers a retry of a kept report with the same receipt, and keeps it once', async () => {
  const c = collector();
  const report = envelope();
  const ch = await makeChallenge(SECRET, 4);
  const first = await send(c, { report, challenge: ch });
  assert.equal(first.res.status, 201);
  const again = await send(c, { report, challenge: ch });
  assert.equal(again.res.status, 200);
  assert.deepEqual(again.body, first.body);
  // With a new challenge (the old one ran out meanwhile), too.
  const later = await send(c, { report, bits: 3 });
  assert.equal(later.res.status, 200);
  assert.deepEqual(later.body, first.body);
  assert.equal(rows(c).length, 1);
  assert.equal(c.env.DB.sqlite.prepare('SELECT count FROM report_quota').get().count, 1);
  assert.equal(c.env.DB.sqlite.prepare('SELECT count FROM report_days').get().count, 1);
});

test('scrubs secrets the app left in, everywhere, and counts them', async () => {
  const c = collector();
  const report = envelope({
    description: 'It fails with my key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and then the window closes.',
    attachments: { chat: true, screenshots: [] },
    diagnostics: {
      collectedAt: 1,
      settings: {
        providers: [{ type: 'openai', apiKey: 'plain-value', note: 'password=hunter2' }],
        theme: 'dark',
        maxTokens: 4096,
      },
      log: [
        'GET /v1/models Authorization: Bearer abcdefghijklmnop',
        'retry with https://user:pa55word@example.com/feed',
        'max_tokens: 4096',
        'token: <redacted>',
      ],
      notes: { aws: 'AKIAABCDEFGHIJKLMNOP' },
    },
  });
  const chat = chatOf('my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  chat.messages.push({
    index: 1,
    role: 'assistant',
    kind: 'text',
    createdAt: 2,
    parts: [
      {
        type: 'tool_call',
        id: 't1',
        name: 'Bash',
        input: '{"command":"curl -H \\"x-api-key: sk-proj-0123456789abcdefghij\\" api"}',
      },
    ],
  });
  const { res, body } = await send(c, { report, chat });
  assert.equal(res.status, 201);
  const stored = c.env.REPORTS.objects.get(`reports/${body.id}/report.json`);
  const storedChat = c.env.REPORTS.objects.get(`reports/${body.id}/chat.json`);
  const all =
    new TextDecoder().decode(stored.bytes) + new TextDecoder().decode(storedChat.bytes) + JSON.stringify(rows(c));
  for (const secret of [
    'sk-ant-api03',
    'plain-value',
    'hunter2',
    'abcdefghijklmnop',
    'pa55word',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_',
    'sk-proj-',
  ])
    assert.ok(!all.includes(secret), secret);
  const kept = JSON.parse(new TextDecoder().decode(stored.bytes));
  assert.equal(kept.diagnostics.settings.theme, 'dark');
  assert.equal(kept.diagnostics.settings.maxTokens, 4096);
  assert.equal(kept.diagnostics.log[2], 'max_tokens: 4096');
  assert.equal(kept.diagnostics.log[3], 'token: <redacted>');
  assert.match(kept.description, /my key <token> and then/);
  assert.equal(rows(c)[0].description, kept.description);
  assert.ok(rows(c)[0].scrubbed >= 8, `scrubbed ${rows(c)[0].scrubbed}`);
});

test('never stores an address', async () => {
  const c = collector({ REPORT_LIMITER: fakeLimiter(), CHALLENGE_LIMITER: fakeLimiter() });
  const addresses = ['203.0.113.77', '2001:db8::1:7'];
  for (const ip of addresses) {
    await c.call('/v1/challenge', { method: 'POST' }, ip);
    assert.equal((await send(c, { ip })).res.status, 201);
  }
  const everything =
    JSON.stringify(c.env.DB.dump()) +
    [...c.env.REPORTS.objects.values()].map((o) => new TextDecoder().decode(o.bytes)).join('');
  for (const ip of addresses) assert.ok(!everything.includes(ip), ip);
  const keys = c.env.DB.sqlite
    .prepare('SELECT key FROM report_quota')
    .all()
    .map((r) => r.key);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/);
});
