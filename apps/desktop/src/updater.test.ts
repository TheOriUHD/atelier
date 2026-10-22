import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater';
import { signedMessage } from './update-signature.ts';
import { compareVersions, createUpdates, inertUpdater, type BundleSwap, type UpdateChannel, type UpdateStatus, type Updater } from './updater.ts';

const SERVER = { url: 'https://atelier.example.com', token: 'fake-session-token' };

/** electron-updater's autoUpdater: each check runs the scripted events and returns the scripted result. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableDifferentialDownload = false;
  requestHeaders: Record<string, string> | null = null;
  feed: unknown = null;
  installed: unknown[] | null = null;
  checks = 0;
  downloads = 0;
  /** The versions downloadUpdate fetched, in order. */
  fetched: string[] = [];
  /** Makes the next downloads fail as a dropped connection does. */
  failDownloads = false;
  lastInfo: UpdateInfo | null = null;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'update-available') this.lastInfo = args[0] as UpdateInfo;
    return super.emit(event, ...args);
  }
  /** What a manual download does: progress, then done (or the error event and a rejection). */
  async downloadUpdate() {
    this.downloads++;
    this.fetched.push(this.lastInfo!.version);
    this.emit('download-progress', { percent: 42.7, bytesPerSecond: 1, total: 100, transferred: 42, delta: 1 });
    if (this.failDownloads) {
      const error = new Error('net::ERR_CONNECTION_RESET');
      this.emit('error', error);
      throw error;
    }
    this.emit('update-downloaded', { ...this.lastInfo, downloadedFile: '/tmp/x' });
    return [];
  }
  script: (u: FakeUpdater) => UpdateCheckResult | null = () => null;
  setFeedURL(options: unknown) {
    this.feed = options;
  }
  async checkForUpdates() {
    this.checks++;
    return this.script(this);
  }
  quitAndInstall(...args: unknown[]) {
    this.installed = args;
  }
}

const IMAGE_ARM = 'image for Apple silicon';
const IMAGE_INTEL = 'image for Intel';
const ZIP = 'zip bytes of the app';
const sha512 = (text: string) => createHash('sha512').update(text).digest('base64');

const info = (version: string): UpdateInfo => ({
  version,
  releaseDate: '2026-10-14T00:00:00Z',
  path: `Atelier-${version}-arm64-mac.zip`,
  sha512: 'zip',
  files: [
    { url: `Atelier-${version}-arm64-mac.zip`, sha512: sha512(ZIP), size: ZIP.length },
    { url: `Atelier-${version}-arm64.dmg`, sha512: sha512(IMAGE_ARM), size: IMAGE_ARM.length },
    { url: `Atelier-${version}.dmg`, sha512: sha512(IMAGE_INTEL), size: IMAGE_INTEL.length },
  ],
});

/** A check that finds `version`; with autoDownload, the download runs and finishes. */
const finds =
  (version: string) =>
  (u: FakeUpdater): UpdateCheckResult => {
    u.emit('checking-for-update');
    u.emit('update-available', info(version));
    if (u.autoDownload) {
      u.emit('download-progress', { percent: 42.7, bytesPerSecond: 1, total: 100, transferred: 42, delta: 1 });
      u.emit('update-downloaded', { ...info(version), downloadedFile: '/tmp/x' });
    }
    return { isUpdateAvailable: true, updateInfo: info(version), versionInfo: info(version), downloadPromise: Promise.resolve([]) };
  };

let downloads: string;
beforeEach(() => {
  downloads = mkdtempSync(join(tmpdir(), 'atelier-updates-'));
});
afterEach(() => rmSync(downloads, { recursive: true, force: true }));

