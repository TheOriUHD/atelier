import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { updateFeed, type UpdateFeedOptions } from './updates.ts';

const TOKEN = 'ghp_fake_token_for_tests';
const STORAGE = 'https://release-assets.example.com/signed';

const release = (tag: string, published: string | null, extra: { draft?: boolean; prerelease?: boolean } = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: published,
  ...extra,
  assets: ['latest-mac.yml', `Atelier-${tag}-arm64.dmg`].map((name, i) => ({ name, url: `https://api.github.com/repos/ada/atelier/releases/assets/${tag}-${i}` })),
});

const RELEASES = [
  release('0.4.0', null, { draft: true }),
  release('0.3.0-beta.1', '2026-10-10T00:00:00Z', { prerelease: true }),
  release('0.2.0', '2026-10-01T00:00:00Z'),
  release('0.1.0', '2026-09-01T00:00:00Z'),
];

/** GitHub's API (release list, asset redirects) and its storage, recording what each was sent. */
function fakeGitHub() {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith('https://api.github.com/repos/ada/atelier/releases?')) return Response.json(RELEASES);
    const asset = url.match(/\/releases\/assets\/(.+)$/);
    if (asset) return new Response(null, { status: 302, headers: { location: `${STORAGE}/${asset[1]}?sig=abc` } });
    if (url.startsWith(STORAGE)) return new Response(`contents of ${new URL(url).pathname.split('/').pop()}`, { headers: { 'content-length': '20' } });
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests };
}

function server(options: Partial<UpdateFeedOptions> = {}) {
  const github = fakeGitHub();
  let time = 0;
  const app = new Hono().route(
    '/updates',
    updateFeed({
      repo: 'ada/atelier',
      token: TOKEN,
      authenticated: async (c) => c.req.header('authorization') === 'Bearer session',
      fetch: github.fetch,
      now: () => time,
      ...options,
    }),
  );
  const get = (path: string, auth = true) => app.request(path, { headers: auth ? { authorization: 'Bearer session' } : {} });
  return { get, github, advance: (ms: number) => (time += ms) };
}

describe('update feed', () => {
  it('is off without a repository and token', async () => {
    const { get, github } = server({ repo: undefined, token: undefined });
    const response = await get('/updates/stable/latest-mac.yml');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_configured', message: expect.stringContaining('ATELIER_UPDATES_REPO') });
    expect(github.requests).toEqual([]);
  });

  it('refuses people who aren’t signed in', async () => {
    const { get, github } = server();
    const response = await get('/updates/stable/latest-mac.yml', false);
    expect(response.status).toBe(401);
    expect(github.requests).toEqual([]);
  });

  it('serves stable from the newest release and beta from the newest prerelease, never a draft', async () => {
    const { get } = server();
    expect(await (await get('/updates/stable/latest-mac.yml')).text()).toBe('contents of 0.2.0-0');
    expect(await (await get('/updates/beta/latest-mac.yml')).text()).toBe('contents of 0.3.0-beta.1-0');
    expect(await (await get('/updates/beta/Atelier-0.3.0-beta.1-arm64.dmg')).text()).toBe('contents of 0.3.0-beta.1-1');
  });

  it('serves only assets of that release on a known channel', async () => {
    const { get } = server();
    for (const path of [
      '/updates/stable/Atelier-0.3.0-beta.1-arm64.dmg',
      '/updates/stable/Atelier-0.1.0-arm64.dmg',
      '/updates/stable/..%2F..%2Fetc%2Fpasswd',
      '/updates/stable/https%3A%2F%2Fexample.com%2Fx',
      '/updates/nightly/latest-mac.yml',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it('sends the token to GitHub’s API but not to the storage it redirects to', async () => {
    const { get, github } = server();
    const response = await get('/updates/stable/Atelier-0.2.0-arm64.dmg');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe('20');
    const [list, asset, storage] = github.requests;
    expect(list!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(asset!.url).toBe('https://api.github.com/repos/ada/atelier/releases/assets/0.2.0-1');
    expect(asset!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(asset!.headers.get('accept')).toBe('application/octet-stream');
    expect(storage!.url).toBe(`${STORAGE}/0.2.0-1?sig=abc`);
    expect(storage!.headers.get('authorization')).toBeNull();
  });

  it('keeps the release list for five minutes', async () => {
    const { get, github, advance } = server();
    await get('/updates/stable/latest-mac.yml');
    advance(4 * 60_000);
    await get('/updates/beta/latest-mac.yml');
    const lists = () => github.requests.filter((r) => r.url.includes('/releases?')).length;
    expect(lists()).toBe(1);
    advance(2 * 60_000);
    await get('/updates/stable/latest-mac.yml');
    expect(lists()).toBe(2);
  });

  it('reports GitHub failures as a bad gateway', async () => {
    const { get } = server({ fetch: (async () => new Response('bad credentials', { status: 401 })) as typeof fetch });
    const response = await get('/updates/stable/latest-mac.yml');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: 'GitHub answered 401 for the releases of ada/atelier.' });
  });

  it('refuses a repository that isn’t owner/repo', () => {
    expect(() => updateFeed({ repo: 'ada/atelier/../../users', token: TOKEN, authenticated: async () => true })).toThrow(/owner\/repo/);
  });
});
