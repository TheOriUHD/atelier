/**
 * A small log of the main process (`<logs>/main.log`: %APPDATA%\Atelier\logs on Windows, ~/Library/Logs/Atelier on
 * macOS): how a start went, and what failed or crashed. It is what is left to read when the app runs without a window.
 * Kept under 1 MB: the older half moves to main.old.log.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

let file: string | null = null;

/** Starts the log in `dir` (call once `app.getPath('logs')` works). */
export function openMainLog(dir: string): string {
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'main.log');
  return file;
}

export function logMain(message: string): void {
  if (!file) return;
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, file.replace(/\.log$/, '.old.log'));
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A log that can't be written changes nothing else.
  }
}

/** An error with its stack, on one entry. */
export function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}
