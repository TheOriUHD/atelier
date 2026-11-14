import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretName, scrubJson, scrubText, TooDeep } from './scrub.js';

const scrub = (text) => {
  const count = { n: 0 };
  return { text: scrubText(text, count), n: count.n };
};

test('replaces keys and tokens by their shape', () => {
  const cases = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwx here', 'key <token> here'],
    ['key sk-proj-ABCDEFGHIJKLMNOPQRST', 'key <token>'],
    ['stripe sk_live_abcdefghijklmnop1234', 'stripe <token>'],
    ['gh ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'gh <token>'],
    ['pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'pat <token>'],
    ['aws AKIAIOSFODNN7EXAMPLE id', 'aws <token> id'],
    ['google AIzaSyA-abcdefghijklmnopqrstuvwxyz012345', 'google <token>'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop end', 'jwt <token> end'],
    ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: Bearer <token>'],
    ['git clone https://me:s3cret@example.com/repo.git', 'git clone https://me:<redacted>@example.com/repo.git'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', '<private key>'],
    ['cut -----BEGIN RSA PRIVATE KEY-----\nMIIE', 'cut <private key>'],
  ];
  for (const [input, expected] of cases) {
    const { text, n } = scrub(input);
    assert.equal(text, expected, input);
    assert.ok(n >= 1, input);
  }
});

test('replaces the values of secret-looking names in configs, URLs, flags and JSON', () => {
  const cases = [
    ['password=hunter2', 'password=<redacted>'],
    ['OPENAI_API_KEY=abc123def', 'OPENAI_API_KEY=<redacted>'],
    ['{"password":"correct horse"}', '{"password":"<redacted>"}'],
    ["client_secret: 'abcdef'", "client_secret: '<redacted>'"],
    ['https://x.example/cb?access_token=abc123&state=1', 'https://x.example/cb?access_token=<redacted>&state=1'],
    ['run --client-secret=abc123 now', 'run --client-secret=<redacted> now'],
    ['cookie: sid=0123456789abcdef', 'cookie: <redacted>'],
    ['config.password: Hunter2!', 'config.password: <redacted>'],
  ];
  for (const [input, expected] of cases) assert.equal(scrub(input).text, expected, input);
});

test('leaves prose, counts, settings names and what was already replaced', () => {
  for (const text of [
    'The password: field stays empty after I paste it.',
    'max_tokens: 4096 and prompt_tokens: 12',
    'token: 42',
    'auth: none',
    'author: someone',
    'token: <redacted>',
    'Authorization: Bearer <token>',
    'apiKey: true',
    'https://<credentials>@example.com',
    'short',
  ]) {
    const { text: out, n } = scrub(text);
    assert.equal(out, text, text);
    assert.equal(n, 0, text);
  }
});

test('knows secret field names, not their look-alikes', () => {
  for (const name of [
    'apiKey',
    'api_key',
    'authToken',
    'clientSecret',
    'password',
    'auth',
    'cookie',
    'privateKey',
    'x-api-key',
    'sessionId',
  ])
    assert.ok(isSecretName(name), name);
  for (const name of ['maxTokens', 'tokens', 'author', 'keySet', 'tokenizer', 'secretRef', 'theme', 'passwordPolicy'])
    assert.ok(!isSecretName(name), name);
});

test('walks JSON: every string, and any string under a secret name', () => {
  const { value, count } = scrubJson({
    settings: {
      apiKey: 'looks-harmless',
      keySet: true,
      maxTokens: 4096,
      nested: [{ token: 'abc' }, 'Bearer abcdefghijkl'],
      empty: { password: '' },
    },
    title: 'Nothing secret here',
  });
  assert.deepEqual(value, {
    settings: {
      apiKey: '<redacted>',
      keySet: true,
      maxTokens: 4096,
      nested: [{ token: '<redacted>' }, 'Bearer <token>'],
      empty: { password: '' },
    },
    title: 'Nothing secret here',
  });
  assert.equal(count, 3);
  let deep = 'x';
  for (let i = 0; i < 100; i++) deep = [deep];
  assert.throws(() => scrubJson(deep), TooDeep);
});

test('stays fast on long runs of name-like characters', () => {
  const started = performance.now();
  scrub('a.'.repeat(500_000));
  scrub('token'.repeat(200_000));
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
});
