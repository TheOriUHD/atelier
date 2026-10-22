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
function fakeNetwork({ feedVersion = '0.1.9', feedUp = true, updater = 'registry' as 'registry' | 'source' | 'down' | 'busy' } = {}) {
  const requests: { url: string; method: string; auth: string | null }[] = [];
  const state = { feedVersion, feedUp, updater };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    if (url === `${FEED}/stable/latest.yml`) {
      if (!state.feedUp) throw new TypeError('fetch failed');
      return new Response(`version: ${state.feedVersion}\nfiles:\n  - url: Atelier-Setup.exe\nreleaseDate: '2026-10-17'\n`);
    }
    if (url.startsWith('https://api.github.com/repos/ada/atelier/releases/latest')) return Response.json({ tag_name: 'v0.2.0' });
    if (url.startsWith(UPDATER)) {
      if (state.updater === 'down') throw new TypeError('fetch failed');
      if (url.endsWith('/status')) {
        const image = state.updater === 'source' ? 'atelier:local' : 'ghcr.io/theoriuhd/atelier:latest';
        return Response.json({ project: 'atelier', services: { atelier: { image, source: state.updater === 'source' } }, job: IDLE });
      }
      if (url.endsWith('/update')) {
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
    });
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
