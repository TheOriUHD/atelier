/**
 * The last error this window hit, kept only in memory for "Copy diagnostics". Nothing reads it but that button, and it
 * is gone when the window closes: Atelier reports no errors anywhere.
 */
export interface LastError {
  message: string;
  at: number;
}

let last: LastError | null = null;

const KEPT = 2000;

/** Remembers an error (or whatever was thrown) as its message only: no stack, which carries file paths. */
export function recordError(error: unknown, now = Date.now()): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : (() => {
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  })();
  last = { message: message.slice(0, KEPT), at: now };
}

export function lastError(): LastError | null {
  return last;
}

export function clearLastError(): void {
  last = null;
}

let tracking = false;

/** Listens for uncaught errors and unhandled rejections in this window; once. */
export function trackErrors(): void {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener('error', (e) => recordError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => recordError(e.reason));
}
