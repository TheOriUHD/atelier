/**
 * A small log of the main process (`<logs>/main.log`: %APPDATA%\Atelier\logs on Windows, ~/Library/Logs/Atelier on
 * macOS): how a start went, and what failed or crashed. It is what is left to read when the app runs without a window.
 * Kept under 1 MB: the older half moves to main.old.log.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
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

const TAIL_BYTES = 256 * 1024;
const TAIL_LINE_MAX = 2000;

/**
 * The last `count` lines of the log, for "Copy diagnostics". Reads only the end of the file, so a full 1 MB log costs
 * no more than a short one, and cuts every line: this text goes to a window, which redacts it again before copying.
 */
export function readMainLogTail(count: number): string[] {
  if (!file) return [];
  try {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (!size) return [];
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString('utf8').split('\n');
    // A read that began mid-file starts mid-line: that first piece is not a line.
    if (length < size) lines.shift();
    const kept = lines.map((l) => l.replace(/\r$/, '')).filter(Boolean);
    return kept
      .slice(Math.max(0, kept.length - Math.max(0, count)))
      .map((l) => (l.length > TAIL_LINE_MAX ? `${l.slice(0, TAIL_LINE_MAX)}…` : l));
  } catch {
    return [];
  }
}
