import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerUpdates, type ServerUpdatesOptions } from './server-updates.ts';

const FEED = 'https://updates.example.test';
const UPDATER = 'http://updater:7341';
const IDLE = { state: 'idle', message: null, startedAt: null, finishedAt: null };

let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'atelier-server-updates-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

/** The public feed and an updater service, recording what each was asked. */
function fakeNetwork({ feedVersion = '0.1.9', betaVersion = null as string | null, feedUp = true, updater = 'registry' as 'registry' | 'source' | 'down' | 'busy' | 'old' | 'pre-0.10.7' } = {}) {
  const requests: { url: string; method: string; auth: string | null }[] = [];
  const state = { feedVersion, betaVersion, feedUp, updater };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    if (url === `${FEED}/stable/latest.yml`) {
      if (!state.feedUp) throw new TypeError('fetch failed');
      return new Response(`version: ${state.feedVersion}\nfiles:\n  - url: Atelier-Setup.exe\nreleaseDate: '2026-10-17'\n`);
    }
    if (url === `${FEED}/beta/latest.yml`) {
      if (!state.feedUp || !state.betaVersion) return new Response('not found', { status: 404 });
      return new Response(`version: ${state.betaVersion}\nfiles:\n  - url: Atelier-Setup.exe\n`);
    }
    if (url.startsWith('https://api.github.com/repos/ada/atelier/releases/latest')) return Response.json({ tag_name: 'v0.2.0' });
    if (url.startsWith('https://api.github.com/repos/ada/atelier/releases?')) return Response.json([{ tag_name: 'v0.3.0-beta.2', draft: true }, { tag_name: 'v0.3.0-beta.1' }, { tag_name: 'v0.2.0' }, { tag_name: 'nightly' }]);
    if (url.startsWith(UPDATER)) {
      if (state.updater === 'down') throw new TypeError('fetch failed');
      if (url.endsWith('/status')) {
        const image = state.updater === 'source' ? 'atelier:local' : 'ghcr.io/theoriuhd/atelier:latest';
        const features = state.updater === 'old' ? {} : state.updater === 'pre-0.10.7' ? { features: ['pull'] } : { features: ['pull', 'version'] };
        return Response.json({ project: 'atelier', services: { atelier: { image, source: state.updater === 'source' } }, job: IDLE, ...features });
      }
      // An updater from before 0.10.6 doesn't know the download-ahead step.
      if (/\/pull(\?version=[\w.-]+)?$/.test(url)) return state.updater === 'old' ? new Response('not found', { status: 404 }) : state.updater === 'busy' ? Response.json({ error: 'An update is already running.' }, { status: 409 }) : Response.json({ job: { ...IDLE, state: 'pulling' } }, { status: 202 });
      if (/\/update(\?(pull=false&?)?(version=[\w.-]+)?)?$/.test(url)) {
        if (state.updater === 'busy') return Response.json({ error: 'An update is already running.' }, { status: 409 });
        return Response.json({ job: { ...IDLE, state: 'pulling' } }, { status: 202 });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests, state };
}

function make(options: Partial<ServerUpdatesOptions> = {}, network = fakeNetwork()) {
  let now = 1_000_000;
  const updates = new ServerUpdates({ version: '0.1.8', feed: FEED, fetch: network.fetch, now: () => now, ...options });
  return { updates, network, advance: (ms: number) => (now += ms) };
}

const withUpdater = () => ({ updater: { url: UPDATER, secretFile: join(dir, 'updater', 'secret') }, image: 'ghcr.io/theoriuhd/atelier' });

describe('the newest server version', () => {
  it('comes from the public feed’s latest.yml', async () => {
    const { updates } = make({ image: 'ghcr.io/theoriuhd/atelier' });
    expect(await updates.status()).toEqual({
      version: '0.1.8',
      latest: { version: '0.1.9', checkedAt: 1_000_000 },
      latestError: null,
      install: 'manual',
      image: 'ghcr.io/theoriuhd/atelier',
      updaterError: null,
      job: null,
      channel: 'stable',
      exactVersions: null,
      updaterUpdate: 'docker compose pull updater && docker compose up -d updater',
    });
  });

  it('on the beta channel is the newer of the newest beta and the newest release', async () => {
    let channel: 'stable' | 'beta' = 'beta';
    const network = fakeNetwork({ feedVersion: '0.10.6', betaVersion: '0.10.7-beta.5' });
    const { updates } = make({ channel: () => channel }, network);
    expect((await updates.status()).latest?.version).toBe('0.10.7-beta.5');
    // The release after the betas: the beta channel moves to it.
    network.state.feedVersion = '0.10.7';
    expect((await updates.status(true)).latest?.version).toBe('0.10.7');
    // Back on stable it looks again at once, without waiting for the cache.
    network.state.feedVersion = '0.10.6';
    channel = 'stable';
    expect(await updates.status()).toMatchObject({ channel: 'stable', latest: { version: '0.10.6' } });
  });

  it('on the beta channel is the stable one while there is no beta', async () => {
    const { updates } = make({ channel: () => 'beta' }, fakeNetwork({ feedVersion: '0.10.6' }));
    expect(await updates.status()).toMatchObject({ latest: { version: '0.10.6' }, latestError: null });
  });

  it('on the beta channel, from GitHub, is the newest release that isn’t a draft', async () => {
    const { updates } = make({ repo: 'ada/atelier', channel: () => 'beta' });
    expect((await updates.status()).latest?.version).toBe('0.3.0-beta.1');
  });

  it('is cached for ten minutes, unless asked to refresh', async () => {
    const { updates, network, advance } = make();
    await updates.status();
    network.state.feedVersion = '0.1.10';
    advance(9 * 60_000);
    expect((await updates.status()).latest?.version).toBe('0.1.9');
    expect((await updates.status(true)).latest?.version).toBe('0.1.10');
    network.state.feedVersion = '0.1.11';
    advance(10 * 60_000 + 1);
    expect((await updates.status()).latest?.version).toBe('0.1.11');
    expect(network.requests.filter((r) => r.url.endsWith('latest.yml'))).toHaveLength(3);
  });

  it('keeps the last version it saw while offline, says why, and doesn’t ask on every look', async () => {
    const { updates, network, advance } = make();
    await updates.status();
    network.state.feedUp = false;
    advance(11 * 60_000);
    const offline = await updates.status();
    expect(offline.latest?.version).toBe('0.1.9');
    expect(offline.latestError).toMatch(/Couldn't check for a newer version: fetch failed/);
    await updates.status();
    expect(network.requests.filter((r) => r.url.endsWith('latest.yml'))).toHaveLength(2);
  });

  it('is unknown, not an error page, when the server was never online', async () => {
    const { updates } = make({}, fakeNetwork({ feedUp: false }));
    const status = await updates.status();
    expect(status.latest).toBeNull();
    expect(status.latestError).toBeTruthy();
  });

  it('comes from GitHub releases when a repository is set', async () => {
    const { updates, network } = make({ repo: 'ada/atelier', token: 'ghp_fake' });
    expect((await updates.status()).latest?.version).toBe('0.2.0');
    expect(network.requests[0]).toMatchObject({ url: 'https://api.github.com/repos/ada/atelier/releases/latest', auth: 'Bearer ghp_fake' });
  });
});

describe('how the server can be updated', () => {
  it('is by rebuilding when the image was built from source', async () => {
    const { updates } = make();
    expect((await updates.status()).install).toBe('source');
    await expect(updates.update()).rejects.toMatchObject({ code: 'source_build' });
  });

  it('is by hand without an updater service', async () => {
    const { updates } = make({ image: 'ghcr.io/theoriuhd/atelier' });
    await expect(updates.update()).rejects.toMatchObject({ code: 'no_updater', message: expect.stringContaining('docker compose pull && docker compose up -d') });
  });

  it('asks the updater with the secret it made in the shared volume', async () => {
    const { updates, network } = make(withUpdater());
    const status = await updates.status();
    expect(status).toMatchObject({ install: 'updater', image: 'ghcr.io/theoriuhd/atelier:latest', updaterError: null, job: IDLE });
    const file = join(dir, 'updater', 'secret');
    const secret = (await readFile(file, 'utf8')).trim();
    expect(secret.length).toBeGreaterThanOrEqual(40);
    // Windows has no Unix permission bits (Node reports 0666 there); the owner-only mode is checked where it exists.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    await updates.update();
    const post = network.requests.find((r) => r.method === 'POST');
    expect(post).toEqual({ url: `${UPDATER}/update`, method: 'POST', auth: `Bearer ${secret}` });
  });

  it('uses a secret that is already there', async () => {
    const file = join(dir, 'secret');
    await writeFile(file, 'made-earlier\n');
    const { updates, network } = make({ updater: { url: UPDATER, secretFile: file }, image: 'x/atelier' });
    await updates.status();
    expect(network.requests.find((r) => r.url.startsWith(UPDATER))?.auth).toBe('Bearer made-earlier');
  });

  it('treats an update that is already running as accepted', async () => {
    const { updates } = make(withUpdater(), fakeNetwork({ updater: 'busy' }));
    await expect(updates.update()).resolves.toMatchObject({ install: 'updater' });
  });

  it('follows the updater when it sees a locally built image', async () => {
    const { updates, network } = make(withUpdater(), fakeNetwork({ updater: 'source' }));
    expect(await updates.status()).toMatchObject({ install: 'source', image: 'atelier:local' });
    await expect(updates.update()).rejects.toMatchObject({ code: 'source_build' });
    expect(network.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('says so when the updater can’t be reached, and offers the manual way', async () => {
    const { updates } = make(withUpdater(), fakeNetwork({ updater: 'down' }));
    const status = await updates.status();
    expect(status).toMatchObject({ install: 'manual', job: null });
    expect(status.updaterError).toMatch(/can’t be reached at http:\/\/updater:7341/);
    await expect(updates.update()).rejects.toMatchObject({ code: 'updater_failed' });
  });
});

describe('downloading ahead and installing', () => {
  it('tells whether the updater downloads ahead, and what its job is', async () => {
    const { updates } = make(withUpdater());
    expect(await updates.updaterState()).toMatchObject({ ok: true, downloadsAhead: true, source: false, job: { state: 'idle', pulledAt: null } });
    const old = make(withUpdater(), fakeNetwork({ updater: 'old' }));
    expect(await old.updates.updaterState()).toMatchObject({ ok: true, downloadsAhead: false });
    const down = make(withUpdater(), fakeNetwork({ updater: 'down' }));
    expect(await down.updates.updaterState()).toMatchObject({ ok: false, error: expect.stringContaining('can’t be reached') });
  });

  it('asks the updater to download, and knows when it can’t or already does', async () => {
    const { updates, network } = make(withUpdater());
    expect(await updates.pull()).toBe('started');
    expect(network.requests.at(-1)).toMatchObject({ method: 'POST', url: `${UPDATER}/pull` });
    expect(await make(withUpdater(), fakeNetwork({ updater: 'old' })).updates.pull()).toBe('unsupported');
    expect(await make(withUpdater(), fakeNetwork({ updater: 'busy' })).updates.pull()).toBe('running');
  });

  it('installs what was downloaded without fetching it again, or downloads and installs in one go', async () => {
    const { updates, network } = make(withUpdater());
    await updates.install(true);
    expect(network.requests.at(-1)).toMatchObject({ method: 'POST', url: `${UPDATER}/update?pull=false` });
    await updates.install(false);
    expect(network.requests.at(-1)).toMatchObject({ method: 'POST', url: `${UPDATER}/update` });
    // An update that is already running is what was asked for.
    await expect(make(withUpdater(), fakeNetwork({ updater: 'busy' })).updates.install(false)).resolves.toBeUndefined();
  });

  it('on the beta channel, asks for the exact version it found, which a beta needs', async () => {
    const network = fakeNetwork({ feedVersion: '0.10.6', betaVersion: '0.10.7-beta.6' });
    const { updates } = make({ ...withUpdater(), version: '0.10.6', channel: () => 'beta' }, network);
    expect(await updates.status()).toMatchObject({ channel: 'beta', exactVersions: true, latest: { version: '0.10.7-beta.6' } });
    await updates.update();
    expect(network.requests.filter((r) => r.method === 'POST')).toMatchObject([{ url: `${UPDATER}/update?version=0.10.7-beta.6` }]);
    await updates.pull(updates.exactVersion('0.10.7-beta.6'));
    expect(network.requests.at(-1)).toMatchObject({ url: `${UPDATER}/pull?version=0.10.7-beta.6` });
    await updates.install(true, '0.10.7-beta.6');
    expect(network.requests.at(-1)).toMatchObject({ url: `${UPDATER}/update?pull=false&version=0.10.7-beta.6` });
  });

  it('on the beta channel, refuses to install with an updater too old for betas, and says how to update it', async () => {
    const network = fakeNetwork({ feedVersion: '0.10.6', betaVersion: '0.10.7-beta.6', updater: 'pre-0.10.7' });
    const { updates } = make({ ...withUpdater(), version: '0.10.6', channel: () => 'beta' }, network);
    expect(await updates.status()).toMatchObject({ exactVersions: false });
    // Before the release, `:latest` is too old as well: the beta's own updater, under the name the compose file runs.
    const command =
      'docker pull ghcr.io/theoriuhd/atelier-updater:v0.10.7-beta.6 && docker tag ghcr.io/theoriuhd/atelier-updater:v0.10.7-beta.6 ghcr.io/theoriuhd/atelier-updater:latest && docker compose up -d updater';
    expect((await updates.status()).updaterUpdate).toBe(command);
    await expect(updates.update()).rejects.toMatchObject({ code: 'updater_old', message: expect.stringContaining(command) });
    expect(network.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('on stable, keeps the compose file’s tags even with an updater that could choose', async () => {
    expect(make(withUpdater()).updates.exactVersion('0.1.9')).toBeNull();
  });

  it('looks for the newest version again whatever its cache says', async () => {
    const { updates, network } = make(withUpdater());
    expect(await updates.refreshLatest()).toBe('0.1.9');
    network.state.feedVersion = '0.2.0';
    expect(await updates.refreshLatest()).toBe('0.2.0');
    network.state.feedUp = false;
    // Offline: the last version found stays.
    expect(await updates.refreshLatest()).toBe('0.2.0');
  });
});
