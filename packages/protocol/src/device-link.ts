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
import { McpImportEntry } from './mcp.ts';
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
 * one), `ssh` (SSH hosts reached with the device's own ssh, keys and runner builds), `http` (addresses on the device or
 * its network: personal model servers and connectors), `mcp` (personal connectors that run a program there), `home`
 * (the person's own instructions, skills and Claude Code settings in its home folder), `chatgptChat` (the ChatGPT window
 * of the desktop app there).
 */
export const DeviceService = z.enum(['runner', 'scratch', 'ssh', 'http', 'mcp', 'home', 'chatgptChat']);
export type DeviceService = z.infer<typeof DeviceService>;

/** A personal connector the person allowed to run here, by what runs: see `connectorFingerprintInput`. */
export const LentConnector = z.object({ id: z.string().min(1).max(64), name: z.string().max(80), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
export type LentConnector = z.infer<typeof LentConnector>;

/** An address the server may reach from here (a model server or connector on this computer or its network), by id. */
export const LentAddress = z.object({ id: z.string().min(1).max(64), baseUrl: z.url().max(2048) });
export type LentAddress = z.infer<typeof LentAddress>;

/**
 * What the person allowed this device to do for this server, set only from the device's own windows (its
 * `lending.json`): scratch folders, the SSH hosts it may connect to, personal connectors it may run, addresses it may
 * reach, its ChatGPT window, and (on unless turned off, as the app's own backend reads them) its home folder's config.
 */
export const DeviceLending = z.object({
  scratch: z.boolean(),
  ssh: z.array(SshHost).max(500),
  connectors: z.array(LentConnector).max(200).default([]),
  http: z.array(LentAddress).max(200).default([]),
  chatgptChat: z.boolean().default(false),
  home: z.boolean().default(true),
});
export type DeviceLending = z.infer<typeof DeviceLending>;
export const NO_LENDING: DeviceLending = { scratch: false, ssh: [], connectors: [], http: [], chatgptChat: false, home: true };

/**
 * What a personal connector's fingerprint is taken of: the program, its arguments and the names (not values) of its
 * environment. A change to any of them needs the person's say-so on the device again; new secret values don't.
 */
export function connectorFingerprintInput(command: string, args: readonly string[], envKeys: readonly string[]): string {
  return JSON.stringify([command, [...args], [...new Set(envKeys)].sort()]);
}

/**
 * Environment variables a personal connector may not set, on any computer: ones that change which code a program
 * loads or runs (the loader's, Node's, Python's, Perl's, Ruby's, the JVM's, the shell's, npm's and git's), or where
 * it finds programs and its home. Matched without case, as Windows names are.
 */
export const UNSAFE_CONNECTOR_ENV =
  /^(LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|PATH$|PATHEXT$|PYTHON(PATH|STARTUP|HOME|INSPECT)$|PERL5(LIB|OPT)$|PERLLIB$|RUBY(OPT|LIB)$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|PS4$|PROMPT_COMMAND$|IFS$|(JAVA_TOOL|_JAVA|JDK_JAVA)_OPTIONS$|CLASSPATH$|COMSPEC$|HOME$|USERPROFILE$|NPM_CONFIG_|GIT_|ELECTRON_RUN_AS_NODE$)/i;

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

const HeaderMap = z.record(z.string().max(256), z.string().max(16_384));

/**
 * Something long-lived the device runs for the server, its lines carried in a channel like a runner's.
 *
 * `http` is one request from the device to an address it lent (`lending.http`, by `target`), at or below its base URL.
 * The device's lines are JSON: `{"head":{"status","headers"}}` first, then `{"chunk":"<base64>"}` for the body as it
 * arrives; the channel closing ends the body. `{"error":"<why>","code":"ECONNREFUSED"}` says the request failed there (`code`
 * when it was the network).
 * `mcp` runs a personal connector's program on the device; its lines are the program's MCP JSON-RPC lines.
 */
export const DeviceStart = z.discriminatedUnion('kind', [
  /** A runner on an SSH host, reached with the device's ssh (the device uploads its own runner build there). */
  z.object({ kind: z.literal('ssh'), connection: DeviceSshConnection, answers: SshAnswers, root: z.string().min(1).max(4096), env: SafeEnv }),
  z.object({
    kind: z.literal('http'),
    target: z.string().min(1).max(64),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.url().max(8192),
    headers: HeaderMap,
    /** Base64; at most 48 MiB of request. */
    body: z.string().max(64 * 1024 * 1024).optional(),
  }),
  z.object({
    kind: z.literal('mcp'),
    connectorId: z.string().min(1).max(64),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(200),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200), z.string().max(65_536)),
  }),
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
  /** The model servers answering on the device's default local ports (Ollama, llama.cpp, LM Studio): `LocalServer[]`. */
  z.object({ op: z.literal('providers.detect') }),
  /** One call to the desktop app's ChatGPT window there (a personal ChatGPT Chat provider); its answer is a string. */
  z.object({
    op: z.literal('chatgptChat'),
    operation: z.enum(['status', 'open', 'hide', 'disconnect', 'models', 'start', 'poll', 'stop']),
    /** What `start` sends: the prompt and its files (base64), at most 48 MiB. */
    value: z.string().max(64 * 1024 * 1024).optional(),
  }),
  /** Everything the person's own config in the home folder there brings, at once: a `HomeScan`. */
  z.object({ op: z.literal('home.scan') }),
  /** One file there that the scan didn't hold (a file an instruction file imports): its text, or null. */
  z.object({ op: z.literal('home.read'), path: z.string().min(1).max(4096) }),
  /** Claude Code's connectors there (`~/.claude.json` and the folders trusted there), converted: `McpImportEntry[]`. */
  z.object({ op: z.literal('mcp.import') }),
]);
export type DeviceRequest = z.infer<typeof DeviceRequest>;

