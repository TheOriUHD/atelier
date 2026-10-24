/**
 * MCP connectors (ARCHITECTURE §9-B): servers in Claude Code's `mcpServers` shape, kept in the system settings
 * by admins, their live status, and the desktop's import from Claude Code.
 */
import { z } from 'zod';

export const McpServerName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Use up to 64 letters, digits, - and _.');

export const McpTransport = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransport>;

/**
 * One server. `env`, `headers` and `url` may reference `${secret:<id>}` and `${ENV}`; they are resolved only when
 * connecting. stdio servers run only where the backend may start programs (the desktop app). An HTTP or SSE server
 * with `auth: 'oauth'` is signed in once by an admin; the backend keeps its tokens and uses them for every session.
 */
export const McpServerConfig = z
  .object({
    type: McpTransport.default('stdio'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    /** The server's own names of tools that never reach a model. */
    disabledTools: z.array(z.string()).default([]),
    /** The catalog entry it was set up from (`cloudflare`, `github`, …). */
    preset: z.string().optional(),
    /** Sign in with OAuth instead of sending a token in `headers`. */
    auth: z.literal('oauth').optional(),
  })
  .refine((s) => (s.type === 'stdio' ? !!s.command : !!s.url), { message: 'stdio servers need a command; http and sse servers need a url.' })
  .refine((s) => s.type !== 'stdio' || !s.auth, { message: 'Only http and sse servers can sign in with OAuth.' });
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Regular users get names, states and enabled tool names only; admins also see descriptions, errors and the era. */
export const McpServerStatus = z.object({
  name: z.string(),
  type: McpTransport,
  state: z.enum(['connecting', 'ready', 'error', 'disabled']),
  error: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), readOnly: z.boolean(), enabled: z.boolean() })),
  /** `modern` is the stateless 2026-07-28 protocol, `legacy` the `initialize` handshake of earlier ones. */
  protocolEra: z.enum(['modern', 'legacy']).optional(),
  /** An OAuth server (state `error`) that has no usable sign-in: `needed` until an admin signs in, `waiting` while the sign-in page is open. */
  signIn: z.enum(['needed', 'waiting']).optional(),
  /** One of the person's own connectors (`PersonalConnector`), only ever reported to them. */
  personal: z.boolean().optional(),
  /** A personal connector's desktop device it runs on or through, while it does ("MacBook"). */
  device: z.string().optional(),
});
export type McpServerStatus = z.infer<typeof McpServerStatus>;

/**
 * A Claude Code server converted for import. `secrets` are paths into `config` of literal credentials to move into
 * the secret store; `source` says where Claude Code keeps it (`~/.claude.json`, a project in it, or a `.mcp.json`).
 */
export const McpImportEntry = z.object({ name: McpServerName, config: McpServerConfig, secrets: z.array(z.array(z.string())), source: z.string() });
export type McpImportEntry = z.infer<typeof McpImportEntry>;

// ---------------------------------------------------------------- personal connectors

/** An environment variable's name. */
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Letters, digits and _, not starting with a digit.').max(200);
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/, 'Not a header name.');

/**
 * A person's own connector (ARCHITECTURE §9-B), anyone's on a server: kept in their preferences without its values,
 * which are one personal secret (`connector-user-<user>-<id>`, `{env, headers}`). A program (stdio) runs on a desktop
 * of theirs that allows it (`lending.json`); an HTTP or SSE server is reached from the server, or through their desktop
 * when its address is on that computer or its network. Its name can't be an admin connector's: theirs wins.
 */
export const PersonalConnector = z
  .object({
    id: z.string().regex(/^[a-z0-9]{1,32}$/),
    name: McpServerName,
    type: McpTransport,
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(8192)).max(200).default([]),
    url: z.string().min(1).max(2048).optional(),
    /** The names of its environment variables (stdio) and headers; the values are in its secret. */
    envKeys: z.array(EnvName).max(100).default([]),
    headerKeys: z.array(HeaderName).max(50).default([]),
    enabled: z.boolean().default(true),
    disabledTools: z.array(z.string()).default([]),
    auth: z.literal('oauth').optional(),
  })
  .refine((c) => (c.type === 'stdio' ? !!c.command : !!c.url), { message: 'stdio connectors need a command; http and sse ones need a url.' })
  .refine((c) => c.type !== 'stdio' || !c.auth, { message: 'Only http and sse connectors can sign in with OAuth.' });
export type PersonalConnector = z.infer<typeof PersonalConnector>;

/** A personal connector to save: its values by name, where null keeps the value saved before. */
export const PersonalConnectorInput = z.object({
  /** Absent for a new one. */
  id: z.string().regex(/^[a-z0-9]{1,32}$/).optional(),
  name: McpServerName,
  type: McpTransport,
  command: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(8192)).max(200).default([]),
  url: z.string().min(1).max(2048).optional(),
  env: z.record(EnvName, z.string().max(65_536).nullable()).default({}),
  headers: z.record(HeaderName, z.string().max(16_384).nullable()).default({}),
  enabled: z.boolean().default(true),
  disabledTools: z.array(z.string()).default([]),
  auth: z.literal('oauth').optional(),
});
export type PersonalConnectorInput = z.infer<typeof PersonalConnectorInput>;

/** A personal connector as its owner's windows list it; `clash` is an admin connector of the same name, which wins. */
export const PersonalConnectorView = z.object({ connector: PersonalConnector, clash: z.boolean() });
export type PersonalConnectorView = z.infer<typeof PersonalConnectorView>;

/**
 * The model-facing name of a server's tool, built as Claude Code builds it so its permission rules apply:
 * `mcp__<server>__<tool>`, other characters replaced by `_`, at most 64 characters.
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
