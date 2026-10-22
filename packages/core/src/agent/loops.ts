/**
 * `/loop` (ARCHITECTURE §8): a prompt the person wants sent again and again in a Code or Cowork session. A loop sends
 * it at once and then every interval, each time only while the session is idle: a run that is still going (or waits
 * for the person's approval) holds the next send back until the session is idle, and however many intervals passed
 * meanwhile it goes once. Loops are listed in Background tasks, live in memory while the backend runs (so they go on
 * with every window closed, and end with a restart) and end when stopped, when their session is deleted, after
 * LOOP_MAX_RUNS sends or LOOP_MAX_AGE_MS after they started. A session has LOOP_MAX_PER_SESSION running at most, and
 * a person LOOP_MAX_PER_USER.
 */
import { LOOP_MAX_AGE_MS, LOOP_MAX_PER_SESSION, LOOP_MAX_PER_USER, LOOP_MAX_RUNS, LOOP_MIN_INTERVAL_MS, type LoopSchedule } from '@atelier/protocol';
import { newId } from '../util/ids.ts';
import type { BackgroundTasks } from './background-tasks.ts';

/** One send: the loop's prompt, which of its runs this is, and how often it repeats. */
export interface LoopTick {
  loopId: string;
  prompt: string;
  run: number;
  intervalMs: number;
}

export interface LoopsDeps {
  tasks: BackgroundTasks;
  /** Whether the session is running a turn (or waiting for the person inside one). */
  busy(sessionId: string): boolean;
  /** Sends a loop's prompt as the person's message and starts the turn that answers it. */
  send(sessionId: string, tick: LoopTick): void;
  /** The shortest interval; tests lower it (ATELIER_LOOP_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  now?(): number;
}

/** A loop that would pass LOOP_MAX_PER_SESSION or LOOP_MAX_PER_USER didn't start; the message says which. */
export class LoopLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopLimitError';
  }
}

