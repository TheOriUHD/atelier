/**
 * Spacing and concurrency for requests to the open web. Each family (one backend, one rate limit) gets its own
 * minimum gap with a little jitter; a few requests at most are in flight overall. Queued calls wait their turn in
 * the order they came and leave the queue when their signal aborts.
 */
export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => (signal.removeEventListener('abort', onAbort), resolve()), ms);
      const onAbort = () => (clearTimeout(timer), reject(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

export class Limiter {
  private readonly nextAt = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly maxInFlight = 2,
  ) {}

  /** How long a request to the family would wait for its turn right now. */
  waitFor(family: string): number {
    return Math.max(0, (this.nextAt.get(family) ?? 0) - this.clock.now());
  }

  /** Runs `fn` once the family's gap has passed and a slot is free. */
  async run<T>(family: string, gapMs: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const start = Math.max(now, this.nextAt.get(family) ?? 0);
    // Reserved at once, so calls queued behind this one are spaced from it, not from the same instant.
    this.nextAt.set(family, start + gapMs + Math.round(this.clock.random() * gapMs * 0.35));
    if (start > now) await this.clock.sleep(start - now, signal);
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.maxInFlight) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      const grant = () => (signal.removeEventListener('abort', onAbort), resolve());
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
