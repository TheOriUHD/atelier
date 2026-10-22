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
  resolve(answer: unknown): void;
}

export class InteractionBroker {
  private waiting = new Map<string, Waiting>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly setPending: (sessionId: string, pending: PendingInteraction | null) => Promise<void>) {}

  /** Asks and waits for the answer. An abort resolves with `onAbort` and clears the question. */
  ask<A>(sessionId: string, kind: PendingInteraction['kind'], payload: unknown, signal: AbortSignal, onAbort: A): Promise<A> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (signal.aborted) return onAbort;
      const id = newId();
      let settle!: (answer: A) => void;
      const answered = new Promise<A>((resolve) => (settle = resolve));
      const abort = () => settle(onAbort);
      signal.addEventListener('abort', abort, { once: true });
      // Waiting before the question goes out, so an answer that comes straight back isn't refused.
      this.waiting.set(id, { sessionId, kind, resolve: (answer) => settle(answer as A) });
      try {
        await this.setPending(sessionId, { kind, id, payload });
        return await answered;
      } finally {
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

  /** Delivers an answer; false when nothing with that id is waiting in that session (already answered or stale). */
  respond(sessionId: string, interactionId: string, answer: unknown): boolean {
    const w = this.waiting.get(interactionId);
    if (!w || w.sessionId !== sessionId) return false;
    this.waiting.delete(interactionId);
    w.resolve(answer);
    return true;
  }
}
