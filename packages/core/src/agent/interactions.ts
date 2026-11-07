/**
 * Questions a run puts to the person (permission prompts, AskUser and MCP elicitation). The
 * open question is persisted on the session so a reloaded or second client sees it; one question per
 * session is open at a time.
 */
import type { PendingInteraction } from '@atelier/protocol';
import { newId } from '../util/ids.ts';

interface Waiting {
  sessionId: string;
  kind: PendingInteraction['kind'];
  payload: unknown;
  /** Co-op: who may answer it. */
  approver?: string;
  resolve(answer: unknown): void;
  /** Settles it as if it were stopped (a denial). */
  cancel(): void;
}

/** Co-op: who answers a question, and how long it waits for them before it is denied by itself. */
export interface AskOptions {
  approver?: string;
  timeoutMs?: number;
}

export class InteractionBroker {
  private waiting = new Map<string, Waiting>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly setPending: (sessionId: string, pending: PendingInteraction | null) => Promise<void>) {}

  /** Asks and waits for the answer. An abort resolves with `onAbort` and clears the question. */
  ask<A>(sessionId: string, kind: PendingInteraction['kind'], payload: unknown, signal: AbortSignal, onAbort: A, opts: AskOptions = {}): Promise<A> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (signal.aborted) return onAbort;
      const id = newId();
      let settle!: (answer: A) => void;
      const answered = new Promise<A>((resolve) => (settle = resolve));
      const abort = () => settle(onAbort);
      signal.addEventListener('abort', abort, { once: true });
      // Co-op: nobody who may answer does (a host away from their computer), so it is denied after a while.
      const timer = opts.timeoutMs ? setTimeout(abort, opts.timeoutMs) : undefined;
      // Waiting before the question goes out, so an answer that comes straight back isn't refused.
      this.waiting.set(id, { sessionId, kind, payload, ...(opts.approver ? { approver: opts.approver } : {}), resolve: (answer) => settle(answer as A), cancel: abort });
      try {
        await this.setPending(sessionId, { kind, id, payload, ...(opts.approver ? { approver: opts.approver } : {}), ...(opts.timeoutMs ? { expiresAt: Date.now() + opts.timeoutMs } : {}) });
        return await answered;
      } finally {
        if (timer) clearTimeout(timer);
        this.waiting.delete(id);
        signal.removeEventListener('abort', abort);
        await this.setPending(sessionId, null);
      }
    });
    this.queues.set(sessionId, run.catch(() => undefined));
    return run;
  }

  /** Whether a question is open in this session (a sub-agent's included: they ask where their parent is shown). */
  asking(sessionId: string): boolean {
    return [...this.waiting.values()].some((w) => w.sessionId === sessionId);
  }

  /** What kind of question is open under this id in this session, if any. */
  kindOf(sessionId: string, interactionId: string): PendingInteraction['kind'] | null {
    const w = this.waiting.get(interactionId);
    return w && w.sessionId === sessionId ? w.kind : null;
  }

  /** What the open question under this id in this session asks, if there is one. */
  payloadOf(sessionId: string, interactionId: string): unknown {
    const w = this.waiting.get(interactionId);
    return w && w.sessionId === sessionId ? w.payload : undefined;
  }

  /** Co-op: who may answer the open question under this id, if there is one. */
  pendingOf(sessionId: string, interactionId: string): { approver?: string } | null {
    const w = this.waiting.get(interactionId);
    return w && w.sessionId === sessionId ? { ...(w.approver ? { approver: w.approver } : {}) } : null;
  }

  /** Co-op: someone left: the questions only they could answer are denied. */
  denyFor(sessionId: string, approver: string): void {
    for (const w of [...this.waiting.values()]) if (w.sessionId === sessionId && w.approver === approver) w.cancel();
  }

  /** Delivers an answer; false when nothing with that id is waiting in that session (already answered or stale). */
  respond(sessionId: string, interactionId: string, answer: unknown): boolean {
    const w = this.waiting.get(interactionId);
    if (!w || w.sessionId !== sessionId) return false;
    this.waiting.delete(interactionId);
    w.resolve(answer);
    return true;
  }
}