function setup({ platform = 'linux' as NodeJS.Platform, arch = 'x64', channel = 'stable' as UpdateChannel, automatic = true, served = IMAGE_ARM, publicFeed = null as string | null, publicKey = null as string | null, answer = null as ((url: string) => Response | null) | null, swap = null as BundleSwap | null } = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const saved: UpdateChannel[] = [];
  const savedAutomatic: boolean[] = [];
  const revealed: string[] = [];
  const quit = vi.fn();
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    const given = answer?.(url);
    if (given) return given;
    const body = url.endsWith('-mac.zip') ? ZIP : served;
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  });
  const updates = createUpdates({
    updater: updater as unknown as Updater,
    platform,
    arch,
    version: '0.2.0',
    channel,
    saveChannel: async (c) => void saved.push(c),
    automatic,
    saveAutomatic: async (on) => void savedAutomatic.push(on),
    fetch,
    downloads,
    reveal: (path) => void revealed.push(path),
    onStatus: (s) => void statuses.push(s),
    publicFeed,
    publicKey,
    swap,
    quit,
    now: () => 1000,
  });
  const states = () => statuses.map((s) => s.state.kind);
  return { updater, updates, statuses, states, saved, savedAutomatic, revealed, fetch, quit };
}

describe('updates', () => {
  it('stay quiet with the inert updater that main falls back to when electron-updater cannot be built', async () => {
    const updates = createUpdates({
      updater: inertUpdater(),
      platform: 'linux',
      arch: 'x64',
      version: '0.0',
      channel: 'stable',
      saveChannel: async () => undefined,
      fetch: async () => new Response('', { status: 404 }),
      downloads: '/tmp',
      reveal: () => undefined,
      onStatus: () => undefined,
      publicFeed: 'https://updates.example.com',
    });
    updates.setServer(null);
    await updates.check();
    expect(updates.status().state).toEqual({ kind: 'unsupported', reason: expect.stringContaining('can’t update itself') });
  });

  describe('automatic checks', () => {
    const PUBLIC = 'https://updates.example.com';

    it('look for updates by themselves by default', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC });
      updates.setServer(null);
      await updates.checkAutomatically();
      expect(updater.checks).toBe(1);
      expect(updates.status().automatic).toBe(true);
    });

    it('send nothing while they are off, but a check the person asks for still goes out', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC, automatic: false });
      updates.setServer(null);
      await updates.checkAutomatically();
      expect(updater.checks).toBe(0);
      expect(updates.status().automatic).toBe(false);
      await updates.check();
      expect(updater.checks).toBe(1);
    });

    it('are switched on and off, saved, and announced to the window', async () => {
      const { updater, updates, statuses, savedAutomatic } = setup({ publicFeed: PUBLIC });
      updates.setServer(null);
      await updates.setAutomatic(false);
      expect(savedAutomatic).toEqual([false]);
      expect(statuses.at(-1)).toMatchObject({ automatic: false });
      await updates.checkAutomatically();
      expect(updater.checks).toBe(0);
      await updates.setAutomatic(true);
      await updates.checkAutomatically();
      expect(updater.checks).toBe(1);
    });
  });

  it('have no feed in "Run on this computer" mode', async () => {
    const { updater, updates } = setup();
    updates.setServer(null);
    await updates.check();
    expect(updates.status()).toEqual({ version: '0.2.0', channel: 'stable', automatic: true, state: { kind: 'unsupported', reason: expect.stringContaining('no update source') }, checkedAt: null });
    expect(updater.checks).toBe(0);
  });

  describe('with an update key', () => {
    const PUBLIC = 'https://updates.example.com';
    const ours = generateKeyPairSync('ed25519');
    const theirs = generateKeyPairSync('ed25519');
    const publicKey = ours.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    /** Answers `<file>.sig` with a signature by `key` over the file as `info()` lists it, or by a stranger. */
    const signatures = (key: typeof ours, skip: string[] = []) => (url: string) => {
      const match = /\/([^/]+)\.sig$/.exec(url);
      if (!match) return null;
      if (skip.includes(match[1]!)) return new Response('missing', { status: 404 });
      const file = info('0.3.0').files.find((f) => f.url === match[1]);
      return new Response(sign(null, signedMessage(match[1]!, file?.sha512 ?? ''), key.privateKey).toString('base64'));
    };

    it('keep the update that waits when a newer one is not signed', async () => {
      const { updater, updates, fetch } = setup({ publicFeed: PUBLIC, publicKey, answer: signatures(ours) });
      updates.setServer(null);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      // signatures() signs 0.3.0's packages only, so 0.4.0's do not match.
      updater.script = finds('0.4.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('0.4.0'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(updater.fetched).toEqual(['0.3.0']);
      expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' });
    });

    it('download nothing until every package of the update has a signature that is ours', async () => {
      const { updater, updates, states } = setup({ publicFeed: PUBLIC, publicKey, answer: signatures(ours) });
      expect(updater.autoDownload).toBe(false);
      updates.setServer(null);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(updater.downloads).toBe(1);
      expect(states()).toContain('available');
    });

    it('refuse an update with a package that has no signature', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC, publicKey, answer: signatures(ours, ['Atelier-0.3.0.dmg']) });
      updates.setServer(null);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toMatchObject({ kind: 'error', message: expect.stringContaining('is not signed') }));
      expect(updater.downloads).toBe(0);
    });

    it('refuse a signature made with another key', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC, publicKey, answer: signatures(theirs) });
      updates.setServer(null);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toMatchObject({ kind: 'error', message: expect.stringContaining('not signed with Atelier') }));
      expect(updater.downloads).toBe(0);
    });

    it('check a Mac’s disk image before saving it', async () => {
      const unsignedMac = setup({ platform: 'darwin', arch: 'arm64', publicFeed: PUBLIC, publicKey, answer: signatures(theirs) });
      unsignedMac.updates.setServer(null);
      unsignedMac.updater.script = finds('0.3.0');
      await unsignedMac.updates.check();
      await unsignedMac.updates.download();
      expect(unsignedMac.updates.status().state).toMatchObject({ kind: 'error' });
      // Only the signature was asked for: no disk image was fetched.
      expect(unsignedMac.fetch.mock.calls.every(([url]) => String(url).endsWith('.sig'))).toBe(true);

      const signedMac = setup({ platform: 'darwin', arch: 'arm64', publicFeed: PUBLIC, publicKey, answer: (url) => signatures(ours)(url) });
      signedMac.updates.setServer(null);
      signedMac.updater.script = finds('0.3.0');
      await signedMac.updates.check();
      await signedMac.updates.download();
      expect(signedMac.updates.status().state).toEqual({ kind: 'saved', version: '0.3.0' });
    });
  });

  describe('with a public feed', () => {
    const PUBLIC = 'https://updates.example.com';

    it('update a copy that has no server, in the background, from the channel’s folder and without a token', async () => {
      const { updater, updates, states } = setup({ publicFeed: `${PUBLIC}/` });
      updates.setServer(null);
      expect(updater.feed).toEqual({ provider: 'generic', url: 'https://updates.example.com/stable' });
      expect(updater.requestHeaders).toBeNull();
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(states()).toEqual(['idle', 'checking', 'available', 'downloading', 'downloading', 'downloaded']);
    });

    it('is used while a server is signed out, and for the other channel', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC });
      updates.setServer({ url: SERVER.url, token: null });
      expect(updater.feed).toEqual({ provider: 'generic', url: 'https://updates.example.com/stable' });
      updater.script = finds('0.3.0-beta.1');
      await updates.setChannel('beta');
      expect(updater.feed).toEqual({ provider: 'generic', url: 'https://updates.example.com/beta' });
      expect(updater.checks).toBe(1);
    });

    it('is asked instead when the signed-in server publishes no updates', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC });
      updates.setServer(SERVER);
      expect(updater.feed).toEqual({ provider: 'generic', url: 'https://atelier.example.com/updates/stable' });
      let first = true;
      updater.script = (u) => {
        if (first) {
          first = false;
          // As electron-updater does: the error event, and the check itself rejects.
          const error = Object.assign(new Error('Cannot find channel "latest.yml"'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
          u.emit('error', error);
          throw error;
        }
        return finds('0.3.0')(u);
      };
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(updater.feed).toEqual({ provider: 'generic', url: 'https://updates.example.com/stable' });
      expect(updater.requestHeaders).toBeNull();
    });

    it('is not a failure that nothing is published there yet', async () => {
      const { updater, updates } = setup({ publicFeed: PUBLIC });
      updates.setServer(null);
      updater.script = (u) => {
        const error = Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', statusCode: 404 });
        u.emit('error', error);
        throw error;
      };
      await updates.check();
      expect(updates.status()).toMatchObject({ state: { kind: 'idle' }, checkedAt: 1000 });
    });

    it('gives a Mac its disk image from the public feed without sending a token', async () => {
      const { updater, updates, fetch } = setup({ platform: 'darwin', arch: 'arm64', publicFeed: PUBLIC });
      updates.setServer(null);
      updater.script = finds('0.3.0');
      await updates.check();
      await updates.download();
      expect(fetch.mock.calls[0]![0]).toBe('https://updates.example.com/stable/Atelier-0.3.0-arm64.dmg');
      expect(fetch.mock.calls[0]![1]).toEqual({ headers: {} });
    });
  });

  it('read the signed-in server’s feed with the token in a header', () => {
    const { updater, updates } = setup();
    updates.setServer(SERVER);
    expect(updater.feed).toEqual({ provider: 'generic', url: 'https://atelier.example.com/updates/stable' });
    expect(updater.requestHeaders).toEqual({ Authorization: 'Bearer fake-session-token' });
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updates.status().state).toEqual({ kind: 'idle' });
  });

  it('don’t check while signed out', async () => {
    const { updater, updates } = setup();
    updates.setServer({ url: SERVER.url, token: null });
    await updates.check();
    expect(updater.requestHeaders).toBeNull();
    expect(updater.checks).toBe(0);
  });

  it('download in the background on Windows and Linux and install on quit or restart', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { updater, updates, states } = setup({ platform });
      expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, true]);
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(states()).toEqual(['idle', 'checking', 'available', 'downloading', 'downloading', 'downloaded']);
      // Checked again while it waits, the same version is neither downloaded again nor shown as anything but ready.
      const before = states().length;
      await updates.check();
      await Promise.resolve();
      expect(updater.checks).toBe(2);
      expect(updater.fetched).toEqual(['0.3.0']);
      expect(states().slice(before)).toEqual([]);
      updates.install();
      expect(updater.installed).toEqual([true, true]);
    }
  });

  describe('with an update waiting for a restart (Windows, Linux)', () => {
    async function waiting(platform: NodeJS.Platform = 'win32') {
      const t = setup({ platform });
      t.updates.setServer(SERVER);
      t.updater.script = finds('0.3.0');
      await t.updates.check();
      await vi.waitFor(() => expect(t.updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      return t;
    }

    it('download a newer version the feed offers meanwhile, which Restart then installs', async () => {
      for (const platform of ['win32', 'linux'] as const) {
        const { updater, updates, statuses } = await waiting(platform);
        const before = statuses.length;
        updater.script = finds('0.4.0');
        await updates.check();
        await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.4.0' }));
        expect(updater.fetched).toEqual(['0.3.0', '0.4.0']);
        // No "checking" or "available" in between: the notice goes from ready to downloading the newer one.
        expect(statuses.slice(before).map((s) => s.state)).toEqual([
          { kind: 'downloading', percent: 0, version: '0.4.0' },
          { kind: 'downloading', percent: 42, version: '0.4.0' },
          { kind: 'downloaded', version: '0.4.0' },
        ]);
        updates.install();
        expect(updater.installed).toEqual([true, true]);
      }
    });

    it('never take an older version than the one that waits', async () => {
      const { updater, updates } = await waiting();
      updater.script = finds('0.3.0-beta.2');
      await updates.check();
      await Promise.resolve();
      expect(updater.fetched).toEqual(['0.3.0']);
      expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' });
    });

    it('keep offering the one that waits when a check fails', async () => {
      const { updater, updates } = await waiting();
      updater.script = (u) => {
        const error = new Error('net::ERR_INTERNET_DISCONNECTED');
        u.emit('error', error);
        throw error;
      };
      await updates.check();
      expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' });
    });

    it('say so when the newer download fails: electron-updater has dropped the older installer with it', async () => {
      const { updater, updates } = await waiting();
      updater.failDownloads = true;
      updater.script = finds('0.4.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'error', message: 'net::ERR_CONNECTION_RESET' }));
      updates.install();
      expect(updater.installed).toBeNull();
      // The next check tries again.
      updater.failDownloads = false;
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.4.0' }));
    });
  });

  it('compare versions as semver does', () => {
    expect(compareVersions('0.1.7', '0.1.6')).toBeGreaterThan(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.0-beta.3')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.10', '0.2.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.1', '0.2.0-beta')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.6', '0.1.7')).toBeLessThan(0);
  });

  it('report the download’s progress in whole percent', async () => {
    const { updater, updates, statuses } = setup();
    updates.setServer(SERVER);
    updater.script = finds('0.3.0');
    await updates.check();
    await vi.waitFor(() => expect(updates.status().state.kind).toBe('downloaded'));
    expect(statuses.filter((s) => s.state.kind === 'downloading').map((s) => s.state)).toEqual([
      { kind: 'downloading', percent: 0, version: '0.3.0' },
      { kind: 'downloading', percent: 42, version: '0.3.0' },
    ]);
  });

  it('remember when a check found nothing newer', async () => {
    const { updater, updates } = setup();
    updates.setServer(SERVER);
    updater.script = (u) => {
      u.emit('checking-for-update');
      u.emit('update-not-available', info('0.2.0'));
      return { isUpdateAvailable: false, updateInfo: info('0.2.0'), versionInfo: info('0.2.0') };
    };
    await updates.check();
    expect(updates.status()).toMatchObject({ state: { kind: 'idle' }, checkedAt: 1000 });
  });

  it('say in one sentence what went wrong', async () => {
    const { updater, updates } = setup();
    updates.setServer(SERVER);
    const fail = (error: Error) => {
      updater.script = (u) => {
        u.emit('error', error);
        throw error;
      };
      return updates.check().then(() => updates.status().state);
    };
    expect(await fail(new Error('net::ERR_CONNECTION_REFUSED\n    at stack'))).toEqual({ kind: 'error', message: 'net::ERR_CONNECTION_REFUSED' });
    expect(await fail(Object.assign(new Error('401 Unauthorized\nHeaders: {}'), { statusCode: 401 }))).toEqual({ kind: 'error', message: expect.stringContaining('Sign in again') });
    expect(await fail(Object.assign(new Error('Cannot find channel "latest.yml"'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))).toEqual({
      kind: 'error',
      message: expect.stringContaining('ATELIER_UPDATES_REPO'),
    });
  });

  it('say so when this copy can’t update itself', async () => {
    const { updater, updates } = setup();
    updates.setServer(SERVER);
    updater.script = () => null;
    await updates.check();
    expect(updates.status().state).toEqual({ kind: 'unsupported', reason: expect.stringContaining('releases page') });
  });

  it('switch channels: saved, a new feed, and a check right away', async () => {
    const { updater, updates, saved } = setup();
    updates.setServer(SERVER);
    updater.script = finds('0.3.0-beta.1');
    await updates.setChannel('beta');
    expect(saved).toEqual(['beta']);
    expect(updater.feed).toEqual({ provider: 'generic', url: 'https://atelier.example.com/updates/beta' });
    expect(updater.checks).toBe(1);
    await vi.waitFor(() => expect(updates.status().state.kind).toBe('downloaded'));
    expect(updates.status()).toMatchObject({ channel: 'beta', state: { kind: 'downloaded', version: '0.3.0-beta.1' } });
  });

  describe('on a Mac that can replace its own app', () => {
    const APP = '/Applications/Atelier.app';
    function fakeSwap(target: BundleSwap['target'] = { bundle: APP }) {
      const unpacked: string[] = [];
      const replaced: unknown[][] = [];
      const removed: string[] = [];
      const swap: BundleSwap = {
        target,
        staging: join(downloads, 'staging'),
        unpack: async (zip, into) => {
          unpacked.push(zip);
          mkdirSync(join(into, 'Atelier.app'), { recursive: true });
          return join(into, 'Atelier.app');
        },
        replaceAfterQuit: (...args) => void replaced.push(args),
        remove: async (path) => {
          removed.push(path);
          rmSync(path, { recursive: true, force: true });
        },
      };
      return { swap, unpacked, replaced, removed };
    }

    it('download the zip in the background, unpack it, and swap it in when Restart is pressed', async () => {
      const { swap, unpacked, replaced } = fakeSwap();
      const { updater, updates, fetch, quit, states } = setup({ platform: 'darwin', arch: 'arm64', swap });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(fetch).toHaveBeenCalledWith('https://atelier.example.com/updates/stable/Atelier-0.3.0-arm64-mac.zip', { headers: { Authorization: 'Bearer fake-session-token' } });
      expect(unpacked).toEqual([join(swap.staging, 'Atelier-0.3.0-arm64-mac.zip')]);
      expect(states()).toContain('downloading');
      // The zip itself is not kept once it is unpacked.
      expect(readdirSync(swap.staging)).toEqual(['0.3.0']);
      // Checked again while it waits, the same version is not downloaded again.
      await updates.check();
      expect(updater.checks).toBe(2);
      expect(unpacked).toHaveLength(1);
      expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' });

      updates.install();
      expect(replaced).toEqual([[join(swap.staging, '0.3.0', 'Atelier.app'), APP, true]]);
      expect(quit).toHaveBeenCalledTimes(1);
      updates.install();
      updates.installOnQuit();
      expect(replaced).toHaveLength(1);
    });

    it('clear a whole app left in the staging folder by an earlier run through the swap, not Node', async () => {
      // An update staged by 0.1.10 and never installed (the person installed a newer copy by hand) stayed as a full app;
      // Node's rm in Electron can't delete its app.asar, which failed every later update ("ENOTEMPTY").
      const { swap, removed } = fakeSwap();
      mkdirSync(join(swap.staging, '0.1.10', 'Atelier.app', 'Contents', 'Resources', 'app.asar'), { recursive: true });
      const { updater, updates } = setup({ platform: 'darwin', arch: 'arm64', swap });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      expect(removed[0]).toBe(swap.staging);
      expect(readdirSync(swap.staging)).toEqual(['0.3.0']);
    });

    it('replace the staged update with a newer one the feed offers meanwhile', async () => {
      const { swap, unpacked, replaced } = fakeSwap();
      const { updater, updates, statuses } = setup({ platform: 'darwin', arch: 'arm64', swap });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      updater.script = finds('0.4.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.4.0' }));
      expect(statuses.map((s) => s.state)).toContainEqual({ kind: 'downloading', percent: 100, version: '0.4.0' });
      expect(unpacked).toEqual([join(swap.staging, 'Atelier-0.3.0-arm64-mac.zip'), join(swap.staging, 'Atelier-0.4.0-arm64-mac.zip')]);
      expect(readdirSync(swap.staging)).toEqual(['0.4.0']);
      // The same version again is not downloaded twice.
      await updates.check();
      expect(unpacked).toHaveLength(2);
      updates.install();
      expect(replaced).toEqual([[join(swap.staging, '0.4.0', 'Atelier.app'), APP, true]]);
    });

    it('keep the staged update ready when a newer download fails, with nothing of the newer one left', async () => {
      const { swap, replaced } = fakeSwap();
      const { updater, updates, statuses } = setup({ platform: 'darwin', arch: 'arm64', swap, answer: (url) => (url.endsWith('0.4.0-arm64-mac.zip') ? new Response('something else') : null) });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'downloaded', version: '0.3.0' }));
      const before = statuses.length;
      updater.script = finds('0.4.0');
      await updates.check();
      await vi.waitFor(() => {
        expect(statuses.length).toBeGreaterThan(before + 1);
        expect(statuses.at(-1)!.state).toEqual({ kind: 'downloaded', version: '0.3.0' });
      });
      expect(statuses[before]!.state).toEqual({ kind: 'downloading', percent: 0, version: '0.4.0' });
      expect(readdirSync(swap.staging)).toEqual(['0.3.0']);
      updates.installOnQuit();
      expect(replaced).toEqual([[join(swap.staging, '0.3.0', 'Atelier.app'), APP, false]]);
    });

    it('swap when the app quits by itself, without starting it again', async () => {
      const { swap, replaced } = fakeSwap();
      const { updater, updates, quit } = setup({ platform: 'darwin', arch: 'arm64', swap });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      updates.installOnQuit();
      expect(replaced).toEqual([]);
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state.kind).toBe('downloaded'));
      updates.installOnQuit();
      expect(replaced).toEqual([[join(swap.staging, '0.3.0', 'Atelier.app'), APP, false]]);
      expect(quit).not.toHaveBeenCalled();
    });

    it('keep nothing of a damaged zip', async () => {
      const { swap, replaced } = fakeSwap();
      const { updater, updates } = setup({ platform: 'darwin', arch: 'arm64', swap, answer: (url) => (url.endsWith('-mac.zip') ? new Response('something else') : null) });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await vi.waitFor(() => expect(updates.status().state).toEqual({ kind: 'error', message: 'Couldn’t download Atelier 0.3.0: the file is damaged.' }));
      updates.install();
      expect(replaced).toEqual([]);
      expect(() => readdirSync(swap.staging)).toThrow();
    });

    it('offer the disk image when the app cannot replace itself (a disk image, a folder it cannot write)', async () => {
      const { swap, unpacked } = fakeSwap({ reason: 'Atelier is running from a disk image: drag it to Applications.' });
      const { updater, updates, fetch } = setup({ platform: 'darwin', arch: 'arm64', swap });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      expect(updates.status().state).toEqual({ kind: 'available', version: '0.3.0', manual: true });
      expect(fetch).not.toHaveBeenCalled();
      expect(unpacked).toEqual([]);
    });
  });

  describe('on macOS', () => {
    it('only say an update is available, then save this Mac’s disk image to Downloads and show it', async () => {
      const { updater, updates, states, fetch, revealed } = setup({ platform: 'darwin', arch: 'arm64' });
      expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, false]);
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      // No replaceable app here: the disk image is what is offered.
      expect(updates.status().state).toEqual({ kind: 'available', version: '0.3.0', manual: true });

      await updates.download();
      expect(fetch).toHaveBeenCalledWith('https://atelier.example.com/updates/stable/Atelier-0.3.0-arm64.dmg', { headers: { Authorization: 'Bearer fake-session-token' } });
      const saved = join(downloads, 'Atelier-0.3.0-arm64.dmg');
      expect(readFileSync(saved, 'utf8')).toBe(IMAGE_ARM);
      expect(revealed).toEqual([saved]);
      expect(states().slice(-3)).toEqual(['downloading', 'downloading', 'saved']);
      expect(updates.status().state).toEqual({ kind: 'saved', version: '0.3.0' });
      // The disk image is for the person to open.
      updates.install();
      expect(updater.installed).toBeNull();
    });

    it('pick the Intel disk image on an Intel Mac', async () => {
      const { updater, updates, fetch } = setup({ platform: 'darwin', arch: 'x64', served: IMAGE_INTEL });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await updates.download();
      expect(fetch.mock.calls[0]![0]).toBe('https://atelier.example.com/updates/stable/Atelier-0.3.0.dmg');
      expect(readdirSync(downloads)).toEqual(['Atelier-0.3.0.dmg']);
    });

    it('keep no damaged download', async () => {
      const { updater, updates, revealed } = setup({ platform: 'darwin', arch: 'arm64', served: 'something else' });
      updates.setServer(SERVER);
      updater.script = finds('0.3.0');
      await updates.check();
      await updates.download();
      expect(updates.status().state).toEqual({ kind: 'error', message: 'Couldn’t download Atelier 0.3.0: the file is damaged.' });
      expect(readdirSync(downloads)).toEqual([]);
      expect(revealed).toEqual([]);
    });

    it('never send the token anywhere but the feed', async () => {
      const { updater, updates, fetch } = setup({ platform: 'darwin', arch: 'arm64' });
      updates.setServer(SERVER);
      updater.script = (u) => {
        const elsewhere = { ...info('0.3.0'), files: [{ url: 'https://elsewhere.example.com/Atelier-0.3.0-arm64.dmg', sha512: 'x' }] };
        u.emit('update-available', elsewhere);
        return { isUpdateAvailable: true, updateInfo: elsewhere, versionInfo: elsewhere };
      };
      await updates.check();
      await updates.download();
      expect(fetch).not.toHaveBeenCalled();
      expect(updates.status().state).toEqual({ kind: 'error', message: 'Atelier 0.3.0 has no disk image for this Mac.' });
    });
  });

  it('download nothing themselves on Windows and Linux', async () => {
    const { updater, updates, fetch } = setup({ platform: 'win32' });
    updates.setServer(SERVER);
    updater.script = (u) => {
      u.emit('update-available', info('0.3.0'));
      return { isUpdateAvailable: true, updateInfo: info('0.3.0'), versionInfo: info('0.3.0') };
    };
    await updates.check();
    await updates.download();
    expect(fetch).not.toHaveBeenCalled();
  });
});
