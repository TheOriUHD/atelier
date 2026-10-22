/**
 * Per-family health. A block opens the breaker for two minutes, doubling up to twenty; after that one request is let
 * through (half-open) and its outcome closes or re-opens it. Pages that look empty count as strikes: a few in a row
 * are treated like a block. Being offline says nothing about an engine and never trips it.
 */
const BASE_MS = 2 * 60_000;
const MAX_MS = 20 * 60_000;
const STRIKES = 3;

interface State {
  openUntil: number;
  trips: number;
  strikes: number;
  probing: boolean;
  lastOkAt: number | null;
}

export type Health = { state: 'ok' } | { state: 'limited'; retryAt: number } | { state: 'unknown' };

export class Breakers {
  private readonly states = new Map<string, State>();

  private of(family: string): State {
    let s = this.states.get(family);
    if (!s) this.states.set(family, (s = { openUntil: 0, trips: 0, strikes: 0, probing: false, lastOkAt: null }));
    return s;
  }

  /** Whether a request may go to the family now; at most one probe at a time once an open period has passed. */
  allow(family: string, now: number): boolean {
    const s = this.of(family);
    if (s.openUntil === 0 || now >= s.openUntil) {
      if (s.openUntil !== 0) {
        if (s.probing) return false;
        s.probing = true;
      }
      return true;
    }
    return false;
  }

  success(family: string, now: number): void {
    this.states.set(family, { openUntil: 0, trips: 0, strikes: 0, probing: false, lastOkAt: now });
  }

  /** A block, a challenge, or results for another query. */
  block(family: string, now: number): void {
    const s = this.of(family);
    s.openUntil = now + Math.min(MAX_MS, BASE_MS * 2 ** s.trips);
    s.trips++;
    s.strikes = 0;
    s.probing = false;
  }

  /** An empty page that another engine answered after all: a soft block when it repeats. */
  strike(family: string, now: number): void {
    const s = this.of(family);
    s.probing = false;
    if (++s.strikes >= STRIKES) this.block(family, now);
  }

  /** The probe ended without telling anything (offline, an error): let the next request probe again. */
  release(family: string): void {
    this.of(family).probing = false;
  }

  health(family: string, now: number): Health {
    const s = this.states.get(family);
    if (!s) return { state: 'unknown' };
    if (s.openUntil > now) return { state: 'limited', retryAt: s.openUntil };
    return s.lastOkAt ? { state: 'ok' } : { state: 'unknown' };
  }

  lastOkAt(family: string): number | null {
    return this.states.get(family)?.lastOkAt ?? null;
  }
}