interface Loop {
  id: string;
  sessionId: string;
  /** Whose loop it is (the user id), for LOOP_MAX_PER_USER. */
  owner: string | null;
  prompt: string;
  intervalMs: number;
  startedAt: number;
  runs: number;
  nextAt: number;
  /** Came due while the session was busy. */
  waiting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Loops {
  private loops = new Map<string, Loop>();

  constructor(private readonly deps: LoopsDeps) {}

  /** The shortest interval this backend allows. */
  get minIntervalMs(): number {
    return this.deps.minIntervalMs ?? LOOP_MIN_INTERVAL_MS;
  }

  /**
   * Starts a loop that sends `prompt` now (or once the session is idle) and then every `intervalMs`, rounded up to the
   * shortest interval. Throws LoopLimitError when the session, or `owner`, has as many loops running as allowed.
   */
  start(sessionId: string, prompt: string, intervalMs: number, owner: string | null = null): { taskId: string; intervalMs: number } {
    if (this.of(sessionId).length >= LOOP_MAX_PER_SESSION) throw new LoopLimitError(`This session already has ${LOOP_MAX_PER_SESSION} loops running, the most one session may have. Stop one first with /loop stop.`);
    if (owner !== null && [...this.loops.values()].filter((l) => l.owner === owner).length >= LOOP_MAX_PER_USER)
      throw new LoopLimitError(`You already have ${LOOP_MAX_PER_USER} loops running across your sessions, the most one person may have. Stop one first with /loop stop in its session.`);
    const now = this.now();
    const loop: Loop = { id: `loop:${newId()}`, sessionId, owner, prompt, intervalMs: Math.max(intervalMs, this.minIntervalMs), startedAt: now, runs: 0, nextAt: now, waiting: false, timer: null };
    this.loops.set(loop.id, loop);
    this.deps.tasks.addLoop(sessionId, { id: loop.id, prompt, schedule: this.schedule(loop), stop: async () => this.end(loop, 'stopped') });
    this.due(loop);
    return { taskId: loop.id, intervalMs: loop.intervalMs };
  }

  /** A session's running loops, oldest first. */
  list(sessionId: string): { id: string; prompt: string; intervalMs: number }[] {
    return this.of(sessionId).map(({ id, prompt, intervalMs }) => ({ id, prompt, intervalMs }));
  }

  /** Stops a session's loops, or the one `target` names: its number among the running loops (from 1) or its id. Returns how many stopped. */
  stop(sessionId: string, target: string | null = null): number {
    const loops = this.of(sessionId);
    const chosen = target === null ? loops : loops.filter((l, i) => l.id === target || l.id === `loop:${target}` || String(i + 1) === target);
    for (const loop of chosen) this.end(loop, 'stopped');
    return chosen.length;
  }

  /**
   * The session's run ended. A loop that came due meanwhile sends now (one at a time: the next waits for the run this
   * one starts). True when a loop started a run.
   */
  idle(sessionId: string): boolean {
    const next = this.of(sessionId).find((l) => l.waiting);
    if (!next || this.deps.busy(sessionId)) return false;
    this.fire(next);
    return true;
  }

  /**
   * The person pressed Stop in the session: its loops go on, but none sends right after the Stop. A send that waited
   * is skipped, and each loop's next send comes a full interval from now.
   */
  stopped(sessionId: string): void {
    for (const loop of this.of(sessionId)) this.arm(loop, this.now() + loop.intervalMs);
  }

  /** The session is gone: its loops end without a word (its task list goes with it). */
  forget(sessionId: string): void {
    for (const loop of this.of(sessionId)) {
      if (loop.timer) clearTimeout(loop.timer);
      this.loops.delete(loop.id);
    }
  }

  dispose(): void {
    for (const loop of this.loops.values()) if (loop.timer) clearTimeout(loop.timer);
    this.loops.clear();
  }

  private of(sessionId: string): Loop[] {
    return [...this.loops.values()].filter((l) => l.sessionId === sessionId);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private schedule(loop: Loop, ended = false): LoopSchedule {
    return { intervalMs: loop.intervalMs, runs: loop.runs, nextAt: ended ? null : loop.nextAt, waiting: loop.waiting };
  }

  /** Its time came: it sends, or waits for the session to be idle, or ends past its age. */
  private due(loop: Loop): void {
    loop.timer = null;
    if (!this.loops.has(loop.id)) return;
    if (this.now() - loop.startedAt >= LOOP_MAX_AGE_MS) return this.end(loop, 'done');
    if (!this.deps.busy(loop.sessionId)) return this.fire(loop);
    loop.waiting = true;
    this.deps.tasks.loopChanged(loop.sessionId, loop.id, this.schedule(loop));
  }

  private fire(loop: Loop): void {
    loop.runs++;
    loop.waiting = false;
    const tick = { loopId: loop.id, prompt: loop.prompt, run: loop.runs, intervalMs: loop.intervalMs };
    // The next interval counts from this send, so a send that waited doesn't make the next one come early.
    if (loop.runs >= LOOP_MAX_RUNS) this.end(loop, 'done');
    else this.arm(loop, this.now() + loop.intervalMs);
    this.deps.send(loop.sessionId, tick);
  }

  private arm(loop: Loop, at: number): void {
    if (loop.timer) clearTimeout(loop.timer);
    loop.nextAt = at;
    loop.waiting = false;
    loop.timer = setTimeout(() => this.due(loop), Math.max(0, at - this.now()));
    loop.timer.unref?.();
    this.deps.tasks.loopChanged(loop.sessionId, loop.id, this.schedule(loop));
  }

  private end(loop: Loop, status: 'done' | 'stopped'): void {
    if (!this.loops.delete(loop.id)) return;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
    loop.waiting = false;
    this.deps.tasks.endLoop(loop.sessionId, loop.id, status, this.schedule(loop, true));
  }
}
