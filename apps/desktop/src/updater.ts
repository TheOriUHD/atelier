/**
 * Desktop updates through electron-updater's generic provider. The feed is the Atelier server this app is signed in
 * to (`<server>/updates/<channel>`, see apps/server/src/updates.ts), with the sign-in token sent by main as a
 * header (the renderer never sees it), or else the public feed (`<publicFeed>/<channel>`, a static host such as
 * Cloudflare R2, see deploy/cloudflare) for a copy that has no server or whose server offers no updates.
 * Windows and Linux download in the background and install on quit (or on "Restart to update"): the next start
 * runs the new version. macOS does the same without a Developer ID, by itself: it downloads the zip, checks its hash
 * and signature, unpacks it beside the app, and swaps the app bundle once Atelier has quit (a helper shell script
 * does that from outside the app), which the next start then runs. Squirrel.Mac, electron-updater's macOS path,
 * needs a signed app, so it is not used. Where the bundle can't be replaced (not writable, run from a disk image)
 * "Download" saves the new disk image to the Downloads folder and shows it in Finder instead.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import { compareVersions } from '@atelier/protocol';
import { isSigned } from './update-signature.ts';

export type UpdateChannel = 'stable' | 'beta';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** `manual`: this copy can't install it by itself (a Mac whose app can't be replaced): offer the disk image. */
  | { kind: 'available'; version: string; manual?: boolean }
  | { kind: 'downloading'; percent: number; version: string }
  /** Ready: it installs when Atelier quits, or at once on Restart. */
  | { kind: 'downloaded'; version: string }
  /** macOS, manual: the disk image is in the Downloads folder. */
  | { kind: 'saved'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported'; reason: string };

export interface UpdateStatus {
  /** This app's version. */
  version: string;
  channel: UpdateChannel;
  /** Whether the app looks for updates by itself (at start and on a timer); off, only a check the person asks for does. */
  automatic: boolean;
  state: UpdateState;
  /** When a check last found nothing newer. */
  checkedAt: number | null;
}

/** The part of electron-updater's `autoUpdater` used here; tests pass a fake. */
export type Updater = Pick<
  AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'disableDifferentialDownload' | 'requestHeaders' | 'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on'
>;

/**
 * An updater that never finds anything, for when electron-updater cannot be built (it refuses an app version that
 * is not semver, as a bare Electron run on Linux has): Atelier opens anyway and the updates page says it can't update.
 */
export function inertUpdater(): Updater {
  const events = new EventEmitter();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: true,
    requestHeaders: null,
    setFeedURL: () => undefined,
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => undefined,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return updater;
    },
  };
  return updater as unknown as Updater;
}

/** What replacing the running app takes on macOS (main.ts has the real one; tests pass a fake). */
export interface BundleSwap {
  /** The running app bundle when it can replace itself; otherwise why not. */
  target: { bundle: string } | { reason: string };
  /** Where new versions are unpacked, inside the app's own data. */
  staging: string;
  /** Unpacks a downloaded zip into `into` and returns the app bundle in it; throws when it is not this app. */
  unpack(zip: string, into: string): Promise<string>;
  /**
   * Deletes a folder in `staging` and everything in it. Not Node's `rm`: Electron's fs takes an app's `app.asar` for a
   * folder and can't delete it, so a staged app that was never installed would stay, and block every later update.
   */
  remove(path: string): Promise<void>;
  /** Once this app has quit: puts `staged` where `target` is and, with `relaunch`, starts it. */
  replaceAfterQuit(staged: string, target: string, relaunch: boolean): void;
}

export interface UpdatesOptions {
  updater: Updater;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  channel: UpdateChannel;
  saveChannel(channel: UpdateChannel): Promise<void>;
  /** Look for updates by itself; default on. */
  automatic?: boolean;
  saveAutomatic?(automatic: boolean): Promise<void>;
  /** Main's `net.fetch`, for the macOS disk image. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The Downloads folder. */
  downloads: string;
  /** Shows a file in Finder. */
  reveal(path: string): void;
  onStatus(status: UpdateStatus): void;
  /** macOS: how the app replaces itself. Without it (or with a target that can't be replaced) the disk image is offered. */
  swap?: BundleSwap | null;
  /** Quits the app (Restart). */
  quit?(): void;
  /** The public feed's address (no trailing slash), or none. */
  publicFeed?: string | null;
  /**
   * The key updates must be signed with (raw Ed25519 public key, base64): each package needs a `<file>.sig` beside it
   * (update-signature.ts), checked before anything is downloaded. Without it updates are taken as the feed gives them.
   */
  publicKey?: string | null;
  now?: () => number;
}

