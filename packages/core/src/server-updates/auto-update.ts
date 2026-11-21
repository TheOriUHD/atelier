/**
 * Automatic updates of a server in Docker (Settings › Admin › Server › Update automatically; off unless an admin turns
 * it on). Every minute it asks the feed for the newest version. A newer one is downloaded at once, in the background, by
 * the updater service, and installed as soon as nothing runs on the server: no turn being written, no sub-agent or
 * command running in the background. A busy session is never cut off; the install waits and looks again every few
 * seconds, so it happens within seconds of the last thing finishing. From the moment the install starts until the server
 * restarts, a turn that tries to start is refused with the `updating` error, which the apps show as a calm note.
 * Nothing asks the admin: turning the setting on is the question.
 */
import { compareVersions, type ServerAutoUpdate } from '@atelier/protocol';
import type { ServerUpdates } from './server-updates.ts';

/** What the automatic update needs of the server's own update module. */
export type AutoUpdateSource = Pick<ServerUpdates, 'version' | 'refreshLatest' | 'updaterState' | 'pull' | 'install'>;

export interface AutoUpdateOptions {
  source: AutoUpdateSource;
  /** The setting, read on every step: turning it off stops everything at once. */
  enabled(): boolean;
  /** What a restart would cut off right now. */
  activity(): { turns: number; background: number };
  /** Turns the refusal of new turns on or off. */
  hold(on: boolean): void;
  /** Tells the connected apps the server is about to restart into the new version (or that it won't). */
  announce(event: { installing: boolean; version: string | null }): void;
  /** How often the feed is asked (a minute). */
  intervalMs?: number;
  /** How often it looks again while a download or the wait for a quiet server is under way. */
  watchMs?: number;
  /** How long nothing must have run before the install starts: a message waiting for a turn just ended starts it at once. */
  quietMs?: number;
  /** An install that hasn't restarted the server after this long failed. */
  installTimeoutMs?: number;
  /**
   * Remembers across the restart which version an install was for. A server that comes back still on the old version
   * (its compose file pins an image tag, say) must not install again every minute for ever.
   */
  memory?: { load(): Promise<{ target: string; at: number } | null>; save(value: { target: string; at: number } | null): Promise<void> };
  now?: () => number;
  log?: (message: string) => void;
}

