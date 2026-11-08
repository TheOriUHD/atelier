/**
 * The background service's local socket (ARCHITECTURE §25): one JSON object per line. A client's first line proves it
 * may talk to the service (the token in `run/daemon.token`, readable by this user only) and says which connection it
 * wants; then the lines are JSON-RPC to the backend (standalone) or the service's own requests.
 */
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export const Want = z.discriminatedUnion('mode', [z.object({ mode: z.literal('local') }), z.object({ mode: z.literal('server'), serverUrl: z.string() })]);
export type Want = z.infer<typeof Want>;

export const ClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string(), version: z.string(), want: Want }),
  z.object({ t: z.literal('rpc'), m: z.unknown() }),
  /** Ends the service (to start a newer one, or another connection); refused while a reply runs unless forced. */
  z.object({ t: z.literal('stop'), force: z.boolean().optional() }),
  z.object({ t: z.literal('status') }),
  /** Server mode: a new token (after `atelier login`), or none (logged out). */
  z.object({ t: z.literal('token') }),
  /** Server mode: lending.json changed here. */
  z.object({ t: z.literal('lending') }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServiceStatus = z.object({
  version: z.string(),
  pid: z.number(),
  want: Want,
  startedAt: z.number(),
  clients: z.number(),
  /** Replies running or waiting on someone (standalone). */
  busy: z.number(),
  /** Server mode: how the device link stands. */
  link: z.enum(['online', 'connecting', 'signed_out', 'off']).optional(),
  /** Keeps running with no terminal open (so the server can work in this computer's folders). */
  keepAvailable: z.boolean(),
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;

export const ServiceFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), status: ServiceStatus }),
  z.object({ t: z.literal('refused'), reason: z.string() }),
  z.object({ t: z.literal('rpc'), m: z.unknown() }),
  z.object({ t: z.literal('status'), status: ServiceStatus }),
  z.object({ t: z.literal('stopping') }),
  z.object({ t: z.literal('busy'), busy: z.number() }),
]);
export type ServiceFrame = z.infer<typeof ServiceFrame>;

/** Reads a socket's lines as frames; lines that aren't one are dropped. */
export function onFrames<T>(socket: Socket, schema: z.ZodType<T>, handle: (frame: T) => void): void {
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.length > 64 * 1024 * 1024) return;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) handle(parsed.data);
    } catch {
      // Not JSON.
    }
  });
}

export const sendFrame = (socket: Socket, frame: ClientFrame | ServiceFrame) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
};

export const sameWant = (a: Want, b: Want) => a.mode === b.mode && (a.mode === 'local' || (b.mode === 'server' && a.serverUrl === b.serverUrl));
