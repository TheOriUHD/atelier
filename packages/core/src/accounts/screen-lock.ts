/**
 * The optional screen lock of the desktop app's own backend (ARCHITECTURE §21). One per installation: the PIN or
 * password is kept only as a scrypt hash in `screen-lock.json` next to the database, and every connection is refused
 * all but unlocking while it is locked. It hides the app; it encrypts nothing.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AutoLockMinutes, NewScreenLock, ScreenLockKind, type ScreenLockStatus } from '@atelier/protocol';
import { hashPassword, verifyPassword } from './passwords.ts';

/** Wrong tries allowed before each further one makes the next wait. */
export const FREE_ATTEMPTS = 5;
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;

export class ScreenLockError extends Error {
  constructor(
    readonly code: 'wrong_secret' | 'rate_limited' | 'not_set' | 'invalid_lock',
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

const LockFile = z.object({
  version: z.literal(1),
  kind: ScreenLockKind,
  hash: z.string(),
  autoLockMinutes: AutoLockMinutes.catch(0),
  failures: z.number().int().min(0).catch(0),
  retryAt: z.number().nullable().catch(null),
});
type LockFile = z.infer<typeof LockFile>;

/** How long the next try waits after `failures` wrong ones in a row: nothing for the first few, then doubling. */
export function lockDelay(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(FIRST_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

export class ScreenLock {
  private state: LockFile | null = null;
  /** Locked at start whenever a lock is set; a fresh backend is a fresh launch. */
  private isLocked = false;
  /** One check at a time, so parallel guesses can't skip the delay. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the file again; a removed file (the documented way out of a forgotten PIN) turns the lock off. */
  async load(): Promise<void> {
    const text = await readFile(this.file, 'utf8').catch(() => null);
    const parsed = text === null ? null : LockFile.safeParse(safeJson(text));
    const wasSet = this.state !== null;
    this.state = parsed?.success ? parsed.data : null;
    if (!this.state) this.isLocked = false;
    else if (!wasSet) this.isLocked = true;
  }

  get locked(): boolean {
    return this.isLocked;
  }

  status(): ScreenLockStatus {
    const s = this.state;
    return {
      enabled: s !== null,
      kind: s?.kind ?? null,
      autoLockMinutes: s?.autoLockMinutes ?? 0,
      locked: this.isLocked,
      retryAt: s?.retryAt && s.retryAt > this.now() ? s.retryAt : null,
    };
  }

  lock(): ScreenLockStatus {
    if (this.state) this.isLocked = true;
    return this.status();
  }

  unlock(secret: string): Promise<ScreenLockStatus> {
    return this.serial(async () => {
      await this.load();
      if (!this.state) return this.status();
      await this.check(secret);
      this.isLocked = false;
      return this.status();
    });
  }

  /** Sets or replaces the PIN or password. Replacing it needs the current one, with the same limits as unlocking. */
  set(lock: { kind: 'pin' | 'password'; secret: string }, current: string | undefined): Promise<ScreenLockStatus> {
    return this.serial(async () => {
      const parsed = NewScreenLock.safeParse(lock);
      if (!parsed.success)
        throw new ScreenLockError(
          'invalid_lock',
          parsed.error.issues[0]?.message ?? 'That PIN or password can’t be used.',
        );
      await this.load();
      if (this.state) await this.check(current ?? '');
      await this.save({
        version: 1,
        kind: parsed.data.kind,
        hash: await hashPassword(parsed.data.secret),
        autoLockMinutes: this.state?.autoLockMinutes ?? 0,
        failures: 0,
        retryAt: null,
      });
      return this.status();
    });
  }

  /** Turns the lock off; needs the current PIN or password. */
  clear(current: string): Promise<ScreenLockStatus> {
    return this.serial(async () => {
      await this.load();
      if (!this.state) return this.status();
      await this.check(current);
      await this.remove();
      return this.status();
    });
  }

  /** Turns the lock off without the PIN, for a caller that verified the person another way (the OS account). */
  removeTrusted(): Promise<ScreenLockStatus> {
    return this.serial(async () => {
      await this.remove();
      return this.status();
    });
  }

  setAutoLock(minutes: AutoLockMinutes): Promise<ScreenLockStatus> {
    return this.serial(async () => {
      await this.load();
      if (!this.state) throw new ScreenLockError('not_set', 'Set a PIN or password first.');
      await this.save({ ...this.state, autoLockMinutes: minutes });
      return this.status();
    });
  }

  private async check(secret: string): Promise<void> {
    const s = this.state!;
    const now = this.now();
    if (s.retryAt && s.retryAt > now)
      throw new ScreenLockError('rate_limited', 'Too many wrong tries. Wait a moment, then try again.', s.retryAt);
    if (await verifyPassword(secret, s.hash)) {
      if (s.failures || s.retryAt) await this.save({ ...s, failures: 0, retryAt: null });
      return;
    }
    const failures = s.failures + 1;
    const delay = lockDelay(failures);
    const retryAt = delay ? this.now() + delay : null;
    // Kept on disk, so quitting the app doesn't reset the count.
    await this.save({ ...s, failures, retryAt });
    throw new ScreenLockError(
      'wrong_secret',
      s.kind === 'pin' ? 'That PIN is wrong.' : 'That password is wrong.',
      retryAt,
    );
  }

  private async save(next: LockFile): Promise<void> {
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    this.state = next;
  }

  private async remove(): Promise<void> {
    await rm(this.file, { force: true });
    this.state = null;
    this.isLocked = false;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
