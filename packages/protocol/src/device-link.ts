/**
 * The device link (ARCHITECTURE §21): a desktop app signed in to a server lends that server its runner, for
 * folders the person trusted on the machine. One WebSocket per device; the runner's JSON-RPC lines travel
 * inside frames tagged with a channel, one channel per open workspace. The device only pipes lines: the
 * server is the runner's client, and the runner's own path scoping still applies to its file methods (its
 * commands run as the desktop's user, wherever they reach).
 */
import { z } from 'zod';

export const DEVICE_LINK_PATH = '/api/devices/link';
/** Request headers naming the device, next to `Authorization: Bearer <token>`. */
export const DEVICE_HEADERS = { id: 'x-atelier-device-id', name: 'x-atelier-device-name', platform: 'x-atelier-device-platform' } as const;

/** The device as named in those headers (same limits as `devices.register`). */
export const DeviceInfo = z.object({ id: z.uuid(), name: z.string().min(1).max(120), platform: z.string().min(1).max(40) });
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/**
 * The server pings the device this often and the device answers. Each end drops a link that stays quiet for
 * two pings: the device connects again, and the server shows its workspaces as unavailable meanwhile.
 */
export const DEVICE_LINK_PING_MS = 10_000;

const Channel = z.string().min(1).max(64);
/** A runner frame; large reads travel base64-encoded inside one line. */
const Line = z.string().max(64 * 1024 * 1024);

export const ServerToDevice = z.discriminatedUnion('t', [
  /** Start a runner rooted at `root`; the device refuses roots it doesn't trust. */
  z.object({ t: z.literal('open'), channel: Channel, root: z.string().min(1).max(4096) }),
  z.object({ t: z.literal('line'), channel: Channel, line: Line }),
  z.object({ t: z.literal('close'), channel: Channel }),
  z.object({ t: z.literal('ping') }),
]);
export type ServerToDevice = z.infer<typeof ServerToDevice>;

export const DeviceToServer = z.discriminatedUnion('t', [
  z.object({ t: z.literal('opened'), channel: Channel }),
  z.object({ t: z.literal('line'), channel: Channel, line: Line }),
  /** The runner exited, or `open` was refused; `reason` is shown to the person. */
  z.object({ t: z.literal('closed'), channel: Channel, reason: z.string().max(500) }),
  z.object({ t: z.literal('pong') }),
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;
