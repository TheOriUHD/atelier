/** The running Ink instance, for the few things that act on the whole screen (printing the transcript again). */
import type { Instance } from 'ink';
import { CLEAR_ALL } from '../term.ts';

let current: Instance | null = null;

export const setInstance = (instance: Instance | null) => void (current = instance);

/** Clears the terminal and its scrollback so the transcript can be printed again from the top. */
export function clearScreen(): void {
  current?.clear();
  if (process.stdout.isTTY) process.stdout.write(CLEAR_ALL);
}

export const suspend = () => current;
