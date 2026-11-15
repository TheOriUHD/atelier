/**
 * Which of a person's computers a session's computer use reaches on a server.
 *
 * A session in a folder on one of their computers (or reached through it, over SSH) runs on that computer, whichever
 * device its messages are written from: computer use is that computer's too, and none while it doesn't lend it. Only a
 * session that runs on the server itself (a chat, a folder on the server) follows the person: the computer they last
 * wrote from in it, else the one they last wrote from anywhere, else the first one that lends computer use.
 */
export function computerDeviceFor(input: {
  /** The computer the session's folder is on or reached through; null for none. */
  folderDevice: string | null;
  lastInSession: string | undefined;
  lastAnywhere: string | undefined;
  devices: readonly string[];
  lends(deviceId: string): boolean;
}): string | null {
  const { folderDevice, lends } = input;
  if (folderDevice) return lends(folderDevice) ? folderDevice : null;
  for (const id of [input.lastInSession, input.lastAnywhere]) if (id && lends(id)) return id;
  return input.devices.find((d) => lends(d)) ?? null;
}
