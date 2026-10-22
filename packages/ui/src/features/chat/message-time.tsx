/**
 * When a finished message was sent, in the row of its buttons: "5 minutes ago", and the exact date and time after a
 * click (another click goes back). The hover title says the other one.
 */
import { useState, useSyncExternalStore } from 'react';
import { cn } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';

const exactFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** One timer for every label on screen, so "5 minutes ago" moves on without a clock per message. */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const bucket = () => Math.floor(Date.now() / 30_000);
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((l) => l()), 30_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function MessageTime({ at, className }: { at: number; className?: string }) {
  const [exact, setExact] = useState(false);
  useSyncExternalStore(subscribe, bucket);
  const relative = relativeTime(at);
  const absolute = exactFormat.format(at);
  return (
    <button
      type="button"
      onClick={() => setExact((value) => !value)}
      title={exact ? relative : absolute}
      className={cn('rounded-md px-1 text-caption text-fg-muted tabular-nums outline-none hover:text-fg-secondary focus-ring', className)}
    >
      {exact ? absolute : relative}
    </button>
  );
}
