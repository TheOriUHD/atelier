import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockDelay, ScreenLock, type ScreenLockError } from './screen-lock.ts';

let dir: string;
let file: string;
let now: number;
const clock = () => now;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-lock-'));
  file = join(dir, 'screen-lock.json');
  now = 1_000_000;
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ScreenLockError) => ({ code: e.code, retryAt: e.retryAt }),
  );

describe('screen lock', () => {
  it('is off until a PIN is set, keeps only a scrypt hash, and starts locked on the next launch', async () => {
    const lock = new ScreenLock(file, clock);
    await lock.load();
    expect(lock.status()).toEqual({ enabled: false, kind: null, autoLockMinutes: 0, locked: false, retryAt: null });

    expect(await lock.set({ kind: 'pin', secret: '2468' }, undefined)).toMatchObject({
      enabled: true,
      kind: 'pin',
      locked: false,
    });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('2468');
    expect(JSON.parse(text).hash).toMatch(/^scrypt\$/);
    // Windows has no Unix permission bits (Node reports 0666 there); the owner-only mode is checked where it exists.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    const relaunched = new ScreenLock(file, clock);
    await relaunched.load();
    expect(relaunched.locked).toBe(true);
    expect(await failure(relaunched.unlock('1357'))).toEqual({ code: 'wrong_secret', retryAt: null });
    expect(relaunched.locked).toBe(true);
    expect(await relaunched.unlock('2468')).toMatchObject({ locked: false });
  });

  it('accepts 4–8 digit PINs and passwords of 6 or more characters', async () => {
    const lock = new ScreenLock(file, clock);
    await lock.load();
    expect((await failure(lock.set({ kind: 'pin', secret: '123' }, undefined)))?.code).toBe('invalid_lock');
    expect((await failure(lock.set({ kind: 'pin', secret: '123456789' }, undefined)))?.code).toBe('invalid_lock');
    expect((await failure(lock.set({ kind: 'pin', secret: '12a4' }, undefined)))?.code).toBe('invalid_lock');
    expect((await failure(lock.set({ kind: 'password', secret: 'short' }, undefined)))?.code).toBe('invalid_lock');
    expect(await lock.set({ kind: 'password', secret: 'open sesame' }, undefined)).toMatchObject({ kind: 'password' });
  });

  it('changes and clears only with the current secret', async () => {
    const lock = new ScreenLock(file, clock);
    await lock.load();
    await lock.set({ kind: 'pin', secret: '2468' }, undefined);
    expect((await failure(lock.set({ kind: 'pin', secret: '1111' }, undefined)))?.code).toBe('wrong_secret');
    expect((await failure(lock.set({ kind: 'pin', secret: '1111' }, '0000')))?.code).toBe('wrong_secret');
    await lock.set({ kind: 'password', secret: 'new secret' }, '2468');
    expect(await lock.setAutoLock(15)).toMatchObject({ autoLockMinutes: 15 });
    expect((await failure(lock.clear('2468')))?.code).toBe('wrong_secret');
    expect(await lock.clear('new secret')).toMatchObject({ enabled: false, locked: false });
    await expect(stat(file)).rejects.toThrow();
  });

  it('makes each try after five wrong ones wait longer, across launches', async () => {
    expect([4, 5, 6, 7].map(lockDelay)).toEqual([0, 30_000, 60_000, 120_000]);
    expect(lockDelay(40)).toBe(3_600_000);

    const lock = new ScreenLock(file, clock);
    await lock.load();
    await lock.set({ kind: 'pin', secret: '2468' }, undefined);
    lock.lock();
    for (let i = 0; i < 4; i++)
      expect(await failure(lock.unlock('0000'))).toEqual({ code: 'wrong_secret', retryAt: null });
    expect(await failure(lock.unlock('0000'))).toEqual({ code: 'wrong_secret', retryAt: now + 30_000 });

    // The right PIN is refused too until the wait is over, and so is a relaunched app.
    expect(await failure(lock.unlock('2468'))).toEqual({ code: 'rate_limited', retryAt: now + 30_000 });
    const relaunched = new ScreenLock(file, clock);
    await relaunched.load();
    expect(relaunched.status().retryAt).toBe(now + 30_000);
    expect((await failure(relaunched.unlock('2468')))?.code).toBe('rate_limited');

    now += 30_000;
    expect(await failure(relaunched.unlock('0000'))).toEqual({ code: 'wrong_secret', retryAt: now + 60_000 });
    now += 60_000;
    expect(await relaunched.unlock('2468')).toMatchObject({ locked: false, retryAt: null });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ failures: 0, retryAt: null });
  });

  it('turns off when its file is deleted, the way out of a forgotten PIN', async () => {
    const lock = new ScreenLock(file, clock);
    await lock.load();
    await lock.set({ kind: 'pin', secret: '2468' }, undefined);
    lock.lock();
    await rm(file);
    await lock.load();
    expect(lock.status()).toMatchObject({ enabled: false, locked: false });
  });

  it('is removed without the PIN by a caller that checked the OS account', async () => {
    const lock = new ScreenLock(file, clock);
    await lock.load();
    await lock.set({ kind: 'pin', secret: '2468' }, undefined);
    lock.lock();
    expect(await lock.removeTrusted()).toMatchObject({ enabled: false, locked: false });
  });
});
