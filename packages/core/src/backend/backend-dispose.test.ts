import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from './backend.ts';

// Closing a real chokidar watcher over a person's many (symlinked) skills blocks the process for seconds; the fake counts.
const watchers = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock('chokidar', () => ({
  watch: () => {
    watchers.opened++;
    const watcher = {
      on: () => watcher,
      add: () => watcher,
      unwatch: () => watcher,
      close: async () => {
        watchers.closed++;
      },
    };
    return watcher;
  },
}));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-dispose-'));
  watchers.opened = 0;
  watchers.closed = 0;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const start = () =>
  createBackend({ surface: 'web', configDir: dir, dataDir: dir, cipher: { encrypt: async (s) => s, decrypt: async (s) => s }, env: {}, logger: { info: () => {}, error: () => {} }, fetch: () => Promise.reject(new Error('offline')) });

describe('dispose', () => {
  it('closes every file watcher when the backend stops but the process goes on', async () => {
    const backend = await start();
    expect(watchers.opened).toBeGreaterThan(0);
    await backend.dispose();
    expect(watchers.closed).toBe(watchers.opened);
  });

  it('leaves the file watchers to a process that is exiting, so stopping is not held up by closing them', async () => {
    const backend = await start();
    expect(watchers.opened).toBeGreaterThan(0);
    await backend.dispose({ exiting: true });
    expect(watchers.closed).toBe(0);
  });
});
