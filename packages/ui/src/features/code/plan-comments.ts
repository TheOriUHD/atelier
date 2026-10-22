/**
 * Comments on a plan the session is waiting on: text the person selected in the Plan pane and what they want changed.
 * They are kept here, per session, until the plan is answered, and go to the model with "Revise…".
 */
import { useSyncExternalStore } from 'react';

export interface PlanComment {
  id: string;
  /** The passage the comment is about. */
  quote: string;
  text: string;
}

const NONE: readonly PlanComment[] = [];
const comments = new Map<string, readonly PlanComment[]>();
const listeners = new Set<() => void>();
let counter = 0;

const emit = () => listeners.forEach((l) => l());

export const planComments = {
  get: (sessionId: string): readonly PlanComment[] => comments.get(sessionId) ?? NONE,
  add(sessionId: string, quote: string, text: string): void {
    comments.set(sessionId, [...planComments.get(sessionId), { id: `c${++counter}`, quote, text }]);
    emit();
  },
  remove(sessionId: string, id: string): void {
    comments.set(sessionId, planComments.get(sessionId).filter((c) => c.id !== id));
    emit();
  },
  clear(sessionId: string): void {
    if (comments.delete(sessionId)) emit();
  },
};

export function usePlanComments(sessionId: string): readonly PlanComment[] {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => planComments.get(sessionId),
  );
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** What the model is told when the plan is sent back: the person's words, then each comment with its passage. */
export function revisionMessage(feedback: string, list: readonly PlanComment[], max = 2000): string | undefined {
  const parts: string[] = [];
  if (feedback.trim()) parts.push(feedback.trim());
  if (list.length) parts.push(`Comments on the plan:\n${list.map((c) => `- On “${clip(c.quote.replace(/\s+/g, ' '), 140)}”: ${c.text.trim()}`).join('\n')}`);
  const message = parts.join('\n\n');
  return message ? clip(message, max) : undefined;
}