/** The server this app is signed in to; the token is null while signed out. */
export interface UpdateServer {
  url: string;
  token: string | null;
}

const NO_FEED = 'This copy has no update source, so it can’t check for new versions. Get them from the Releases page.';
/** A feed of its own: where the update files are. */
interface Feed {
  base: string;
  token: string | null;
}
/** Shared with the UI, which compares this app's version with its server's. */
export { compareVersions };

const INACTIVE = 'This copy of Atelier can’t update itself. Install it from the releases page to get updates.';

/** electron-updater's errors carry HTTP details and stacks; people get one sentence. */
function describe(error: Error & { code?: string; statusCode?: number }): string {
  if (error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'The server doesn’t offer updates for this computer yet. Its admin sets them up with ATELIER_UPDATES_REPO.';
  if (error.statusCode === 401) return 'The server didn’t accept your sign-in. Sign in again to get updates.';
  return error.message.split('\n')[0]!;
}

export function createUpdates(options: UpdatesOptions) {
  const { updater, now = Date.now } = options;
  const mac = options.platform === 'darwin';
  const publicKey = options.publicKey || null;
  const swap = mac ? (options.swap ?? null) : null;
  /** The running app bundle, when this Mac can replace it by itself. */
  const bundle = swap && 'bundle' in swap.target ? swap.target.bundle : null;
  /** An unpacked update waiting for Atelier to quit, and whether its swap has been handed to the helper. */
  let staged: string | null = null;
  let swapping = false;
  /** The version downloaded (or staged) and waiting for Atelier to quit; a newer one found meanwhile replaces it. */
  let ready: string | null = null;
  /** The version being signature-checked or downloaded now; checks wait for it. */
  let fetching: string | null = null;
  // Downloads are started here, after the signature check, and only for a version newer than the one that waits.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = !mac;
  // A differential download needs the previous version's blockmap, and the feed only has the newest release.
  updater.disableDifferentialDownload = true;

  let channel = options.channel;
  let automatic = options.automatic ?? true;
  const publicFeed = options.publicFeed?.replace(/\/+$/, '') || null;
  let server: UpdateServer | null = null;
  /** The signed-in server has no updates to offer: the public feed is used instead. */
  let serverOffersNone = false;
  let state: UpdateState = { kind: 'unsupported', reason: NO_FEED };
  let checkedAt: number | null = null;
  /** The update the last check found, for the macOS download. */
  let found: UpdateInfo | null = null;

  const status = (): UpdateStatus => ({ version: options.version, channel, automatic, state, checkedAt });
  const set = (next: UpdateState) => {
    state = next;
    options.onStatus(status());
  };
  /** Where updates are read now: the signed-in server's, else the public one, else nowhere. */
  const feed = (): Feed | null => {
    if (server?.token && !serverOffersNone) return { base: `${server.url}/updates/${channel}`, token: server.token };
    return publicFeed ? { base: `${publicFeed}/${channel}`, token: null } : null;
  };
  const useFeed = () => {
    const f = feed();
    if (!f) return;
    updater.setFeedURL({ provider: 'generic', url: f.base });
    updater.requestHeaders = f.token ? { Authorization: `Bearer ${f.token}` } : null;
  };

  /** A newer download that came to nothing: the update that waits stays offered, else the problem is shown. */
  const fail = (message: string) => set(ready ? { kind: 'downloaded', version: ready } : { kind: 'error', message });

  // While an update waits, checks go on quietly: the notice keeps offering it until a newer one replaces it.
  updater.on('checking-for-update', () => void (ready || set({ kind: 'checking' })));
  updater.on('update-not-available', () => {
    checkedAt = now();
    if (!ready) set({ kind: 'idle' });
  });
  /** Whether every package the update lists has a signature that is ours; the first problem, in words, or null. */
  const unsigned = async (info: UpdateInfo, from: Feed, names?: (url: string) => boolean): Promise<string | null> => {
    if (!publicKey) return null;
    const base = `${from.base}/`;
    for (const file of info.files) {
      if (names && !names(file.url)) continue;
      const url = new URL(file.url, base);
      // Only files of the feed itself: the token goes nowhere else, and a feed cannot send us elsewhere.
      if (!url.href.startsWith(base)) return `Atelier ${info.version} points outside its feed.`;
      try {
        const response = await options.fetch(`${url.href}.sig`, { headers: from.token ? { Authorization: `Bearer ${from.token}` } : {} });
        if (!response.ok) return `Atelier ${info.version} is not signed, so it was not downloaded.`;
        if (!isSigned(publicKey, basename(url.pathname), file.sha512, await response.text())) return `Atelier ${info.version} is not signed with Atelier's key, so it was not downloaded.`;
      } catch {
        return `Couldn’t check the signature of Atelier ${info.version}.`;
      }
    }
    return null;
  };

  /** Downloads `href` to `partial`, reporting whole percents, and checks it against the update file's hash. */
  const fetchTo = async (from: Feed, href: string, partial: string, file: { sha512: string; size?: number }, version: string): Promise<void> => {
    const response = await options.fetch(href, { headers: from.token ? { Authorization: `Bearer ${from.token}` } : {} });
    if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
    const total = Number(response.headers.get('content-length')) || file.size || 0;
    const hash = createHash('sha512');
    const out = await open(partial, 'w');
    try {
      const reader = response.body.getReader();
      let received = 0;
      let shown = 0;
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        hash.update(chunk.value);
        await out.write(chunk.value);
        received += chunk.value.length;
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent > shown) set({ kind: 'downloading', percent: (shown = percent), version });
      }
    } finally {
      await out.close();
    }
    if (hash.digest('base64') !== file.sha512) throw new Error('the file is damaged');
  };

  /** macOS: this Mac's zip, signed, hashed and unpacked beside any staged one, which stays until this one is complete. */
  const stage = async (info: UpdateInfo, from: Feed): Promise<void> => {
    if (!swap || !bundle) return;
    const { version } = info;
    const zip = info.files.find((f) => f.url.endsWith('.zip') && f.url.includes('arm64') === (options.arch === 'arm64'));
    const base = `${from.base}/`;
    const url = zip && new URL(zip.url, base);
    if (!zip || !url?.href.startsWith(base)) return fail(`Atelier ${version} has no update for this Mac.`);
    const partial = join(swap.staging, basename(url.pathname));
    const into = join(swap.staging, version);
    fetching = version;
    try {
      const problem = await unsigned({ ...info, files: [zip] }, from);
      if (problem) return fail(problem);
      set({ kind: 'downloading', percent: 0, version });
      // Leftovers of earlier runs go, but never the update that waits.
      if (!ready) await swap.remove(swap.staging);
      await mkdir(swap.staging, { recursive: true });
      await fetchTo(from, url.href, partial, zip, version);
      const unpacked = await swap.unpack(partial, into);
      await rm(partial, { force: true });
      // The helper already moves the older bundle in: it must stay where it is.
      if (swapping) return;
      const older = ready;
      staged = unpacked;
      ready = version;
      set({ kind: 'downloaded', version });
      if (older && older !== version) await swap.remove(join(swap.staging, older)).catch(() => undefined);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      if (ready) await swap.remove(into).catch(() => undefined);
      else {
        staged = null;
        await swap.remove(swap.staging).catch(() => undefined);
      }
      fail(`Couldn’t download Atelier ${version}: ${(error as Error).message}.`);
    } finally {
      fetching = null;
    }
  };

  /** Windows and Linux: signed, then downloaded by electron-updater, whose installer then replaces the one that waits. */
  const download = async (info: UpdateInfo, from: Feed): Promise<void> => {
    fetching = info.version;
    try {
      const problem = await unsigned(info, from);
      if (problem) return fail(problem);
      set({ kind: 'downloading', percent: 0, version: info.version });
      await updater.downloadUpdate();
    } catch (error) {
      // Usually reported by the `error` event already; a cancelled download has none and must not stay "downloading".
      if (state.kind === 'downloading') {
        ready = null;
        set({ kind: 'error', message: describe(error as Error) });
      }
    } finally {
      fetching = null;
    }
  };

  updater.on('update-available', (info) => {
    // Only a version newer than the one that waits replaces it: the same one is never downloaded twice.
    if (fetching || swapping || (ready && compareVersions(info.version, ready) <= 0)) return;
    found = info;
    const from = feed();
    // A Mac that can replace its own app takes the update by itself; any other Mac offers the disk image.
    const manual = mac && !bundle;
    if (!ready) set({ kind: 'available', version: info.version, ...(manual ? { manual: true } : {}) });
    if (!from || manual) return;
    void (mac ? stage(info, from) : download(info, from));
  });
  updater.on('download-progress', (progress) => set({ kind: 'downloading', percent: Math.floor(progress.percent), version: fetching ?? found?.version ?? '' }));
  updater.on('update-downloaded', (info) => {
    ready = info.version;
    set({ kind: 'downloaded', version: info.version });
  });
  updater.on('error', (error: Error & { code?: string; statusCode?: number }) => {
    // A server that publishes no updates isn't a failure while there is a public feed to ask instead.
    const missing = error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || error.statusCode === 404;
    if (missing && publicFeed && server?.token && !serverOffersNone) {
      serverOffersNone = true;
      useFeed();
      if (!ready) set({ kind: 'idle' });
      void check();
      return;
    }
    // A failed download empties electron-updater's download folder, the installer that waited included.
    if (fetching && !mac) ready = null;
    // A failed check leaves the update that waits as it is.
    if (ready) return;
    // Nothing published to the public feed yet is not a failure: this is the newest there is.
    if (missing && feed()?.token === null) {
      checkedAt = now();
      set({ kind: 'idle' });
      return;
    }
    set({ kind: 'error', message: describe(error) });
  });

  /** Checks the feed. Results and failures arrive as the updater's events. */
  const check = async (): Promise<void> => {
    if (!feed() || fetching || swapping || state.kind === 'downloading') return;
    const result = await updater.checkForUpdates().catch(() => undefined);
    // Unpackaged builds, and Linux packages other than AppImage and deb, don't update.
    if (result === null) set({ kind: 'unsupported', reason: INACTIVE });
  };

  return {
    status,
    check,

    /** The checks at start, after signing in and on the timer: nothing happens while automatic checks are off. */
    async checkAutomatically(): Promise<void> {
      if (automatic) await check();
    },

    async setAutomatic(next: boolean): Promise<void> {
      automatic = next;
      await options.saveAutomatic?.(next);
      options.onStatus(status());
    },

    /** Follows the connection and its sign-in; null in "Run on this computer" mode. */
    setServer(next: UpdateServer | null): void {
      server = next;
      serverOffersNone = false;
      if (!feed()) return set({ kind: 'unsupported', reason: NO_FEED });
      useFeed();
      if (state.kind === 'unsupported') set({ kind: 'idle' });
    },

    async setChannel(next: UpdateChannel): Promise<void> {
      channel = next;
      await options.saveChannel(next);
      useFeed();
      options.onStatus(status());
      await check();
    },

    /** macOS without a replaceable app: saves the disk image for this Mac's architecture to Downloads (checked against the feed's hash) and shows it. */
    async download(): Promise<void> {
      const from = feed();
      if (!mac || state.kind !== 'available' || !found || !from) return;
      const { version } = found;
      const image = found.files.find((f) => f.url.endsWith('.dmg') && f.url.includes('arm64') === (options.arch === 'arm64'));
      const base = `${from.base}/`;
      const url = image && new URL(image.url, base);
      // The token only ever goes to the feed.
      if (!image || !url?.href.startsWith(base)) return set({ kind: 'error', message: `Atelier ${version} has no disk image for this Mac.` });
      const problem = await unsigned({ ...found, files: [image] }, from);
      if (problem) return set({ kind: 'error', message: problem });
      const target = join(options.downloads, basename(url.pathname));
      const partial = `${target}.download`;
      set({ kind: 'downloading', percent: 0, version });
      try {
        await fetchTo(from, url.href, partial, image, version);
        await rename(partial, target);
        set({ kind: 'saved', version });
        options.reveal(target);
      } catch (error) {
        await rm(partial, { force: true });
        set({ kind: 'error', message: `Couldn’t download Atelier ${version}: ${(error as Error).message}.` });
      }
    },

    /** Quits and installs the downloaded update, then starts the new version. */
    install(): void {
      if (state.kind !== 'downloaded') return;
      if (!mac) return updater.quitAndInstall(true, true);
      if (!staged || !bundle || swapping) return;
      swapping = true;
      swap!.replaceAfterQuit(staged, bundle, true);
      options.quit?.();
    },

    /** macOS: the app is quitting by itself with an update ready: the swap happens now and the next start is the new one. */
    installOnQuit(): void {
      if (!mac || !staged || !bundle || swapping) return;
      swapping = true;
      swap!.replaceAfterQuit(staged, bundle, false);
    },
  };
}