const INTERVAL_MS = 60_000;
const WATCH_MS = 3_000;
const QUIET_MS = 3_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** An install that left the server on the old version is not tried again for this long. */
const UNCHANGED_PAUSE_MS = 24 * 60 * 60_000;
/** After a failure: five minutes, a quarter of an hour, then an hour. */
const PAUSES_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export class AutoUpdate {
  private state: ServerAutoUpdate['state'] = 'idle';
  private target: string | null = null;
  /** The version a download was asked for, so that a finished download is known to be this one's. */
  private pullFor: string | null = null;
  private pulled = false;
  private downloadsAhead = false;
  private error: string | null = null;
  private retryAt: number | null = null;
  private failures = 0;
  private checkedAt = 0;
  private quietSince: number | null = null;
  private installingSince = 0;
  private waitingFor: ServerAutoUpdate['waitingFor'] = null;
  private holding = false;
  /** The last install: undefined until read from `memory`. */
  private tried: { target: string; at: number } | null | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly options: AutoUpdateOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Starts looking: first a few seconds after the server booted, then every minute. */
  start(firstAfterMs = 10_000): void {
    this.stopped = false;
    this.schedule(firstAfterMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The setting changed: look now. */
  poke(): void {
    if (this.stopped) return;
    this.checkedAt = 0;
    this.schedule(0);
  }

  /**
   * An update the admin started by hand (Update now): held and watched like an automatic one, so that new turns get the
   * `updating` notice meanwhile, and a failure (or a server that never restarts) lets them start again.
   */
  adopt(version: string | null): void {
    this.target ??= version;
    this.beginInstall(version);
    this.schedule();
  }

  /** The update the admin asked for did not start. */
  abandon(): void {
    this.release();
    if (this.state === 'installing') this.options.announce({ installing: false, version: this.target });
    this.state = 'idle';
  }

  snapshot(): ServerAutoUpdate {
    return {
      enabled: this.options.enabled(),
      state: this.state,
      version: this.target,
      waitingFor: this.state === 'waiting' ? this.waitingFor : null,
      error: this.error,
      retryAt: this.state === 'failed' ? this.retryAt : null,
      downloadsAhead: this.downloadsAhead,
    };
  }

  private schedule(afterMs?: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const watching = this.state === 'downloading' || this.state === 'waiting' || this.state === 'installing';
    this.timer = setTimeout(() => void this.tick(), afterMs ?? (watching ? (this.options.watchMs ?? WATCH_MS) : (this.options.intervalMs ?? INTERVAL_MS)));
    this.timer.unref?.();
  }

  /** One look: for tests, and what the timer runs. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.step();
    } catch (e) {
      this.fail(e);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async step(): Promise<void> {
    const { source } = this.options;
    // An install under way is watched whatever the setting says: one the admin started by hand ends the same way.
    if (this.state === 'installing') return this.watchInstall();
    if (!this.options.enabled()) return this.reset();
    const now = this.now();
    if (this.retryAt !== null) {
      if (now < this.retryAt) return;
      this.retryAt = null;
      this.error = null;
      this.state = 'idle';
    }

    if (now - this.checkedAt >= (this.options.intervalMs ?? INTERVAL_MS) || !this.target) {
      this.checkedAt = now;
      const latest = await source.refreshLatest();
      if (latest && compareVersions(latest, source.version) <= 0) return this.reset(true);
      if (latest && latest !== this.target) {
        this.target = latest;
        this.pullFor = null;
        this.pulled = false;
        this.failures = 0;
      }
    }
    if (!this.target) return void (this.state = 'idle');

    // An install of this very version already restarted the server, and it is still on the old one: nothing would change.
    this.tried ??= (await this.options.memory?.load().catch(() => null)) ?? null;
    if (this.tried && compareVersions(source.version, this.tried.target) >= 0) {
      this.tried = null;
      await this.options.memory?.save(null).catch(() => undefined);
    }
    if (this.tried && this.tried.target === this.target && now - this.tried.at < UNCHANGED_PAUSE_MS) {
      this.state = 'failed';
      this.error = `Atelier ${this.target} was installed, but this server still runs ${source.version}. Its compose file may pin an image version: use the :latest tag, or update it by hand.`;
      this.retryAt = this.tried.at + UNCHANGED_PAUSE_MS;
      return;
    }

    const updater = await source.updaterState();
    // No updater service (updated by hand) or a server built from source: nothing here can install it.
    if (!updater.ok) {
      if (updater.error === null) return this.reset(true);
      throw new Error(updater.error);
    }
    if (updater.source) return this.reset(true);
    this.downloadsAhead = updater.downloadsAhead;
    if (updater.job.state === 'restarting') {
      // Started elsewhere (the admin's button): the server is about to restart, so nothing new may start now either.
      this.beginInstall(this.target);
      return;
    }

    if (updater.downloadsAhead) {
      if (updater.job.state === 'failed' && this.pullFor === this.target) throw new Error(updater.job.message ?? 'The download failed.');
      if (this.pullFor !== this.target) {
        if ((await source.pull()) === 'unsupported') this.downloadsAhead = false;
        else {
          this.pullFor = this.target;
          this.pulled = false;
          this.state = 'downloading';
          this.options.log?.(`Atelier ${this.target} is out: downloading it.`);
          return;
        }
      } else if (updater.job.state === 'pulling') {
        this.state = 'downloading';
        return;
      } else if (updater.job.state === 'idle' && updater.job.pulledAt !== null) {
        this.pulled = true;
      } else {
        // The updater forgot the download (it restarted): ask again.
        this.pullFor = null;
        this.state = 'downloading';
        return;
      }
    }

    // Down (or an updater that downloads as it installs): the install waits for a quiet server.
    this.state = 'waiting';
    const activity = this.options.activity();
    if (activity.turns + activity.background > 0) {
      this.waitingFor = activity;
      this.quietSince = null;
      return;
    }
    this.waitingFor = null;
    this.quietSince ??= now;
    if (now - this.quietSince < (this.options.quietMs ?? QUIET_MS)) return;
    await this.install();
  }

  private async install(): Promise<void> {
    // The hold first, then the look at what runs: from here no turn can start, so what the look finds is final.
    this.options.hold(true);
    this.holding = true;
    const activity = this.options.activity();
    if (activity.turns + activity.background > 0) {
      this.release();
      this.quietSince = null;
      this.waitingFor = activity;
      return;
    }
    this.beginInstall(this.target!);
    try {
      this.tried = { target: this.target!, at: this.now() };
      await this.options.memory?.save(this.tried).catch(() => undefined);
      await this.options.source.install(this.pulled);
    } catch (e) {
      this.fail(e);
    }
  }

  private beginInstall(version: string | null): void {
    if (!this.holding) {
      this.options.hold(true);
      this.holding = true;
    }
    this.state = 'installing';
    this.installingSince = this.now();
    this.options.log?.(`Installing ${version ? `Atelier ${version}` : 'an update'}: the server restarts in a moment.`);
    this.options.announce({ installing: true, version });
  }

  /** While the install runs: the updater may have failed, or the server may not have restarted at all. */
  private async watchInstall(): Promise<void> {
    const updater = await this.options.source.updaterState();
    if (updater.ok && updater.job.state === 'failed') throw new Error(updater.job.message ?? 'The update failed.');
    if (this.now() - this.installingSince > (this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS)) throw new Error('The update did not restart the server.');
  }

  private release(): void {
    if (!this.holding) return;
    this.holding = false;
    this.options.hold(false);
  }

  private fail(e: unknown): void {
    const was = this.state;
    // The install didn't happen (or failed before the restart): this isn't the "still on the old version" case.
    if (was === 'installing' && this.tried) {
      this.tried = null;
      void this.options.memory?.save(null).catch(() => undefined);
    }
    this.release();
    if (was === 'installing') this.options.announce({ installing: false, version: this.target });
    this.error = e instanceof Error ? e.message : String(e);
    this.state = 'failed';
    this.pullFor = null;
    this.pulled = false;
    const pause = PAUSES_MS[Math.min(this.failures, PAUSES_MS.length - 1)]!;
    this.failures++;
    this.retryAt = this.now() + pause;
    this.options.log?.(`Automatic update failed: ${this.error}. Trying again in ${Math.round(pause / 60_000)} minutes.`);
  }

  /** Nothing to do (off, up to date, or not installable here); `upToDate` also forgets the version it was working on. */
  private reset(upToDate = false): void {
    this.release();
    this.state = 'idle';
    this.error = null;
    this.retryAt = null;
    this.waitingFor = null;
    this.quietSince = null;
    if (!this.options.enabled() || upToDate) {
      this.target = null;
      this.pullFor = null;
      this.pulled = false;
      this.failures = 0;
    }
  }
}
