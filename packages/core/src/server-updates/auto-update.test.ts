import { describe, expect, it, vi } from 'vitest';
import type { ServerUpdateJob } from '@atelier/protocol';
import { AutoUpdate, type AutoUpdateSource } from './auto-update.ts';

const idleJob = (extra: Partial<ServerUpdateJob> = {}): ServerUpdateJob => ({ state: 'idle', message: null, startedAt: null, finishedAt: null, progress: null, pulledAt: null, ...extra });

/** An updater and a feed that the test moves along by hand. */
function setup(options: { enabled?: boolean; ahead?: boolean; latest?: string | null; busy?: { turns: number; background: number }; source?: boolean } = {}) {
  const state = {
    enabled: options.enabled ?? true,
    latest: options.latest === undefined ? '0.10.6' : options.latest,
    ahead: options.ahead ?? true,
    job: idleJob(),
    busy: options.busy ?? { turns: 0, background: 0 },
    now: 1_000_000,
    holds: [] as boolean[],
    announced: [] as { installing: boolean; version: string | null }[],
    pulls: 0,
    installs: [] as boolean[],
    pullAnswer: 'started' as 'started' | 'running' | 'unsupported',
    installError: null as Error | null,
    updaterError: undefined as string | null | undefined,
    source: options.source ?? false,
  };
  const source: AutoUpdateSource = {
    version: '0.10.5',
    refreshLatest: async () => state.latest,
    updaterState: async () => (state.updaterError !== undefined ? { ok: false, error: state.updaterError } : { ok: true, job: state.job, downloadsAhead: state.ahead, source: state.source }),
    pull: async () => {
      state.pulls++;
      if (state.pullAnswer === 'started') state.job = idleJob({ state: 'pulling', startedAt: state.now });
      return state.pullAnswer;
    },
    install: async (pulled) => {
      state.installs.push(pulled);
      if (state.installError) throw state.installError;
      state.job = idleJob({ state: 'restarting', startedAt: state.now });
    },
  };
  const auto = new AutoUpdate({
    source,
    enabled: () => state.enabled,
    activity: () => state.busy,
    hold: (on) => state.holds.push(on),
    announce: (event) => state.announced.push(event),
    now: () => state.now,
    intervalMs: 60_000,
    quietMs: 3_000,
    installTimeoutMs: 120_000,
  });
  /** Time passes, then it looks. */
  const look = async (ms = 3_000) => {
    state.now += ms;
    await auto.tick();
  };
  /** The updater finished downloading. */
  const downloaded = () => (state.job = idleJob({ pulledAt: state.now }));
  return { auto, state, look, downloaded };
}

