/**
 * The device link (ARCHITECTURE §21): a desktop app signed in to a server lends that server what its own backend would
 * use on this computer. One WebSocket per device. The runner's JSON-RPC lines travel inside frames tagged with a
 * channel, one channel per open workspace; other services (an SSH host reached with this computer's ssh) are channels
 * too, and one-shot questions (make a scratch folder, list ~/.ssh/config's hosts) are requests.
 *
 * Version 2 adds `hello`, `start`, `req`/`res` and `event`; a version-1 desktop sends no `hello` and only lends runners.
 * Each end drops frames it can't parse, so new frames never reach an old peer's handlers.
 */
import { z } from 'zod';
import { SshHost } from './ssh.ts';

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

/** The link version this build speaks. */
export const DEVICE_LINK_PROTOCOL = 2;

/**
 * What a device can lend: `runner` (folders trusted on it), `scratch` (a new empty folder per session started without
 * one), `ssh` (SSH hosts reached with the device's own ssh, keys and runner builds).
 */
export const DeviceService = z.enum(['runner', 'scratch', 'ssh']);
export type DeviceService = z.infer<typeof DeviceService>;

/**
 * What the person allowed this device to do for this server, set only from the device's own windows (its
 * `lending.json`): scratch folders, and the SSH hosts it may connect to.
 */
export const DeviceLending = z.object({
  scratch: z.boolean(),
  ssh: z.array(SshHost).max(500),
});
export type DeviceLending = z.infer<typeof DeviceLending>;
export const NO_LENDING: DeviceLending = { scratch: false, ssh: [] };

const Channel = z.string().min(1).max(64);
/** A runner frame; large reads travel base64-encoded inside one line. */
const Line = z.string().max(64 * 1024 * 1024);

/** An SSH connection as the device's ssh needs it: where, which port, which key. Never ssh options. */
export const DeviceSshConnection = z.object({
  name: z.string().min(1).max(80),
  host: SshHost,
  port: z.number().int().min(1).max(65535).nullable(),
  /** An absolute path or `~/…` on the device; no control characters. */
  keyPath: z
    .string()
    .max(1024)
    .refine((p) => /^(?:~\/|\/|[A-Za-z]:[\\/])/.test(p) && [...p].every((c) => c.charCodeAt(0) >= 0x20), 'An absolute path or one in the home folder.')
    .nullable(),
});
export type DeviceSshConnection = z.infer<typeof DeviceSshConnection>;

/** The answers ssh gets from the askpass script: whether to trust a new host key, and a password to give. */
export const SshAnswers = z.object({
  trust: z.boolean(),
  password: z.string().max(4096).optional(),
  /** Also give the password for a local key's passphrase (the person was shown that prompt). */
  passphrase: z.boolean().optional(),
});
export type SshAnswers = z.infer<typeof SshAnswers>;

/** What a probe (`ssh … true`) learned: how it ended, what ssh said, what it asked. */
export const SshProbe = z.object({
  code: z.number().int().nullable(),
  stderr: z.string().max(64 * 1024),
  prompts: z.array(z.string().max(4096)).max(20),
});
export type SshProbe = z.infer<typeof SshProbe>;

/** The environment a service may get from the server: only what keeps git inside a scratch folder. */
const SafeEnv = z.object({ GIT_CEILING_DIRECTORIES: z.string().max(4096).optional() }).strict();

/** Something long-lived the device runs for the server, its lines carried in a channel like a runner's. */
export const DeviceStart = z.discriminatedUnion('kind', [
  /** A runner on an SSH host, reached with the device's ssh (the device uploads its own runner build there). */
  z.object({ kind: z.literal('ssh'), connection: DeviceSshConnection, answers: SshAnswers, root: z.string().min(1).max(4096), env: SafeEnv }),
]);
export type DeviceStart = z.infer<typeof DeviceStart>;

/** A one-shot question to the device; `res` answers it. */
export const DeviceRequest = z.discriminatedUnion('op', [
  /** Make `<scratch folder>/<user>/<name>` and say where it is. */
  z.object({ op: z.literal('scratch.create'), user: z.string().regex(/^[\w-]{1,64}$/), name: z.string().regex(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/) }),
  /** The Host entries of the device's ~/.ssh/config (names only). */
  z.object({ op: z.literal('ssh.hosts') }),
  /** `ssh … true` with these answers: what ssh asked and how it ended. */
  z.object({ op: z.literal('ssh.probe'), connection: DeviceSshConnection, answers: SshAnswers }),
  /** What the host says it is (`uname -sm`), once a probe went through. */
  z.object({ op: z.literal('ssh.test'), connection: DeviceSshConnection, answers: SshAnswers }),
]);
export type DeviceRequest = z.infer<typeof DeviceRequest>;

/** The service a request needs the device to lend. */
export const REQUEST_SERVICE: Record<DeviceRequest['op'], DeviceService> = {
  'scratch.create': 'scratch',
  'ssh.hosts': 'ssh',
  'ssh.probe': 'ssh',
  'ssh.test': 'ssh',
};

/** What a device says about itself when it connects. */
export const DeviceHello = z.object({
  protocol: z.number().int().min(2),
  /** The desktop app's version. */
  app: z.string().max(40),
  services: z.array(z.string().max(40)).max(40),
  lending: DeviceLending,
  /** The home folder there and its path separator, for paths the server builds. */
  home: z.string().max(4096),
  sep: z.enum(['/', '\\']),
  os: z.string().max(40),
  arch: z.string().max(40),
});
export type DeviceHello = z.infer<typeof DeviceHello>;

export const ServerToDevice = z.discriminatedUnion('t', [
  /** Start a runner rooted at `root`; the device refuses roots it doesn't trust. */
  z.object({ t: z.literal('open'), channel: Channel, root: z.string().min(1).max(4096) }),
  /** Start another kind of channel (version 2). */
  z.object({ t: z.literal('start'), channel: Channel, service: DeviceStart }),
  z.object({ t: z.literal('line'), channel: Channel, line: Line }),
  z.object({ t: z.literal('close'), channel: Channel }),
  z.object({ t: z.literal('req'), id: z.number().int().min(0), request: DeviceRequest }),
  z.object({ t: z.literal('ping') }),
]);
export type ServerToDevice = z.infer<typeof ServerToDevice>;

/** Why a device didn't do what a request asked: not allowed there, not something it can do, or it failed. */
export const DeviceRefusal = z.enum(['refused', 'unsupported', 'failed']);

export const DeviceToServer = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), hello: DeviceHello }),
  z.object({ t: z.literal('opened'), channel: Channel }),
  z.object({ t: z.literal('line'), channel: Channel, line: Line }),
  /** What a channel's program wrote to stderr (an SSH host's runner), for the server's log. */
  z.object({ t: z.literal('log'), channel: Channel, line: z.string().max(8192) }),
  /** The runner exited, or `open` was refused; `reason` is shown to the person. */
  z.object({ t: z.literal('closed'), channel: Channel, reason: z.string().max(500) }),
  /** The answer to `req`: its value, or (`ok` false) why not. */
  z.object({ t: z.literal('res'), id: z.number().int().min(0), ok: z.boolean(), value: z.unknown().optional(), code: DeviceRefusal.optional(), error: z.string().max(2000).optional() }),
  /** What the person allows this device to do for the server changed. */
  z.object({ t: z.literal('event'), event: z.literal('lending.changed'), lending: DeviceLending }),
  z.object({ t: z.literal('pong') }),
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;
