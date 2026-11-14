import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fakeD1, fakeR2 } from '../test/fakes.mjs';
import { adminEmails, forgetKeys, verifyAccess } from './access.js';
import worker from './index.js';

const TEAM = 'atelier-test.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const OWNER = 'owner@example.com';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const enc = (value) => b64url(Buffer.from(JSON.stringify(value)));

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { ...pair, kid, jwk };
}

const now = () => Math.floor(Date.now() / 1000);
/** A token the way Access makes one; `over` changes claims, `header` the header, `key` signs with another key. */
async function token(key, over = {}, header = {}) {
  const head = enc({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = enc({
    aud: [AUD],
    email: OWNER,
    exp: now() + 3600,
    iat: now(),
    nbf: now() - 5,
    iss: `https://${TEAM}`,
    type: 'app',
    sub: 'user-id',
    ...over,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

let keys;
let other;
let published;
let fetches;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  keys ??= await keyPair('key-1');
  other ??= await keyPair('key-2');
  published = [keys.jwk];
  fetches = [];
  forgetKeys();
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`)
      return Response.json({ keys: published, public_cert: { kid: 'x', cert: '' }, public_certs: [] });
    return new Response('no', { status: 500 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ENV = { TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: ` ${OWNER.toUpperCase()} , second@example.com` };
const ask = (jwt, env = ENV, url = 'https://admin.example.com/api/me') =>
  verifyAccess(new Request(url, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} }), env);

test('lets the owner in with a token Access signed', async () => {
  const who = await ask(await token(keys));
  assert.deepEqual(who, { ok: true, email: OWNER });
  // An audience given as a string, and another admin from the list.
  assert.equal((await ask(await token(keys, { aud: AUD, email: 'Second@Example.com' }))).ok, true);
  // The keys are fetched once and kept.
  await ask(await token(keys));
  assert.deepEqual(fetches, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test('refuses everything when it is not set up', async () => {
  const jwt = await token(keys);
  for (const missing of ['TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']) {
    const env = { ...ENV, [missing]: '' };
    const who = await ask(jwt, env);
    assert.equal(who.ok, false, missing);
    assert.match(who.error, /not set up/);
  }
  assert.equal((await ask(jwt, { ...ENV, ADMIN_EMAILS: ' , ' })).ok, false);
  assert.equal((await ask(jwt, { ...ENV, TEAM_DOMAIN: 'evil.example/path?' })).ok, false);
  assert.deepEqual(fetches, []);
});

test('refuses a missing or malformed token', async () => {
  for (const jwt of [null, 'abc', 'a.b', 'a.b.c', `${enc({ alg: 'RS256', kid: 'key-1' })}.not-json.sig`])
    assert.equal((await ask(jwt)).ok, false, String(jwt));
});

test('refuses tokens for another audience, issuer, time or person', async () => {
  const cases = [
    [{ aud: ['someone-else'] }, /another application/],
    [{ aud: undefined }, /another application/],
    [{ iss: 'https://other-team.cloudflareaccess.com' }, /another team/],
    [{ exp: now() - 120 }, /expired/],
    [{ exp: undefined }, /expired/],
    [{ nbf: now() + 600 }, /not valid yet/],
    [{ email: 'intruder@example.com' }, /may not use/],
    [{ email: undefined, common_name: 'service-token' }, /may not use/],
  ];
  for (const [over, error] of cases) {
    const who = await ask(await token(keys, over));
    assert.equal(who.ok, false, JSON.stringify(over));
    assert.match(who.error, error);
  }
});

test('refuses a forged signature, another algorithm and an unknown key', async () => {
  // Signed with a key that isn't the team's, under the team key's id.
  const forged = await token({ ...other, kid: 'key-1' });
  assert.equal((await ask(forged)).ok, false);
  const [head, body, sig] = (await token(keys)).split('.');
  assert.equal(
    (
      await ask(
        `${head}.${enc({ aud: [AUD], email: 'intruder@example.com', exp: now() + 60, iss: `https://${TEAM}` })}.${sig}`,
      )
    ).ok,
    false,
  );
  assert.equal((await ask(`${enc({ alg: 'none', kid: 'key-1' })}.${body}.`)).ok, false);
  assert.equal((await ask(`${enc({ alg: 'HS256', kid: 'key-1' })}.${body}.${sig}`)).ok, false);
  assert.equal((await ask(await token(keys, {}, { kid: undefined }))).ok, false);
  assert.equal((await ask(await token(other))).ok, false);
});

test('fetches the keys again when Access rotated them, but not on every unknown key', async () => {
  assert.equal((await ask(await token(keys))).ok, true);
  published = [keys.jwk, other.jwk];
  // Within 30 seconds of the last fetch an unknown key doesn't fetch again…
  assert.equal((await ask(await token(other))).ok, false);
  assert.equal(fetches.length, 1);
  // …after it, it does.
  forgetKeys();
  assert.equal((await ask(await token(keys))).ok, true);
  assert.equal((await ask(await token(other))).ok, true);
});

test('refuses when the keys cannot be fetched', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const who = await ask(await token(keys));
  assert.equal(who.ok, false);
  assert.match(who.error, /keys didn't load/);
});

test('lets local development in without Access only on localhost with DEV_NO_ACCESS', async () => {
  const dev = { DEV_NO_ACCESS: '1' };
  assert.equal((await ask(null, dev, 'http://localhost:8788/api/me')).ok, true);
  assert.equal((await ask(null, dev, 'http://127.0.0.1:8788/api/me')).ok, true);
  assert.equal((await ask(null, dev, 'https://admin.atelierhq.dev/api/me')).ok, false);
  assert.equal((await ask(null, { DEV_NO_ACCESS: 'true' }, 'http://localhost/api/me')).ok, false);
  assert.equal((await ask(null, {}, 'http://localhost/api/me')).ok, false);
  // A Host header can't fake it: the URL's own host is what counts.
  assert.equal(
    (await verifyAccess(new Request('https://admin.atelierhq.dev/api/me', { headers: { host: 'localhost' } }), dev)).ok,
    false,
  );
});

test('the Worker answers 403 on every API route without a valid sign-in, and serves the page from the assets', async () => {
  const env = {
    ...ENV,
    DB: fakeD1(),
    REPORTS: fakeR2(),
    ASSETS: { fetch: async () => new Response('<!doctype html>page') },
  };
  for (const [method, path] of [
    ['GET', '/api/me'],
    ['GET', '/api/overview'],
    ['GET', '/api/reports?kind=issue'],
    ['GET', '/api/reports/I-ABCDEF/files/shot0.png'],
    ['PATCH', '/api/reports/I-ABCDEF'],
    ['DELETE', '/api/reports/I-ABCDEF'],
    ['POST', '/api/reports/bulk'],
    ['GET', '/api/nothing'],
  ]) {
    const res = await worker.fetch(
      new Request(`https://admin.example.com${path}`, {
        method,
        headers: { 'x-atelier-admin': '1', 'content-type': 'application/json' },
      }),
      env,
      {},
    );
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const unset = await worker.fetch(
    new Request('https://admin.example.com/api/me', { headers: { 'cf-access-jwt-assertion': await token(keys) } }),
    { DB: fakeD1(), REPORTS: fakeR2() },
    {},
  );
  assert.equal(unset.status, 403);
  assert.equal(
    await (await worker.fetch(new Request('https://admin.example.com/'), env, {})).text(),
    '<!doctype html>page',
  );
});

test('reads ADMIN_EMAILS as a list', () => {
  assert.deepEqual(adminEmails(' A@x.com,b@y.org ,, '), ['a@x.com', 'b@y.org']);
  assert.deepEqual(adminEmails(undefined), []);
});