/** The service a request needs the device to lend. */
export const REQUEST_SERVICE: Record<DeviceRequest['op'], DeviceService> = {
  'scratch.create': 'scratch',
  'ssh.hosts': 'ssh',
  'ssh.probe': 'ssh',
  'ssh.test': 'ssh',
  'providers.detect': 'http',
  chatgptChat: 'chatgptChat',
  'home.scan': 'home',
  'home.read': 'home',
  'mcp.import': 'mcp',
};

/** `mcp.import`'s answer. */
export const McpImportList = z.array(McpImportEntry).max(500);

/**
 * What `home.scan` brings (the person's skills, commands, agents, Claude Code plugins and instruction files there): the
 * folders listed and files read while looking, by their path there, so the server can look again in it. `settings` is
 * `~/.claude/settings.json` without anything but its permission rules, hooks and switched plugins (never its `env`).
 */
export const HomeScan = z.object({
  home: z.string().max(4096),
  sep: z.enum(['/', '\\']),
  dirs: z.record(z.string().max(4096), z.array(z.string().max(1024)).max(5000)),
  files: z.record(z.string().max(4096), z.string().nullable()),
  real: z.record(z.string().max(4096), z.string().max(4096)),
  settings: z
    .object({
      permissions: z.object({ allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) }),
      hooks: z.unknown().optional(),
      enabledPlugins: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
export type HomeScan = z.infer<typeof HomeScan>;

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
  z.discriminatedUnion('event', [
    /** What the person allows this device to do for the server changed. */
    z.object({ t: z.literal('event'), event: z.literal('lending.changed'), lending: DeviceLending }),
    /** The person's config in the home folder there changed (a skill added, ~/.claude/CLAUDE.md edited): scan it again. */
    z.object({ t: z.literal('event'), event: z.literal('home.changed') }),
  ]),
  z.object({ t: z.literal('pong') }),
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;
