/** What typing `command` and pressing Enter sends to a shell: lines end with a carriage return, as the Enter key does. */
export const keystrokes = (command: string): string => `${command.replace(/\s+$/, '').replace(/\r?\n/g, '\r')}\r`;