describe('automatic server updates', () => {
  it('does nothing while the setting is off', async () => {
    const { auto, state, look } = setup({ enabled: false });
    await look();
    expect(state.pulls).toBe(0);
    expect(auto.snapshot()).toMatchObject({ enabled: false, state: 'idle', version: null });
  });

  it('stays idle when the server runs the newest version', async () => {
    const { auto, state, look } = setup({ latest: '0.10.5' });
    await look();
    expect(state.pulls).toBe(0);
    expect(auto.snapshot()).toMatchObject({ enabled: true, state: 'idle', version: null });
  });

  it('downloads a newer version at once, and installs it at once when nothing runs', async () => {
    const { auto, state, look, downloaded } = setup();
    await look();
    expect(state.pulls).toBe(1);
    expect(auto.snapshot()).toMatchObject({ state: 'downloading', version: '0.10.6' });
    // The download is under way: nothing is asked twice.
    state.job = idleJob({ state: 'pulling' });
    await look();
    expect(state.pulls).toBe(1);
    downloaded();
    await look();
    // Down, and the server has been quiet for the moment it takes to be sure: the install starts.
    expect(auto.snapshot().state).toBe('waiting');
    await look();
    expect(state.installs).toEqual([true]);
    expect(auto.snapshot().state).toBe('installing');
    expect(state.holds).toEqual([true]);
    expect(state.announced).toEqual([{ installing: true, version: '0.10.6' }]);
  });

  it('waits while a turn or a background command runs, and says what it waits for', async () => {
    const { auto, state, look, downloaded } = setup({ busy: { turns: 2, background: 1 } });
    await look();
    downloaded();
    for (let i = 0; i < 5; i++) await look(10_000);
    expect(state.installs).toEqual([]);
    expect(auto.snapshot()).toMatchObject({ state: 'waiting', waitingFor: { turns: 2, background: 1 } });
    // Nothing is held back from the people who use the server meanwhile.
    expect(state.holds).toEqual([]);
    state.busy = { turns: 0, background: 0 };
    await look();
    expect(state.installs).toEqual([]);
    await look();
    expect(state.installs).toEqual([true]);
  });

  it('gives up the install when a turn started in the very moment before it, and tries again', async () => {
    const { auto, state, look, downloaded } = setup();
    await look();
    downloaded();
    await look();
    // The check before the hold said quiet; by the time the hold is on, a turn has started.
    const activity = vi.fn().mockReturnValueOnce({ turns: 0, background: 0 }).mockReturnValueOnce({ turns: 1, background: 0 });
    (auto as unknown as { options: { activity: typeof activity } }).options.activity = activity;
    await look();
    expect(state.installs).toEqual([]);
    expect(state.holds).toEqual([true, false]);
    expect(auto.snapshot()).toMatchObject({ state: 'waiting', waitingFor: { turns: 1, background: 0 } });
  });

  it('with an updater from before downloading ahead, installs when quiet and lets the updater download then', async () => {
    const { auto, state, look } = setup({ ahead: false });
    await look();
    expect(state.pulls).toBe(0);
    expect(auto.snapshot()).toMatchObject({ state: 'waiting', downloadsAhead: false });
    await look();
    expect(state.installs).toEqual([false]);
  });

  it('falls back to the one-step update when the updater says it has no pull', async () => {
    const { auto, state, look } = setup({ ahead: true });
    state.pullAnswer = 'unsupported';
    await look();
    expect(auto.snapshot()).toMatchObject({ state: 'waiting', downloadsAhead: false });
    await look();
    expect(state.installs).toEqual([false]);
  });

  it('asks for the newer download when an even newer version comes out meanwhile', async () => {
    const { auto, state, look, downloaded } = setup({ busy: { turns: 1, background: 0 } });
    await look();
    downloaded();
    await look();
    expect(state.pulls).toBe(1);
    state.latest = '0.10.7';
    await look(61_000);
    expect(state.pulls).toBe(2);
    expect(auto.snapshot()).toMatchObject({ state: 'downloading', version: '0.10.7' });
  });

  it('releases the hold, says so and pauses when the updater fails the install', async () => {
    const { auto, state, look, downloaded } = setup();
    await look();
    downloaded();
    await look();
    state.job = idleJob({ pulledAt: state.now });
    state.installError = new Error('The updater answered 500.');
    await look();
    expect(state.holds).toEqual([true, false]);
    expect(state.announced).toEqual([{ installing: true, version: '0.10.6' }, { installing: false, version: '0.10.6' }]);
    expect(auto.snapshot()).toMatchObject({ state: 'failed', error: 'The updater answered 500.' });
    expect(auto.snapshot().retryAt).toBe(state.now + 5 * 60_000);
    // Nothing is tried inside the pause, and the next try downloads again.
    state.installError = null;
    await look(60_000);
    expect(state.pulls).toBe(1);
    await look(5 * 60_000);
    expect(state.pulls).toBe(2);
  });

  it('notices an install that the updater failed after it accepted it, and one that never restarted the server', async () => {
    const a = setup();
    await a.look();
    a.downloaded();
    await a.look();
    await a.look();
    expect(a.auto.snapshot().state).toBe('installing');
    a.state.job = idleJob({ state: 'failed', message: 'port is already allocated' });
    await a.look();
    expect(a.auto.snapshot()).toMatchObject({ state: 'failed', error: 'port is already allocated' });
    expect(a.state.holds.at(-1)).toBe(false);

    const b = setup();
    await b.look();
    b.downloaded();
    await b.look();
    await b.look();
    expect(b.auto.snapshot().state).toBe('installing');
    await b.look(130_000);
    expect(b.auto.snapshot()).toMatchObject({ state: 'failed', error: 'The update did not restart the server.' });
    expect(b.state.holds.at(-1)).toBe(false);
  });

  it('holds new turns off when the admin’s button started the update', async () => {
    const { auto, state, look } = setup();
    state.job = idleJob({ state: 'restarting' });
    await look();
    expect(auto.snapshot().state).toBe('installing');
    expect(state.holds).toEqual([true]);
    expect(state.announced).toEqual([{ installing: true, version: '0.10.6' }]);
  });

  it('holds and watches an update the admin started by hand, also with the setting off, and lets turns start again when it fails', async () => {
    const { auto, state, look } = setup({ enabled: false });
    auto.adopt('0.10.6');
    expect(state.holds).toEqual([true]);
    expect(state.announced).toEqual([{ installing: true, version: '0.10.6' }]);
    expect(auto.snapshot()).toMatchObject({ enabled: false, state: 'installing' });
    state.job = idleJob({ state: 'failed', message: 'manifest unknown' });
    await look();
    expect(state.holds).toEqual([true, false]);
    expect(state.announced.at(-1)).toEqual({ installing: false, version: '0.10.6' });
    await look();
    expect(auto.snapshot().state).toBe('idle');
  });

  it('lets turns start again when the update the admin asked for did not start', () => {
    const { auto, state } = setup({ enabled: false });
    auto.adopt(null);
    auto.abandon();
    expect(state.holds).toEqual([true, false]);
    expect(state.announced).toEqual([{ installing: true, version: null }, { installing: false, version: null }]);
    expect(auto.snapshot().state).toBe('idle');
  });

  it('leaves a server without an updater, or built from source, alone', async () => {
    const none = setup();
    none.state.updaterError = null;
    await none.look();
    expect(none.auto.snapshot().state).toBe('idle');
    const source = setup({ source: true });
    await source.look();
    expect(source.auto.snapshot().state).toBe('idle');
    expect(source.state.pulls).toBe(0);
  });

  it('forgets everything when the setting goes off, and starts again when it is back on', async () => {
    const { auto, state, look } = setup();
    await look();
    expect(auto.snapshot().state).toBe('downloading');
    state.enabled = false;
    await look();
    expect(auto.snapshot()).toMatchObject({ enabled: false, state: 'idle', version: null });
    state.enabled = true;
    await look();
    expect(auto.snapshot().state).toBe('downloading');
  });

  it('does not install the same version again when the server came back on the old one', async () => {
    let saved: { target: string; at: number } | null = null;
    const memory = { load: async () => saved, save: async (v: typeof saved) => void (saved = v) };
    const a = setup();
    (a.auto as unknown as { options: { memory: typeof memory } }).options.memory = memory;
    await a.look();
    a.downloaded();
    await a.look();
    await a.look();
    expect(a.state.installs).toEqual([true]);
    expect(saved).toMatchObject({ target: '0.10.6' });
    // The server restarted into the same version it had (a pinned image tag): a new process finds that out and leaves it be.
    const b = setup();
    (b.auto as unknown as { options: { memory: typeof memory } }).options.memory = memory;
    saved = { target: '0.10.6', at: b.state.now };
    await b.look();
    expect(b.state.pulls).toBe(0);
    expect(b.auto.snapshot()).toMatchObject({ state: 'failed', error: expect.stringContaining('still runs 0.10.5') });
    // A still newer version is another matter.
    b.state.latest = '0.10.7';
    await b.look(25 * 60 * 60_000);
    expect(b.state.pulls).toBe(1);
  });

  it('forgets an install once the server runs the version it was for', async () => {
    let saved: { target: string; at: number } | null = { target: '0.10.5', at: 1 };
    const memory = { load: async () => saved, save: async (v: typeof saved) => void (saved = v) };
    const a = setup();
    (a.auto as unknown as { options: { memory: typeof memory } }).options.memory = memory;
    a.state.latest = '0.10.6';
    await a.look();
    expect(saved).toBeNull();
    expect(a.state.pulls).toBe(1);
  });

  it('checks the feed every minute by itself', async () => {
    vi.useFakeTimers();
    try {
      const { auto, state } = setup();
      auto.start(100);
      await vi.advanceTimersByTimeAsync(150);
      expect(state.pulls).toBe(1);
      auto.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(state.pulls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
